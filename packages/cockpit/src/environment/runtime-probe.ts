import { randomBytes } from 'node:crypto'
import { sha256Hex } from '../sha256.js'
import { open, readFile, readdir, realpath, rm, mkdir, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { admitLocalDockerEndpoint } from './docker-endpoint.js'
import { authenticatedExecutionOutcome, executeProbe, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { ENVIRONMENT_CODES, errorCause, isMissing, RefusalError, type ExecutionStep, type StackId } from './contract.js'
import { isResolvedDockerExecutable, isResolvedGitExecutable, type ResolvedExecutable } from './executable.js'
import { runDown, runReset } from './application/destructive.js'
import { runSleep, runUp } from './application/lifecycle.js'
import { runLogs } from './application/logs.js'
import { createDestructiveCommandAdapters } from './destructive-composition.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { createReadCommandAdapters } from './read-composition.js'
import { decodeCoordinationRecord, readActiveStackInventory, type ActiveStackInventoryResult } from './claims.js'
import { readState, type StateRecord, type StateResult } from './state.js'
import { COMPOSE_OWNERSHIP_FILE, renderComposeOwnership } from './compose-ownership.js'
import { isVersionFloor, issueRuntimeMeasurementProbeAuthority, observeDockerRuntime, versionAtLeast } from './runtime.js'
import { PROBE_OWNER_LABEL, isProbeOwner } from './runtime-probe-residue.js'
import { exactKeys } from '../exact-keys.js'

export interface RuntimeProbeRequest {
    readonly executable: ResolvedExecutable
    readonly gitExecutable: ResolvedExecutable
    readonly cwd: string
    /** The measuring cockpit's name; the probe's Compose project carries it so its resources are attributable. */
    readonly projectPrefix: string
    /** The measuring process, labelled on every probe resource so a later measure can tell whether it still runs. */
    readonly owner: string
    readonly env: Readonly<Record<string, string>>
    readonly composeFloor: string
    readonly measuredOn: string
    readonly timeoutMs: number
    readonly image: { readonly reference: string; readonly id: string }
    readonly installedModule: { readonly canonicalPath: string; readonly sha256: string }
}

export interface RuntimeProbeEvidence {
    readonly batchId: string
    readonly installedModuleSha256: string
    readonly runtimeExecutableSha256: string
    readonly candidateSha256: string
    readonly brokenControlSha256: string
    readonly projectName: string
    readonly runtimePath: string
    readonly runtimeVersion: string | null
    readonly composeVersion: string | null
    readonly operatingSystem: string
    readonly architecture: string
    readonly startedAt: string
    readonly finishedAt: string
    readonly expiresAt: string
    readonly candidateChecks: Readonly<Record<string, boolean>>
    readonly brokenControlRejected: boolean
    readonly cleanup: {
        readonly ownedSurvivors: readonly string[]
        readonly resourcesEqual: boolean
        readonly claimsEqual: boolean
        readonly leasesEqual: boolean
    }
}

export interface RuntimeProbeVerdict {
    readonly status: 'supported' | 'unavailable'
    readonly runtime: { readonly name: string; readonly version: string } | null
    readonly composeVersion: string | null
    readonly composeFloor: string
    readonly measuredOn: string
    readonly candidate: 'passed' | 'failed'
    readonly brokenControl: 'rejected' | 'accepted' | 'inconclusive'
    readonly evidence: RuntimeProbeEvidence | null
    readonly operatorAction: null | {
        readonly required: true
        readonly code: typeof ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE | typeof ENVIRONMENT_CODES.RUNTIME_PROBE_TIMEOUT
        readonly reason: string
    }
}

const SHA256 = /^[a-f0-9]{64}$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/
// A cockpit name, bounded so the probe's project and resource names stay short.
const PROJECT_PREFIX = /^[a-z0-9][a-z0-9-]{0,39}$/
const SAFE_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DOCKER_HOST', 'DOCKER_CONTEXT'])
const MAX_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 1_048_576
const PROBE_WINDOW_MS = 300_000
const CLEANUP_RESERVE_MS = 90_000
// The candidate's data volume: its Compose key, which `resettable_volumes` names.
const PROBE_VOLUME_KEY = 'probe_data'

function validDate(value: string): boolean {
    const match = DATE.exec(value)
    if (match === null) return false
    const date = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}


function unavailable(
    input: Partial<RuntimeProbeRequest>,
    reason: string,
    timedOut = false,
    evidence: RuntimeProbeEvidence | null = null,
    brokenControl: RuntimeProbeVerdict['brokenControl'] = 'inconclusive',
): RuntimeProbeVerdict {
    return {
        status: 'unavailable', runtime: null, composeVersion: null,
        composeFloor: typeof input.composeFloor === 'string' ? input.composeFloor : '',
        measuredOn: typeof input.measuredOn === 'string' ? input.measuredOn : '',
        candidate: 'failed', brokenControl, evidence,
        operatorAction: {
            required: true,
            code: timedOut ? ENVIRONMENT_CODES.RUNTIME_PROBE_TIMEOUT : ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
            reason,
        },
    }
}

function captureRequest(value: unknown): RuntimeProbeRequest | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || !exactKeys(value, ['executable', 'gitExecutable', 'cwd', 'projectPrefix', 'owner', 'env', 'composeFloor', 'measuredOn', 'timeoutMs', 'image', 'installedModule'])) return undefined
    const input = value as Partial<RuntimeProbeRequest>
    if (!isResolvedDockerExecutable(input.executable)
        || !isResolvedGitExecutable(input.gitExecutable)
        || typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || normalize(input.cwd) !== input.cwd || input.cwd.includes('\0')
        || typeof input.projectPrefix !== 'string' || !PROJECT_PREFIX.test(input.projectPrefix)
        || typeof input.owner !== 'string' || !isProbeOwner(input.owner)
        || input.env === null || typeof input.env !== 'object' || Array.isArray(input.env)
        || Object.entries(input.env).some(([name, item]) => !SAFE_ENV.has(name) || typeof item !== 'string' || item.includes('\0'))
        || typeof input.composeFloor !== 'string' || !isVersionFloor(input.composeFloor)
        || typeof input.measuredOn !== 'string' || !validDate(input.measuredOn)
        || input.measuredOn !== new Date().toISOString().slice(0, 10)
        || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs! < 1 || input.timeoutMs! > MAX_TIMEOUT_MS
        || input.image === null || typeof input.image !== 'object' || Array.isArray(input.image)
        || !exactKeys(input.image, ['reference', 'id']) || typeof input.image.reference !== 'string'
        || typeof input.image.id !== 'string' || !IMAGE_ID.test(input.image.id)
        || input.image.reference !== input.image.id
        || input.installedModule === null || typeof input.installedModule !== 'object' || Array.isArray(input.installedModule)
        || !exactKeys(input.installedModule, ['canonicalPath', 'sha256'])
        || typeof input.installedModule.canonicalPath !== 'string' || !isAbsolute(input.installedModule.canonicalPath)
        || normalize(input.installedModule.canonicalPath) !== input.installedModule.canonicalPath
        || typeof input.installedModule.sha256 !== 'string' || !SHA256.test(input.installedModule.sha256)) return undefined
    const captured = input as RuntimeProbeRequest
    return {
        ...captured,
        executable: { ...captured.executable },
        gitExecutable: { ...captured.gitExecutable },
        env: { ...captured.env },
        image: { ...captured.image },
        installedModule: { ...captured.installedModule },
    }
}

function confined(root: string, target: string): boolean {
    const path = relative(root, target)
    return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)
}

function decode(outcome: ExecuteProbeOutcome): string | undefined {
    if (outcome.kind !== 'complete') return undefined
    // Preserve endpoint-edge whitespace so locality admission can refuse identity aliases.
    try { return new TextDecoder('utf-8', { fatal: true }).decode(outcome.stdout).replace(/\r?\n$/, '') } catch {
        // Undecodable output is reported by each caller as an unreadable result.
        return undefined
    }
}

function refusalCategory(outcome: ExecuteProbeOutcome): string {
    if (outcome.kind !== 'refusal') return 'unreadable-output'
    let stderr = ''
    try { stderr = new TextDecoder('utf-8', { fatal: true }).decode(outcome.stderr) } catch {
        // Undecodable stderr cannot be categorised; the refusal code alone is the category.
        return outcome.code
    }
    if (/unknown flag/i.test(stderr)) return `${outcome.code}:unknown-flag`
    if (/cannot|incompatible|conflict/i.test(stderr)) return `${outcome.code}:incompatible-options`
    if (/services\.probe\.labels/i.test(stderr)) return `${outcome.code}:service-labels`
    if (/volumes\..*labels/i.test(stderr)) return `${outcome.code}:volume-labels`
    if (/networks\..*labels/i.test(stderr)) return `${outcome.code}:network-labels`
    if (/services\.probe\.command/i.test(stderr)) return `${outcome.code}:service-command`
    if (/services\.probe\.volumes/i.test(stderr)) return `${outcome.code}:service-volumes`
    if (/services\.probe\.healthcheck/i.test(stderr)) return `${outcome.code}:service-healthcheck`
    if (/no such file|cannot.*file|failed to read/i.test(stderr)) return `${outcome.code}:unreadable-artifact`
    if (/additional propert/i.test(stderr)) return `${outcome.code}:unsupported-field`
    if (/yaml|validat|invalid|parse|decode/i.test(stderr)) return `${outcome.code}:invalid-config`
    if (/no such image|not found/i.test(stderr)) return `${outcome.code}:missing-image`
    return outcome.code
}

function generatedArtifactDetail(outcome: ExecuteProbeOutcome): string {
    if (outcome.kind !== 'refusal') return 'unreadable output'
    try {
        const first = new TextDecoder('utf-8', { fatal: true }).decode(outcome.stderr).split('\n', 1)[0] ?? ''
        return first.replaceAll(/[a-f0-9]{32,}/g, '<identity>').replaceAll(/\/[\w./-]+/g, '<path>').slice(0, 256)
    } catch {
        // Undecodable stderr has no first line to show; the category stands in for it.
        return refusalCategory(outcome)
    }
}

interface ProbeRunner {
    readonly run: (
        id: string,
        args: readonly string[],
        artifact?: { path: string; sha256: string },
        executable?: ResolvedExecutable,
    ) => Promise<ExecuteProbeOutcome>
    readonly timedOut: () => boolean
}

function runner(input: RuntimeProbeRequest, batchId: string, deadline: number): ProbeRunner {
    let sawTimeout = false
    return {
        timedOut: () => sawTimeout,
        run: async (id, args, artifact, selectedExecutable = input.executable) => {
            const remainingMs = deadline - Date.now()
            if (remainingMs <= 0) {
                sawTimeout = true
                throw new RefusalError('the absolute runtime observation window expired before command spawn')
            }
            const argv = [selectedExecutable.canonicalPath, ...args] as [string, ...string[]]
            const artifactIndexes = artifact === undefined ? [] : argv.flatMap((part, index) => part === artifact.path ? [index] : [])
            const step: ExecutionStep = {
                id: `runtime:capability:${id}`,
                argv, argv0: selectedExecutable.invocationPath,
                cwd: input.cwd, env: input.env, timeoutMs: Math.min(input.timeoutMs, remainingMs),
                stdoutLimitBytes: OUTPUT_LIMIT, stderrLimitBytes: OUTPUT_LIMIT,
                paths: artifact === undefined ? [] : [artifact.path], ports: [],
                labels: { batchId, subject: id },
                expected: [],
                consumedFiles: [
                    {
                        path: selectedExecutable.canonicalPath, sha256: selectedExecutable.sha256,
                        maxBytes: 536_870_912, argvIndexes: [0], executable: true,
                        executionMode: selectedExecutable.executionMode,
                    },
                    ...(artifact === undefined ? [] : [{
                        path: artifact.path, sha256: artifact.sha256, maxBytes: 1_048_576,
                        argvIndexes: artifactIndexes, executable: false as const,
                    }]),
                ],
                filesystemChecks: [], compensation: [],
            }
            const outcome = await executeProbe(step)
            if (!authenticatedExecutionOutcome(outcome, step)) throw new RefusalError('runtime probe execution outcome is unauthenticated')
            if (outcome.kind === 'refusal' && outcome.code === ENVIRONMENT_CODES.EXECUTION_TIMEOUT) sawTimeout = true
            return outcome
        },
    }
}

const composeArgs = (input: RuntimeProbeRequest, projectName: string, file: string): string[] => [
    'compose', '--project-directory', input.cwd, '--file', file, '--project-name', projectName,
]

// The daemon is often shared with other stacks, so the inventory covers only what this probe can
// own: anything carrying its owner label or its Compose project label. Compose labels everything it
// creates for a project, including an implicit default network the owner label never reaches.
async function inventory(run: ProbeRunner['run'], scope: string, labels: readonly string[]): Promise<Readonly<Record<string, readonly string[]>> | undefined> {
    const commands = labels.flatMap((label, index) => {
        const filter = ['--filter', `label=${label}`]
        return [
            ['containers', `${index}`, ['ps', '-aq', ...filter]],
            ['volumes', `${index}`, ['volume', 'ls', '-q', ...filter]],
            ['networks', `${index}`, ['network', 'ls', '-q', ...filter]],
            ['images', `${index}`, ['image', 'ls', '--no-trunc', '--quiet', ...filter]],
        ] as const
    })
    const found: Record<string, Set<string>> = { containers: new Set(), volumes: new Set(), networks: new Set(), images: new Set() }
    const outcomes = await Promise.all(commands.map(async ([kind, index, args]) => [kind, await run(`${scope}:${kind}:${index}`, args)] as const))
    for (const [kind, outcome] of outcomes) {
        const text = decode(outcome)
        if (text === undefined) return undefined
        for (const id of text.split('\n').filter(Boolean)) found[kind]!.add(id)
    }
    return Object.fromEntries(Object.entries(found).map(([kind, ids]) => [kind, [...ids].sort()]))
}

async function exactCleanup(run: ProbeRunner['run'], owned: Readonly<Record<string, readonly string[]>>): Promise<boolean> {
    let complete = true
    for (const id of owned.containers) complete = (await run(`fallback:container:${id.slice(0, 12)}`, ['container', 'rm', '--force', id])).kind === 'complete' && complete
    const detached = await Promise.all([
        ...owned.networks.map(async (id) => (await run(`fallback:network:${id.slice(0, 12)}`, ['network', 'rm', id])).kind === 'complete'),
        ...owned.volumes.map(async (id) => (await run(`fallback:volume:${id.slice(0, 12)}`, ['volume', 'rm', id])).kind === 'complete'),
    ])
    complete = detached.every(Boolean) && complete
    return complete
}

function stateSnapshot(value: unknown): string {
    return JSON.stringify(value)
}

function currentLeaseSnapshot(result: StateResult<StateRecord>, stackId: StackId): string | undefined {
    if (result.kind !== 'missing' && result.kind !== 'complete') return undefined
    const coordination = decodeCoordinationRecord(result.kind === 'complete' ? result.value : null, stackId)
    if (!coordination) return undefined
    return stateSnapshot(coordination.lease === null || coordination.lease.released ? null : coordination.lease)
}

export function currentCoordinationCleanupVerdict(
    beforeClaims: ActiveStackInventoryResult,
    afterClaims: ActiveStackInventoryResult,
    beforeLease: StateResult<StateRecord>,
    afterLease: StateResult<StateRecord>,
    stackId: StackId,
): Readonly<{ claimsEqual: boolean; leasesEqual: boolean }> {
    const beforeSnapshot = currentLeaseSnapshot(beforeLease, stackId)
    const afterSnapshot = currentLeaseSnapshot(afterLease, stackId)
    const inactive = stateSnapshot(null)
    return {
        claimsEqual: beforeClaims.kind === 'complete' && afterClaims.kind === 'complete'
            && stateSnapshot(beforeClaims.value) === stateSnapshot(afterClaims.value),
        leasesEqual: beforeSnapshot === inactive && afterSnapshot === inactive,
    }
}

function inventoriesEqual(left: Readonly<Record<string, readonly string[]>>, right: Readonly<Record<string, readonly string[]>>): boolean {
    return ['containers', 'volumes', 'networks', 'images'].every((kind) => JSON.stringify(left[kind]) === JSON.stringify(right[kind]))
}

function inventoryDifferences(left: Readonly<Record<string, readonly string[]>>, right: Readonly<Record<string, readonly string[]>>): readonly string[] {
    return ['containers', 'volumes', 'networks', 'images']
        .filter((kind) => JSON.stringify(left[kind]) !== JSON.stringify(right[kind]))
}

async function emptyDirectory(path: string): Promise<boolean> {
    try {
        const canonical = await realpath(path)
        return canonical === path && (await readdir(path)).length === 0
    } catch (error) {
        // A missing directory is not an empty one; any other failure reaches the caller's refusal.
        if (!isMissing(error)) throw error
        return false
    }
}

async function writeExclusive(path: string, contents: string): Promise<void> {
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(contents); await handle.sync() } finally { await handle.close() }
}

export async function probeRuntimeSupport(rawInput: RuntimeProbeRequest): Promise<RuntimeProbeVerdict> {
    const input = captureRequest(rawInput)
    if (input === undefined) return unavailable({}, 'runtime probe input is malformed or contains an unsafe environment')
    const modulePath = fileURLToPath(import.meta.url)
    try {
        const [canonicalModule, moduleBytes] = await Promise.all([realpath(modulePath), readFile(modulePath)])
        const installedSuffix = join('node_modules', '@b00dea', 'cockpit', 'dist', 'environment', 'runtime-probe.js')
        if (!canonicalModule.endsWith(installedSuffix)
            || canonicalModule !== input.installedModule.canonicalPath || sha256Hex(moduleBytes) !== input.installedModule.sha256
            || !await emptyDirectory(input.cwd)) {
            return unavailable(input, 'the installed module identity or disposable probe directory could not be authenticated')
        }
    } catch (error) { return unavailable(input, `the installed module identity could not be read: ${errorCause(error)}`) }

    const startedAt = new Date().toISOString()
    const deadline = Date.parse(startedAt) + PROBE_WINDOW_MS
    const mutationDeadline = deadline - CLEANUP_RESERVE_MS
    const expiresAt = new Date(deadline).toISOString()
    const batchId = randomBytes(16).toString('hex')
    // Named after the measuring cockpit so a survivor on a shared daemon says whose it is; the batch
    // keeps it disjoint from that cockpit's own stack and from any concurrent probe.
    const projectName = `${input.projectPrefix}-probe-${batchId}`
    const ownerLabel = `dev.b0dea.cockpit.probe=${batchId}`
    const ownerLabelName = 'dev.b0dea.cockpit.probe'
    const probeScope = [ownerLabel, `com.docker.compose.project=${projectName}`]
    const siblingsRoot = join(input.cwd, 'siblings')
    const siblingPath = join(siblingsRoot, 'probe')
    const homePath = join(dirname(input.cwd), `runtime-home-${batchId}`)
    const generatedName = `generated-${batchId}`
    const generatedPath = join(input.cwd, generatedName)
    const configPath = join(input.cwd, 'cockpit.toml')
    const inputMarkerPath = join(siblingPath, 'input')
    const outputMarkerPath = join(siblingPath, 'output')
    const candidatePath = join(input.cwd, `candidate-${batchId}.yml`)
    const controlPath = join(input.cwd, `broken-${batchId}.yml`)
    const defaultEnvironmentPath = join(input.cwd, '.env')
    const serviceEnvironmentPath = join(siblingPath, 'service.env')
    const ownershipPath = join(input.cwd, COMPOSE_OWNERSHIP_FILE)
    const volumeName = `${projectName}-data`
    if (![siblingsRoot, siblingPath, generatedPath, configPath, inputMarkerPath, outputMarkerPath, candidatePath, controlPath,
        defaultEnvironmentPath, serviceEnvironmentPath, ownershipPath]
        .every((path) => confined(input.cwd, path))) return unavailable(input, 'the disposable probe paths escaped their authenticated root')

    const marker = `cockpit-runtime-${randomBytes(16).toString('hex')}`
    const brokenSource = 'services:\n  probe: [\n'
    let candidateSource = 'services: {}\n'
    let candidateArtifact = { path: candidatePath, sha256: sha256Hex(candidateSource) }
    const controlArtifact = { path: controlPath, sha256: sha256Hex(brokenSource) }
    const execute = runner(input, batchId, mutationDeadline)
    const cleanupExecute = runner(input, batchId, deadline)
    const checks: Record<string, boolean> = {
        localRuntime: false, imagePreexisting: false, profile: false, topology: false,
        applicationUp: false, mountHostToContainer: false, mountContainerToHost: false,
        ownership: false, health: false, recovery: false, logs: false,
        resetPreview: false, configuredHostPathTeardown: false, teardown: false,
    }
    let pre: Readonly<Record<string, readonly string[]>> | undefined
    let collisionFree = false
    let runtimeVersion: string | undefined
    let composeVersion: string | undefined
    let profileProjected = false
    let brokenControl: RuntimeProbeVerdict['brokenControl'] = 'inconclusive'
    let resourcesEqual = false
    let claimsEqual = false
    let leasesEqual = false
    let changedResourceKinds: readonly string[] = []
    let ownedSurvivors: readonly string[] = []
    let failureReason: string | undefined
    let preClaims: ActiveStackInventoryResult | undefined
    let preLease: StateResult<StateRecord> | undefined
    let lifecycleEnvironment: Readonly<Record<string, string>> | undefined
    let dockerContext = ''
    let ownerCleanup: (() => Promise<void>) | undefined
    let ownerCleanupAttempted = false
    let ownerTimedOut = false
    // Owner refusals behind a failed check, so an incomplete verdict names what the owner said.
    const refusals: string[] = []
    const noteRefusal = (step: string, outcome: { readonly kind: string; readonly diagnostics: readonly { readonly code: string; readonly message: string }[] }) => {
        if (outcome.kind === 'refusal') refusals.push(`${step}: ${outcome.diagnostics.map(({ code, message }) => `${code}: ${message}`).join('; ') || 'refused'}`)
    }
    const ownerStages: Record<string, string> = {}
    const executeOwnerStep = async (step: ExecutionStep, stepDeadline: number): Promise<ExecuteProbeOutcome> => {
        if (Date.now() + step.timeoutMs > stepDeadline) {
            ownerTimedOut = true
            throw new RefusalError('the absolute runtime observation window cannot fit the next authenticated owner step')
        }
        const outcome = await executeProbe(step)
        if (outcome.kind === 'refusal' && outcome.code === ENVIRONMENT_CODES.EXECUTION_TIMEOUT) ownerTimedOut = true
        if (step.id.startsWith('runtime:docker-compose:') || step.id.startsWith('runtime:docker-container:')) {
            ownerStages[step.id] = outcome.kind === 'complete'
                ? `complete:stderr=${outcome.stderr.byteLength}` : `${outcome.kind}:${outcome.code}`
        }
        return outcome
    }
    const ownerExecute = async (step: ExecutionStep): Promise<ExecuteProbeOutcome> => executeOwnerStep(step, mutationDeadline)
    const cleanupOwnerExecute = async (step: ExecutionStep): Promise<ExecuteProbeOutcome> => executeOwnerStep(step, deadline)
    const fail = (reason: string): never => { throw new RefusalError(reason) }
    const fresh = (): void => { if (Date.now() >= mutationDeadline) fail('the runtime mutation window closed to reserve authenticated cleanup') }
    try {
        // A remote daemon's behaviour says nothing about this machine. Keep the selected endpoint
        // exact so a host override cannot borrow a different context's runtime evidence.
        const dockerHost = input.env.DOCKER_HOST
        if (dockerHost !== undefined && admitLocalDockerEndpoint(dockerHost) === undefined) {
            fail('DOCKER_HOST does not name a local Docker endpoint; unset it or point it at a local Unix socket')
        }
        await Promise.all([
            mkdir(siblingPath, { recursive: true, mode: 0o700 }),
            mkdir(homePath, { mode: 0o700 }),
            mkdir(generatedPath, { mode: 0o700 }),
        ])
        await writeFile(inputMarkerPath, `${marker}\n`, { flag: 'wx', mode: 0o600 })
        await writeExclusive(candidatePath, candidateSource)
        await writeExclusive(controlPath, brokenSource)
        const git = await execute.run('git-init', ['init', '--quiet', '.'], undefined, input.gitExecutable)
        if (git.kind !== 'complete') fail('the disposable installed-child checkout could not be initialized')

        const runtimeEnvironment = Object.fromEntries(Object.entries(input.env).filter(([name]) =>
            ['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT'].includes(name),
        ))
        dockerContext = decode(await execute.run('context-name', ['context', 'show'])) ?? ''
        const endpoint = dockerContext === '' ? undefined
            : decode(await execute.run('context-endpoint', ['context', 'inspect', dockerContext, '--format', '{{.Endpoints.docker.Host}}']))
        // A named context is the daemon `up` will reach, so it is the one measured, never the active one.
        checks.localRuntime = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(dockerContext) && admitLocalDockerEndpoint(endpoint) !== undefined
            && (dockerHost === undefined ? input.env.DOCKER_CONTEXT === undefined || dockerContext === input.env.DOCKER_CONTEXT : endpoint === dockerHost)
        if (!checks.localRuntime) fail('remote or unauthenticated Docker endpoints cannot establish local runtime support')

        const runtime = await observeDockerRuntime({
            executable: input.executable, cwd: input.cwd, env: runtimeEnvironment,
            timeoutMs: Math.min(input.timeoutMs, 30_000),
        }, ownerExecute)
        if (runtime.kind !== 'complete') throw new RefusalError('the local Docker runtime is unavailable')
        if (!versionAtLeast(runtime.composeVersion, input.composeFloor)) throw new RefusalError('the required Compose version is unavailable')
        runtimeVersion = runtime.runtime.version
        composeVersion = runtime.composeVersion

        pre = await inventory(execute.run, 'pre', probeScope)
        if (!pre || Object.values(pre).some((ids) => ids.length > 0)) fail('the disposable namespace collided with pre-existing runtime state')
        collisionFree = true
        const image = decode(await execute.run('image-precondition', ['image', 'inspect', input.image.reference, '--format', '{{.Id}}']))
        checks.imagePreexisting = image === input.image.id
        if (!checks.imagePreexisting) fail('the exact pre-existing probe image is unavailable; the probe does not pull or build')

        const portBase = 40_000 + Number.parseInt(batchId.slice(0, 4), 16) % 20_000
        const configSource = [
            '[cockpit]', `name = ${JSON.stringify(projectName)}`, 'siblings_root = "siblings"', '',
            '[[sibling]]', 'slug = "probe"', 'dir = "probe"', 'mount = "always"', 'acquire = "none"',
            'var = "PROBE_DIR"', 'toolchain = "none"', 'purpose = "Synthetic runtime probe"', '',
            '[ports]', 'step = 1', 'count = 1', `bases = { PROBE_PORT = ${portBase} }`, '',
            '[environment]', `compose_files = [${JSON.stringify(basename(candidatePath))}]`,
            'addressing = "port"', 'authentication = "bypassed"',
            'posture_requirements = [{ requirement = "local-runtime-endpoint", addressing = "port" }, { requirement = "local-runtime-access", authentication = "bypassed" }]',
            `resettable_volumes = [${JSON.stringify(PROBE_VOLUME_KEY)}]`, `generated_host_paths = [${JSON.stringify(generatedName)}]`, '',
            '[environment.machine]', 'runtime_memory_mb = 1', 'runtime_cpus = 1', 'free_disk_mb = 1', 'cold_start_seconds = 30', '',
        ].join('\n')
        await writeExclusive(configPath, configSource)
        // The lifecycle owners address the context checked above by name, so a `docker context use`
        // during the probe cannot move its stack to another daemon.
        lifecycleEnvironment = { PATH: input.env.PATH ?? '', HOME: homePath,
            ...(dockerHost === undefined ? { DOCKER_CONTEXT: dockerContext } : { DOCKER_HOST: dockerHost }) }
        const operationEnvironment = lifecycleEnvironment
        const freshLifecycle = () => createLifecycleCommandAdapters({
            configPath, env: operationEnvironment, sessionId: `runtime-probe-${batchId}`, timeoutMs: Math.min(input.timeoutMs, 30_000),
            activeProfiles: ['runtime_probe'],
            // A resume reads runtime readiness more than once, and each authority admits one reading.
            runtimeMeasurementProbeAuthority: () => issueRuntimeMeasurementProbeAuthority(runtime),
        }, ownerExecute)
        const lifecycle = freshLifecycle()
        const loadedContext = await lifecycle.load({ configPath })
        if (loadedContext.kind !== 'complete' || loadedContext.result === null) {
            const diagnostic = loadedContext.diagnostics[0]
            throw new RefusalError(diagnostic
                ? `the production lifecycle owner refused the disposable checkout (${diagnostic.code}: ${diagnostic.message})`
                : 'the production lifecycle owner could not authenticate the disposable checkout')
        }
        const context = loadedContext.result
        preClaims = await readActiveStackInventory(context.namespace)
        preLease = await readState(context.namespace.paths.coordination(context.stackId))
        // The candidate carries the same ownership set the Compose override gives a stack. Reclaim
        // admits a resource as current only with stack, config and owner labels, and reset admits a
        // data-bearing volume only with a generation; without them the probe measured a reset
        // refusal that no real stack produces.
        const labels = {
            'dev.b0dea.cockpit.stack-id': context.stackId,
            'dev.b0dea.cockpit.config-sha256': context.runtimeSha256,
            'dev.b0dea.cockpit.owner-id': context.cockpitId,
            'dev.b0dea.cockpit.generation-id': sha256Hex(`compose-volume-generation\0${context.runtimeSha256}`),
            [ownerLabelName]: batchId,
            [PROBE_OWNER_LABEL]: input.owner,
        }
        ownerCleanup = async () => {
            ownerCleanupAttempted = true
            const destructive = createDestructiveCommandAdapters({
                configPath, env: lifecycleEnvironment!, sessionId: `runtime-probe-${batchId}`,
                timeoutMs: Math.min(input.timeoutMs, 10_000), dockerContext,
                activeProfiles: ['runtime_probe'],
                runtimeMeasurementProbeAuthority: () => issueRuntimeMeasurementProbeAuthority(runtime),
            }, cleanupOwnerExecute)
            const down = await runDown({ configPath }, destructive)
            noteRefusal('down', down)
            // `down` removes the stack's runtime resources and keeps its declared data, which only
            // an approved `reset` removes: the resettable volume and the generated host path must
            // both survive it. The probe then removes that data itself, as its own disposable state.
            const left = down.kind === 'complete' ? await inventory(cleanupExecute.run, 'after-down', probeScope) : undefined
            checks.teardown = left !== undefined && left.containers.length === 0 && left.networks.length === 0
            checks.configuredHostPathTeardown = left !== undefined && JSON.stringify(left.volumes) === JSON.stringify([volumeName])
                && await readFile(join(generatedPath, 'owned'), 'utf8').then((owned) => owned === `${marker}\n`, () => false)
            if (left !== undefined && left.volumes.length > 0) await exactCleanup(cleanupExecute.run, { ...left, containers: [], networks: [] })
            const [postClaims, postLease] = await Promise.all([
                readActiveStackInventory(context.namespace),
                readState(context.namespace.paths.coordination(context.stackId)),
            ])
            if (preClaims !== undefined && preLease !== undefined) {
                ({ claimsEqual, leasesEqual } = currentCoordinationCleanupVerdict(
                    preClaims, postClaims, preLease, postLease, context.stackId,
                ))
            }
        }
        const candidateLabels = {
            ...labels,
            'dev.b0dea.cockpit.owner-id': '${COCKPIT_OWNER_ID:?cockpit runtime owner identity is unavailable}',
            'dev.b0dea.cockpit.stack-id': '${COCKPIT_STACK_ID:?cockpit runtime stack identity is unavailable}',
        }
        const labelLines = Object.entries(candidateLabels).map(([name, value]) => `      ${JSON.stringify(name)}: ${JSON.stringify(value)}`)
        candidateSource = [
            'services:', '  probe:', `    image: ${JSON.stringify(input.image.reference)}`,
            `    command: ["sh", "-c", ${JSON.stringify(`printf '%s\\n' '${marker}'; printf '%s\\n' '${marker}' > /generated/owned; while :; do sleep 3600; done`)}]`,
            '    environment: ["DEFAULT_ENV_CANARY=${DEFAULT_ENV_CANARY:-declared}"]',
            `    env_file: [${JSON.stringify(serviceEnvironmentPath)}]`,
            '    labels:', ...labelLines,
            '    healthcheck:', '      test: ["CMD", "sh", "-c", "test \\"$$DEFAULT_ENV_CANARY\\" = declared && test \\"$$SERVICE_ENV_CANARY\\" = service-file && test -f /probe/input"]', '      interval: 1s', '      timeout: 1s', '      retries: 10',
            '    volumes:',
            `      - type: bind`, `        source: ${JSON.stringify(siblingPath)}`, '        target: /probe',
            `      - type: bind`, `        source: ${JSON.stringify(generatedPath)}`, '        target: /generated',
            '      - type: volume', `        source: ${PROBE_VOLUME_KEY}`, '        target: /data',
            '    networks: [probe_net]',
            '  profile_control:', `    image: ${JSON.stringify(input.image.reference)}`, '    command: ["sh", "-c", "while :; do sleep 3600; done"]',
            '    profiles: ["runtime_probe"]', '    networks: [probe_net]', '    labels:', ...labelLines,
            '    healthcheck:', '      test: ["CMD", "sh", "-c", "kill -0 1"]', '      interval: 1s', '      timeout: 1s', '      retries: 10',
            'volumes:', `  ${PROBE_VOLUME_KEY}:`, `    name: ${JSON.stringify(volumeName)}`, '    labels:', ...labelLines,
            'networks:', '  probe_net:', `    name: ${JSON.stringify(`${projectName}-network`)}`, '    labels:', ...labelLines, '',
        ].join('\n')
        candidateArtifact = { path: candidatePath, sha256: sha256Hex(candidateSource) }
        await writeFile(defaultEnvironmentPath, 'DEFAULT_ENV_CANARY=unauthenticated\n', { mode: 0o600 })
        await writeFile(serviceEnvironmentPath, 'SERVICE_ENV_CANARY=service-file\n', { mode: 0o600 })
        await writeFile(candidatePath, candidateSource, { mode: 0o600 })
        // A compose_files stack runs with the ownership override `sync` publishes; the probe writes
        // the same production render instead of running sync in its disposable checkout.
        const ownership = renderComposeOwnership({
            sources: [{ reference: basename(candidatePath), source: candidateSource }],
            stackId: context.stackId, cockpitId: context.cockpitId, configSha256: context.runtimeSha256,
            resettableVolumes: [PROBE_VOLUME_KEY],
        })
        if (ownership.kind !== 'complete') fail(`the candidate's ownership override could not be rendered (${ownership.reason})`)
        await writeExclusive(ownershipPath, (ownership as Extract<typeof ownership, { kind: 'complete' }>).bytes)
        fresh()

        const control = await execute.run('broken-control', [...composeArgs(input, projectName, controlPath), 'config', '--quiet'], controlArtifact)
        if (control.kind === 'complete') brokenControl = 'accepted'
        else if (control.execution.started && control.execution.signal === null && control.code === ENVIRONMENT_CODES.EXECUTION_STEP_FAILED) brokenControl = 'rejected'
        if (brokenControl !== 'rejected') fail('the deliberately broken adjacent control was accepted or inconclusive')
        const topology = await execute.run('profile-topology', [
            ...composeArgs(input, projectName, candidatePath), '--profile', 'runtime_probe',
            'config', '--format', 'json', '--no-interpolate', '--no-env-resolution',
        ], candidateArtifact)
        const topologyText = decode(topology)
        if (topologyText === undefined) throw new RefusalError(`the exact topology projection failed (${refusalCategory(topology)}: ${generatedArtifactDetail(topology)})`)
        try {
            const parsed = JSON.parse(topologyText) as { services?: Record<string, { profiles?: unknown; volumes?: unknown; healthcheck?: unknown; labels?: unknown }> }
            profileProjected = Array.isArray(parsed.services?.profile_control?.profiles)
                && parsed.services.profile_control.profiles.includes('runtime_probe')
            const probe = parsed.services?.probe
            checks.topology = probe !== undefined && Array.isArray(probe.volumes) && probe.volumes.length === 3
                && probe.healthcheck !== undefined && probe.labels !== undefined
        } catch (error) { fail(`the topology projection was not readable JSON: ${errorCause(error)}`) }
        if (!profileProjected || !checks.topology) fail('the candidate did not project its profile, mounts, labels, and healthcheck')

        fresh()
        const up = await runUp({ configPath }, lifecycle)
        checks.applicationUp = up.kind === 'complete'
        if (!checks.applicationUp) {
            const diagnostics = up.diagnostics.map(({ code, message }) => `${code}: ${message}`).join('; ')
            const stages = Object.entries(ownerStages).map(([id, outcome]) => `${id}=${outcome}`).join(',')
            fail(diagnostics.length > 0
                ? `the application lifecycle owner refused the live candidate (${diagnostics}; stages=${stages})`
                : 'the application lifecycle owner did not start the live candidate')
        }
        const owned = await inventory(execute.run, 'created', [ownerLabel])
        checks.ownership = owned !== undefined && owned.containers.length === 2 && owned.volumes.length === 1 && owned.networks.length === 1
        if (!checks.ownership) fail('created identities did not carry the complete ownership label')
        const containerId = decode(await execute.run('probe-container', [
            'ps', '-aq', '--filter', `label=${ownerLabel}`, '--filter', 'label=com.docker.compose.service=probe',
        ]))
        if (!containerId || !owned!.containers.includes(containerId)) throw new RefusalError('the live probe container identity was not uniquely authenticated')
        const inspected = decode(await execute.run('inspect', ['container', 'inspect', containerId, '--format', '{{json .}}']))
        if (inspected === undefined) throw new RefusalError('the created container identity could not be inspected')
        const profileContainerId = decode(await execute.run('profile-container', [
            'ps', '-aq', '--filter', `label=${ownerLabel}`, '--filter', 'label=com.docker.compose.service=profile_control',
        ]))
        if (!profileContainerId || !owned!.containers.includes(profileContainerId)) throw new RefusalError('the activated profile container identity was not uniquely authenticated')
        const profileInspected = decode(await execute.run('profile-inspect', ['container', 'inspect', profileContainerId, '--format', '{{json .}}']))
        if (profileInspected === undefined) throw new RefusalError('the activated profile container identity could not be inspected')
        try {
            const data = JSON.parse(inspected) as { Config?: { Labels?: Record<string, string> }; State?: { Health?: { Status?: string } }; Mounts?: { Source?: string }[] }
            const profileData = JSON.parse(profileInspected) as { Config?: { Labels?: Record<string, string> }; State?: { Status?: string } }
            checks.health = data.State?.Health?.Status === 'healthy'
            checks.profile = profileProjected && profileData.State?.Status === 'running'
                && Object.entries(labels).every(([name, value]) => profileData.Config?.Labels?.[name] === value)
            checks.ownership = checks.ownership && Object.entries(labels).every(([name, value]) => data.Config?.Labels?.[name] === value)
                && [siblingPath, generatedPath].every((source) => data.Mounts?.some((mount) => mount.Source === source) === true)
        } catch (error) { fail(`the container inspection was malformed: ${errorCause(error)}`) }
        if (!checks.profile || !checks.health || !checks.ownership) fail('profile activation, health, mounts, or canonical ownership labels were not closed')

        const readMarker = decode(await execute.run('mount-read', ['container', 'exec', containerId, 'cat', '/probe/input']))
        checks.mountHostToContainer = readMarker === marker
        const writeMarker = await execute.run('mount-write', [
            'container', 'exec', containerId, 'sh', '-c', `printf '%s\\n' '${marker}' > /probe/output`,
        ])
        checks.mountContainerToHost = writeMarker.kind === 'complete' && (await readFile(outputMarkerPath, 'utf8').catch(() => '')) === `${marker}\n`
        if (!checks.mountHostToContainer || !checks.mountContainerToHost) fail('live bind-mount byte movement was not proven in both directions')

        const read = createReadCommandAdapters({
            configPath, env: lifecycleEnvironment, sessionId: `runtime-probe-${batchId}`,
            timeoutMs: Math.min(input.timeoutMs, 30_000),
            runtimeMeasurementProbeAuthority: issueRuntimeMeasurementProbeAuthority(runtime),
        }, ownerExecute)
        const logResult = await runLogs({ configPath, service: 'probe', since: '10m', tail: 20, follow: false, json: false }, read.logs)
        checks.logs = logResult.kind === 'complete' && logResult.result.records.some(({ message }) => message.includes(marker))
        if (!checks.logs) fail('bounded non-follow logs did not carry the live marker')
        const slept = await runSleep({ configPath }, freshLifecycle())
        const resumed = slept.kind === 'complete' ? await runUp({ configPath }, freshLifecycle()) : slept
        checks.recovery = slept.kind === 'complete' && resumed.kind === 'complete'
        if (!checks.recovery) {
            const refused = slept.kind === 'complete' ? resumed : slept
            const diagnostics = refused.diagnostics.map(({ code, message }) => `${code}: ${message}`).join('; ')
            fail(`the application lifecycle owner did not close interrupted recovery (${slept.kind === 'complete' ? 'resume' : 'sleep'}`
                + `${diagnostics.length > 0 ? `: ${diagnostics}` : ''})`)
        }

        const destructive = createDestructiveCommandAdapters({
            configPath, env: lifecycleEnvironment, sessionId: `runtime-probe-${batchId}`,
            timeoutMs: Math.min(input.timeoutMs, 30_000), dockerContext,
            activeProfiles: ['runtime_probe'],
            runtimeMeasurementProbeAuthority: () => issueRuntimeMeasurementProbeAuthority(runtime),
        }, ownerExecute)
        const reset = await runReset({ configPath }, destructive)
        checks.resetPreview = reset.kind === 'preview' && !reset.result.noop
        noteRefusal('reset preview', reset)
        await ownerCleanup()
    } catch (error) {
        failureReason = error instanceof RefusalError ? error.message : 'the installed runtime cell threw before it could close'
    } finally {
        if (collisionFree) {
            try {
                if (ownerCleanup && !ownerCleanupAttempted) {
                    try { await ownerCleanup() } catch { checks.teardown = false /* reported as the teardown verdict */ }
                }
                let survivors = await inventory(cleanupExecute.run, 'post-owned', probeScope)
                for (let attempt = 0; attempt < 2 && survivors
                    && ['containers', 'volumes', 'networks'].some((kind) => survivors![kind]!.length > 0); attempt += 1) {
                    checks.teardown = false
                    await exactCleanup(cleanupExecute.run, survivors)
                    survivors = await inventory(cleanupExecute.run, `post-fallback-${attempt + 1}`, probeScope)
                }
                ownedSurvivors = (survivors === undefined ? ['inventory-unavailable']
                    : Object.entries(survivors).flatMap(([kind, ids]) => kind === 'images' ? [] : ids.map((id) => `${kind}:${id}`)).sort())
                const post = pre === undefined ? undefined : await inventory(cleanupExecute.run, 'post', probeScope)
                resourcesEqual = pre !== undefined && post !== undefined && inventoriesEqual(pre, post)
                changedResourceKinds = pre !== undefined && post !== undefined ? inventoryDifferences(pre, post) : ['inventory-unavailable']
            } catch {
                // Cleanup is best effort; the teardown verdict and survivor list report the failure.
                checks.teardown = false
                ownedSurvivors = ['cleanup-unavailable']
            }
        }
        for (const path of [configPath, candidatePath, controlPath, defaultEnvironmentPath, ownershipPath,
            generatedPath, siblingsRoot, homePath, join(input.cwd, '.git')]) {
            try { await rm(path, { recursive: true, force: true }) } catch { checks.teardown = false /* reported as the teardown verdict */ }
        }
    }

    const finishedAt = new Date().toISOString()
    const evidence: RuntimeProbeEvidence = {
        batchId,
        installedModuleSha256: input.installedModule.sha256, runtimeExecutableSha256: input.executable.sha256,
        candidateSha256: candidateArtifact.sha256, brokenControlSha256: controlArtifact.sha256,
        projectName, runtimePath: input.executable.canonicalPath, runtimeVersion: runtimeVersion ?? null, composeVersion: composeVersion ?? null,
        operatingSystem: platform(), architecture: arch(), startedAt, finishedAt, expiresAt,
        candidateChecks: { ...checks }, brokenControlRejected: brokenControl === 'rejected',
        cleanup: { ownedSurvivors, resourcesEqual, claimsEqual, leasesEqual },
    }
    const complete = runtimeVersion !== undefined && composeVersion !== undefined && brokenControl === 'rejected'
        && failureReason === undefined && Date.parse(finishedAt) <= Date.parse(expiresAt) && Object.values(checks).every(Boolean)
        && ownedSurvivors.length === 0 && resourcesEqual && claimsEqual && leasesEqual
    if (!complete) {
        const missing = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(',') || 'none'
        const reason = failureReason ?? `the installed runtime cell remained incomplete (checks=${missing}; survivors=${ownedSurvivors.length}; changedResources=${changedResourceKinds.join(',') || 'none'}${refusals.length > 0 ? `; ${refusals.join('; ')}` : ''})`
        return unavailable(input, reason, execute.timedOut() || cleanupExecute.timedOut() || ownerTimedOut, evidence, brokenControl)
    }
    const supportedRuntimeVersion = runtimeVersion
    const supportedComposeVersion = composeVersion
    if (supportedRuntimeVersion === undefined || supportedComposeVersion === undefined) return unavailable(input, 'runtime identity was not retained', execute.timedOut() || cleanupExecute.timedOut() || ownerTimedOut, evidence, brokenControl)
    return {
        status: 'supported', runtime: { name: 'Docker Engine', version: supportedRuntimeVersion }, composeVersion: supportedComposeVersion,
        composeFloor: input.composeFloor, measuredOn: input.measuredOn, candidate: 'passed', brokenControl: 'rejected', evidence, operatorAction: null,
    }
}
