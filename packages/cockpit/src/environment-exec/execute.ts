import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, lstatSync } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFenceMarkerFile } from '../../libexec/fence-marker.cjs'
import {
    ENVIRONMENT_CODES,
    EXECUTION_FAILURE_CODES,
    sameFilesystemObject,
    snapshotExecutionPlan,
    snapshotExecutionStep,
    snapshotJson,
    type ConsumedFile,
    type ExecutionFailureCode,
    type ExecutionPlan,
    type ExecutionReceipt,
    type ExecutionStep,
    type ExecutionFence,
    type FilesystemCheck,
    type EnvironmentDiagnostic,
} from '../environment/contract.js'
import { redactSensitiveMessage } from '../environment/sensitive.js'
import { fileFingerprint, recordVerifiedDigest, verifiedDigest } from './verified-digest.js'

export const mechanism = {
    id: 'environment-execution',
    module: 'packages/cockpit/src/environment-exec/execute.ts',
    exports: ['executePlan', 'executeProbe', 'executeForegroundProcess', 'repairFencedExecution', 'cleanupFencedExecution', 'consumeFencedExecutionTermination', 'authenticatedExecutionOutcome', 'executionOutcomeMatches', 'executionReceiptMatches'],
} as const

const FENCE_READY_MS = 2_000
const FENCE_REPAIR_MS = 2_000

interface FenceMarker {
    readonly format: 'cockpit-executor/v1'
    readonly attemptId: string
    readonly supervisorPid?: number
    readonly groupPid?: number
    readonly markerDev: string
    readonly markerIno: string
    readonly parentDev: string
    readonly parentIno: string
    readonly status: 'active' | 'terminating' | 'terminated' | 'cancelled'
    readonly finishedAt?: string
}

export interface FencedExecutionTermination { readonly kind: 'fenced-execution-termination' }
const fencedTerminations = new WeakMap<object, ExecutionFence>()

function validExecutionFence(fence: ExecutionFence): boolean {
    return /^[a-f0-9]{64}$/.test(fence.attemptId)
        && [fence.markerPath, fence.socketPath].every(path => isAbsolute(path) && normalize(path) === path && !path.includes('\0'))
        && fence.markerPath !== fence.socketPath && Buffer.byteLength(fence.socketPath) <= 103
}

async function secureFenceSocketDirectory(fence: ExecutionFence): Promise<boolean> {
    const directory = dirname(fence.socketPath)
    try { await mkdir(directory, { recursive: false, mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false
    }
    try {
        const identity = await lstat(directory)
        return identity.isDirectory() && !identity.isSymbolicLink()
            && identity.uid === (process.getuid?.() ?? identity.uid) && (identity.mode & 0o077) === 0
    } catch { return false }
}

function exactFenceMarker(value: unknown, fence: ExecutionFence, identity: {
    readonly markerDev: string; readonly markerIno: string; readonly parentDev: string; readonly parentIno: string
}): FenceMarker | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const marker = value as Record<string, unknown>
    const markerKeys = marker.status === 'terminated'
        ? ['attemptId', 'finishedAt', 'format', 'markerDev', 'markerIno', 'parentDev', 'parentIno', 'status', 'supervisorPid']
        : marker.status === 'terminating'
            ? ['attemptId', 'format', 'groupPid', 'markerDev', 'markerIno', 'parentDev', 'parentIno', 'status', 'supervisorPid']
        : marker.status === 'active'
            ? ['attemptId', 'format', 'markerDev', 'markerIno', 'parentDev', 'parentIno', 'status', 'supervisorPid']
            : ['attemptId', 'format', 'markerDev', 'markerIno', 'parentDev', 'parentIno', 'status']
    if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(markerKeys)
        || marker.format !== 'cockpit-executor/v1' || marker.attemptId !== fence.attemptId
        || marker.markerDev !== identity.markerDev || marker.markerIno !== identity.markerIno
        || marker.parentDev !== identity.parentDev || marker.parentIno !== identity.parentIno
        || marker.status !== 'cancelled' && (!Number.isSafeInteger(marker.supervisorPid) || (marker.supervisorPid as number) < 1)
        || marker.status === 'terminating' && (!Number.isSafeInteger(marker.groupPid) || (marker.groupPid as number) < 1)
        || marker.status !== 'active' && marker.status !== 'terminating' && marker.status !== 'terminated' && marker.status !== 'cancelled'
        || marker.status === 'terminated' && (typeof marker.finishedAt !== 'string' || !Number.isFinite(Date.parse(marker.finishedAt)))) return undefined
    return marker as unknown as FenceMarker
}

function readFenceMarker(fence: ExecutionFence): FenceMarker | undefined {
    const read = readFenceMarkerFile(fence.markerPath)
    return read && exactFenceMarker(read.value, fence, read.identity)
}

async function pathAbsent(path: string): Promise<boolean> {
    try { await lstat(path); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
}

function issueFencedTermination(fence: ExecutionFence): FencedExecutionTermination {
    const evidence = Object.freeze({ kind: 'fenced-execution-termination' as const })
    fencedTerminations.set(evidence, Object.freeze({ ...fence }))
    return evidence
}

async function publishFenceMarker(
    fence: ExecutionFence,
    status: 'active' | 'cancelled',
    supervisorPid?: number,
): Promise<FenceMarker | undefined> {
    const prepared = `${fence.markerPath}.${status}-${process.pid}.prepared`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        const parent = await lstat(dirname(fence.markerPath), { bigint: true })
        if (!parent.isDirectory() || parent.isSymbolicLink()) return undefined
        handle = await open(prepared, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        const markerIdentity = await handle.stat({ bigint: true })
        const marker = Object.freeze({ format: 'cockpit-executor/v1' as const, attemptId: fence.attemptId,
            ...(status === 'active' ? { supervisorPid } : {}),
            markerDev: String(markerIdentity.dev), markerIno: String(markerIdentity.ino),
            parentDev: String(parent.dev), parentIno: String(parent.ino), status })
        await handle.writeFile(`${JSON.stringify(marker)}\n`)
        await handle.sync(); await handle.close(); handle = undefined
        await link(prepared, fence.markerPath)
        await unlink(prepared)
        const directory = await open(dirname(fence.markerPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await directory.sync() } finally { await directory.close() }
        const authenticated = readFenceMarker(fence)
        return authenticated?.status === status && authenticated.supervisorPid === supervisorPid ? authenticated : undefined
    } catch {
        try { await handle?.close() } catch { /* incomplete prepared marker */ }
        try { await unlink(prepared) } catch { /* linked winner or absent preparation */ }
        return undefined
    }
}

const writeActiveFence = (fence: ExecutionFence, supervisorPid: number) =>
    publishFenceMarker(fence, 'active', supervisorPid)
const writeCancelledFence = (fence: ExecutionFence) => publishFenceMarker(fence, 'cancelled')

// The supervisor and its group runner are separate programs so a fenced action outlives this
// process; see libexec/fenced-supervisor.cjs for their protocol.
const FENCED_SUPERVISOR = fileURLToPath(new URL('../../libexec/fenced-supervisor.cjs', import.meta.url))

async function waitForFenceReady(child: ReturnType<typeof spawn>): Promise<boolean> {
    const control = child.stdio[3]
    if (!control || !('on' in control)) return false
    return new Promise(resolve => {
        let settled = false, input = ''
        const settleFenceReady = (value: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
        const timer = setTimeout(() => settleFenceReady(false), FENCE_READY_MS)
        const readable = control as NodeJS.ReadableStream
        readable.setEncoding('utf8')
        readable.on('data', (chunk: string) => { input += chunk; if (input === 'READY\n') settleFenceReady(true); else if (input.length > 6) settleFenceReady(false) })
        child.once('error', () => settleFenceReady(false)); child.once('close', () => settleFenceReady(false))
    })
}

async function spawnFencedSupervisor(step: ExecutionStep, argv: readonly [string, ...string[]]): Promise<{
    readonly child: ReturnType<typeof spawn>
    readonly spawnExpired: () => boolean
} | undefined> {
    const fence = step.executionFence
    if (!fence || !validExecutionFence(fence) || !await secureFenceSocketDirectory(fence)) return undefined
    const [command, ...args] = argv
    const encoded = Buffer.from(JSON.stringify({ command, args, argv0: step.argv0, cwd: step.cwd, spawnNotAfter: step.spawnNotAfter, fence })).toString('base64url')
    const supervisor = spawn(process.execPath, ['--', FENCED_SUPERVISOR, encoded], {
        cwd: step.cwd, env: step.env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    const active = supervisor.pid === undefined || !await waitForFenceReady(supervisor)
        ? undefined : await writeActiveFence(fence, supervisor.pid)
    if (supervisor.pid === undefined || !active) {
        supervisor.stdin?.destroy(); try { process.kill(-supervisor.pid!, 'SIGKILL') } catch { /* no released action */ }
        return undefined
    }
    // Startup and durable acknowledgement can outlive the evidence that authorized the action.
    let control = ''
    const readable = supervisor.stdio[3] as NodeJS.ReadableStream
    readable.on('data', (chunk: string) => { control += chunk })
    const release = step.spawnNotAfter !== undefined && Date.now() > Date.parse(step.spawnNotAfter) ? 'CANCEL' : 'GO'
    supervisor.stdin?.end(`${release} ${fence.attemptId} ${active.markerDev} ${active.markerIno} ${active.parentDev} ${active.parentIno}\n`)
    return { child: supervisor, spawnExpired: () => control === 'EXPIRED\n' }
}

function fencedProcessGone(pid: number): boolean {
    try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

export async function repairFencedExecution(fence: ExecutionFence): Promise<
    | { readonly kind: 'complete'; readonly evidence: FencedExecutionTermination }
    | { readonly kind: 'refusal'; readonly code: typeof ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }
> {
    if (!validExecutionFence(fence) || !await secureFenceSocketDirectory(fence)) return { kind: 'refusal', code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }
    let marker = readFenceMarker(fence)
    if (!marker) {
        if (!await pathAbsent(fence.markerPath)) return { kind: 'refusal', code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }
        marker = await writeCancelledFence(fence) ?? readFenceMarker(fence)
        if (!marker) return { kind: 'refusal', code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }
    }
    if (marker.status === 'active') {
        const expectedPid = marker.supervisorPid!
        const acknowledged = await new Promise<boolean>(resolve => {
            const socket = createConnection(fence.socketPath); let input = ''
            const timer = setTimeout(() => { socket.destroy(); resolve(false) }, FENCE_REPAIR_MS)
            socket.setEncoding('utf8'); socket.once('connect', () => socket.write(`${fence.attemptId}\n`)); socket.on('data', chunk => { input += chunk })
            socket.once('error', () => { clearTimeout(timer); resolve(false) })
            socket.once('close', () => { clearTimeout(timer); try { const reply = JSON.parse(input); resolve(reply.attemptId === fence.attemptId && reply.supervisorPid === expectedPid) } catch { resolve(false) } })
        })
        if (!acknowledged) return { kind: 'refusal', code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }
    }
    const deadline = Date.now() + FENCE_REPAIR_MS
    while (Date.now() <= deadline) {
        marker = readFenceMarker(fence)
        if (marker?.status === 'cancelled' && await pathAbsent(fence.socketPath)) return { kind: 'complete', evidence: issueFencedTermination(fence) }
        if (marker?.status === 'terminated' && fencedProcessGone(marker.supervisorPid!)) return { kind: 'complete', evidence: issueFencedTermination(fence) }
        if (marker?.status === 'terminating' && fencedProcessGone(marker.supervisorPid!)
            && fencedProcessGone(-marker.groupPid!) && await pathAbsent(fence.socketPath)) {
            return { kind: 'complete', evidence: issueFencedTermination(fence) }
        }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    return { kind: 'refusal', code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }
}

export async function cleanupFencedExecution(fence: ExecutionFence): Promise<boolean> {
    if (!validExecutionFence(fence) || !await secureFenceSocketDirectory(fence)) return false
    const marker = readFenceMarker(fence)
    if (!marker) return await pathAbsent(fence.markerPath) && await pathAbsent(fence.socketPath)
    if (marker.status === 'active' || marker.status === 'terminated' && !fencedProcessGone(marker.supervisorPid!)
        || marker.status === 'terminating' && (!fencedProcessGone(marker.supervisorPid!) || !fencedProcessGone(-marker.groupPid!))
        || !await pathAbsent(fence.socketPath)) return false
    try {
        await unlink(fence.markerPath)
        const directory = await open(dirname(fence.markerPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await directory.sync() } finally { await directory.close() }
        return true
    } catch { return false }
}

export function consumeFencedExecutionTermination(evidence: FencedExecutionTermination, fence: ExecutionFence): boolean {
    if (!evidence || typeof evidence !== 'object') return false
    const issued = fencedTerminations.get(evidence)
    if (!issued || issued.attemptId !== fence.attemptId || issued.markerPath !== fence.markerPath || issued.socketPath !== fence.socketPath) return false
    fencedTerminations.delete(evidence)
    return true
}

export interface ForegroundProcessInput {
    readonly executable: import('../environment/executable.js').ResolvedExecutable
    readonly argv: readonly string[]
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
}

export type ForegroundProcessOutcome = Readonly<{
    kind: 'complete'
    exitCode: number
    signal: NodeJS.Signals | null
    terminationConfirmed: true
}> | Readonly<{
    kind: 'refusal'
    code: ExecutionFailureCode
    exitCode: number
    signal: NodeJS.Signals | null
    started: boolean
    terminationConfirmed: boolean
}>

export interface StepExecution {
    id: string
    exitCode: number
    signal: NodeJS.Signals | null
    stdoutBytes: number
    stderrBytes: number
}

export interface ProbeStepExecution extends StepExecution {
    started: boolean
    stdoutObservedBytes: number
    stderrObservedBytes: number
    stdoutRetainedBytes: number
    stderrRetainedBytes: number
}

export interface CompensationFailure {
    id: string
    code: ExecutionFailureCode
}

export type ExecutePlanOutcome =
    | { kind: 'complete'; status: 0; diagnostics: readonly EnvironmentDiagnostic[]; result: { steps: readonly StepExecution[] } }
    | {
          kind: 'refusal'
          status: 2
          diagnostics: readonly EnvironmentDiagnostic[]
          result: null
          execution: {
              completedStepIds: readonly string[]
              failedStep: { id: string; started: boolean; stderr?: string }
              compensation: {
                  attemptedStepIds: readonly string[]
                  completedStepIds: readonly string[]
                  failed: readonly CompensationFailure[]
              }
          }
      }

const TERMINATION_GRACE_MS = 100
const TERMINATION_KILL_MS = TERMINATION_GRACE_MS / 2
interface ReceiptBinding {
    readonly stepFingerprint: string
    readonly consumedFingerprint: string
    outcomeFingerprint?: string
}

const issuedReceipts = new WeakMap<object, ReceiptBinding>()
const issuedOutcomes = new WeakMap<object, Readonly<{ stepFingerprint: string; outcomeFingerprint: string }>>()

function failedStep(step: ExecutionStep, failure: ExecutionFailureCode): StepExecution & { failure: ExecutionFailureCode } {
    return { id: step.id, exitCode: 1, signal: null, stdoutBytes: 0, stderrBytes: 0, failure }
}

interface InternalStepExecution extends ProbeStepExecution {
    failure?: ExecutionFailureCode
    stdout: Buffer
    stderr: Buffer
    receipt?: ExecutionReceipt
    resolvedStep?: ExecutionStep
}

function stepFingerprint(step: ExecutionStep): string {
    return createHash('sha256').update(JSON.stringify(step)).digest('hex')
}

function executionReceipt(stepId: string, fingerprint: string, consumedFingerprint: string, startedAt: string, finishedAt: string): ExecutionReceipt {
    const receipt = Object.freeze({
        stepId,
        startedAt,
        finishedAt,
        receiptMatches: (candidate: ExecutionStep): boolean => {
            const owned = snapshotExecutionStep(candidate)
            return owned !== undefined && stepFingerprint(owned) === fingerprint
        },
    })
    issuedReceipts.set(receipt, { stepFingerprint: fingerprint, consumedFingerprint })
    return receipt
}

export function executionReceiptMatches(receipt: ExecutionReceipt, step: ExecutionStep): boolean {
    return issuedReceipts.has(receipt) && receipt.receiptMatches(step)
}

async function checkFilesystem(check: FilesystemCheck): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        const stat = await lstat(check.path)
        if (stat.isSymbolicLink()) return false
        if (check.expected === 'absent') return false
        if (check.expected === 'directory') return stat.isDirectory()
        if (!stat.isFile()) return false
        if (check.sha256 === undefined) return true
        if (check.maxBytes === undefined || stat.size > check.maxBytes) return false
        handle = await open(check.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = await handle.stat()
        if (!opened.isFile() || opened.size > check.maxBytes || opened.dev !== stat.dev || opened.ino !== stat.ino) return false
        const hash = createHash('sha256')
        const chunk = Buffer.allocUnsafe(65_536)
        let total = 0
        while (true) {
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.byteLength, check.maxBytes - total + 1), null)
            if (bytesRead === 0) break
            total += bytesRead
            if (total > check.maxBytes) return false
            hash.update(chunk.subarray(0, bytesRead))
        }
        const after = await handle.stat()
        return total === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs
            && hash.digest('hex') === check.sha256
    } catch (error) {
        return check.expected === 'absent' && (error as NodeJS.ErrnoException).code === 'ENOENT'
    } finally {
        try { await handle?.close() } catch { /* A closed precondition descriptor carries no execution authority. */ }
    }
}

async function filesystemChecksPass(checks: readonly FilesystemCheck[]): Promise<boolean> {
    for (const check of checks) {
        if (!await checkFilesystem(check)) return false
    }
    return true
}

function filesystemIdentitiesPass(checks: readonly FilesystemCheck[]): boolean {
    try {
        return checks.every((check) => {
            if (check.identity === undefined) return true
            for (const ancestor of check.identity.ancestors) {
                const status = lstatSync(ancestor.path, { bigint: true })
                if (!status.isDirectory() || status.isSymbolicLink() || !sameFilesystemObject(status, ancestor)) return false
            }
            const status = lstatSync(check.path, { bigint: true })
            const typeMatches = check.expected === 'directory' ? status.isDirectory() : status.isFile()
            return typeMatches && !status.isSymbolicLink() && sameFilesystemObject(status, check.identity)
        })
    } catch {
        return false
    }
}

interface PreparedStep {
    readonly logical: ExecutionStep
    readonly argv: readonly [string, ...string[]]
    readonly consumedFingerprint: string
    readonly verifiedPathExecutables: readonly ConsumedFile[]
}

interface PreparedPlan {
    readonly directory: string | undefined
    readonly steps: ReadonlyMap<ExecutionStep, PreparedStep>
}
type PreparationResult = { readonly kind: 'prepared'; readonly plan: PreparedPlan }
    | { readonly kind: 'failure'; readonly reason: 'input-changed' | 'staging-failed' | 'cleanup-failed' }

const STAGING_PREFIX = 'cockpit-execution-'
const ownedStagingDirectories = new Set<string>()

// Data inputs are copied into a private snapshot so the process reads the bytes that were hashed.
// Executables run from their own path and are re-checked just before spawn instead.
async function stageVerifiedFile(file: ConsumedFile, snapshot: string): Promise<string | undefined> {
    let source: Awaited<ReturnType<typeof open>> | undefined
    let staged: Awaited<ReturnType<typeof open>> | undefined
    try {
        const before = await lstat(file.path)
        if (before.isSymbolicLink() || !before.isFile() || before.size > file.maxBytes) return undefined
        source = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = await source.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > file.maxBytes) return undefined
        staged = await open(snapshot, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        const hash = createHash('sha256')
        const chunk = Buffer.allocUnsafe(65_536)
        let total = 0
        while (true) {
            const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.byteLength, file.maxBytes - total + 1), null)
            if (bytesRead === 0) break
            total += bytesRead
            if (total > file.maxBytes) return undefined
            const bytes = chunk.subarray(0, bytesRead)
            hash.update(bytes)
            await staged.writeFile(bytes)
        }
        const after = await source.stat()
        if (total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return undefined
        const digest = hash.digest('hex')
        if (digest !== file.sha256) return undefined
        await staged.close()
        staged = undefined
        await chmod(snapshot, 0o400)
        return digest
    } catch {
        return undefined
    } finally {
        try { await staged?.close() } catch { /* The private incomplete file will be removed with its staging directory. */ }
        try { await source?.close() } catch { /* The descriptor is already outside the execution boundary. */ }
    }
}

async function consumedFileMatches(file: ConsumedFile): Promise<boolean> {
    let source: Awaited<ReturnType<typeof open>> | undefined
    try {
        const before = await lstat(file.path)
        if (before.isSymbolicLink() || !before.isFile() || before.size > file.maxBytes
            || (file.executable && (before.mode & 0o111) === 0)) return false
        source = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = await source.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > file.maxBytes
            || (file.executable && (opened.mode & 0o111) === 0)) return false
        const fingerprint = fileFingerprint(file.path, opened)
        if (verifiedDigest(fingerprint) === file.sha256) {
            const linked = await lstat(file.path)
            return fileFingerprint(file.path, linked) === fingerprint
        }
        const hash = createHash('sha256')
        const chunk = Buffer.allocUnsafe(Math.min(file.maxBytes + 1, 1_048_576))
        let total = 0
        while (true) {
            const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.byteLength, file.maxBytes - total + 1), null)
            if (bytesRead === 0) break
            total += bytesRead
            if (total > file.maxBytes) return false
            hash.update(chunk.subarray(0, bytesRead))
        }
        const after = await source.stat()
        const linked = await lstat(file.path)
        const matches = total === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs
            && linked.dev === opened.dev && linked.ino === opened.ino && linked.size === opened.size && linked.mtimeMs === opened.mtimeMs
            && (!file.executable || (linked.mode & 0o111) !== 0)
            && hash.digest('hex') === file.sha256
        if (matches && fileFingerprint(file.path, after) === fingerprint) recordVerifiedDigest(fingerprint, file.sha256)
        return matches
    } catch {
        return false
    } finally {
        try { await source?.close() } catch { /* Failure remains closed even when descriptor cleanup also fails. */ }
    }
}

async function removePreparedDirectory(directory: string): Promise<boolean> {
    if (dirname(directory) !== tmpdir() || !basename(directory).startsWith(STAGING_PREFIX)
        || !ownedStagingDirectories.has(directory)) return false
    try {
        await rm(directory, { recursive: true, force: true })
        ownedStagingDirectories.delete(directory)
        return true
    } catch {
        return false
    }
}

async function prepareExecutionPlan(plan: ExecutionPlan): Promise<PreparationResult> {
    let directory: string | undefined
    const prepared = new Map<ExecutionStep, PreparedStep>()
    let sequence = 0
    const prepare = async (step: ExecutionStep): Promise<boolean> => {
        if (prepared.has(step)) return true
        const argv = [...step.argv]
        const consumed: ConsumedFile[] = []
        const verifiedPathExecutables: ConsumedFile[] = []
        for (const file of step.consumedFiles) {
            if (file.executable) {
                verifiedPathExecutables.push(file)
                consumed.push(file)
                continue
            }
            if (directory === undefined) {
                directory = await mkdtemp(join(tmpdir(), STAGING_PREFIX))
                ownedStagingDirectories.add(directory)
            }
            const snapshot = join(directory, `${String(sequence).padStart(4, '0')}-${file.sha256}`)
            sequence += 1
            const digest = await stageVerifiedFile(file, snapshot)
            if (digest === undefined) return false
            for (const index of file.argvIndexes) argv[index] = snapshot
            consumed.push({ ...file, sha256: digest })
        }
        prepared.set(step, Object.freeze({
            logical: step,
            argv: Object.freeze(argv) as readonly [string, ...string[]],
            consumedFingerprint: createHash('sha256').update(JSON.stringify(consumed)).digest('hex'),
            verifiedPathExecutables: Object.freeze(verifiedPathExecutables),
        }))
        for (const compensation of step.compensation) if (!await prepare(compensation)) return false
        return true
    }
    let reason: 'input-changed' | 'staging-failed' = 'staging-failed'
    try {
        for (const step of plan.steps) if (!await prepare(step)) {
            reason = 'input-changed'
            throw new TypeError('consumed execution file changed')
        }
        return { kind: 'prepared', plan: { directory, steps: prepared } }
    } catch {
        if (directory !== undefined && !await removePreparedDirectory(directory)) return { kind: 'failure', reason: 'cleanup-failed' }
        return { kind: 'failure', reason }
    }
}

async function executeStep(prepared: PreparedStep, signal?: AbortSignal): Promise<InternalStepExecution> {
    const step = prepared.logical
    const beforeSpawnFailure = (failure: ExecutionFailureCode): InternalStepExecution => ({
        ...failedStep(step, failure), stdoutObservedBytes: 0, stderrObservedBytes: 0,
        stdoutRetainedBytes: 0, stderrRetainedBytes: 0,
        started: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), resolvedStep: step,
    })
    const fingerprint = stepFingerprint(step)
    const stepId = step.id
    const spawnExpired = (): boolean => step.spawnNotAfter !== undefined && Date.now() > Date.parse(step.spawnNotAfter)
    if (spawnExpired()) return beforeSpawnFailure(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED)
    if (signal?.aborted) return beforeSpawnFailure(ENVIRONMENT_CODES.EXECUTION_ABORTED)
    if (!await filesystemChecksPass(step.filesystemChecks)) {
        return beforeSpawnFailure(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED)
    }
    for (const executable of prepared.verifiedPathExecutables) {
        // Node cannot bind an opened descriptor to spawn. Same-UID replacement after this
        // final check remains outside the cooperative filesystem authority promised here.
        if (!await consumedFileMatches(executable)) return beforeSpawnFailure(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED)
    }
    if (signal?.aborted) return beforeSpawnFailure(ENVIRONMENT_CODES.EXECUTION_ABORTED)
    if (spawnExpired()) return beforeSpawnFailure(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED)

    // Node cannot bind an lstat result to a later removal syscall. This synchronous final
    // check closes cooperative replacement, not an adversarial same-UID lstat-to-spawn race.
    if (!filesystemIdentitiesPass(step.filesystemChecks)) {
        return beforeSpawnFailure(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED)
    }

    const [command, ...args] = prepared.argv
    let runningProcess: ReturnType<typeof spawn>
    let fenced: Awaited<ReturnType<typeof spawnFencedSupervisor>>
    try {
        fenced = step.executionFence ? await spawnFencedSupervisor(step, prepared.argv) : undefined
        if (step.executionFence && !fenced) return beforeSpawnFailure(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED)
        runningProcess = fenced?.child ?? spawn(command, args, {
                argv0: step.argv0,
                cwd: step.cwd,
                env: step.env,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true,
            })
    } catch {
        return beforeSpawnFailure(ENVIRONMENT_CODES.EXECUTION_SPAWN_FAILED)
    }
    const startedAt = new Date().toISOString()
    return await new Promise((resolveStep) => {
        let stdoutBytes = 0
        let stderrBytes = 0
        let stdoutRetainedBytes = 0
        let stderrRetainedBytes = 0
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let failure: ExecutionFailureCode | undefined
        let settled = false
        let terminationConfirmed = true
        let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined
        let killTimer: ReturnType<typeof setTimeout> | undefined
        let terminationPoll: ReturnType<typeof setTimeout> | undefined
        const result = (): InternalStepExecution => {
            const expired = fenced?.spawnExpired() === true
            const started = runningProcess.pid !== undefined && !expired
            const retainedStdout = Buffer.concat(stdout).subarray(0, step.stdoutLimitBytes)
            const retainedStderr = Buffer.concat(stderr).subarray(0, step.stderrLimitBytes)
            const processSignal = closed?.signal ?? null
            const processFailure = failure ?? (expired ? ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED : closed?.code === 0 && processSignal === null
                ? undefined : ENVIRONMENT_CODES.EXECUTION_STEP_FAILED)
            return {
                id: step.id,
                exitCode: processFailure === undefined ? (closed?.code ?? 0) : closed?.code && closed.code > 0 ? closed.code : 1,
                signal: processSignal,
                stdoutBytes: Math.min(stdoutBytes, step.stdoutLimitBytes),
                stderrBytes: Math.min(stderrBytes, step.stderrLimitBytes),
                stdoutObservedBytes: stdoutBytes,
                stderrObservedBytes: stderrBytes,
                stdoutRetainedBytes: retainedStdout.byteLength,
                stderrRetainedBytes: retainedStderr.byteLength,
                failure: processFailure,
                started,
                stdout: retainedStdout,
                stderr: retainedStderr,
                receipt: started && terminationConfirmed
                    ? executionReceipt(stepId, fingerprint, prepared.consumedFingerprint, startedAt, new Date().toISOString())
                    : undefined,
                resolvedStep: step,
            }
        }
        const settle = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (killTimer !== undefined) clearTimeout(killTimer)
            if (terminationPoll !== undefined) clearTimeout(terminationPoll)
            signal?.removeEventListener('abort', abort)
            resolveStep(result())
        }
        const terminate = (terminationSignal: NodeJS.Signals): void => {
            if (runningProcess.pid !== undefined) {
                try {
                    process.kill(-runningProcess.pid, terminationSignal)
                    return
                } catch {
                    // The child may have exited between observation and termination.
                }
            }
            try { runningProcess.kill(terminationSignal) } catch { /* The child may have exited before fallback termination. */ }
        }
        const processGroupGone = (): boolean => {
            if (closed === undefined) return false
            if (runningProcess.pid === undefined) return true
            try {
                process.kill(-runningProcess.pid, 0)
                return false
            } catch (error) {
                return (error as NodeJS.ErrnoException).code === 'ESRCH'
            }
        }
        let terminationDeadline = 0
        const confirmTermination = (): void => {
            if (settled || terminationConfirmed) return
            if (processGroupGone()) {
                terminationConfirmed = true
                settle()
                return
            }
            if (Date.now() >= terminationDeadline) {
                failure = ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED
                settle()
                return
            }
            terminationPoll = setTimeout(confirmTermination, 5)
        }
        const beginTermination = (): void => {
            if (!terminationConfirmed) return
            terminationConfirmed = false
            terminationDeadline = Date.now() + (step.executionFence ? FENCE_REPAIR_MS : TERMINATION_GRACE_MS)
            terminate('SIGTERM')
            if (!step.executionFence) {
                killTimer = setTimeout(() => {
                    terminate('SIGKILL')
                }, TERMINATION_KILL_MS)
            }
            confirmTermination()
        }
        const stop = (code: ExecutionFailureCode): void => {
            if (failure !== undefined) return
            failure = code
            beginTermination()
        }
        const timer = setTimeout(() => stop(ENVIRONMENT_CODES.EXECUTION_TIMEOUT), step.timeoutMs)
        const abort = (): void => stop(ENVIRONMENT_CODES.EXECUTION_ABORTED)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        // A tail-retaining step keeps running past its limit and keeps only the newest bytes, because a
        // long tool's verdict is its exit status and its final lines name the failure; memory stays bounded.
        const retainTail = (buffers: Buffer[], chunk: Buffer, limit: number): number => {
            buffers.push(chunk)
            const joined = Buffer.concat(buffers)
            const tail = joined.subarray(Math.max(0, joined.byteLength - limit))
            buffers.splice(0, buffers.length, tail)
            return tail.byteLength
        }
        runningProcess.stdout?.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length
            if (step.outputOverflow === 'retain-tail') {
                stdoutRetainedBytes = retainTail(stdout, chunk, step.stdoutLimitBytes)
                return
            }
            if (stdoutRetainedBytes < step.stdoutLimitBytes) {
                const retained = chunk.subarray(0, step.stdoutLimitBytes - stdoutRetainedBytes)
                stdout.push(retained)
                stdoutRetainedBytes += retained.byteLength
            }
            if (stdoutBytes > step.stdoutLimitBytes) stop(ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT)
        })
        runningProcess.stderr?.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length
            if (step.outputOverflow === 'retain-tail') {
                stderrRetainedBytes = retainTail(stderr, chunk, step.stderrLimitBytes)
                return
            }
            if (stderrRetainedBytes < step.stderrLimitBytes) {
                const retained = chunk.subarray(0, step.stderrLimitBytes - stderrRetainedBytes)
                stderr.push(retained)
                stderrRetainedBytes += retained.byteLength
            }
            if (stderrBytes > step.stderrLimitBytes) stop(ENVIRONMENT_CODES.EXECUTION_STDERR_LIMIT)
        })
        runningProcess.on('error', () => stop(ENVIRONMENT_CODES.EXECUTION_SPAWN_FAILED))
        runningProcess.on('close', (code, closeSignal) => {
            closed = { code, signal: closeSignal }
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
            if (failure === undefined && processGroupGone()) settle()
            else if (failure === undefined) beginTermination()
            else confirmTermination()
        })
    })
}

function invalidStepExecution(): InternalStepExecution {
    return {
        id: 'execution-input', exitCode: 1, signal: null, stdoutBytes: 0, stderrBytes: 0,
        stdoutObservedBytes: 0, stderrObservedBytes: 0, stdoutRetainedBytes: 0, stderrRetainedBytes: 0,
        failure: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED, started: false,
        stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
    }
}

export type ExecuteProbeOutcome =
    | { kind: 'complete'; execution: ProbeStepExecution; receipt: ExecutionReceipt; stdout: Buffer; stderr: Buffer }
    | { kind: 'refusal'; code: ExecutionFailureCode; execution: ProbeStepExecution; receipt?: ExecutionReceipt; stdout: Buffer; stderr: Buffer }

const FAILED_STEP_STDERR_BYTES = 2_048

// Only a step that declares `failureOutput` gets this: for a tool such as git clone, its last words
// are the only statement of the cause (an unreachable host, a missing repository).
function failedStepStderr(stderr: Buffer): string | undefined {
    const tail = new TextDecoder('utf-8').decode(stderr.subarray(Math.max(0, stderr.byteLength - FAILED_STEP_STDERR_BYTES)))
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/(\w+:\/\/)[^/@\s]+@/g, '$1[redacted]@').trim()
    return tail === '' ? undefined : redactSensitiveMessage(tail)
}

function immutablePlanOutcome(outcome: ExecutePlanOutcome): ExecutePlanOutcome {
    const diagnostics = Object.freeze(outcome.diagnostics.map((item) => Object.freeze({ ...item })))
    if (outcome.kind === 'complete') return Object.freeze({
        ...outcome, diagnostics,
        result: Object.freeze({ steps: Object.freeze(outcome.result.steps.map((step) => Object.freeze({ ...step }))) }),
    })
    return Object.freeze({
        ...outcome, diagnostics,
        execution: Object.freeze({
            completedStepIds: Object.freeze([...outcome.execution.completedStepIds]),
            failedStep: Object.freeze({ ...outcome.execution.failedStep }),
            compensation: Object.freeze({
                attemptedStepIds: Object.freeze([...outcome.execution.compensation.attemptedStepIds]),
                completedStepIds: Object.freeze([...outcome.execution.compensation.completedStepIds]),
                failed: Object.freeze(outcome.execution.compensation.failed.map((failure) => Object.freeze({ ...failure }))),
            }),
        }),
    })
}

function probeOutcomeFingerprint(outcome: ExecuteProbeOutcome, consumedFingerprint: string): string {
    const receipt = outcome.receipt
    return createHash('sha256').update(JSON.stringify({
        kind: outcome.kind,
        code: outcome.kind === 'refusal' ? outcome.code : null,
        execution: outcome.execution,
        receipt: receipt === undefined ? null : {
            stepId: receipt.stepId, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt,
        },
        stdoutSha256: createHash('sha256').update(outcome.stdout).digest('hex'),
        stderrSha256: createHash('sha256').update(outcome.stderr).digest('hex'),
        consumedFingerprint,
    })).digest('hex')
}

function immutableProbeOutput<Value extends object>(value: Value, stdout: Buffer, stderr: Buffer): Value & { stdout: Buffer; stderr: Buffer } {
    return Object.freeze(Object.defineProperties(value, {
        stdout: { enumerable: true, get: () => Buffer.from(stdout) },
        stderr: { enumerable: true, get: () => Buffer.from(stderr) },
    })) as Value & { stdout: Buffer; stderr: Buffer }
}

interface CapturedProbeOutcome { readonly outcome: ExecuteProbeOutcome; readonly sourceReceipt?: ExecutionReceipt }

function captureProbeOutcome(value: unknown): CapturedProbeOutcome | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
        const candidate = value as Partial<ExecuteProbeOutcome>
        const receiptPresent = Object.prototype.hasOwnProperty.call(value, 'receipt')
        const kind = candidate.kind
        const expectedKeys = kind === 'complete' || receiptPresent
            ? ['kind', 'execution', 'receipt', 'stdout', 'stderr']
            : ['kind', 'code', 'execution', 'stdout', 'stderr']
        if (kind === 'refusal' && receiptPresent) expectedKeys.splice(1, 0, 'code')
        const actualKeys = Object.keys(value).sort()
        expectedKeys.sort()
        if (actualKeys.length !== expectedKeys.length || !actualKeys.every((key, index) => key === expectedKeys[index])) return undefined
        const code = kind === 'refusal' ? candidate.code : undefined
        const execution = snapshotJson(candidate.execution)
        const receipt = candidate.receipt
        const stdout = candidate.stdout
        const stderr = candidate.stderr
        if ((kind !== 'complete' && kind !== 'refusal') || (kind === 'refusal' && !EXECUTION_FAILURE_CODES.includes(code as ExecutionFailureCode))
            || execution === undefined || execution === null || typeof execution !== 'object' || Array.isArray(execution)
            || !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) || stdout.byteLength > 16_777_216 || stderr.byteLength > 16_777_216) return undefined
        const executionKeys = Object.keys(execution).sort()
        const expectedExecutionKeys = ['id', 'exitCode', 'signal', 'stdoutBytes', 'stderrBytes', 'started', 'stdoutObservedBytes', 'stderrObservedBytes', 'stdoutRetainedBytes', 'stderrRetainedBytes'].sort()
        if (executionKeys.length !== expectedExecutionKeys.length || !executionKeys.every((key, index) => key === expectedExecutionKeys[index])) return undefined
        const observed = execution as unknown as ProbeStepExecution
        if (typeof observed.id !== 'string' || observed.id.length === 0 || observed.id.includes('\0')
            || !Number.isSafeInteger(observed.exitCode) || observed.exitCode < 0
            || (kind === 'complete' ? observed.exitCode !== 0 : observed.exitCode === 0)
            || (observed.signal !== null && (typeof observed.signal !== 'string' || !/^SIG[A-Z0-9]+$/.test(observed.signal)))
            || typeof observed.started !== 'boolean'
            || [observed.stdoutBytes, observed.stderrBytes, observed.stdoutObservedBytes, observed.stderrObservedBytes,
                observed.stdoutRetainedBytes, observed.stderrRetainedBytes].some((count) => !Number.isSafeInteger(count) || count < 0)
            || observed.stdoutRetainedBytes !== stdout.byteLength || observed.stderrRetainedBytes !== stderr.byteLength
            || observed.stdoutBytes > observed.stdoutObservedBytes || observed.stderrBytes > observed.stderrObservedBytes) return undefined
        let ownedReceipt: ExecutionReceipt | undefined
        if (receipt !== undefined) {
            if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) return undefined
            const receiptKeys = Object.keys(receipt).sort()
            const expectedReceiptKeys = ['stepId', 'startedAt', 'finishedAt', 'receiptMatches'].sort()
            const stepId = receipt.stepId
            const startedAt = receipt.startedAt
            const finishedAt = receipt.finishedAt
            const receiptMatches = receipt.receiptMatches
            if (receiptKeys.length !== expectedReceiptKeys.length || !receiptKeys.every((key, index) => key === expectedReceiptKeys[index])
                || typeof stepId !== 'string' || typeof startedAt !== 'string'
                || typeof finishedAt !== 'string' || typeof receiptMatches !== 'function') return undefined
            ownedReceipt = Object.freeze({ stepId, startedAt, finishedAt, receiptMatches })
        } else if (kind === 'complete') return undefined
        const ownedExecution = Object.freeze({
            id: observed.id, exitCode: observed.exitCode, signal: observed.signal,
            stdoutBytes: observed.stdoutBytes, stderrBytes: observed.stderrBytes, started: observed.started,
            stdoutObservedBytes: observed.stdoutObservedBytes, stderrObservedBytes: observed.stderrObservedBytes,
            stdoutRetainedBytes: observed.stdoutRetainedBytes, stderrRetainedBytes: observed.stderrRetainedBytes,
        })
        const owned = kind === 'complete'
            ? { kind, execution: ownedExecution, receipt: ownedReceipt as ExecutionReceipt, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) } as const
            : ownedReceipt === undefined
                ? { kind, code: code as ExecutionFailureCode, execution: ownedExecution, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) } as const
                : { kind, code: code as ExecutionFailureCode, execution: ownedExecution, receipt: ownedReceipt, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) } as const
        return { outcome: Object.freeze(owned), sourceReceipt: receipt }
    } catch {
        return undefined
    }
}

function issueProbeOutcome(outcome: ExecuteProbeOutcome, resolvedStep?: ExecutionStep): ExecuteProbeOutcome {
    const captured = captureProbeOutcome(outcome)
    if (captured === undefined || resolvedStep === undefined) return outcome
    const fingerprint = stepFingerprint(resolvedStep)
    const receiptBinding = captured.sourceReceipt === undefined ? undefined : issuedReceipts.get(captured.sourceReceipt)
    const consumedFingerprint = receiptBinding?.consumedFingerprint ?? fingerprint
    const outcomeFingerprint = probeOutcomeFingerprint(captured.outcome, consumedFingerprint)
    if (receiptBinding !== undefined) receiptBinding.outcomeFingerprint = outcomeFingerprint
    issuedOutcomes.set(outcome, Object.freeze({ stepFingerprint: fingerprint, outcomeFingerprint }))
    return outcome
}

export function authenticatedExecutionOutcome(outcome: unknown, step: ExecutionStep): ExecuteProbeOutcome | undefined {
    if (outcome === null || typeof outcome !== 'object') return undefined
    const issued = issuedOutcomes.get(outcome)
    const captured = captureProbeOutcome(outcome)
    const resolved = snapshotExecutionStep(step)
    if (issued === undefined || captured === undefined || resolved === undefined || issued.stepFingerprint !== stepFingerprint(resolved)) return undefined
    const receiptBinding = captured.sourceReceipt === undefined ? undefined : issuedReceipts.get(captured.sourceReceipt)
    if (captured.sourceReceipt !== undefined && (receiptBinding === undefined || receiptBinding.stepFingerprint !== issued.stepFingerprint)) return undefined
    const consumedFingerprint = receiptBinding?.consumedFingerprint ?? issued.stepFingerprint
    return issued.outcomeFingerprint === probeOutcomeFingerprint(captured.outcome, consumedFingerprint) ? captured.outcome : undefined
}

export function executionOutcomeMatches(outcome: ExecuteProbeOutcome, step: ExecutionStep): boolean {
    return authenticatedExecutionOutcome(outcome, step) !== undefined
}

function captureForegroundInput(input: ForegroundProcessInput): ForegroundProcessInput | undefined {
    try {
        const executable = input.executable
        const argv = input.argv
        const cwd = input.cwd
        const env = input.env
        if (executable === null || typeof executable !== 'object'
            || typeof executable.canonicalPath !== 'string' || typeof executable.invocationPath !== 'string'
            || typeof executable.sha256 !== 'string'
            || executable.executionMode !== 'verified-path'
            || !Array.isArray(argv) || argv.length > 4_096
            || argv.some(value => typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 65_536)
            || typeof cwd !== 'string' || !isAbsolute(cwd) || normalize(cwd) !== cwd || cwd.includes('\0')
            || env === null || typeof env !== 'object' || Array.isArray(env)
            || Object.getPrototypeOf(env) !== Object.prototype && Object.getPrototypeOf(env) !== null) return undefined
        const environment: Record<string, string> = {}
        let environmentBytes = 0
        const descriptors = Object.getOwnPropertyDescriptors(env)
        const keys = Reflect.ownKeys(env)
        if (keys.length > 4_096 || keys.some(key => typeof key !== 'string')) return undefined
        for (const key of keys as string[]) {
            const descriptor = descriptors[key]
            if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string'
                || key.length === 0 || key.includes('\0') || descriptor.value.includes('\0')) return undefined
            environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(descriptor.value)
            if (environmentBytes > 1_048_576) return undefined
            Object.defineProperty(environment, key, { enumerable: true, value: descriptor.value })
        }
        return Object.freeze({
            executable: Object.freeze({ ...executable }),
            argv: Object.freeze([...argv]),
            cwd,
            env: Object.freeze(environment),
        })
    } catch {
        return undefined
    }
}

/** Runs one operator/agent session process while retaining ownership of its whole process group. */
export async function executeForegroundProcess(
    input: ForegroundProcessInput,
    options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<ForegroundProcessOutcome> {
    const captured = captureForegroundInput(input)
    let signal: AbortSignal | undefined
    try {
        signal = options.signal
        if (signal !== undefined && Object.getPrototypeOf(signal) !== AbortSignal.prototype) throw new TypeError('invalid signal')
    } catch {
        return Object.freeze({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            exitCode: 1, signal: null, started: false, terminationConfirmed: true })
    }
    if (!captured || signal?.aborted) return Object.freeze({
        kind: 'refusal',
        code: signal?.aborted ? ENVIRONMENT_CODES.EXECUTION_ABORTED : ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        exitCode: 1, signal: null, started: false, terminationConfirmed: true,
    })
    const executable = captured.executable
    const consumed: ConsumedFile = {
        path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912,
        argvIndexes: Object.freeze([0]), executable: true, executionMode: 'verified-path',
    }
    if (!await consumedFileMatches(consumed)) return Object.freeze({
        kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        exitCode: 1, signal: null, started: false, terminationConfirmed: true,
    })
    try {
        if (await realpath(executable.invocationPath) !== executable.canonicalPath) throw new Error('identity changed')
    } catch {
        return Object.freeze({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            exitCode: 1, signal: null, started: false, terminationConfirmed: true })
    }

    let child: ReturnType<typeof spawn>
    try {
        child = spawn(executable.canonicalPath, captured.argv, {
            argv0: executable.invocationPath,
            cwd: captured.cwd,
            env: captured.env,
            stdio: 'inherit',
            detached: true,
        })
    } catch {
        return Object.freeze({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_SPAWN_FAILED,
            exitCode: 1, signal: null, started: false, terminationConfirmed: true })
    }

    return await new Promise(resolveProcess => {
        let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined
        let failure: ExecutionFailureCode | undefined
        let terminationStarted = false
        let settled = false
        let killTimer: ReturnType<typeof setTimeout> | undefined
        let pollTimer: ReturnType<typeof setTimeout> | undefined
        let deadline = 0
        const groupGone = (): boolean => {
            if (child.pid === undefined) return closed !== undefined
            try {
                process.kill(-child.pid, 0)
                return false
            } catch (error) {
                return (error as NodeJS.ErrnoException).code === 'ESRCH'
            }
        }
        const terminate = (terminationSignal: NodeJS.Signals): void => {
            if (child.pid === undefined) return
            try { process.kill(-child.pid, terminationSignal) } catch { /* Exit races are authenticated by groupGone. */ }
        }
        const finish = (terminationConfirmed: boolean): void => {
            if (settled) return
            settled = true
            if (killTimer !== undefined) clearTimeout(killTimer)
            if (pollTimer !== undefined) clearTimeout(pollTimer)
            signal?.removeEventListener('abort', abort)
            const processSignal = closed?.signal ?? null
            const exitCode = closed?.code ?? (failure === undefined ? 0 : 1)
            resolveProcess(failure === undefined
                ? Object.freeze({ kind: 'complete', exitCode, signal: processSignal, terminationConfirmed: true })
                : Object.freeze({ kind: 'refusal', code: failure, exitCode: exitCode === 0 ? 1 : exitCode,
                    signal: processSignal, started: child.pid !== undefined, terminationConfirmed }))
        }
        const confirmGone = (): void => {
            if (settled) return
            if (groupGone()) {
                finish(true)
                return
            }
            if (Date.now() >= deadline) {
                failure = ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED
                finish(false)
                return
            }
            pollTimer = setTimeout(confirmGone, 5)
        }
        const beginTermination = (): void => {
            if (terminationStarted) return
            terminationStarted = true
            deadline = Date.now() + TERMINATION_GRACE_MS
            terminate('SIGTERM')
            killTimer = setTimeout(() => terminate('SIGKILL'), TERMINATION_KILL_MS)
            confirmGone()
        }
        const abort = (): void => {
            if (failure === undefined) failure = ENVIRONMENT_CODES.EXECUTION_ABORTED
            beginTermination()
        }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        child.on('error', () => {
            failure = ENVIRONMENT_CODES.EXECUTION_SPAWN_FAILED
            beginTermination()
        })
        child.on('close', (code, closeSignal) => {
            closed = { code, signal: closeSignal }
            if (groupGone()) finish(true)
            else beginTermination()
        })
    })
}

export async function executeProbe(
    step: ExecutionStep,
    options: { signal?: AbortSignal } = {},
): Promise<ExecuteProbeOutcome> {
    let signal: AbortSignal | undefined
    let optionsReadable = true
    try {
        signal = options.signal
        if (signal !== undefined && Object.getPrototypeOf(signal) !== AbortSignal.prototype) optionsReadable = false
    } catch { optionsReadable = false }
    const resolved = optionsReadable ? snapshotExecutionStep(step) : undefined
    const preparation = resolved === undefined ? undefined : await prepareExecutionPlan({ steps: [resolved] })
    let observation: InternalStepExecution
    if (resolved === undefined || preparation === undefined || preparation.kind === 'failure') {
        observation = invalidStepExecution()
        if (preparation?.kind === 'failure' && preparation.reason !== 'input-changed') observation.failure = preparation.reason === 'cleanup-failed'
            ? ENVIRONMENT_CODES.EXECUTION_STAGING_CLEANUP_FAILED : ENVIRONMENT_CODES.EXECUTION_STAGING_FAILED
    }
    else {
        const prepared = preparation.plan
        const execution = prepared.steps.get(resolved)
        observation = execution === undefined ? invalidStepExecution() : await executeStep(execution, signal)
        if (observation.failure !== ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED
            && prepared.directory !== undefined && !await removePreparedDirectory(prepared.directory)) {
            observation.failure = ENVIRONMENT_CODES.EXECUTION_STAGING_CLEANUP_FAILED
        }
    }
    if (observation.failure !== undefined && observation.exitCode === 0) observation.exitCode = 1
    const { failure, stdout, stderr, receipt, resolvedStep: _resolvedStep, ...executionValue } = observation
    const execution = Object.freeze(executionValue)
    if (failure) return issueProbeOutcome(receipt === undefined
        ? immutableProbeOutput({ kind: 'refusal', code: failure, execution } as const, stdout, stderr)
        : immutableProbeOutput({ kind: 'refusal', code: failure, execution, receipt } as const, stdout, stderr), resolved)
    if (receipt === undefined) throw new TypeError('completed process is missing its execution receipt')
    return issueProbeOutcome(immutableProbeOutput({ kind: 'complete', execution, receipt } as const, stdout, stderr), resolved)
}

export async function executePlan(plan: ExecutionPlan, options: { signal?: AbortSignal } = {}): Promise<ExecutePlanOutcome> {
    let signal: AbortSignal | undefined
    let optionsReadable = true
    try {
        signal = options.signal
        if (signal !== undefined && Object.getPrototypeOf(signal) !== AbortSignal.prototype) optionsReadable = false
    } catch { optionsReadable = false }
    const resolvedPlan = optionsReadable ? snapshotExecutionPlan(plan) : undefined
    if (resolvedPlan === undefined) return immutablePlanOutcome({
        kind: 'refusal', status: 2, result: null,
        diagnostics: [{ severity: 'error', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED, message: 'execution plan is malformed', target: 'execution-input' }],
        execution: {
            completedStepIds: [], failedStep: { id: 'execution-input', started: false },
            compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] },
        },
    })
    const preparation = await prepareExecutionPlan(resolvedPlan)
    if (preparation.kind === 'failure') return immutablePlanOutcome({
        kind: 'refusal', status: 2, result: null,
        diagnostics: [{ severity: 'error', code: preparation.reason === 'input-changed' ? ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED : preparation.reason === 'cleanup-failed' ? ENVIRONMENT_CODES.EXECUTION_STAGING_CLEANUP_FAILED : ENVIRONMENT_CODES.EXECUTION_STAGING_FAILED, message: preparation.reason === 'input-changed' ? 'consumed execution input changed' : preparation.reason === 'cleanup-failed' ? 'execution staging cleanup failed' : 'execution staging failed', target: preparation.reason === 'input-changed' ? 'execution-input' : 'execution-staging' }],
        execution: {
            completedStepIds: [], failedStep: { id: preparation.reason === 'input-changed' ? 'execution-input' : 'execution-staging', started: false },
            compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] },
        },
    })
    const preparedPlan = preparation.plan
    let preserveStaging = false
    const runPreparedPlan = async (): Promise<ExecutePlanOutcome> => {
        const completed: StepExecution[] = []
        for (const step of resolvedPlan.steps) {
        const preparedStep = preparedPlan.steps.get(step)
        const observation = preparedStep === undefined ? invalidStepExecution() : await executeStep(preparedStep, signal)
        if (!observation.failure) {
            const {
                failure: _failure, started: _started, stdout: _stdout, stderr: _stderr, receipt: _receipt,
                stdoutObservedBytes: _stdoutObservedBytes, stderrObservedBytes: _stderrObservedBytes,
                stdoutRetainedBytes: _stdoutRetainedBytes, stderrRetainedBytes: _stderrRetainedBytes,
                resolvedStep: _resolvedStep,
                ...execution
            } = observation
            completed.push(execution)
            continue
        }
        const attempted: string[] = []
        const compensated: string[] = []
        const compensationFailures: CompensationFailure[] = []
        const compensationDiagnostics: EnvironmentDiagnostic[] = []
        if (observation.failure === ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED) preserveStaging = true
        const compensations = preserveStaging ? [] : observation.started ? observation.resolvedStep?.compensation ?? [] : []
        for (const compensation of compensations) {
            attempted.push(compensation.id)
            const preparedCompensation = preparedPlan.steps.get(compensation)
            const compensationObservation = preparedCompensation === undefined
                ? invalidStepExecution()
                : await executeStep(preparedCompensation)
            if (!compensationObservation.failure) {
                compensated.push(compensation.id)
                continue
            }
            compensationFailures.push({ id: compensation.id, code: compensationObservation.failure })
            if (compensationObservation.failure === ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED) preserveStaging = true
            compensationDiagnostics.push({
                severity: 'error',
                code: compensationObservation.failure === ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED
                    ? ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED
                    : compensationObservation.failure === ENVIRONMENT_CODES.EXECUTION_TIMEOUT
                    ? ENVIRONMENT_CODES.EXECUTION_COMPENSATION_TIMEOUT
                    : ENVIRONMENT_CODES.EXECUTION_COMPENSATION_STEP_FAILED,
                message: `compensation step ${compensation.id} failed (${compensationObservation.failure})`,
                target: compensation.id,
            })
            if (preserveStaging) break
        }
        const stderrTail = observation.resolvedStep?.failureOutput === 'stderr-tail' ? failedStepStderr(observation.stderr) : undefined
        return {
            kind: 'refusal', status: 2, result: null,
            diagnostics: [
                { severity: 'error', code: observation.failure,
                    message: `execution step ${observation.id} failed`,
                    target: observation.id },
                ...compensationDiagnostics,
            ],
            execution: {
                completedStepIds: completed.map(({ id }) => id),
                failedStep: { id: observation.id, started: observation.started, ...(stderrTail === undefined ? {} : { stderr: stderrTail }) },
                compensation: {
                    attemptedStepIds: attempted,
                    completedStepIds: compensated,
                    failed: compensationFailures,
                },
            },
        }
        }
        return { kind: 'complete', status: 0, diagnostics: [], result: { steps: completed } }
    }
    const outcome = await runPreparedPlan()
    if (preserveStaging) return immutablePlanOutcome(outcome)
    if (preparedPlan.directory === undefined || await removePreparedDirectory(preparedPlan.directory)) return immutablePlanOutcome(outcome)
    if (outcome.kind === 'refusal') return immutablePlanOutcome({
        ...outcome,
        diagnostics: [...outcome.diagnostics, { severity: 'error', code: ENVIRONMENT_CODES.EXECUTION_STAGING_CLEANUP_FAILED, message: 'execution staging cleanup failed', target: 'execution-staging' }],
    })
    return immutablePlanOutcome({
        kind: 'refusal', status: 2, result: null,
        diagnostics: [{ severity: 'error', code: ENVIRONMENT_CODES.EXECUTION_STAGING_CLEANUP_FAILED, message: 'execution staging cleanup failed', target: 'execution-staging' }],
        execution: {
            completedStepIds: outcome.result.steps.map(({ id }) => id),
            failedStep: { id: 'execution-staging', started: true },
            compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] },
        },
    })
}
