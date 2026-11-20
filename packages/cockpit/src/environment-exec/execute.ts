import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, lstatSync } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import {
    hasErrorCode,
    ENVIRONMENT_CODES,
    sameFilesystemObject,
    snapshotExecutionPlan,
    snapshotExecutionStep,
    type ConsumedFile,
    type ExecutionFailureCode,
    type ExecutionPlan,
    type ExecutionReceipt,
    type ExecutionStep,
    type FilesystemCheck,
    type EnvironmentDiagnostic,
} from '../environment/contract.js'
import { redactSensitiveMessage } from '../environment/sensitive.js'
import { fileFingerprint, recordVerifiedDigest, verifiedDigest } from './verified-digest.js'

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

interface StepExecution {
    id: string
    exitCode: number
    signal: NodeJS.Signals | null
    stdoutBytes: number
    stderrBytes: number
}

interface ProbeStepExecution extends StepExecution {
    started: boolean
    stdoutObservedBytes: number
    stderrObservedBytes: number
    stdoutRetainedBytes: number
    stderrRetainedBytes: number
}

interface CompensationFailure {
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

// A process group gets SIGKILL this long after SIGTERM, then this long to be gone. The grace is counted from SIGKILL:
// counted from SIGTERM, an event loop a loaded machine held past it gave up before SIGKILL went out, leaving the group alive.
const TERMINATION_KILL_MS = 50
const TERMINATION_GRACE_MS = 100
// The step each outcome came from, so a caller can prove its result came from this executor for that step.
const issuedOutcomes = new WeakMap<object, string>()

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

function executionReceipt(stepId: string, fingerprint: string, startedAt: string, finishedAt: string): ExecutionReceipt {
    return {
        stepId,
        startedAt,
        finishedAt,
        receiptMatches: (candidate: ExecutionStep): boolean => {
            const owned = snapshotExecutionStep(candidate)
            return owned !== undefined && stepFingerprint(owned) === fingerprint
        },
    }
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
        return check.expected === 'absent' && hasErrorCode(error, 'ENOENT')
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
        // Any lstat failure means the checked path no longer matches its recorded identity; false reports the change.
        return false
    }
}

interface PreparedStep {
    readonly logical: ExecutionStep
    readonly argv: readonly [string, ...string[]]
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
        // Staging failures surface as the staging-failed outcome; the outcome carries a code, not a cause.
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
        // Any read or stat failure means the file does not match its pinned digest; false reports the mismatch.
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
        // A directory that cannot be removed is reported as the cleanup-failed outcome.
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
        const verifiedPathExecutables: ConsumedFile[] = []
        for (const file of step.consumedFiles) {
            if (file.executable) {
                verifiedPathExecutables.push(file)
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
        }
        prepared.set(step, {
            logical: step,
            argv: argv as [string, ...string[]],
            verifiedPathExecutables,
        })
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
        // Both the changed-input marker and fs failures surface through the typed failure reason chosen above.
        if (directory !== undefined && !await removePreparedDirectory(directory)) return { kind: 'failure', reason: 'cleanup-failed' }
        return { kind: 'failure', reason }
    }
}

// Each step runs detached in its own process group, which the end of this process leaves running. A
// caller that must stop by a deadline, whatever owner it is waiting on (the guard, before its harness
// gives up on the hook), scopes its work to a signal: every step that work starts, at any depth, ends
// with it and none starts after. Compensation is not scoped; it undoes what already ran.
const executionScope = new AsyncLocalStorage<AbortSignal>()

export function withExecutionSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return executionScope.run(signal, work)
}

/**
 * `work`'s answer, or `expired`'s once `deadline` (a time on the performance clock, which starts with
 * this process) passes first; then every step the work started ends and none starts after.
 */
export async function runUntilDeadline<T>(deadline: number, work: () => Promise<T>, expired: () => T): Promise<T> {
    const stop = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<T>(resolve => { timer = setTimeout(() => { stop.abort(); resolve(expired()) }, Math.max(0, deadline - performance.now())) })
    try { return await Promise.race([withExecutionSignal(stop.signal, work), late]) }
    finally { clearTimeout(timer) }
}

function scopedSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
    const scoped = executionScope.getStore()
    return scoped && signal ? AbortSignal.any([scoped, signal]) : scoped ?? signal
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
    try {
        runningProcess = spawn(command, args, {
                argv0: step.argv0,
                cwd: step.cwd,
                env: step.env,
                stdio: [step.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
                detached: true,
            })
    } catch {
        // The outcome carries the spawn-failed code; spawn errors echo argv and environment details.
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
            const started = runningProcess.pid !== undefined
            const retainedStdout = retainedOutput(stdout, step.stdoutLimitBytes)
            const retainedStderr = retainedOutput(stderr, step.stderrLimitBytes)
            const processSignal = closed?.signal ?? null
            const processFailure = failure ?? (closed?.code === 0 && processSignal === null
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
                    ? executionReceipt(stepId, fingerprint, startedAt, new Date().toISOString())
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
                return hasErrorCode(error, 'ESRCH')
            }
        }
        let terminationDeadline = Infinity
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
            terminate('SIGTERM')
            killTimer = setTimeout(() => {
                terminate('SIGKILL')
                terminationDeadline = Date.now() + TERMINATION_GRACE_MS
            }, TERMINATION_KILL_MS)
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
        // A long follow delivers many small chunks, so each one only appends and drops whole chunks that
        // the rest already covers; the single copy and cut happen when the outcome is built.
        const retainTail = (buffers: Buffer[], chunk: Buffer, retained: number, limit: number): number => {
            buffers.push(chunk)
            let total = retained + chunk.byteLength
            while (buffers.length > 1 && total - buffers[0]!.byteLength >= limit) total -= buffers.shift()!.byteLength
            return total
        }
        // The cut can land inside a UTF-8 character; its leftover continuation bytes decode to U+FFFD
        // or fail a strict decoder, and they carry nothing, so the tail starts at the next character.
        const retainedOutput = (buffers: Buffer[], limit: number): Buffer => {
            const joined = Buffer.concat(buffers)
            if (step.outputOverflow !== 'retain-tail') return joined.subarray(0, limit)
            let start = Math.max(0, joined.byteLength - limit)
            for (let skipped = 0; start > 0 && skipped < 3 && start < joined.byteLength && (joined[start]! & 0xc0) === 0x80; skipped += 1) start += 1
            return joined.subarray(start)
        }
        runningProcess.stdout?.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length
            if (step.outputOverflow === 'retain-tail') {
                stdoutRetainedBytes = retainTail(stdout, chunk, stdoutRetainedBytes, step.stdoutLimitBytes)
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
                stderrRetainedBytes = retainTail(stderr, chunk, stderrRetainedBytes, step.stderrLimitBytes)
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
        if (step.stdin !== undefined) {
            // A process that exits before reading its input closes the pipe (EPIPE); its exit status is
            // still its answer. Any other write failure means the input never arrived.
            runningProcess.stdin?.on('error', error => { if (!hasErrorCode(error, 'EPIPE')) stop(ENVIRONMENT_CODES.EXECUTION_STEP_FAILED) })
            runningProcess.stdin?.end(step.stdin)
        }
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

const FAILED_STEP_STDERR_CHARACTERS = 2_048

// A failed step's last words, bounded and redacted: for a tool such as git clone they are the only
// statement of the cause (an unreachable host, a missing repository). A plan's failed step carries
// them only when it declares `failureOutput`.
export function failedStepStderr(stderr: Buffer): string | undefined {
    // Redact before cutting, so a cut inside a URL cannot leave its credentials behind the cut, and
    // drop a partial first line.
    const text = new TextDecoder('utf-8').decode(stderr)
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/(\w+:\/\/)[^/@\s]+@/g, '$1[redacted]@')
    const cut = text.slice(-FAILED_STEP_STDERR_CHARACTERS)
    const tail = (cut.length < text.length ? cut.slice(cut.indexOf('\n') + 1) : cut).trim().replace(/\s*\n\s*/g, ' ')
    return tail === '' ? undefined : redactSensitiveMessage(tail)
}

function immutablePlanOutcome(outcome: ExecutePlanOutcome): ExecutePlanOutcome {
    const diagnostics = outcome.diagnostics.map((item) => ({ ...item }))
    if (outcome.kind === 'complete') return {
        ...outcome, diagnostics,
        result: { steps: outcome.result.steps.map((step) => ({ ...step })) },
    }
    return {
        ...outcome, diagnostics,
        execution: {
            completedStepIds: [...outcome.execution.completedStepIds],
            failedStep: { ...outcome.execution.failedStep },
            compensation: {
                attemptedStepIds: [...outcome.execution.compensation.attemptedStepIds],
                completedStepIds: [...outcome.execution.compensation.completedStepIds],
                failed: outcome.execution.compensation.failed.map((failure) => ({ ...failure })),
            },
        },
    }
}

function immutableProbeOutput<Value extends object>(value: Value, stdout: Buffer, stderr: Buffer): Value & { stdout: Buffer; stderr: Buffer } {
    return Object.defineProperties(value, {
        stdout: { enumerable: true, get: () => Buffer.from(stdout) },
        stderr: { enumerable: true, get: () => Buffer.from(stderr) },
    }) as Value & { stdout: Buffer; stderr: Buffer }
}

function issueProbeOutcome(outcome: ExecuteProbeOutcome, resolvedStep: ExecutionStep | undefined): ExecuteProbeOutcome {
    if (resolvedStep !== undefined) issuedOutcomes.set(outcome, stepFingerprint(resolvedStep))
    return outcome
}

/** The outcome when this executor produced it for exactly `step`; undefined for any other value. */
export function authenticatedExecutionOutcome(outcome: unknown, step: ExecutionStep): ExecuteProbeOutcome | undefined {
    if (outcome === null || typeof outcome !== 'object') return undefined
    const resolved = snapshotExecutionStep(step)
    return resolved !== undefined && issuedOutcomes.get(outcome) === stepFingerprint(resolved) ? outcome as ExecuteProbeOutcome : undefined
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
        return {
            executable: { ...executable },
            argv: [...argv],
            cwd,
            env: environment,
        }
    } catch {
        // A throwing accessor or proxy trap means the step is malformed; the caller refuses it.
        return undefined
    }
}

/** Runs one operator/agent session process while retaining ownership of its whole process group. */
/** Whether a foreground process inherits a terminal on both stdin and stdout, so it may ask for one of its own. */
export function foregroundTerminal(): boolean {
    return process.stdin.isTTY === true && process.stdout.isTTY === true
}

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
        // A throwing accessor or proxy trap on the options means they are malformed, which is refused.
        return { kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            exitCode: 1, signal: null, started: false, terminationConfirmed: true }
    }
    if (!captured || signal?.aborted) return {
        kind: 'refusal',
        code: signal?.aborted ? ENVIRONMENT_CODES.EXECUTION_ABORTED : ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        exitCode: 1, signal: null, started: false, terminationConfirmed: true,
    }
    const executable = captured.executable
    const consumed: ConsumedFile = {
        path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912,
        argvIndexes: [0], executable: true, executionMode: 'verified-path',
    }
    if (!await consumedFileMatches(consumed)) return {
        kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        exitCode: 1, signal: null, started: false, terminationConfirmed: true,
    }
    try {
        if (await realpath(executable.invocationPath) !== executable.canonicalPath) throw new Error('identity changed')
    } catch {
        // A changed or unresolvable executable path is reported by the precondition-changed refusal.
        return { kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            exitCode: 1, signal: null, started: false, terminationConfirmed: true }
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
        // The refusal carries the spawn-failed code; spawn errors echo argv and environment details.
        return { kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_SPAWN_FAILED,
            exitCode: 1, signal: null, started: false, terminationConfirmed: true }
    }

    return await new Promise(resolveProcess => {
        let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined
        let failure: ExecutionFailureCode | undefined
        let terminationStarted = false
        let settled = false
        let killTimer: ReturnType<typeof setTimeout> | undefined
        let pollTimer: ReturnType<typeof setTimeout> | undefined
        let deadline = Infinity
        const groupGone = (): boolean => {
            if (child.pid === undefined) return closed !== undefined
            try {
                process.kill(-child.pid, 0)
                return false
            } catch (error) {
                return hasErrorCode(error, 'ESRCH')
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
                ? { kind: 'complete', exitCode, signal: processSignal, terminationConfirmed: true }
                : { kind: 'refusal', code: failure, exitCode: exitCode === 0 ? 1 : exitCode,
                    signal: processSignal, started: child.pid !== undefined, terminationConfirmed })
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
            terminate('SIGTERM')
            killTimer = setTimeout(() => {
                terminate('SIGKILL')
                deadline = Date.now() + TERMINATION_GRACE_MS
            }, TERMINATION_KILL_MS)
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
    } catch { /* A throwing accessor or proxy trap on the options means they are malformed, which is refused below. */ optionsReadable = false }
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
        observation = execution === undefined ? invalidStepExecution() : await executeStep(execution, scopedSignal(signal))
        if (observation.failure !== ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED
            && prepared.directory !== undefined && !await removePreparedDirectory(prepared.directory)) {
            observation.failure = ENVIRONMENT_CODES.EXECUTION_STAGING_CLEANUP_FAILED
        }
    }
    if (observation.failure !== undefined && observation.exitCode === 0) observation.exitCode = 1
    const { failure, stdout, stderr, receipt, resolvedStep: _resolvedStep, ...executionValue } = observation
    const execution = executionValue
    if (failure) return issueProbeOutcome(receipt === undefined
        ? immutableProbeOutput({ kind: 'refusal', code: failure, execution } as const, stdout, stderr)
        : immutableProbeOutput({ kind: 'refusal', code: failure, execution, receipt } as const, stdout, stderr), resolved)
    if (receipt === undefined) throw new TypeError('completed process is missing its execution receipt')
    return issueProbeOutcome(immutableProbeOutput({ kind: 'complete', execution, receipt } as const, stdout, stderr), resolved)
}

const PREPARATION_REFUSALS = {
    'input-changed': { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED, message: 'consumed execution input changed', target: 'execution-input' },
    'cleanup-failed': { code: ENVIRONMENT_CODES.EXECUTION_STAGING_CLEANUP_FAILED, message: 'execution staging cleanup failed', target: 'execution-staging' },
    'staging-failed': { code: ENVIRONMENT_CODES.EXECUTION_STAGING_FAILED, message: 'execution staging failed', target: 'execution-staging' },
} as const satisfies Record<Extract<PreparationResult, { kind: 'failure' }>['reason'], { code: string; message: string; target: string }>

export async function executePlan(plan: ExecutionPlan, options: { signal?: AbortSignal } = {}): Promise<ExecutePlanOutcome> {
    let signal: AbortSignal | undefined
    let optionsReadable = true
    try {
        signal = options.signal
        if (signal !== undefined && Object.getPrototypeOf(signal) !== AbortSignal.prototype) optionsReadable = false
    } catch { /* A throwing accessor or proxy trap on the options means they are malformed, which is refused below. */ optionsReadable = false }
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
    if (preparation.kind === 'failure') {
        const { code, message, target } = PREPARATION_REFUSALS[preparation.reason]
        return immutablePlanOutcome({
            kind: 'refusal', status: 2, result: null,
            diagnostics: [{ severity: 'error', code, message, target }],
            execution: {
                completedStepIds: [], failedStep: { id: target, started: false },
                compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] },
            },
        })
    }
    const preparedPlan = preparation.plan
    let preserveStaging = false
    const runPreparedPlan = async (): Promise<ExecutePlanOutcome> => {
        const completed: StepExecution[] = []
        for (const step of resolvedPlan.steps) {
        const preparedStep = preparedPlan.steps.get(step)
        const observation = preparedStep === undefined ? invalidStepExecution() : await executeStep(preparedStep, scopedSignal(signal))
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
