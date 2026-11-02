import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { isProxy } from 'node:util/types'
import { fileURLToPath } from 'node:url'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { authenticatedExecutionOutcome } from '../environment-exec/execute.js'
import {
    ENVIRONMENT_CODES,
    isCanonicalTimestamp,
    snapshotEnvironmentObservation,
    snapshotExecutionStep,
    snapshotJson,
    type CheckoutId,
    type ExecutionFailureCode,
    type ExecutionStep,
    type HolderId,
    errorCause,
    type EnvironmentObservation,
    type StackId,
} from './contract.js'
import { resolvedExecutable, type ResolvedExecutable } from './executable.js'
import { snapshotStateNamespace, type StateNamespace } from './state.js'
import {
    admitDependencyExecution,
    admitDependencyLoad,
    createDependencyExecutionPlan,
    createDependencyLoadPlan,
    type DependencyRuntimeBinding,
    type DependencyExecutionPlan,
} from './dependency-runtime.js'

export const mechanism = {
    id: 'dependency-install-policy',
    module: 'packages/cockpit/src/environment/installs.ts',
    exports: ['deriveCacheKey', 'resolveInstallExecutables', 'planInstall', 'verifyInstall', 'projectInstallProgress', 'observeDependencyInstall', 'observeDependencyLoad', 'isInstallObservation', 'observationDeclarations'],
} as const

export const observationDeclarations = Object.freeze([
    { id: 'dependency-install', owner: mechanism.id, postures: ['dependencies'], stages: [{ stage: 'bootstrap', disposition: 'not-applicable', reason: 'dependency state is created after the first seed' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.INSTALL_STATE_UNHEALTHY, isIssued: isInstallObservation, issuedAt: observationIssuedAt },
] as const)

const issuedObservations = new WeakMap<object, number>()
type InstallPolicyIdentity = Readonly<{
    volume: string
    lockfile: string
    install: readonly [string, ...string[]]
    load_probe: readonly [string, ...string[]]
}>
type InstallObservationIdentity = Readonly<{
    checkoutId: CheckoutId
    lockfilePath: string
    stackId: StackId
    configSha256: string
    generation: string
    target: string
    policy: InstallPolicyIdentity
}>
const issuedInstallObservationIdentities = new WeakMap<object, InstallObservationIdentity>()
const issuedProgress = new WeakMap<object, Readonly<{
    applied: readonly string[]
    notApplied: readonly string[]
    attempted?: readonly string[]
}>>()

export function projectInstallProgress(value: unknown): Readonly<{
    applied: readonly string[]
    notApplied: readonly string[]
    attempted?: readonly string[]
}> | undefined {
    return value !== null && typeof value === 'object' ? issuedProgress.get(value) : undefined
}

function issueObservation(value: EnvironmentObservation, identity?: InstallObservationIdentity): EnvironmentObservation {
    const snapshot = snapshotEnvironmentObservation(value)
    if (!snapshot || snapshot.owner !== mechanism.id) throw new TypeError('install observation is malformed')
    issuedObservations.set(snapshot, Date.now())
    if (identity) issuedInstallObservationIdentities.set(snapshot, identity)
    return snapshot
}

function captureInstallObservationExpectation(value: unknown): InstallObservationIdentity | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return undefined
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = ['checkoutId', 'configSha256', 'generation', 'lockfilePath', 'policy', 'stackId', 'target']
    if (Object.keys(descriptors).sort().join('\0') !== keys.join('\0')
        || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) return undefined
    const checkoutId = descriptors.checkoutId?.value
    const configSha256 = descriptors.configSha256?.value
    const generation = descriptors.generation?.value
    const lockfilePath = descriptors.lockfilePath?.value
    const policySnapshot = snapshotJson(descriptors.policy?.value)
    const stackId = descriptors.stackId?.value
    const target = descriptors.target?.value
    if (!policySnapshot || typeof policySnapshot !== 'object' || Array.isArray(policySnapshot)
        || !exactKeys(policySnapshot, ['volume', 'lockfile', 'install', 'load_probe'])) return undefined
    const policy = policySnapshot as unknown as InstallPolicyIdentity
    const validArgv = (value: unknown): value is readonly [string, ...string[]] => Array.isArray(value)
        && value.length > 0 && value.length <= 1_024 && Object.keys(value).length === value.length
        && value.every((entry) => typeof entry === 'string' && entry.length > 0
            && Buffer.byteLength(entry) <= 65_536 && !entry.includes('\0'))
    if (typeof checkoutId !== 'string' || !CHECKOUT_ID.test(checkoutId)
        || typeof configSha256 !== 'string' || !SHA256.test(configSha256)
        || typeof generation !== 'string' || !SHA256.test(generation)
        || typeof lockfilePath !== 'string' || !isAbsolute(lockfilePath) || normalize(lockfilePath) !== lockfilePath
        || typeof stackId !== 'string' || !/^stack:[a-f0-9]{64}$/.test(stackId)
        || typeof target !== 'string' || target.length === 0 || Buffer.byteLength(target) > 65_536 || target.includes('\0')
        || typeof policy.volume !== 'string' || !VOLUME.test(policy.volume)
        || typeof policy.lockfile !== 'string' || policy.lockfile.length === 0 || isAbsolute(policy.lockfile)
        || normalize(policy.lockfile) !== policy.lockfile || policy.lockfile.includes('\0')
        || !validArgv(policy.install) || !validArgv(policy.load_probe)) return undefined
    return Object.freeze({
        checkoutId: checkoutId as CheckoutId, configSha256, generation, lockfilePath,
        policy: Object.freeze({
            volume: policy.volume,
            lockfile: policy.lockfile,
            install: Object.freeze([...policy.install]) as readonly [string, ...string[]],
            load_probe: Object.freeze([...policy.load_probe]) as readonly [string, ...string[]],
        }),
        stackId: stackId as StackId,
        target,
    })
}

export function isInstallObservation(value: unknown, expected?: Readonly<{
    checkoutId: CheckoutId
    lockfilePath: string
    stackId: StackId
    configSha256: string
    generation: string
    target: string
    policy: Readonly<{
        volume: string
        lockfile: string
        install: readonly [string, ...string[]]
        load_probe: readonly [string, ...string[]]
    }>
}>): value is import('./contract.js').EnvironmentObservation {
    if (value === null || typeof value !== 'object' || !issuedObservations.has(value)) return false
    if (expected === undefined) return true
    const captured = captureInstallObservationExpectation(expected)
    const actual = issuedInstallObservationIdentities.get(value)
    return captured !== undefined && actual !== undefined
        && actual.checkoutId === captured.checkoutId
        && actual.lockfilePath === captured.lockfilePath
        && actual.stackId === captured.stackId
        && actual.configSha256 === captured.configSha256
        && actual.generation === captured.generation
        && actual.target === captured.target
        && JSON.stringify(actual.policy) === JSON.stringify(captured.policy)
}

function observationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedObservations.get(value) : undefined
}

const CHECKOUT_ID = /^checkout:[a-f0-9]{64}$/
const HOLDER_ID = /^holder:[a-f0-9]{64}:session$/
const SHA256 = /^[a-f0-9]{64}$/
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VOLUME = /^[a-z0-9][a-z0-9_.-]*$/
const PHYSICAL_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const STAMP_NAME = '.cockpit-install.json'
const LOCK_FORMAT = 'cockpit-install-lock/v1'
const FILE_LIMIT = 536_870_912
const planBrand: unique symbol = Symbol('dependency-install-plan')

export interface CacheIdentity {
    readonly checkoutId: CheckoutId
    readonly lockfileSha256: string
    readonly cacheId: string
}

export interface InstallExecutionSettings {
    readonly env: Readonly<Record<string, string>>
    readonly installTimeoutMs: number
    readonly probeTimeoutMs: number
    readonly helperTimeoutMs: number
    readonly stdoutLimitBytes: number
    readonly stderrLimitBytes: number
}

export type HolderState = 'live' | 'dead' | 'unknown'

export interface PlanInstallInput {
    readonly checkoutId: CheckoutId
    readonly holderId: HolderId
    readonly pid: number
    readonly checkoutRoot: string
    readonly lockfilePath: string
    readonly state: StateNamespace
    readonly runtime: DependencyRuntimeBinding
    readonly policy: {
        readonly volume: string
        readonly lockfile: string
        readonly install: readonly [string, ...string[]]
        readonly load_probe: readonly [string, ...string[]]
    }
    readonly executables: {
        readonly node: ResolvedExecutable
        readonly helper: { readonly path: string; readonly sha256: string }
    }
    readonly execution: InstallExecutionSettings
    readonly observeHolder?: (holder: { holderId: HolderId; pid: number }) => Promise<HolderState>
}

interface InstallLock {
    readonly path: string
    readonly dev: number
    readonly ino: number
    readonly ownerBytes: Buffer
    readonly quarantine: string
}

export interface PlannedInstall {
    readonly [planBrand]: true
    readonly kind: 'complete'
    readonly disposition: 'install' | 'reuse'
    readonly identity: CacheIdentity
    readonly policyFingerprint: string
    readonly stampPath: string
    readonly lockfilePath: string
    readonly lockfileBytes: Buffer
    readonly lock: InstallLock | null
    readonly installStep: ExecutionStep | null
    readonly loadProbeStep: ExecutionStep
}

export interface InstallRefusal {
    readonly kind: 'refusal'
    readonly code: ExecutionFailureCode
        | typeof ENVIRONMENT_CODES.INSTALL_LOCK_HELD
        | typeof ENVIRONMENT_CODES.INSTALL_LOCK_INVALID
        | typeof ENVIRONMENT_CODES.INSTALL_STALE_PATH
        | typeof ENVIRONMENT_CODES.INSTALL_LOAD_PROBE_FAILED
        | typeof ENVIRONMENT_CODES.INSTALL_LOCKFILE_CHANGED
    readonly message: string
    readonly target: string
    readonly recovery?: string
}

export type PlanInstallResult = PlannedInstall | InstallRefusal
export type VerifyInstallResult = { readonly kind: 'complete'; readonly identity: CacheIdentity; readonly disposition: 'installed' | 'reused' } | InstallRefusal
export interface ExecutionOptions { readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome> }

interface Authority {
    readonly lockfile: { readonly bytes: Buffer; readonly dev: number; readonly ino: number; readonly mode: number }
    readonly stateRoot: string
    readonly helper: { readonly path: string; readonly sha256: string }
    readonly node: ResolvedExecutable
    readonly settings: InstallExecutionSettings
    readonly stampBytes: Buffer
    readonly compatibility: Extract<DependencyExecutionPlan, { kind: 'complete' }>['compatibility']
    readonly policy: InstallPolicyIdentity
    readonly lock: InstallLock | null
}

const issuedPlans = new WeakMap<PlannedInstall, Authority>()
const consumedPlans = new WeakSet<PlannedInstall>()

export function deriveCacheKey(input: {
    readonly checkoutId: CheckoutId
    readonly lockfileBytes: Uint8Array
    readonly physicalVolume: string
}): CacheIdentity {
    if (!CHECKOUT_ID.test(input.checkoutId)) throw new TypeError('checkout id is not canonical')
    if (!PHYSICAL_VOLUME.test(input.physicalVolume)) throw new TypeError('physical volume is not canonical')
    const lockfileSha256 = createHash('sha256').update(input.lockfileBytes).digest('hex')
    const cacheId = createHash('sha256')
        .update(input.checkoutId).update('\0')
        .update(lockfileSha256).update('\0')
        .update(input.physicalVolume)
        .digest('hex')
    return Object.freeze({ checkoutId: input.checkoutId, lockfileSha256, cacheId })
}

function refuse(code: InstallRefusal['code'], message: string, target: string, recovery?: string): InstallRefusal {
    return Object.freeze({ kind: 'refusal', code, message, target, ...(recovery ? { recovery } : {}) })
}

function confined(root: string, candidate: string): boolean {
    if (!isAbsolute(root) || !isAbsolute(candidate) || normalize(root) !== root || normalize(candidate) !== candidate) return false
    const relation = relative(root, candidate)
    return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

async function stableFileSnapshot(path: string, limit = FILE_LIMIT): Promise<{ bytes: Buffer; dev: number; ino: number; mode: number } | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        const before = await lstat(path)
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) return undefined
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const opened = await handle.stat()
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > limit) return undefined
        const chunks: Buffer[] = []
        const buffer = Buffer.allocUnsafe(65_536)
        let total = 0
        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - total + 1), null)
            if (bytesRead === 0) break
            total += bytesRead
            if (total > limit) return undefined
            chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
        }
        const after = await handle.stat()
        const named = await lstat(path)
        return after.dev === opened.dev && after.ino === opened.ino && named.dev === opened.dev && named.ino === opened.ino
            && after.size === opened.size && named.size === opened.size && total === opened.size
            ? { bytes: Buffer.concat(chunks), dev: opened.dev, ino: opened.ino, mode: opened.mode } : undefined
    } catch { /* Any read failure means the file is not provably stable; callers refuse with their own message. */ return undefined } finally { try { await handle?.close() } catch { /* The refusal carries no descriptor authority. */ } }
}

async function stableFile(path: string, limit = FILE_LIMIT): Promise<Buffer | undefined> {
    return (await stableFileSnapshot(path, limit))?.bytes
}

export async function resolveInstallExecutables(node: ResolvedExecutable): Promise<
    { readonly kind: 'complete'; readonly executables: PlanInstallInput['executables'] } | InstallRefusal
> {
    const captured = resolvedExecutable(snapshotJson(node))
    if (!captured) return refuse(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        'resolveInstallExecutables requires a captured Node executable identity', 'node')
    let currentNode: string
    try { currentNode = await realpath(process.execPath) }
    catch (error) { return refuse(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        `resolveInstallExecutables cannot resolve the running Node executable: ${errorCause(error)}`, 'node') }
    const bytes = captured.canonicalPath === currentNode ? await stableFile(currentNode) : undefined
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== captured.sha256) {
        return refuse(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            'resolveInstallExecutables Node identity differs from the running executable', captured.canonicalPath)
    }
    const path = fileURLToPath(new URL('../../libexec/install-filesystem.cjs', import.meta.url))
    const helper = await stableFile(path, 1_048_576)
    if (!helper) return refuse(ENVIRONMENT_CODES.INSTALL_STALE_PATH,
        'resolveInstallExecutables installed filesystem helper is missing or unsafe', path)
    return Object.freeze({ kind: 'complete', executables: Object.freeze({ node: captured,
        helper: Object.freeze({ path, sha256: createHash('sha256').update(helper).digest('hex') }) }) })
}

function validExecutable(value: unknown): ResolvedExecutable | undefined {
    return resolvedExecutable(value)
}

function exactKeys(value: object, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const wanted = [...expected].sort()
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function helperStep(authority: Pick<Authority, 'node' | 'helper' | 'settings'>, cwd: string, request: object): ExecutionStep {
    const requestBytes = JSON.stringify(request)
    if (Buffer.byteLength(requestBytes) > 65_536) throw new TypeError('filesystem helper request exceeds its transport budget')
    const candidate = Object.freeze({
        id: `install-filesystem-${(request as { operation: string }).operation}-${(request as { requestId: string }).requestId}`,
        argv: Object.freeze([authority.node.canonicalPath, authority.helper.path, requestBytes]) as readonly [string, ...string[]],
        argv0: authority.node.invocationPath,
        cwd,
        env: Object.freeze({}),
        timeoutMs: authority.settings.helperTimeoutMs,
        stdoutLimitBytes: 16_384,
        stderrLimitBytes: 16_384,
        paths: Object.freeze([cwd]), ports: Object.freeze([]), labels: Object.freeze({}), expected: Object.freeze([]),
        consumedFiles: Object.freeze([
            Object.freeze({ path: authority.node.canonicalPath, sha256: authority.node.sha256, maxBytes: FILE_LIMIT, argvIndexes: Object.freeze([0]), executable: true as const, executionMode: authority.node.executionMode }),
            Object.freeze({ path: authority.helper.path, sha256: authority.helper.sha256, maxBytes: 1_048_576, argvIndexes: Object.freeze([1]), executable: false as const }),
        ]),
        filesystemChecks: Object.freeze([{ path: cwd, expected: 'directory' as const }]), compensation: Object.freeze([]),
    })
    const snapshot = snapshotExecutionStep(candidate)
    if (!snapshot) throw new TypeError('filesystem helper step is invalid')
    return snapshot
}

async function runHelper(authority: Pick<Authority, 'node' | 'helper' | 'settings'>, cwd: string, request: object, options: ExecutionOptions): Promise<{ result?: Record<string, unknown>; refusal?: InstallRefusal }> {
    let helper: ExecutionStep
    try { helper = helperStep(authority, cwd, request) } catch (error) {
        return { refusal: refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, `filesystem helper request is invalid or oversized: ${errorCause(error)}`, authority.helper.path) }
    }
    let raw: ExecuteProbeOutcome
    try { raw = await options.execute(helper) } catch (error) {
        return { refusal: refuse(ENVIRONMENT_CODES.EXECUTION_SPAWN_FAILED, `filesystem helper could not be executed: ${errorCause(error)}`, authority.helper.path) }
    }
    const outcome = authenticatedExecutionOutcome(raw, helper)
    if (outcome === undefined) return { refusal: refuse(ENVIRONMENT_CODES.EXECUTION_STEP_FAILED, 'filesystem helper outcome is not authentic', authority.helper.path) }
    if (outcome.kind === 'refusal') return { refusal: refuse(outcome.code, 'filesystem helper refused the requested operation', authority.helper.path) }
    if (outcome.stderr.byteLength !== 0) return { refusal: refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'filesystem helper emitted unexpected stderr', authority.helper.path) }
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(outcome.stdout)
        const value: unknown = JSON.parse(text)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
        const record = value as Record<string, unknown>
        if (record.version !== 1 || record.requestId !== (request as { requestId: string }).requestId || typeof record.kind !== 'string') throw new Error('mismatched response')
        const operation = (request as { operation: string }).operation
        const allowed = operation === 'acquire'
            ? record.kind === 'acquired' || record.kind === 'exists' ? ['version', 'requestId', 'kind', 'lock'] : []
            : operation === 'release'
                ? record.kind === 'released' ? ['version', 'requestId', 'kind', 'path']
                    : record.kind === 'residue' ? ['version', 'requestId', 'kind', 'path', 'entries'] : []
                : operation === 'stamp' && record.kind === 'stamped' ? ['version', 'requestId', 'kind', 'path']
                    : operation === 'ensure-directory' && record.kind === 'complete' ? ['version', 'requestId', 'kind', 'path', 'dev', 'ino'] : []
        if (allowed.length === 0 || Object.keys(record).sort().join('\0') !== allowed.sort().join('\0')) throw new Error('unexpected response shape')
        if (`${JSON.stringify(record)}\n` !== text) throw new Error('non-canonical response')
        const root = (request as { root: string }).root
        const segments = (request as { segments: string[] }).segments
        const target = join(root, ...segments)
        if (operation === 'acquire') {
            const lock = record.lock
            if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error('invalid lock result')
            const row = lock as Record<string, unknown>
            const expected = record.kind === 'acquired' ? ['path', 'dev', 'ino', 'ownerBase64'] : ['path', 'dev', 'ino', 'entries', 'ownerBase64']
            if (Object.keys(row).sort().join('\0') !== expected.sort().join('\0') || row.path !== target
                || !Number.isSafeInteger(row.dev) || !Number.isSafeInteger(row.ino)
                || (record.kind === 'acquired' && row.ownerBase64 !== (request as { ownerBase64: string }).ownerBase64)
                || (record.kind === 'exists' && (!Array.isArray(row.entries) || row.entries.some((entry) => typeof entry !== 'string')
                    || row.ownerBase64 !== null && typeof row.ownerBase64 !== 'string'))) throw new Error('invalid lock result')
        } else if (operation === 'ensure-directory') {
            if (record.path !== target || !Number.isSafeInteger(record.dev) || !Number.isSafeInteger(record.ino)) throw new Error('invalid directory result')
        } else if (operation === 'stamp') {
            if (record.path !== join(target, (request as { name: string }).name)) throw new Error('invalid stamp result')
        } else if (operation === 'release') {
            const expected = record.kind === 'released' ? target : join(dirname(target), (request as { quarantine: string }).quarantine)
            if (record.path !== expected || (record.kind === 'residue' && (!Array.isArray(record.entries) || record.entries.some((entry) => typeof entry !== 'string')))) throw new Error('invalid release result')
        }
        return { result: record }
    } catch (error) {
        return { refusal: refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, `filesystem helper returned malformed or mismatched evidence: ${errorCause(error)}`, authority.helper.path) }
    }
}

function policyFingerprint(request: PlanInstallInput, compatibility: Extract<DependencyExecutionPlan, { kind: 'complete' }>['compatibility']): string {
    return createHash('sha256').update(JSON.stringify({
        volume: request.policy.volume,
        lockfile: request.policy.lockfile,
        install: request.policy.install,
        loadProbe: request.policy.load_probe,
        runtime: compatibility,
        execution: request.execution,
    })).digest('hex')
}

function stampBytes(identity: CacheIdentity, volume: string, fingerprint: string, compatibility: Extract<DependencyExecutionPlan, { kind: 'complete' }>['compatibility']): Buffer {
    return Buffer.from(`${JSON.stringify({ format: 'cockpit-install-stamp/v1', ...identity, volume, policyFingerprint: fingerprint, runtime: compatibility })}\n`)
}

function parseOwner(bytes: Buffer): { holderId: HolderId; pid: number } | undefined {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const value: unknown = JSON.parse(text)
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const row = value as Record<string, unknown>
        return Object.keys(row).sort().join(',') === 'acquiredAt,format,holderId,pid,token' && row.format === LOCK_FORMAT
            && typeof row.holderId === 'string' && HOLDER_ID.test(row.holderId) && Number.isSafeInteger(row.pid) && (row.pid as number) > 0
            && isCanonicalTimestamp(row.acquiredAt) && typeof row.token === 'string' && UUID_V4.test(row.token)
            && `${JSON.stringify(row)}\n` === text
            ? { holderId: row.holderId as HolderId, pid: row.pid as number } : undefined
    } catch { /* Unparseable or non-UTF-8 lock bytes mean the holder metadata is malformed, which the caller refuses. */ return undefined }
}

async function inspectExistingLock(path: string, encodedOwner: unknown, observe: PlanInstallInput['observeHolder']): Promise<InstallRefusal> {
    if (typeof encodedOwner !== 'string') return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'install lock has incomplete owner evidence', path, `inspect ${path} before recovery`)
    const bytes = Buffer.from(encodedOwner, 'base64')
    if (bytes.toString('base64') !== encodedOwner) return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'install lock holder encoding is malformed', path, `inspect ${path} before recovery`)
    const owner = parseOwner(bytes)
    if (!owner) return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'install lock holder metadata is malformed', path, `inspect ${path} before recovery`)
    let state: HolderState = 'unknown'
    let observeCause = ''
    try { state = observe ? await observe(owner) : 'unknown' } catch (error) { observeCause = `: ${errorCause(error)}` }
    if (state === 'live') return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_HELD, `install lock is held by ${owner.holderId}`, path)
    if (state === 'dead') return refuse(ENVIRONMENT_CODES.INSTALL_STALE_PATH, `install lock belongs to dead holder ${owner.holderId}`, path, `reclaim ${path} only after confirming the holder evidence`)
    return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, `install lock holder ${owner.holderId} has unknown liveness${observeCause}`, path, `inspect ${path} before recovery`)
}

function snapshotInput(input: PlanInstallInput): PlanInstallInput | undefined {
    try {
        const inputKeys = ['checkoutId', 'holderId', 'pid', 'checkoutRoot', 'lockfilePath', 'state', 'runtime', 'policy', 'executables', 'execution']
        if (Object.prototype.hasOwnProperty.call(input, 'observeHolder')) inputKeys.push('observeHolder')
        if (!input || typeof input !== 'object' || Array.isArray(input) || !exactKeys(input, inputKeys)) return undefined
        const checkoutId = input.checkoutId
        const holderId = input.holderId
        const pid = input.pid
        const checkoutRoot = input.checkoutRoot
        const lockfilePath = input.lockfilePath
        const stateInput = input.state
        const runtime = input.runtime
        const policySnapshot = snapshotJson(input.policy)
        const executablesSnapshot = snapshotJson(input.executables)
        const executionSnapshot = snapshotJson(input.execution)
        const observeHolder = input.observeHolder
        if (!policySnapshot || typeof policySnapshot !== 'object' || Array.isArray(policySnapshot)
            || !exactKeys(policySnapshot, ['volume', 'lockfile', 'install', 'load_probe'])
            || !executablesSnapshot || typeof executablesSnapshot !== 'object' || Array.isArray(executablesSnapshot)
            || !exactKeys(executablesSnapshot, ['node', 'helper'])
            || !executionSnapshot || typeof executionSnapshot !== 'object' || Array.isArray(executionSnapshot)
            || !exactKeys(executionSnapshot, ['env', 'installTimeoutMs', 'probeTimeoutMs', 'helperTimeoutMs', 'stdoutLimitBytes', 'stderrLimitBytes'])
            || observeHolder !== undefined && typeof observeHolder !== 'function') return undefined
        const policyInput = policySnapshot as unknown as PlanInstallInput['policy']
        const executableInput = executablesSnapshot as unknown as PlanInstallInput['executables']
        const settings = executionSnapshot as unknown as InstallExecutionSettings
        const state = snapshotStateNamespace(stateInput)
        const helper = executableInput.helper
        const executables = {
            node: validExecutable(executableInput.node),
            helper: helper && typeof helper === 'object' ? Object.freeze({ path: helper.path, sha256: helper.sha256 }) : undefined,
        }
        const helperKeys = helper && typeof helper === 'object' ? Object.keys(helper).sort().join(',') : ''
        const validPath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value)
            && normalize(value) === value && dirname(value) !== value && !value.includes('\0')
        const boundedString = (value: unknown): value is string => typeof value === 'string' && Buffer.byteLength(value) <= 65_536
        const validArgv = (value: unknown): value is readonly [string, ...string[]] => Array.isArray(value)
            && value.length > 0 && value.length <= 1_024 && Object.keys(value).length === value.length
            && value.every((entry) => boundedString(entry) && entry.length > 0 && !entry.includes('\0'))
        const env = settings?.env
        const validEnv = env !== null && typeof env === 'object' && !Array.isArray(env)
            && Object.keys(env).length <= 1_024 && Buffer.byteLength(JSON.stringify(env)) <= 1_048_576
            && Object.entries(env).every(([key, value]) => boundedString(key) && key.length > 0 && !key.includes('\0') && !key.includes('=')
                && boundedString(value) && !value.includes('\0'))
        const validTimeout = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 300_000
        const validLimit = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 16_777_216
        if (!state || !CHECKOUT_ID.test(checkoutId) || !HOLDER_ID.test(holderId)
            || !Number.isSafeInteger(pid) || pid < 1
            || !validPath(checkoutRoot) || !validPath(lockfilePath)
            || !executables.node || !runtime || typeof runtime !== 'object'
            || !executables.helper || typeof executables.helper.path !== 'string' || !isAbsolute(executables.helper.path)
            || normalize(executables.helper.path) !== executables.helper.path || executables.helper.path.includes('\0')
            || helperKeys !== 'path,sha256' || !SHA256.test(executables.helper.sha256)
            || !VOLUME.test(policyInput.volume)
            || typeof policyInput.lockfile !== 'string' || policyInput.lockfile.length === 0
            || isAbsolute(policyInput.lockfile) || normalize(policyInput.lockfile) !== policyInput.lockfile || policyInput.lockfile.includes('\0')
            || !validArgv(policyInput.install) || !validArgv(policyInput.load_probe)
            || !settings || !validEnv || !validTimeout(settings.installTimeoutMs) || !validTimeout(settings.probeTimeoutMs)
            || !validTimeout(settings.helperTimeoutMs) || !validLimit(settings.stdoutLimitBytes) || !validLimit(settings.stderrLimitBytes)) return undefined
        const policy = Object.freeze({
            volume: policyInput.volume,
            lockfile: policyInput.lockfile,
            install: Object.freeze([...policyInput.install]) as readonly [string, ...string[]],
            load_probe: Object.freeze([...policyInput.load_probe]) as readonly [string, ...string[]],
        })
        const execution = Object.freeze({ ...settings, env: Object.freeze(Object.fromEntries(Object.entries(env).sort(([left], [right]) => left.localeCompare(right)))) })
        return Object.freeze({ checkoutId, holderId, pid, checkoutRoot, lockfilePath, state, runtime, policy, execution,
            executables: Object.freeze(executables) as PlanInstallInput['executables'], ...(observeHolder ? { observeHolder } : {}) })
    } catch { /* A throwing accessor or proxy trap means the caller-supplied request is malformed. */ return undefined }
}

export async function planInstall(input: PlanInstallInput, options: ExecutionOptions): Promise<PlanInstallResult> {
    const request = snapshotInput(input)
    if (!request || !HOLDER_ID.test(request.holderId) || !Number.isSafeInteger(request.pid) || request.pid < 1) {
        return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'install request is malformed', 'install-request')
    }
    if (!isAbsolute(request.checkoutRoot) || !confined(request.checkoutRoot, request.lockfilePath)
        || join(request.checkoutRoot, request.policy.lockfile) !== request.lockfilePath) {
        return refuse(ENVIRONMENT_CODES.INSTALL_STALE_PATH, 'install paths or executable declarations are inconsistent', request.lockfilePath)
    }
    const lockfile = await stableFileSnapshot(request.lockfilePath)
    if (!lockfile) return refuse(ENVIRONMENT_CODES.INSTALL_STALE_PATH, 'install lockfile is not a stable independent regular file', request.lockfilePath)
    const lockfileBytes = lockfile.bytes
    const dependency = createDependencyExecutionPlan({
        binding: request.runtime,
        install: request.policy.install,
        load: request.policy.load_probe,
        env: request.execution.env,
        installTimeoutMs: request.execution.installTimeoutMs,
        loadTimeoutMs: request.execution.probeTimeoutMs,
        stdoutLimitBytes: request.execution.stdoutLimitBytes,
        stderrLimitBytes: request.execution.stderrLimitBytes,
    })
    if (dependency.kind !== 'complete') return refuse(ENVIRONMENT_CODES.INSTALL_STALE_PATH, dependency.reason, request.policy.volume)
    if (request.policy.volume !== dependency.compatibility.source) {
        return refuse(ENVIRONMENT_CODES.INSTALL_STALE_PATH, 'dependency policy volume does not match the admitted runtime source', request.policy.volume)
    }
    const identity = deriveCacheKey({
        checkoutId: request.checkoutId,
        lockfileBytes,
        physicalVolume: dependency.compatibility.volume,
    })
    const fingerprint = policyFingerprint(request, dependency.compatibility)
    const expectedStamp = stampBytes(identity, request.policy.volume, fingerprint, dependency.compatibility)
    let lockPath: string
    let stampPath: string
    try {
        lockPath = request.state.paths.installLock(identity.cacheId)
        stampPath = request.state.paths.cache(identity.checkoutId, identity.cacheId).path
    } catch (error) {
        return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, `state namespace could not derive install authority: ${errorCause(error)}`, request.state.root)
    }
    if (!confined(request.state.root, lockPath) || !confined(request.state.root, stampPath)) {
        return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'derived install authority escaped its root', lockPath)
    }
    const installStep = dependency.install
    const loadProbeStep = dependency.load
    const lockParent = dirname(lockPath)
    try {
        const entries = (await readdir(lockParent)).filter((name) => name.startsWith(`.release-${identity.cacheId}-`))
        if (entries.length > 0) return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'an earlier exact-cache release requires recovery', join(lockParent, entries.sort()[0]!))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'install lock inventory is unreadable', lockParent) }
    const existingStamp = await stableFile(stampPath, 1_048_576)
    try {
        await lstat(stampPath)
        if (!existingStamp) return refuse(ENVIRONMENT_CODES.INSTALL_STALE_PATH, 'dependency cache stamp is unreadable or unsafe', stampPath)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refuse(ENVIRONMENT_CODES.INSTALL_STALE_PATH, 'dependency cache stamp cannot be inspected', stampPath)
    }
    if (existingStamp?.equals(expectedStamp)) {
        try { await lstat(lockPath); return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'a stamped cache still has an install lock', lockPath) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'install lock cannot be inspected', lockPath)
        }
        return issuePlan(request, identity, fingerprint, expectedStamp, dependency.compatibility, lockfile, stampPath, null, installStep, loadProbeStep, 'reuse')
    }
    if (existingStamp) return refuse(ENVIRONMENT_CODES.INSTALL_STALE_PATH, 'dependency cache stamp does not match its lockfile', stampPath)
    const ownerBytes = Buffer.from(`${JSON.stringify({ format: LOCK_FORMAT, holderId: request.holderId, pid: request.pid, acquiredAt: new Date().toISOString(), token: randomUUID() })}\n`)
    const requestId = randomUUID()
    const relation = relative(request.state.root, lockPath).split(sep)
    const authority = { node: request.executables.node, helper: request.executables.helper, settings: request.execution }
    const acquired = await runHelper(authority, request.state.root, { version: 1, requestId, operation: 'acquire', root: request.state.root, segments: relation, ownerBase64: ownerBytes.toString('base64') }, options)
    if (acquired.refusal) return acquired.refusal
    if (acquired.result?.kind === 'exists') return inspectExistingLock(lockPath, acquired.result.lock && (acquired.result.lock as Record<string, unknown>).ownerBase64, request.observeHolder)
    const lock = acquired.result?.kind === 'acquired' ? acquired.result.lock as Record<string, unknown> : undefined
    if (!lock || lock.path !== lockPath || !Number.isSafeInteger(lock.dev) || !Number.isSafeInteger(lock.ino) || lock.ownerBase64 !== ownerBytes.toString('base64')) {
        return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'filesystem helper returned invalid lock authority', lockPath)
    }
    const quarantine = `.release-${identity.cacheId}-${randomUUID()}`
    const publicLock = Object.freeze({ path: lockPath, dev: lock.dev as number, ino: lock.ino as number, ownerBytes: Buffer.from(ownerBytes), quarantine })
    return issuePlan(request, identity, fingerprint, expectedStamp, dependency.compatibility, lockfile, stampPath, publicLock, installStep, loadProbeStep, 'install')
}

function issuePlan(request: PlanInstallInput, identity: CacheIdentity, fingerprint: string, expectedStamp: Buffer, compatibility: Extract<DependencyExecutionPlan, { kind: 'complete' }>['compatibility'], lockfile: { bytes: Buffer; dev: number; ino: number; mode: number }, stampPath: string, lock: InstallLock | null, preparedInstallStep: ExecutionStep, loadProbeStep: ExecutionStep, disposition: PlannedInstall['disposition']): PlannedInstall {
    const installStep = disposition === 'install' ? preparedInstallStep : null
    const planned = Object.freeze({
        [planBrand]: true as const, kind: 'complete' as const, disposition, identity, policyFingerprint: fingerprint,
        stampPath, lockfilePath: request.lockfilePath,
        lockfileBytes: Buffer.from(lockfile.bytes), lock, installStep, loadProbeStep,
    })
    issuedPlans.set(planned, {
        lockfile: { ...lockfile, bytes: Buffer.from(lockfile.bytes) },
        stateRoot: request.state.root, helper: request.executables.helper, node: request.executables.node,
        settings: request.execution, stampBytes: Buffer.from(expectedStamp), compatibility,
        policy: Object.freeze({
            volume: request.policy.volume,
            lockfile: request.policy.lockfile,
            install: Object.freeze([...request.policy.install]) as readonly [string, ...string[]],
            load_probe: Object.freeze([...request.policy.load_probe]) as readonly [string, ...string[]],
        }),
        lock: lock ? { ...lock, ownerBytes: Buffer.from(lock.ownerBytes) } : null,
    })
    return planned
}

async function release(authority: Pick<Authority, 'node' | 'helper' | 'settings'>, stateRoot: string, segments: string[], lock: InstallLock, options: ExecutionOptions): Promise<InstallRefusal | undefined> {
    const result = await runHelper(authority, stateRoot, {
        version: 1, requestId: randomUUID(), operation: 'release', root: stateRoot, segments,
        dev: lock.dev, ino: lock.ino, ownerBase64: lock.ownerBytes.toString('base64'), quarantine: lock.quarantine,
    }, options)
    if (result.refusal) return result.refusal
    if (result.result?.kind === 'residue') return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'install lock release left explicit recovery evidence', String(result.result.path))
    return result.result?.kind === 'released' ? undefined : refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'install lock release evidence is invalid', lock.path)
}

async function lockfileChanged(planned: PlannedInstall, authority: Authority): Promise<boolean> {
    const current = await stableFileSnapshot(planned.lockfilePath)
    return current === undefined || !current.bytes.equals(authority.lockfile.bytes) || current.dev !== authority.lockfile.dev
        || current.ino !== authority.lockfile.ino || current.mode !== authority.lockfile.mode
}

type AuthenticatedExecution = Readonly<{ outcome: ExecuteProbeOutcome | undefined; cause: string }>

async function executeAuthenticated(step: ExecutionStep, options: ExecutionOptions): Promise<AuthenticatedExecution> {
    try { return { outcome: admitDependencyExecution({ step, outcome: await options.execute(step) }), cause: '' } } catch (error) { return { outcome: undefined, cause: `: ${errorCause(error)}` } }
}

export async function verifyInstall(planned: PlannedInstall, options: ExecutionOptions): Promise<VerifyInstallResult> {
    const authority = issuedPlans.get(planned)
    if (!authority || consumedPlans.has(planned)) return refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'install plan is not authentic or was already consumed', 'install-plan')
    consumedPlans.add(planned)
    const stages = planned.installStep ? ['install', 'load', 'stamp'] : ['load', 'stamp']
    const applied = new Set<string>()
    const attempted = new Set<string>()
    let result: VerifyInstallResult | undefined
    try {
        if (!planned.lockfileBytes.equals(authority.lockfile.bytes) || await lockfileChanged(planned, authority)) {
            result = refuse(ENVIRONMENT_CODES.INSTALL_LOCKFILE_CHANGED, 'install lockfile changed before execution', planned.lockfilePath)
        } else if (planned.installStep) {
            const { outcome, cause: installCause } = await executeAuthenticated(planned.installStep, options)
            if (outcome?.execution.started && outcome.receipt) attempted.add('install')
            if (outcome?.kind === 'complete') { applied.add('install'); attempted.delete('install') }
            if (await lockfileChanged(planned, authority)) result = refuse(ENVIRONMENT_CODES.INSTALL_LOCKFILE_CHANGED, `dependency command ${planned.installStep.argv0} changed the lockfile`, planned.lockfilePath)
            else if (!outcome) result = refuse(ENVIRONMENT_CODES.EXECUTION_STEP_FAILED, `install executor outcome is not authentic${installCause}`, planned.installStep.argv0)
            else if (outcome.kind === 'refusal') result = refuse(outcome.code, 'dependency install command failed', planned.installStep.argv0)
        }
        if (!result) {
            const { outcome: probe, cause: probeCause } = await executeAuthenticated(planned.loadProbeStep, options)
            if (probe?.execution.started && probe.receipt) attempted.add('load')
            if (probe?.kind === 'complete') { applied.add('load'); attempted.delete('load') }
            if (await lockfileChanged(planned, authority)) result = refuse(ENVIRONMENT_CODES.INSTALL_LOCKFILE_CHANGED, `dependency command ${planned.loadProbeStep.argv0} changed the lockfile`, planned.lockfilePath)
            else if (!probe) result = refuse(ENVIRONMENT_CODES.EXECUTION_STEP_FAILED, `dependency load probe outcome is not authentic${probeCause}`, planned.loadProbeStep.argv0)
            else if (probe.kind === 'refusal') result = refuse(probe.code, 'dependency load probe failed', planned.loadProbeStep.argv0)
            else if (planned.installStep) {
                const stampRoot = authority.stateRoot
                const request = { version: 1, requestId: randomUUID(), operation: 'stamp', root: stampRoot,
                    segments: relative(stampRoot, dirname(planned.stampPath)).split(sep), name: basename(planned.stampPath),
                    bytesBase64: authority.stampBytes.toString('base64') }
                const parent = await runHelper(authority, stampRoot, { version: 1, requestId: randomUUID(), operation: 'ensure-directory', root: stampRoot, segments: relative(stampRoot, dirname(planned.stampPath)).split(sep) }, options)
                if (parent.refusal) result = parent.refusal
                const stamped = result ? undefined : await runHelper(authority, stampRoot, request, {
                    ...options,
                    execute: async (step) => {
                        const raw = await options.execute(step)
                        const actual = authenticatedExecutionOutcome(raw, step)
                        if (actual?.execution.started && actual.receipt) attempted.add('stamp')
                        return raw
                    },
                })
                if (stamped?.refusal) result = stamped.refusal
                else if (!result && (stamped?.result?.kind !== 'stamped' || stamped.result.path !== planned.stampPath)) result = refuse(ENVIRONMENT_CODES.INSTALL_STALE_PATH, 'install stamp publication evidence is invalid', planned.stampPath)
                else if (!result) { applied.add('stamp'); attempted.delete('stamp') }
            } else if (!(await stableFile(planned.stampPath, 1_048_576))?.equals(authority.stampBytes)) {
                result = refuse(ENVIRONMENT_CODES.INSTALL_STALE_PATH, 'dependency cache stamp is missing or changed', planned.stampPath)
            } else {
                applied.add('stamp')
            }
            if (!result) result = Object.freeze({ kind: 'complete', identity: planned.identity, disposition: planned.disposition === 'install' ? 'installed' : 'reused' })
        }
    } finally {
        if (authority.lock) {
            const released = await release(authority, authority.stateRoot, relative(authority.stateRoot, authority.lock.path).split(sep), authority.lock, options)
            if (released) {
                result = result?.kind === 'refusal'
                    ? refuse(result.code, result.message, result.target, `release ${authority.lock.path} before retrying; cleanup failed: ${released.message}`)
                    : released
            }
        }
    }
    const outcome = result ?? refuse(ENVIRONMENT_CODES.INSTALL_LOCK_INVALID, 'install verification produced no result', 'install-plan')
    issuedProgress.set(outcome, Object.freeze({
        applied: Object.freeze([...applied]),
        notApplied: Object.freeze(stages.filter((stage) => !applied.has(stage) && !attempted.has(stage))),
        ...(attempted.size ? { attempted: Object.freeze([...attempted]) } : {}),
    }))
    return outcome
}

export async function observeDependencyInstall(input: {
    readonly planned: PlannedInstall
    readonly options: ExecutionOptions
    readonly stackId: StackId
    readonly observedAt: string
}): Promise<EnvironmentObservation> {
    if (!/^stack:[a-f0-9]{64}$/.test(input.stackId) || !isCanonicalTimestamp(input.observedAt)) {
        throw new TypeError('install observation input is malformed')
    }
    const authority = issuedPlans.get(input.planned)
    const identity = authority && authority.compatibility.source === authority.policy.volume ? Object.freeze({
        checkoutId: input.planned.identity.checkoutId,
        lockfilePath: input.planned.lockfilePath,
        stackId: authority.compatibility.stackId,
        configSha256: authority.compatibility.configSha256,
        generation: authority.compatibility.generation,
        target: authority.compatibility.target,
        policy: authority.policy,
    }) : undefined
    const result = await verifyInstall(input.planned, input.options)
    const observation = issueObservation({
        code: ENVIRONMENT_CODES.INSTALL_STATE_UNHEALTHY,
        owner: mechanism.id,
        stackId: input.stackId,
        source: input.planned.stampPath,
        observed: result.kind === 'complete'
            ? { state: 'available', value: true, observedAt: input.observedAt }
            : { state: 'failed', reason: result.message, observedAt: input.observedAt },
        expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'dependencies' },
        freshness: { state: 'current' },
        remedy: 'restore the dependency cache from the current lockfile',
    }, identity)
    const progress = projectInstallProgress(result)
    if (progress) issuedProgress.set(observation, progress)
    return observation
}

export interface ObserveDependencyLoadInput {
    readonly binding: DependencyRuntimeBinding
    readonly load: readonly [string, ...string[]]
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly stdoutLimitBytes: number
    readonly stderrLimitBytes: number
}

export async function observeDependencyLoad(
    input: ObserveDependencyLoadInput,
    options: ExecutionOptions,
): Promise<EnvironmentObservation | undefined> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)
        || Object.getPrototypeOf(input) !== Object.prototype) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = ['binding', 'env', 'load', 'stderrLimitBytes', 'stdoutLimitBytes', 'timeoutMs']
    if (Object.getOwnPropertySymbols(input).length > 0 || Object.keys(descriptors).sort().join('\0') !== keys.join('\0')
        || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) return undefined
    const planned = createDependencyLoadPlan(input)
    if (planned.kind !== 'planned') return undefined
    let outcome: ExecuteProbeOutcome
    try { outcome = await options.execute(planned.step) } catch { /* The result type carries no reason; an executor failure leaves no observation and the caller refuses it. */ return undefined }
    const authenticated = authenticatedExecutionOutcome(outcome, planned.step)
    if (!authenticated?.receipt) return undefined
    const admitted = admitDependencyLoad({ plan: planned, outcome })
    return issueObservation({
        code: ENVIRONMENT_CODES.INSTALL_STATE_UNHEALTHY,
        owner: mechanism.id,
        stackId: planned.compatibility.stackId,
        source: planned.compatibility.target,
        observed: admitted.kind === 'complete'
            ? { state: 'available', value: true, observedAt: authenticated.receipt.finishedAt }
            : { state: 'failed', reason: admitted.reason, observedAt: authenticated.receipt.finishedAt },
        expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'dependencies' },
        freshness: { state: 'current' },
        remedy: 'restore the dependency cache from the current lockfile',
    })
}
