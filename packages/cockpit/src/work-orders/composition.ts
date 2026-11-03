import { createHash, randomUUID } from 'node:crypto'
import { sha256Hex } from '../sha256.js'
import {
    closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, readdirSync,
} from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from 'node:path'
import { isProxy } from 'node:util/types'
import { readBoundedFile } from '../bounded-read.js'
import { tmpdir } from 'node:os'
import type { ConsumedWorkEnvironmentConfig } from '../config/load.js'
import { readRecordedPolicy, type EffectivePolicy } from '../autonomy.js'
import { evaluate, locateEvaluators, type EvaluatorChain } from '../grading/evaluate.js'
import { gradingDocument, gradingSchema, readGradingAnswer, type ChangedFile, type GradingSubject, type Verdict } from '../grading/grade.js'
import { ENVIRONMENT_CODES, errorCause, hasErrorCode, INHERITED_TOOL_ENVIRONMENT, type ConsumedFile, type FilesystemCheck, type SourceProvenance, type ExecutionStep, RefusalError } from '../environment/contract.js'
import { authenticatedExecutionOutcome, executeProbe } from '../environment-exec/execute.js'
import { issueBrowserRoutePolicy, type BrowserCommandInput, type BrowserCommandKind, type BrowserRoutePolicy } from '../browser/commands.js'
import { type BrowserRuntimeProjection } from '../browser/runtime.js'
import { measuredBrowserHarnessVersions, observeBrowserProjectPackage, renderBrowserSurfaces, type BrowserProjectClient } from '../browser/surfaces.js'
import { isGuardSurfaceTarget } from '../surfaces/harness-registry.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { stripDevelopmentMarkers } from '../surfaces/development-markers.js'
import { decodeLifecycleRecord } from '../environment/application/lifecycle.js'
import type { EnvironmentSnapshot, RuntimeEvidence } from '../environment/evidence.js'
import { resolveExecutablePath } from '../environment/executable.js'
import {
    consumeWorkApplicationAuthorities,
    prepareWorkApplicationAuthorities,
    projectWorkApplicationAuthorities,
} from '../environment/generated-application/authorities.js'
import { prepareGeneratedEnvironmentCurrentness } from '../environment/generated-application/check.js'
import { createLifecycleCommandAdapters } from '../environment/lifecycle-composition.js'
import { createReadCommandAdapters } from '../environment/read-composition.js'
import { deriveEntrypoints, observeRetainedPortFamily } from '../environment/ports.js'
import { readState } from '../environment/state.js'
import { runGate, type GateDependencies, type GateRegistry, type GateRequest, type ProductGateInvocation } from '../testing/gates.js'
import { parseCriteriaFile, parseWorkOrder, WORK_ORDER_ID, type ParsedFile, type WorkOrder, type WorkOrderCheck } from './contract.js'
import { createWorkStore, outputTail, WORK_RECORD_DIRECTORY, type CheckResult, type WorkStore } from './store.js'

export type WorkEnvironmentApplicationConfig = ConsumedWorkEnvironmentConfig

type BrowserAuthority = Readonly<{
    runtime: BrowserRuntimeProjection
    client: BrowserProjectClient
    policy: BrowserRoutePolicy
    state?: BrowserCommandInput['state']
}>

type EvaluatorAuthority = Readonly<{
    path?: string
    bytes: string
    sha256: string
    restriction: 'instructed'
    executableDirectories?: readonly string[]
    chain: EvaluatorChain
    environment?: Readonly<Record<string, string | undefined>>
}>

export interface WorkApplicationAuthorities {
    readonly browser?: BrowserAuthority
    readonly resolveBrowser?: () => Promise<BrowserAuthority>
    readonly testing?: Readonly<{
        registry: GateRegistry
        dependencies: GateDependencies
        runtime?: () => Promise<Readonly<{
            stack: NonNullable<GateRequest['stack']>
            evidence?: Readonly<{ snapshot: EnvironmentSnapshot; capture: () => Promise<RuntimeEvidence> }>
        }>>
    }>
    readonly evaluator?: EvaluatorAuthority
    readonly resolveEvaluator?: () => Promise<EvaluatorAuthority>
    readonly executableDirectories?: readonly string[]
    // The non-secret variables a declared check command receives besides PATH.
    readonly declaredEnvironment?: Readonly<Record<string, string>>
    readonly env: Readonly<Record<string, string | undefined>>
}

export type GradingResult = Readonly<{ criteria: readonly Verdict[]; evaluator: Readonly<{ tool: string; fallbacks: readonly Readonly<{ tool: string; code: string; message: string }>[] }> }>
    | Readonly<{ refusal: Readonly<{ code: string; message: string; fix: string }> }>

export interface WorkApplicationComposition {
    readonly policy: EffectivePolicy
    readonly caps: Readonly<{ wip: number; attempts: number }>
    readonly env: Readonly<Record<string, string | undefined>>
    readonly store: WorkStore
    readonly recordedPolicy: () => Promise<EffectivePolicy | undefined>
    readonly orderIds: () => Promise<readonly string[]>
    readonly readOrder: (id: string) => Promise<ParsedFile<WorkOrder>>
    readonly readCriteriaFile: (path: string) => Promise<ReturnType<typeof parseCriteriaFile>>
    readonly sourceDigests: (order: Pick<WorkOrder, 'criteria'>) => Promise<Readonly<Record<string, string>>>
    readonly heads: () => Promise<Readonly<Record<string, string>>>
    readonly runCheck: (criterion: string, check: WorkOrderCheck) => Promise<CheckResult>
    readonly changes: (base: Readonly<Record<string, string>>) => Promise<readonly ChangedFile[]>
    readonly evaluate: (subject: GradingSubject) => Promise<GradingResult>
    readonly browser: (kind: BrowserCommandKind, role?: string) => Promise<BrowserCommandInput>
    readonly gate: (request: WorkApplicationGateRequest) => Promise<Readonly<{ registry: GateRegistry; request: GateRequest; dependencies: GateDependencies }>>
}
export interface WorkApplicationGateRequest {
    readonly operation: 'test-run'
    readonly gate: string
    readonly mode: 'canonical' | 'full' | 'staged'
    readonly select?: Readonly<{ kind: 'spec' | 'file' | 'test' | 'route'; value: string }>
}
export type VerificationObservation =
    | Readonly<{ kind: 'executed'; exitCode: number; stdout: string; stderr: string; truncated: boolean }>
    | Readonly<{ kind: 'error' | 'unavailable'; reason: string }>
type RepositorySubject = Readonly<{ path: string; revision: string; worktreeDigest: string }>

const issuedCompositions = new WeakSet<object>()
const MAX_DOCUMENT_BYTES = 8 * 1_048_576
const MAX_REPOSITORY_PATHS = 4_096
const MAX_REPOSITORY_FILE_BYTES = 8 * 1_048_576
const MAX_REPOSITORY_AGGREGATE_BYTES = 64 * 1_048_576
// What the grader is shown of one changed file, and of the whole change.
const MAX_DIFF_BYTES = 65_536
const MAX_CHANGE_BYTES = 1_048_576
const VERIFICATION_TIMEOUT_FIELD = 'work.verification_timeout_seconds'
const DEFAULT_EXECUTABLE_DIRECTORIES = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])
// Work-order coordination files change as the work is tracked, not as the product changes: the orders,
// cockpit's records of them and the recorded policy never make a gate's proof stale.
const COORDINATION_PATHS: ReadonlySet<string> = new Set(['workorders/', `${WORK_RECORD_DIRECTORY}/`, '.cockpit/policy.json'])
// Nor is anything cockpit writes below .cockpit/ a change an order made.
const COCKPIT_WRITTEN: ReadonlySet<string> = new Set([...COORDINATION_PATHS, '.cockpit/'])

function boundedName(value: unknown): value is string {
    return typeof value === 'string' && WORK_ORDER_ID.test(value)
}

function exactSource(source: SourceProvenance): boolean {
    try {
        const bytes = readExactFile(source.path, source.byteLength)
        return bytes.byteLength === source.byteLength && sha256Hex(bytes) === source.sha256
    } catch { return false } // A source that cannot be read back cannot be shown to be the admitted bytes; callers refuse it as changed.
}

function contained(root: string, relativePath: string, allowAbsent = false): string {
    if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) || relativePath.includes('\0')
        || relativePath.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new RefusalError('path escapes its admitted root')
    const target = resolve(root, relativePath)
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new RefusalError('path escapes its admitted root')
    let cursor = root
    for (const part of relativePath.split(/[\\/]/)) {
        cursor = join(cursor, part)
        if (!existsSync(cursor)) {
            if (allowAbsent) break
            throw new RefusalError('contained path is missing')
        }
        const metadata = lstatSync(cursor)
        if (metadata.isSymbolicLink()) throw new RefusalError('contained path cannot traverse a symbolic link')
    }
    if (existsSync(target) && realpathSync(target) !== target) throw new RefusalError('contained path changed identity')
    return target
}

type ReadDirectoryAnchor = Readonly<{
    path: string
    descriptor: number
    trackContents: boolean
    dev: bigint
    ino: bigint
    mtimeNs: bigint
    ctimeNs: bigint
}>

function readAnchorsCurrent(anchors: readonly ReadDirectoryAnchor[]): boolean {
    try {
        return anchors.every(anchor => {
            const opened = fstatSync(anchor.descriptor, { bigint: true })
            const named = lstatSync(anchor.path, { bigint: true })
            return opened.isDirectory() && named.isDirectory() && !named.isSymbolicLink()
                && opened.dev === anchor.dev && opened.ino === anchor.ino
                && named.dev === anchor.dev && named.ino === anchor.ino
                && (!anchor.trackContents || opened.mtimeNs === anchor.mtimeNs && opened.ctimeNs === anchor.ctimeNs
                    && named.mtimeNs === anchor.mtimeNs && named.ctimeNs === anchor.ctimeNs)
        })
    } catch { return false } // An anchor that can no longer be observed is not current; callers refuse the read as changed.
}

function anchoredReadPath(root: string, relativePath: string, allowAbsent = false, contentRoot = root): Readonly<{
    target: string
    anchors: readonly ReadDirectoryAnchor[]
}> | undefined {
    if (constants.O_DIRECTORY === undefined || constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined
        || !isAbsolute(root) || resolve(root) !== root || typeof relativePath !== 'string' || !relativePath
        || isAbsolute(relativePath) || relativePath.includes('\0')
        || relativePath.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
        throw new RefusalError('path escapes its admitted root')
    }
    const target = resolve(root, relativePath)
    const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
    if (target === root || !target.startsWith(rootPrefix)) throw new RefusalError('path escapes its admitted root')
    const directories = [root]
    let cursor = root
    for (const part of relativePath.split(/[\\/]/).slice(0, -1)) {
        cursor = join(cursor, part)
        directories.push(cursor)
    }
    const anchors: ReadDirectoryAnchor[] = []
    try {
        for (const path of directories) {
            const trackContents = path === contentRoot || path.startsWith(contentRoot.endsWith(sep) ? contentRoot : `${contentRoot}${sep}`)
            let named
            try { named = lstatSync(path, { bigint: true }) } catch (error) {
                if (allowAbsent && hasErrorCode(error, 'ENOENT')) {
                    if (!readAnchorsCurrent(anchors)) throw new RefusalError('contained file ancestor changed while observing an absent path')
                    closeReadAnchors(anchors)
                    return undefined
                }
                throw error
            }
            if (!named.isDirectory() || named.isSymbolicLink()) throw new RefusalError('contained file ancestor is unsafe')
            const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
            try {
                const opened = fstatSync(descriptor, { bigint: true })
                if (!opened.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino
                    || trackContents && (opened.mtimeNs !== named.mtimeNs || opened.ctimeNs !== named.ctimeNs)) {
                    throw new RefusalError('contained file ancestor changed while anchoring')
                }
                anchors.push({ path, descriptor, trackContents, dev: opened.dev, ino: opened.ino,
                    mtimeNs: opened.mtimeNs, ctimeNs: opened.ctimeNs })
            } catch (error) {
                closeSync(descriptor)
                throw error
            }
        }
        if (!readAnchorsCurrent(anchors)) throw new RefusalError('contained file ancestor changed before leaf admission')
        return { target, anchors }
    } catch (error) {
        for (const anchor of anchors.reverse()) closeSync(anchor.descriptor)
        throw error
    }
}

function anchoredAbsoluteReadPath(path: string): Readonly<{
    target: string
    anchors: readonly ReadDirectoryAnchor[]
}> {
    if (!isAbsolute(path) || resolve(path) !== path) throw new RefusalError('file path is not canonical')
    const root = parsePath(path).root
    // Shared outer directories may gain unrelated entries; the owning directory and leaf stay content-bound.
    const anchored = anchoredReadPath(root, relative(root, path), false, dirname(path))
    if (!anchored) throw new RefusalError('file is missing')
    return anchored
}

function closeReadAnchors(anchors: readonly ReadDirectoryAnchor[]): void {
    let failure: unknown
    for (const anchor of [...anchors].reverse()) try { closeSync(anchor.descriptor) } catch (error) { failure ??= error }
    if (failure !== undefined) throw failure
}

// The leaf is read by the shared no-follow helper; a second link would let an agent-writable name
// alias a file outside the admitted root, so only a single-link file is accepted.
function readAnchoredLeaf(anchored: Readonly<{ target: string; anchors: readonly ReadDirectoryAnchor[] }>, maximum: number, what: string): Buffer {
    try {
        const read = readBoundedFile(anchored.target, maximum)
        if (read.kind !== 'complete') throw new RefusalError(`${what} exceeds its ${maximum}-byte read bound`)
        if (lstatSync(anchored.target).nlink !== 1) throw new RefusalError(`${what} has more than one link`)
        if (!readAnchorsCurrent(anchored.anchors)) throw new RefusalError(`${what} ancestor changed during read`)
        return read.bytes
    } finally { closeReadAnchors(anchored.anchors) }
}

function readBounded(root: string, relativePath: string, maximum = MAX_DOCUMENT_BYTES): Buffer {
    const anchored = anchoredReadPath(root, relativePath)
    if (!anchored) throw new RefusalError('contained file is missing')
    return readAnchoredLeaf(anchored, maximum, 'contained file')
}

function readExactFile(path: string, maximum: number): Buffer {
    const anchored = anchoredAbsoluteReadPath(path)
    try {
        if (realpathSync(path) !== path) throw new RefusalError('file path is not canonical')
    } catch (error) { closeReadAnchors(anchored.anchors); throw error }
    return readAnchoredLeaf(anchored, maximum, 'file')
}


type WorkExecutable = Readonly<{ path: string; sha256: string; bytes: number }>
type WorkExecutableResolution = Readonly<{ state: 'available'; value: WorkExecutable }>
    | Readonly<{ state: 'unavailable'; reason: string }>

async function executable(directories: readonly string[], name: string): Promise<WorkExecutableResolution> {
    let unavailableReason = `Executable ${name} is unavailable`
    for (const directory of directories) {
        if (!isAbsolute(directory)) continue
        const candidate = join(directory, name)
        const resolved = await resolveExecutablePath(candidate)
        if (resolved.state !== 'available') { unavailableReason = resolved.reason; continue }
        let bytes: number
        try { bytes = lstatSync(resolved.value.canonicalPath).size }
        catch (error) { unavailableReason = `Executable ${name} is unavailable: ${errorCause(error)}`; continue }
        return { state: 'available' as const, value: {
            path: resolved.value.canonicalPath, sha256: resolved.value.sha256, bytes,
        } }
    }
    return { state: 'unavailable', reason: unavailableReason }
}

// Every caller sees the same outcome classes: a process that ran reports its exit status, a timeout says
// so, and only evidence that cannot be tied to the issued step is called unauthenticated. A probe parses
// its output, so it refuses a truncated or non-UTF-8 capture. A declared command (a product test stage or
// a work-order verification row) is judged by its exit status: it runs for its declared timeout, keeps
// the tail of long output and receives the non-secret variables build tools resolve caches from.
type BoundedExecutionMode = Readonly<{ kind: 'probe' }>
    | Readonly<{ kind: 'declared'; env: Readonly<Record<string, string>>; timeoutField: string }>

async function executeBounded(root: string, argv: readonly string[], directories = DEFAULT_EXECUTABLE_DIRECTORIES, timeoutMs = 30_000,
    mode: BoundedExecutionMode = { kind: 'probe' }): Promise<VerificationObservation & Readonly<{ observedBytes?: number }>> {
    if (!Array.isArray(argv) || !argv.length || argv.length > 128 || argv.some(value => typeof value !== 'string' || !value || Buffer.byteLength(value) > 4_096)) {
        return { kind: 'error', reason: 'Execution requires bounded argv' }
    }
    if (!Array.isArray(directories) || !directories.length || directories.length > 64
        || directories.some(directory => typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory
            || directory.includes('\0') || directory.includes(delimiter) || Buffer.byteLength(directory) > 4_096)
        || Buffer.byteLength(directories.join(delimiter)) > 65_536) {
        return { kind: 'error', reason: 'Execution requires a bounded executable search path' }
    }
    const resolution = await (isAbsolute(argv[0]) ? executable([dirname(argv[0])], basename(argv[0])) : executable(directories, argv[0]))
    if (resolution.state !== 'available') return { kind: 'unavailable', reason: resolution.reason }
    const resolved = resolution.value
    const consumedFile: ConsumedFile = { path: resolved.path, sha256: resolved.sha256, maxBytes: resolved.bytes,
        argvIndexes: [0], executable: true, executionMode: 'verified-path' }
    const filesystemCheck: FilesystemCheck = { path: root, expected: 'directory' }
    const stepArgv: readonly [string, ...string[]] = [resolved.path, ...argv.slice(1)]
    const step: ExecutionStep = { id: `work-${randomUUID()}`, argv: stepArgv, argv0: resolved.path,
        // macOS's /usr/bin/git looks up a temporary directory when TMPDIR is unset, and inside Codex's
        // workspace-write sandbox that lookup fails and git warns on stderr, which fails a probe that
        // requires silence; a probe therefore names the temporary directory Node already resolved.
        cwd: root, env: { ...(mode.kind === 'declared' ? mode.env : { TMPDIR: tmpdir() }), PATH: directories.join(delimiter) }, timeoutMs,
        spawnNotAfter: new Date(Date.now() + timeoutMs).toISOString(), stdoutLimitBytes: 65_536, stderrLimitBytes: 65_536,
        ...(mode.kind === 'declared' ? { outputOverflow: 'retain-tail' as const } : {}),
        paths: [], ports: [], labels: { owner: 'work-application' }, expected: [],
        consumedFiles: [consumedFile], filesystemChecks: [filesystemCheck], compensation: [] }
    const result = authenticatedExecutionOutcome(await executeProbe(step), step)
    if (!result) return { kind: 'error', reason: `the outcome of ${argv[0]} could not be authenticated as the issued step` }
    if (result.kind === 'refusal' && result.code === ENVIRONMENT_CODES.EXECUTION_TIMEOUT) {
        return { kind: 'error', reason: `timed out after ${timeoutMs / 1_000} seconds${mode.kind === 'declared' ? `; raise ${mode.timeoutField}` : ''}` }
    }
    if (result.kind === 'refusal' && result.code === ENVIRONMENT_CODES.EXECUTION_SPAWN_FAILED) return { kind: 'unavailable', reason: `${argv[0]} could not be started` }
    // A non-zero exit carries a receipt only when the process started and its termination was confirmed.
    const exited = result.kind === 'complete' || result.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED && result.receipt !== undefined
    if (!exited) return { kind: 'error', reason: `${argv[0]} did not run to completion: ${result.code}` }
    const truncated = result.execution.stdoutObservedBytes !== result.execution.stdoutRetainedBytes
        || result.execution.stderrObservedBytes !== result.execution.stderrRetainedBytes
    if (truncated && mode.kind === 'probe') return { kind: 'error', reason: `${argv[0]} output exceeded the 64 KiB probe capture` }
    // A probe parses its output, so it refuses invalid UTF-8; a declared command's output is evidence to read.
    const decode = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: mode.kind === 'probe' }).decode(bytes)
    let stdout: string; let stderr: string
    try {
        stdout = decode(result.stdout)
        stderr = decode(result.stderr)
    }
    catch (error) { return { kind: 'error', reason: `${argv[0]} returned invalid UTF-8: ${errorCause(error)}` } }
    return { kind: 'executed', exitCode: result.execution.exitCode, stdout, stderr, truncated,
        observedBytes: result.execution.stdoutObservedBytes + result.execution.stderrObservedBytes }
}


function admitRepositoryPath(root: string, identity: string, path: string, sensitivePaths: ReadonlySet<string>,
    forbiddenTargets: ReadonlySet<string> = new Set()): string {
    const parts = path.split('/')
    if (!path || Buffer.byteLength(path) > 4_096 || path.includes('\0') || isAbsolute(path)
        || parts.some(part => !part || part === '.' || part === '..')) throw new RefusalError(`repository subject ${identity} contains an unsafe path: ${path}`)
    const foldedPath = path.toLowerCase()
    if ([...sensitivePaths].some(candidate => candidate.toLowerCase() === foldedPath)) {
        throw new RefusalError(`repository subject ${identity} refuses declared environment instance: ${path}`)
    }
    const target = resolve(root, path)
    const foldedTarget = target.toLowerCase()
    if ([...forbiddenTargets].some(candidate => candidate.toLowerCase() === foldedTarget)) {
        throw new RefusalError(`repository subject ${identity} refuses browser authentication state: ${path}`)
    }
    const basename = parts.at(-1) ?? ''
    const safeEnvironmentTemplate = /^\.env(?:\.[A-Za-z0-9_-]+)*\.(?:example|schema|template|sample)$/i.test(basename)
    const universalCredentialShape = parts.some(part => ['.ssh', '.aws', '.gnupg', '.secrets', '.npmrc', '.netrc', '.pypirc'].includes(part.toLowerCase())
        || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?$/i.test(part) || /\.(?:key|pem|p12|pfx)$/i.test(part))
    const environmentCredentialParent = parts.slice(0, -1).some(part => part.toLowerCase() === '.env' || part.toLowerCase().startsWith('.env.'))
    const finalEnvironmentCredential = basename.toLowerCase() === '.env' || basename.toLowerCase().startsWith('.env.')
    if (universalCredentialShape || environmentCredentialParent || finalEnvironmentCredential && !safeEnvironmentTemplate) {
        throw new RefusalError(`repository subject ${identity} refuses credential-shaped path: ${path}`)
    }
    return target
}

function repositoryPathDigest(root: string, identity: string, path: string, aggregate: { bytes: number },
    sensitivePaths: ReadonlySet<string>, forbiddenTargets: ReadonlySet<string> = new Set()): string | null {
    admitRepositoryPath(root, identity, path, sensitivePaths, forbiddenTargets)
    const anchored = anchoredReadPath(root, path, true)
    if (!anchored) return null
    try {
        let stat
        try { stat = lstatSync(anchored.target) } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                if (!readAnchorsCurrent(anchored.anchors)) throw new RefusalError('repository subject ancestor changed while observing an absent file')
                return null
            }
            throw error
        }
        if (stat.isSymbolicLink()) throw new RefusalError(`repository subject ${identity} refuses a symbolic link: ${path}`)
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_REPOSITORY_FILE_BYTES
            || aggregate.bytes + stat.size > MAX_REPOSITORY_AGGREGATE_BYTES) throw new RefusalError('repository subject file exceeds its authenticated bound')
        const descriptor = openSync(anchored.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
            const opened = fstatSync(descriptor)
            if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || opened.size !== stat.size
                || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs) throw new RefusalError('repository subject file changed before hashing')
            const hash = createHash('sha256'); const chunk = Buffer.allocUnsafe(1_048_576); let total = 0
            while (total < opened.size) {
                const count = readSync(descriptor, chunk, 0, Math.min(chunk.byteLength, opened.size - total), null)
                if (count <= 0) throw new RefusalError('repository subject file ended before its observed size')
                total += count; hash.update(chunk.subarray(0, count))
            }
            const after = fstatSync(descriptor); const linked = lstatSync(anchored.target)
            if (total !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 || after.size !== opened.size
                || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
                || linked.dev !== opened.dev || linked.ino !== opened.ino || linked.nlink !== 1 || linked.size !== opened.size
                || linked.mtimeMs !== opened.mtimeMs || linked.ctimeMs !== opened.ctimeMs
                || !readAnchorsCurrent(anchored.anchors)) throw new RefusalError('repository subject file or ancestor changed while hashing')
            aggregate.bytes += total
            return hash.digest('hex')
        } finally { closeSync(descriptor) }
    } finally { closeReadAnchors(anchored.anchors) }
}

function statusPath(record: string, spaces: number): string {
    let offset = 0
    for (let index = 0; index < spaces; index += 1) {
        offset = record.indexOf(' ', offset)
        if (offset < 0) throw new RefusalError('repository status record is malformed')
        offset += 1
    }
    const path = record.slice(offset)
    if (!path) throw new RefusalError('repository status path is missing')
    return path
}


function excludedRepositoryPath(path: string, excluded: ReadonlySet<string>): boolean {
    return [...excluded].some(candidate => candidate.endsWith('/')
        ? path === candidate.slice(0, -1) || path.startsWith(candidate)
        : path === candidate)
}

function repositoryEnvironmentInstancePaths(repositoryRoot: string, siblingsRoot: string,
    siblings: ConsumedWorkEnvironmentConfig['siblings']): ReadonlySet<string> {
    const paths = new Set<string>()
    for (const sibling of siblings) {
        const siblingRoot = resolve(siblingsRoot, sibling.dir)
        const prefix = relative(repositoryRoot, siblingRoot)
        if (isAbsolute(prefix) || prefix === '..' || prefix.startsWith(`..${sep}`)) continue
        for (const file of sibling.environmentFiles) paths.add(prefix ? join(prefix, file.instance) : file.instance)
    }
    return paths
}

// Why a probe that must exit 0 silently did not, in words a person can act on: the first line of
// what it wrote to stderr is usually the whole story (a sandbox denial, a missing repository).
function probeFailure(command: string, observed: VerificationObservation): string {
    if (observed.kind !== 'executed') return `${command} did not run: ${observed.reason}`
    const stderr = observed.stderr.trim().split('\n', 1)[0]?.slice(0, 240)
    if (observed.exitCode !== 0) return `${command} exited ${observed.exitCode}${stderr ? `: ${stderr}` : ''}`
    if (stderr) return `${command} wrote to stderr: ${stderr}`
    return observed.truncated ? `${command} output exceeded the probe capture` : `${command} printed no newline-terminated answer`
}

async function observeRepositorySubject(repository: Readonly<{ identity: string; root: string }>, excluded: ReadonlySet<string>,
    directories: readonly string[], sensitivePaths: ReadonlySet<string> = new Set(), forbiddenTargets: ReadonlySet<string> = new Set()): Promise<RepositorySubject> {
    const prefixResult = await executeBounded(repository.root, ['git', 'rev-parse', '--show-prefix'], directories)
    if (prefixResult.kind !== 'executed' || prefixResult.exitCode !== 0 || prefixResult.stderr || prefixResult.truncated
        || !prefixResult.stdout.endsWith('\n')) {
        throw new RefusalError(`repository subject ${repository.identity} root is unavailable: ${probeFailure('git rev-parse --show-prefix', prefixResult)}`)
    }
    const prefix = prefixResult.stdout.slice(0, -1)
    if (prefix && (!prefix.endsWith('/') || isAbsolute(prefix) || prefix.slice(0, -1).split('/').some(part => !part || part === '.' || part === '..'))) {
        throw new RefusalError(`repository subject ${repository.identity} root prefix is unsafe`)
    }
    const localPath = (path: string) => {
        if (!prefix) return path
        if (!path.startsWith(prefix)) throw new RefusalError(`repository subject ${repository.identity} escaped its declared root: ${path}`)
        return path.slice(prefix.length)
    }
    const status = await executeBounded(repository.root, ['git', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.'], directories)
    if (status.kind !== 'executed' || status.exitCode !== 0 || status.stderr || status.truncated) {
        throw new RefusalError(`repository subject ${repository.identity} is unavailable: ${probeFailure('git status', status)}`)
    }
    const parseStatus = (stdout: string) => {
        const records = stdout.split('\0'); if (records.at(-1) !== '') throw new RefusalError('repository status is not NUL terminated')
        records.pop()
        let revision: string | undefined
        const changes: Array<Readonly<{ kind: string; metadata: string; paths: readonly string[] }>> = []
        const normalizedRecords: string[] = []
        const admittedPaths = new Set<string>()
        for (let index = 0; index < records.length; index += 1) {
            const record = records[index]!
            if (record.startsWith('# branch.oid ')) {
                if (revision !== undefined) throw new RefusalError('repository status contains duplicate HEAD identity')
                revision = record.slice('# branch.oid '.length)
                normalizedRecords.push(record)
                continue
            }
            if (record.startsWith('# ')) { normalizedRecords.push(record); continue }
            let kind: string; let metadata: string; let paths: string[]; let pairedRecord: string | undefined
            if (record.startsWith('1 ')) { kind = 'ordinary'; paths = [statusPath(record, 8)]; metadata = record.slice(0, record.length - paths[0]!.length) }
            else if (record.startsWith('2 ')) {
                kind = 'rename'; const destination = statusPath(record, 9); const source = records[++index]
                if (source === undefined) throw new RefusalError('repository rename source is missing')
                paths = [destination, source]; metadata = record.slice(0, record.length - destination.length); pairedRecord = source
            } else if (record.startsWith('u ')) { kind = 'unmerged'; paths = [statusPath(record, 10)]; metadata = record.slice(0, record.length - paths[0]!.length) }
            else if (record.startsWith('? ')) { kind = 'untracked'; paths = [record.slice(2)]; metadata = '? ' }
            else throw new RefusalError('repository status contains an unsupported record')
            const included = paths.map(localPath).filter(path => !excludedRepositoryPath(path, excluded))
            if (!included.length) continue
            if (included.some(path => admittedPaths.has(path))) throw new RefusalError('repository subject contains duplicate paths')
            for (const path of included) admittedPaths.add(path)
            if (admittedPaths.size > MAX_REPOSITORY_PATHS) throw new RefusalError('repository subject exceeds its path bound')
            const change = { kind, metadata, paths: included }
            changes.push(change)
            normalizedRecords.push(record)
            if (pairedRecord !== undefined) normalizedRecords.push(pairedRecord)
        }
        // A repository made by `sibling add --create` has no HEAD until its first commit, and a work
        // order binds every repository's revision, so name where that commit is missing.
        if (revision === '(initial)') {
            throw new RefusalError(`repository ${repository.identity} at ${repository.root} has no commits yet; fix: commit once in ${repository.root}`)
        }
        if (!revision || !/^(?=[a-f0-9]*[1-9a-f])(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) {
            throw new RefusalError(`repository revision is unavailable for ${repository.identity} at ${repository.root}`)
        }
        changes.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
        return { revision, changes, normalizedRecords }
    }
    const observedStatus = parseStatus(status.stdout)
    const aggregate = { bytes: 0 }
    const changes = observedStatus.changes.map(change => ({ ...change,
        paths: change.paths.map(path => ({ path,
            sha256: repositoryPathDigest(repository.root, repository.identity, path, aggregate, sensitivePaths, forbiddenTargets) })),
    }))
    const confirmed = await executeBounded(repository.root, ['git', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.'], directories)
    const confirmedPrefix = await executeBounded(repository.root, ['git', 'rev-parse', '--show-prefix'], directories)
    if (confirmed.kind !== 'executed' || confirmed.exitCode !== 0 || confirmed.stderr || confirmed.truncated
        || confirmedPrefix.kind !== 'executed' || confirmedPrefix.exitCode !== 0 || confirmedPrefix.stdout !== prefixResult.stdout
        || confirmedPrefix.stderr || confirmedPrefix.truncated) {
        throw new RefusalError(`repository subject ${repository.identity} changed during observation`)
    }
    const confirmedStatus = parseStatus(confirmed.stdout)
    if (JSON.stringify(confirmedStatus) !== JSON.stringify(observedStatus)) {
        throw new RefusalError(`repository subject ${repository.identity} changed during observation`)
    }
    const confirmationAggregate = { bytes: 0 }
    for (const change of changes) for (const path of change.paths) {
        if (repositoryPathDigest(repository.root, repository.identity, path.path, confirmationAggregate, sensitivePaths, forbiddenTargets) !== path.sha256) {
            throw new RefusalError(`repository subject ${repository.identity} changed during hashing`)
        }
    }
    return { path: repository.identity, revision: observedStatus.revision,
        worktreeDigest: sha256Hex(JSON.stringify({ revision: observedStatus.revision, changes })) }
}

export function isWorkApplicationComposition(value: unknown): value is WorkApplicationComposition {
    return value !== null && typeof value === 'object' && issuedCompositions.has(value as object)
}


function createWorkApplicationComposition(config: WorkEnvironmentApplicationConfig, authorities: WorkApplicationAuthorities): WorkApplicationComposition {
    if (!config || isProxy(config) || !boundedName(config.cockpitName) || !isAbsolute(config.cockpitRoot)
        || realpathSync(config.cockpitRoot) !== config.cockpitRoot || dirname(config.source.path) !== config.cockpitRoot
        || typeof config.siblingsRoot !== 'string' || !config.siblingsRoot || config.siblingsRoot.includes('\0')
        || !Array.isArray(config.siblings) || config.siblings.some(row => !boundedName(row?.slug) || typeof row?.dir !== 'string'
            || isAbsolute(row.dir) || row.dir !== '.' && row.dir.split(/[\\/]/).some((part: string) => !part || part === '.' || part === '..'))
        || !authorities || isProxy(authorities)) throw new RefusalError('work application composition requires admitted source-bound configuration')
    const root = config.cockpitRoot
    const siblingsRoot = resolve(root, config.siblingsRoot)
    if (realpathSync(siblingsRoot) !== siblingsRoot) throw new RefusalError('work application composition requires a canonical siblings root')
    const directories = authorities.executableDirectories ?? DEFAULT_EXECUTABLE_DIRECTORIES
    const browserAuthenticationTargets = new Set((config.browser?.authentication.states ?? []).map(row => resolve(root, row.path)))
    // The cockpit's own repository is `.`; a sibling is named by its slug, and its paths read `<slug>:path`.
    // A sibling checked out at the cockpit root is that same repository, under the cockpit's key.
    const repositories = [{ key: '.', identity: config.cockpitName, root }, ...config.siblings.flatMap(row => resolve(siblingsRoot, row.dir) === root ? []
        : [{ key: row.slug, identity: `siblings/${row.slug}`, root: resolve(siblingsRoot, row.dir) }])]
        .map(repository => ({ ...repository, sensitivePaths: repositoryEnvironmentInstancePaths(repository.root, siblingsRoot, config.siblings) }))
    const keyOf = (key: string) => config.siblings.some(row => row.slug === key && resolve(siblingsRoot, row.dir) === root) ? '.' : key
    const qualified = (key: string, path: string) => key === '.' ? path : `${key}:${path}`
    const located = (reference: string) => {
        const colon = reference.indexOf(':')
        const key = colon < 0 ? '.' : keyOf(reference.slice(0, colon))
        const repository = repositories.find(row => row.key === key)
        if (!repository) throw new RefusalError(`${reference} names no declared sibling ${key}`)
        const path = colon < 0 ? reference : reference.slice(colon + 1)
        admitRepositoryPath(repository.root, repository.identity, path, repository.sensitivePaths, browserAuthenticationTargets)
        return { repository, path }
    }
    const readSource = (reference: string): Buffer => {
        const { repository, path } = located(reference)
        try { return readBounded(repository.root, path, MAX_DOCUMENT_BYTES) }
        catch (error) { if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) throw new RefusalError(`${reference} does not exist`); throw error }
    }
    const git = async (repository: typeof repositories[number], args: readonly string[]) => {
        const observed = await executeBounded(repository.root, ['git', ...args], directories)
        if (observed.kind !== 'executed' || observed.exitCode !== 0 || observed.truncated) throw new RefusalError(`${repository.identity}: ${probeFailure(`git ${args.join(' ')}`, observed)}`)
        return observed.stdout
    }
    let evaluatorAuthority: Promise<EvaluatorAuthority> | undefined
    const resolveEvaluator = async (): Promise<EvaluatorAuthority> => {
        evaluatorAuthority ??= authorities.evaluator ? Promise.resolve(authorities.evaluator)
            : authorities.resolveEvaluator ? authorities.resolveEvaluator() : Promise.reject(new RefusalError('Authenticated evaluator surface is unavailable'))
        try { return await evaluatorAuthority }
        catch (error) { evaluatorAuthority = undefined; throw error }
    }
    let browserAuthority: Promise<BrowserAuthority> | undefined
    const resolveBrowser = async (): Promise<BrowserAuthority> => {
        browserAuthority ??= authorities.browser ? Promise.resolve(authorities.browser)
            : authorities.resolveBrowser ? authorities.resolveBrowser() : Promise.reject(new RefusalError('browser application projection is unavailable'))
        try { return await browserAuthority }
        catch (error) { browserAuthority = undefined; throw error }
    }
    const browser = async (kind: BrowserCommandKind, role?: string): Promise<BrowserCommandInput> => {
        if (!config.browser) throw new RefusalError('browser application projection is unavailable')
        const authority = await resolveBrowser()
        return { runtime: authority.runtime, client: authority.client, policy: authority.policy, kind,
            ...(authority.state ? { state: authority.state } : {}), ...(role ? { role } : {}) }
    }
    const gate = async (request: WorkApplicationGateRequest) => {
        if (!authorities.testing || !config.testing) throw new RefusalError('testing gate projection is unavailable')
        const declared = authorities.testing.registry.gates.find(row => row.id === request.gate); const stages = request.mode === 'full' ? declared?.stages : undefined
        const selected = stages ?? declared?.stages ?? []
        const needsStack = selected.some(id => authorities.testing!.registry.stages.find(stage => stage.id === id)?.requiresStack)
        const runtime = needsStack ? await authorities.testing.runtime?.() : undefined
        const stack = needsStack ? runtime?.stack ?? { state: 'unavailable' as const, reason: 'authenticated runtime observation is unavailable' } : undefined
        const dependencies: GateDependencies = runtime?.evidence
            ? { ...authorities.testing.dependencies, runtime: runtime.evidence }
            : authorities.testing.dependencies
        return { registry: authorities.testing.registry, request: { gate: request.gate, ...(stages ? { stages } : {}),
            ...(request.select ? { select: request.select } : {}), staged: request.mode === 'staged', ...(stack ? { stack } : {}) }, dependencies }
    }
    const orderIds = async () => {
        let names: string[]
        try { names = readdirSync(contained(root, 'workorders', true)) }
        catch (error) { if (hasErrorCode(error, 'ENOENT')) return []; throw error }
        return names.filter(name => name.endsWith('.md') && WORK_ORDER_ID.test(name.slice(0, -3))).map(name => name.slice(0, -3)).sort()
    }
    const readOrder = async (id: string): Promise<ParsedFile<WorkOrder>> => {
        let bytes: Buffer
        try { bytes = readBounded(root, `workorders/${id}.md`, 65_536) }
        catch (error) { return { ok: false, problems: [`workorders/${id}.md cannot be read: ${errorCause(error)}`] } }
        return parseWorkOrder(bytes, id)
    }
    const runCheck = async (criterion: string, check: WorkOrderCheck): Promise<CheckResult> => {
        if (Array.isArray(check)) {
            // A check is the product's own test command, so it runs like a product test stage.
            const observed = await executeBounded(root, check, directories, config.verificationTimeoutSeconds * 1_000,
                { kind: 'declared', env: authorities.declaredEnvironment ?? {}, timeoutField: VERIFICATION_TIMEOUT_FIELD })
            return observed.kind === 'executed'
                ? { criterion, kind: 'argv', passed: observed.exitCode === 0, outcome: `exit ${observed.exitCode}${observed.truncated ? ' (output truncated to its end)' : ''}`,
                    output: outputTail(`${observed.stdout}${observed.stderr}`) }
                : { criterion, kind: 'argv', passed: false, outcome: `did not run: ${observed.reason}`.slice(0, 256), output: '' }
        }
        try {
            const prepared = await gate({ operation: 'test-run', gate: check.gate, mode: 'canonical',
                ...check.select ? { select: { kind: check.select.slice(0, check.select.indexOf(':')) as 'spec', value: check.select.slice(check.select.indexOf(':') + 1) } } : {} })
            const run = await runGate(prepared.registry, prepared.request, prepared.dependencies)
            return { criterion, kind: 'gate', passed: run.satisfiesGate, outcome: `gate ${check.gate}: ${run.verdict}`.slice(0, 256), output: outputTail(run.reasons.join('\n') || run.verdict) }
        } catch (error) {
            return { criterion, kind: 'gate', passed: false, outcome: `gate ${check.gate} did not run`, output: outputTail(errorCause(error)) }
        }
    }
    const heads = async () => Object.fromEntries(await Promise.all(repositories.map(async repository => {
        const head = (await git(repository, ['rev-parse', '--verify', 'HEAD'])).trim()
        if (!/^[a-f0-9]{40,64}$/.test(head)) throw new RefusalError(`${repository.identity} at ${repository.root} has no commit yet; commit once there`)
        return [repository.key, head] as const
    })))
    // What changed since the base: committed, staged, unstaged and untracked files, each with its diff
    // or new content. A credential-shaped or declared-instance path is listed but its content is withheld.
    const changes = async (base: Readonly<Record<string, string>>): Promise<readonly ChangedFile[]> => {
        const files: ChangedFile[] = []
        let budget = MAX_CHANGE_BYTES
        // What sync generates is cockpit's, not the order's: the paths the ownership manifest lists.
        const generated = new Set<string>()
        try {
            const manifest = JSON.parse(readBounded(root, '.cockpit/generated-environment-ownership.json', MAX_DOCUMENT_BYTES).toString('utf8')) as { entries?: unknown }
            if (Array.isArray(manifest.entries)) for (const entry of manifest.entries) if (typeof (entry as { path?: unknown })?.path === 'string') generated.add((entry as { path: string }).path)
        } catch (error) {
            if (error instanceof SyntaxError) throw new RefusalError('.cockpit/generated-environment-ownership.json is not JSON; run npx --no cockpit sync --config <your cockpit.toml>')
            if (!hasErrorCode(error, 'ENOENT')) throw error
        }
        for (const repository of repositories) {
            const from = base[repository.key] ?? 'HEAD'
            const tracked = (await git(repository, ['diff', '--name-status', '-z', '--no-renames', from, '--'])).split('\0').filter(Boolean)
            const rows: [status: string, path: string, untracked: boolean][] = []
            for (let index = 0; index + 1 < tracked.length; index += 2) rows.push([tracked[index]!, tracked[index + 1]!, false])
            for (const path of (await git(repository, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) rows.push(['A', path, true])
            for (const [status, path, untracked] of rows) {
                if (repository.key === '.' && (excludedRepositoryPath(path, COCKPIT_WRITTEN) || generated.has(path))) continue
                let diff: string
                try {
                    admitRepositoryPath(repository.root, repository.identity, path, repository.sensitivePaths, browserAuthenticationTargets)
                    const observed = untracked
                        ? { kind: 'executed' as const, stdout: readBounded(repository.root, path, MAX_DIFF_BYTES).toString('utf8') }
                        : await executeBounded(repository.root, ['git', 'diff', '--no-ext-diff', from, '--', path], directories, 30_000,
                            { kind: 'declared', env: {}, timeoutField: VERIFICATION_TIMEOUT_FIELD })
                    diff = observed.kind === 'executed' ? observed.stdout : `(diff unavailable: ${observed.reason})`
                } catch (error) {
                    if (!(error instanceof RefusalError)) throw error
                    diff = `(content withheld: ${error.message})`
                }
                const bounded = Buffer.byteLength(diff) > Math.min(MAX_DIFF_BYTES, budget) ? `${Buffer.from(diff).subarray(0, Math.min(MAX_DIFF_BYTES, budget)).toString('utf8')}\n(diff cut at its bound)` : diff
                budget = Math.max(0, budget - Buffer.byteLength(bounded))
                files.push({ path: qualified(repository.key, path), status, diff: bounded })
            }
        }
        return files
    }
    const gradeIndependently = async (subject: GradingSubject): Promise<GradingResult> => {
        let evaluator: EvaluatorAuthority
        try { evaluator = await resolveEvaluator() }
        catch (error) { return { refusal: { code: 'EVALUATOR_UNAVAILABLE', message: errorCause(error), fix: `run ${cockpitCommand('sync', { config: config.source.path })}` } } }
        if (evaluator.restriction !== 'instructed' || sha256Hex(evaluator.bytes) !== evaluator.sha256) {
            return { refusal: { code: 'EVALUATOR_UNAVAILABLE', message: 'the shipped evaluator instructions could not be authenticated', fix: `run ${cockpitCommand('sync', { config: config.source.path })}` } }
        }
        // The shipped instructions carry notes to cockpit's maintainers that are not addressed to the grader.
        const result = await evaluate({ chain: evaluator.chain, role: 'grader',
            document: gradingDocument(stripDevelopmentMarkers(evaluator.bytes), root, subject), schema: gradingSchema(subject.criteria),
            repository: root, timeoutMs: config.evaluatorTimeoutSeconds * 1_000, timeoutField: 'work.evaluator_timeout_seconds',
            executableDirectories: evaluator.executableDirectories ?? directories, environment: evaluator.environment ?? authorities.env })
        if (result.kind === 'refusal') return { refusal: { code: result.code, message: result.message, fix: result.fix } }
        const read = readGradingAnswer(result.value, subject)
        if ('problem' in read) return { refusal: { code: ENVIRONMENT_CODES.EVALUATOR_ANSWER_INVALID, message: read.problem, fix: 'rerun the command; if the answer is refused again, list another evaluator first in work.evaluators' } }
        return { criteria: read.criteria, evaluator: { tool: result.tool, fallbacks: result.fallbacks } }
    }
    const composition: WorkApplicationComposition = {
        policy: config.policy, caps: { wip: config.wipCap, attempts: config.attemptCap }, env: authorities.env,
        store: createWorkStore(root), recordedPolicy: () => readRecordedPolicy(root), orderIds, readOrder,
        readCriteriaFile: async (path: string) => parseCriteriaFile(readBounded(root, path, 65_536)),
        sourceDigests: async (order: Pick<WorkOrder, 'criteria'>) => Object.fromEntries(order.criteria.flatMap(row => row.source ? [row.source] : [])
            .map(source => [source, sha256Hex(readSource(source))])),
        heads, runCheck, changes, evaluate: gradeIndependently, browser, gate,
    }
    issuedCompositions.add(composition)
    return composition
}

export type ConfiguredWorkApplicationCompositionResult =
    | Readonly<{ kind: 'complete'; composition: WorkApplicationComposition }>
    | Readonly<{ kind: 'refusal'; reason: string }>

function sameSource(left: SourceProvenance, right: SourceProvenance): boolean {
    return left.path === right.path && left.byteLength === right.byteLength && left.sha256 === right.sha256
}

function captureConfiguredInput(value: unknown): Readonly<{ configPath: string; env: Readonly<Record<string, string | undefined>> }> | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')
            || Object.keys(descriptors).sort().join('\0') !== ['configPath', 'env'].join('\0')
            || Object.values(descriptors).some(row => !('value' in row))) return undefined
        const configPath = descriptors.configPath!.value
        const rawEnvironment = descriptors.env!.value
        if (typeof configPath !== 'string' || !isAbsolute(configPath) || resolve(configPath) !== configPath
            || !rawEnvironment || typeof rawEnvironment !== 'object' || Array.isArray(rawEnvironment) || isProxy(rawEnvironment)) return undefined
        const environmentDescriptors = Object.getOwnPropertyDescriptors(rawEnvironment)
        if (Reflect.ownKeys(environmentDescriptors).some(key => typeof key !== 'string')
            || Object.values(environmentDescriptors).some(row => !('value' in row)
                || row.value !== undefined && typeof row.value !== 'string')) return undefined
        return { configPath, env: Object.fromEntries(Object.entries(environmentDescriptors).map(([key, row]) => [key, row.value])) }
    } catch { return undefined } // A throwing accessor or proxy trap on caller-supplied input is malformed input the caller refuses.
}

function declaredCommandEnvironment(environment: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
    return Object.fromEntries(INHERITED_TOOL_ENVIRONMENT.flatMap(name => {
        const value = environment[name]
        return typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= 4_096 ? [[name, value]] : []
    }))
}

function productGateDependencies(root: string, source: SourceProvenance,
    repositories: readonly Readonly<{ identity: string; root: string; sensitivePaths: ReadonlySet<string>; forbiddenTargets: ReadonlySet<string> }>[],
    stageEnvironment: Readonly<Record<string, string>>, executableDirectories?: readonly string[]): GateDependencies {
    return {
        subject: async () => {
            if (!exactSource(source)) throw new RefusalError('configuration source changed during product gate')
            const observed = []
                        for (const repository of repositories) {
                observed.push(await observeRepositorySubject(repository, repository.root === root ? COORDINATION_PATHS : new Set(),
                    executableDirectories ?? DEFAULT_EXECUTABLE_DIRECTORIES, repository.sensitivePaths, repository.forbiddenTargets))
            }
            return sha256Hex(JSON.stringify({ source: sha256Hex(readBounded(root, relative(root, source.path))), repositories: observed }))
        },
        runProductTool: async (invocation: ProductGateInvocation) => {
            const observed = await executeBounded(root, invocation.command, executableDirectories ?? DEFAULT_EXECUTABLE_DIRECTORIES,
                invocation.timeoutSeconds * 1_000, { kind: 'declared', env: stageEnvironment, timeoutField: 'testing.stages[].timeout_seconds' })
            if (observed.kind !== 'executed') return { kind: 'unavailable' as const, reason: observed.reason }
            return { kind: 'executed' as const, exitCode: observed.exitCode, signal: null, outputBytes: observed.observedBytes ?? 0,
                assertion: observed.exitCode === 0 ? 'passed' as const : 'failed' as const }
        },
    }
}

function executableDirectoriesFromEnvironment(environment: Readonly<Record<string, string | undefined>>): readonly string[] {
    const candidates = (environment.PATH ?? '').split(delimiter).filter(Boolean)
    if (!candidates.length || candidates.length > 64) throw new RefusalError('bounded executable search path is unavailable')
    const directories: string[] = []
    for (const candidate of candidates) {
        if (!isAbsolute(candidate) || resolve(candidate) !== candidate) continue
        try {
            const canonical = realpathSync(candidate)
            if (canonical === candidate && lstatSync(candidate).isDirectory() && !directories.includes(candidate)) directories.push(candidate)
        } catch (error) {
            // A PATH entry that is absent or unreachable holds nothing a shell would run, so it is skipped as a shell skips it.
            if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP')) continue
            throw error
        }
    }
    if (!directories.length) throw new RefusalError('canonical executable search directories are unavailable')
    return directories
}

export async function createConfiguredWorkApplicationComposition(input: Readonly<{
    configPath: string
    env: Readonly<Record<string, string | undefined>>
}>): Promise<ConfiguredWorkApplicationCompositionResult> {
    const captured = captureConfiguredInput(input)
    if (!captured) return { kind: 'refusal', reason: 'Configured work application requires a closed canonical config path and environment' }
    try {
        const projection = await prepareWorkApplicationAuthorities({ configPath: captured.configPath })
        if (projection.kind !== 'work-application-authorities') {
            return { kind: 'refusal', reason: projection.diagnostics.map(row => `${row.code}: ${row.message}`).join('; ') }
        }
        const authority = consumeWorkApplicationAuthorities(projection)
        if (!authority || !exactSource(authority.workEnvironment.source)) {
            return { kind: 'refusal', reason: 'Current generated work application authority is unavailable' }
        }
        const config: WorkEnvironmentApplicationConfig = authority.workEnvironment
        if (config.source.path !== captured.configPath || config.cockpitRoot !== dirname(captured.configPath)) {
            return { kind: 'refusal', reason: 'Generated work application authority does not match the selected configuration' }
        }
        const executableDirectories = executableDirectoriesFromEnvironment(captured.env)
        const declaredEnvironment = declaredCommandEnvironment(captured.env)
        const resolveEvaluator = async (): Promise<EvaluatorAuthority> => ({ path: authority.evaluator.path, bytes: authority.evaluator.bytes,
            sha256: authority.evaluator.sha256, restriction: authority.evaluator.restriction, executableDirectories,
            chain: await locateEvaluators(config.evaluators, executableDirectories), environment: captured.env })
        const resolveBrowser = async (): Promise<BrowserAuthority> => {
            if (!config.browser) throw new RefusalError('browser application projection is unavailable')
            const current = await prepareGeneratedEnvironmentCurrentness({ configPath: captured.configPath })
            if (current.outcome.kind !== 'complete' || current.outcome.result.dryRun) {
                throw new RefusalError('browser requires a current generated publication and active retained lease')
            }
            const projected = projectWorkApplicationAuthorities(current.outcome.result.application)
            const currentAuthority = projected && consumeWorkApplicationAuthorities(projected)
            const browserAuthority = currentAuthority?.browser
            if (!browserAuthority || currentAuthority.workEnvironment.source.sha256 !== config.source.sha256
                || !exactSource(currentAuthority.workEnvironment.source)) throw new RefusalError('current browser application authority is unavailable')
            if (captured.env.HOME !== process.env.HOME || captured.env.XDG_STATE_HOME !== process.env.XDG_STATE_HOME) {
                throw new RefusalError('browser state environment differs from canonical generated currentness')
            }
            const lifecycle = createLifecycleCommandAdapters({ configPath: captured.configPath, env: captured.env,
                sessionId: 'cockpit-work-application-read-only', timeoutMs: 30_000 }, executeProbe)
            const loaded = await lifecycle.load({ configPath: captured.configPath })
            if (loaded.kind !== 'complete' || !sameSource(loaded.result.source, config.source)
                || loaded.result.namespace.paths.lifecycle(loaded.result.stackId).path
                    !== browserAuthority.namespace.paths.lifecycle(loaded.result.stackId).path) throw new RefusalError('authenticated browser lifecycle authority is unavailable')
            const stored = await readState(browserAuthority.namespace.paths.lifecycle(loaded.result.stackId))
            if (stored.kind !== 'complete') throw new RefusalError('browser lifecycle state is unavailable')
            const record = decodeLifecycleRecord(stored.value, loaded.result)
            if (!record) throw new RefusalError('browser lifecycle state is malformed')
            const retained = await observeRetainedPortFamily({ namespace: browserAuthority.namespace, stackId: loaded.result.stackId,
                holderId: record.value.holderId, checkoutId: loaded.result.checkoutId, config: loaded.result.ports })
            if (retained.kind !== 'complete') throw new RefusalError('retained application ports are unavailable')
            const entrypoints = deriveEntrypoints({ lease: retained.lease, declarations: loaded.result.entrypointDerivatives })
            if (entrypoints.kind !== 'complete') throw new RefusalError('declared application routes are unavailable')
            const runtime = browserAuthority.runtime
            const mcp = browserAuthority.mcp
            const connection = runtime.connection
            if (connection.kind === 'remote' && mcp.args.filter(argument => argument === connection.endpoint).length !== 1) {
                throw new RefusalError('browser MCP declaration does not uniquely bind its current endpoint')
            }
            const origins = entrypoints.values.filter(row => row.kind === 'origin')
            if (origins.length !== 1) throw new RefusalError('browser application requires exactly one declared HTTP origin')
            const originUrl = new URL(origins[0]!.value)
            const declaredNames = new Set(loaded.result.entrypointDerivatives.map(row => row.name))
            const routeNames = new Map<string, string>()
            const routesByUrl = new Map<string, Readonly<{ name: string; path: string }>>()
            for (const row of entrypoints.values) {
                if (!declaredNames.has(row.name)) continue
                let url: URL
                try { url = new URL(row.value) } catch { continue } // A value that is not a URL is no browser route; an empty route set is refused below.
                if (url.origin !== originUrl.origin) continue
                const prior = routeNames.get(row.name)
                if (prior !== undefined && prior !== url.href) throw new RefusalError('browser application routes are missing or ambiguous')
                routeNames.set(row.name, url.href)
                const policyUrl = `${url.origin}${url.pathname}${url.search}`
                if (!routesByUrl.has(policyUrl)) routesByUrl.set(policyUrl, { name: row.name, path: `${url.pathname}${url.search}` })
            }
            const routes = [...routesByUrl.values()]
            if (!routes.length) throw new RefusalError('browser application routes are missing or ambiguous')
            const skillBytes = browserAuthority.skillTemplate.bytes
            if (sha256Hex(skillBytes) !== browserAuthority.skillTemplate.sha256) throw new RefusalError('browser skill template authority is malformed')
            const harnessRows = config.browser.harnesses.flatMap(row => isGuardSurfaceTarget(row.target)
                ? [{ target: row.target, version: row.version }] : [])
            const rendered = renderBrowserSurfaces({ runtime, cockpitDirectory: config.cockpitRoot,
                harnesses: harnessRows, mcp, approved: true,
                testPackage: observeBrowserProjectPackage({ runtime, cockpitDirectory: config.cockpitRoot,
                    artifactRoot: runtime.cliArtifactRoot }), skillTemplate: skillBytes })
            const client = [...rendered.clients].sort((left, right) => left.target.localeCompare(right.target))[0]
            if (!client) {
                const measured = measuredBrowserHarnessVersions()
                const declared = harnessRows.length ? harnessRows.map(row => `${row.target} ${row.version}`).join(', ') : 'no harness cockpit can drive'
                throw new RefusalError(`authenticated browser project client is unavailable: no browser.harnesses row is at a measured version `
                    + `(declared: ${declared}; measured: ${Object.entries(measured).map(([target, version]) => `${target} ${version}`).join(', ')}); `
                    + `set a browser.harnesses row to a measured target and version in ${captured.configPath}, then run ${cockpitCommand('sync', { config: captured.configPath })}`)
            }
            return { runtime, client,
                policy: issueBrowserRoutePolicy(runtime, { origin: originUrl.origin, routes }),
                ...(runtime.authentication.posture === 'real' ? { state: {
                    namespace: browserAuthority.namespace, stackId: loaded.result.stackId, ownerId: record.value.holderId,
                } } : {}) }
        }
        const configuredSiblingsRoot = resolve(config.cockpitRoot, config.siblingsRoot)
        const gateBrowserAuthenticationTargets = new Set((config.browser?.authentication.states ?? []).map(row => resolve(config.cockpitRoot, row.path)))
        const gateRepositories = [
            { identity: config.cockpitName, root: config.cockpitRoot,
                sensitivePaths: repositoryEnvironmentInstancePaths(config.cockpitRoot, configuredSiblingsRoot, config.siblings),
                forbiddenTargets: gateBrowserAuthenticationTargets },
            ...config.siblings.map(row => ({ identity: `siblings/${row.slug}`, root: resolve(configuredSiblingsRoot, row.dir),
                sensitivePaths: repositoryEnvironmentInstancePaths(resolve(configuredSiblingsRoot, row.dir), configuredSiblingsRoot, config.siblings),
                forbiddenTargets: gateBrowserAuthenticationTargets })),
        ]
        const reads = createReadCommandAdapters({ configPath: captured.configPath, env: captured.env,
            sessionId: 'cockpit-work-gate-read-only', timeoutMs: 30_000 }, executeProbe)
        const gateRuntime = async (): Promise<Readonly<{
            stack: NonNullable<GateRequest['stack']>
            evidence?: Readonly<{ snapshot: EnvironmentSnapshot; capture: () => Promise<RuntimeEvidence> }>
        }>> => {
            try {
                const initial = await reads.environment.observe({ configPath: captured.configPath })
                return { stack: { state: 'available' as const }, evidence: {
                    snapshot: initial.snapshot,
                    capture: async () => (await reads.environment.observe({ configPath: captured.configPath })).evidence,
                } }
            } catch (error) {
                return { stack: { state: 'unavailable' as const,
                    reason: `authenticated runtime observation failed: ${errorCause(error)}` } }
            }
        }
        const composition = createWorkApplicationComposition(config, {
            env: captured.env, executableDirectories, declaredEnvironment,
            resolveEvaluator,
            ...(config.browser ? { resolveBrowser } : {}),
            testing: { registry: authority.testing.registry,
                dependencies: productGateDependencies(config.cockpitRoot, config.source, gateRepositories,
                    declaredEnvironment, executableDirectories), runtime: gateRuntime },
        })
        return { kind: 'complete', composition }
    } catch (error) {
        return { kind: 'refusal', reason: `Configured work application is unavailable: ${errorCause(error)}` }
    }
}

