import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { loadCockpitConfig, projectMachineFloorConfig } from '../config/load.js'
import type { ConsumedLoadedConfig } from '../config/load.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { redirectedBindSources } from './compose-topology.js'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import type { CockpitConfig } from '../schema.js'
import { COMPOSE_OWNERSHIP_FILE, renderComposeOwnership } from './compose-ownership.js'
import {
    issueLifecycleRunContext,
    noticeLifecycleRun,
    type LifecycleRunContext,
    type ReadinessRefusal,
    type RuntimeReadinessPurpose,
    type SleepCommandAdapters,
    type UpCommandAdapters,
} from './application.js'
import { isProcessStart, observeProcessStart, processHost, releaseDeadSessionHolders, type HolderProcess } from './claims.js'
import {
    errorCause,
    RefusalError,
    DOCKER_CLIENT_ENVIRONMENT,
    ENVIRONMENT_CODES,
    snapshotExecutionPlan,
    type EnvironmentCommandOutcome,
    type EnvironmentDiagnostic,
    type ExecutionStep,
} from './contract.js'
import { declaresNothingToRun, runtimeNotDeclared } from './declaration.js'
import { resolveDiskCapacityExecutable, resolveDockerExecutable, resolveExecutable, resolveGitExecutable, type ResolvedExecutable } from './executable.js'
import { readSeededAt, recordSeeded, seedDue } from './seed.js'
import { observeHostCapacity } from './host-observation.js'
import { composeProjectName, holderId, stackId } from './identity.js'
import {
    projectLifecycleStage,
    resolveLifecycleStage,
} from './lifecycle-stage.js'
import {
    acquirePortProjection,
    compensateAcquiredPortHolder,
    type PortLeaseProjection,
    type PortListenerEvidenceInput,
} from './ports.js'
import {
    admitRuntimeMeasurement,
    admitRuntimeTopology,
    collectMachineFloorEvidence,
    createMachineFloorPlan,
    createRuntimeAdapter,
    createRuntimeTopologyPlan,
    issueMachineFloorAuthority,
    OBSERVATION_WINDOW_HEADROOM_MS,
    observeDockerRuntime,
    observeRuntimeMeasurement,
    projectRuntimeLifecycle,
    runtimeMeasurementProbeObservation,
    type ComposeArtifact,
    type RuntimeMeasurementProbeAuthority,
    type MachineFloorAuthority,
    type RuntimeLifecycleProjection,
    type RuntimeMountMismatch,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import { readLocalRuntimeMeasurements } from './runtime-measurement-record.js'
import {
    consumeSetupCheckoutProjection,
    observeSetupCheckout,
    withSetupCheckoutProjection,
} from './setup-observation.js'
import { selectStateRoot } from './state.js'

const OWNER = 'lifecycle-adapter-composition'

const COMPOSE_BYTE_LIMIT = 1_048_576
const LISTENER_CONCURRENCY = 16

function ownerDiagnostics(code: EnvironmentDiagnostic['code'], message: string, target: string, fix?: string): readonly EnvironmentDiagnostic[] {
    return Object.freeze([Object.freeze({ severity: 'error' as const, code, message, target, ...(fix === undefined ? {} : { fix }) })])
}

function runtimeUnavailable(reason: string, target: string): readonly EnvironmentDiagnostic[] {
    return ownerDiagnostics(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, reason, target)
}

/** Names each mount difference by the row that declared it, so the refusal says what to edit. */
function mountMismatchDiagnostics(
    mismatch: RuntimeMountMismatch,
    config: CockpitConfig,
    siblingsRoot: string,
): readonly EnvironmentDiagnostic[] {
    const bySource = new Map(config.sibling.map((sibling) => [resolve(siblingsRoot, sibling.dir), sibling]))
    return Object.freeze([
        ...mismatch.missing.map((source) => {
            const sibling = bySource.get(source)
            return Object.freeze({
                severity: 'error' as const, code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE,
                target: sibling ? `sibling:${sibling.slug}` : source,
                message: sibling
                    ? `sibling ${sibling.slug} is declared mount = "always", but no Compose service bind-mounts ${source} or a directory inside it, so cockpit will not vouch for this stack`
                    : `${source} is declared for the stack to mount, but no Compose service bind-mounts it, so cockpit will not vouch for this stack`,
                fix: sibling
                    ? `bind-mount \${${sibling.var}}, or a directory inside it, in a Compose service, or set mount = "none" on sibling ${sibling.slug} in cockpit.toml; then run npx --no cockpit sync --config <your cockpit.toml> and npx --no cockpit check --config <your cockpit.toml>`
                    : 'bind-mount it in a Compose service or remove it from environment.generated_host_paths; then run npx --no cockpit sync --config <your cockpit.toml> and npx --no cockpit check --config <your cockpit.toml>',
            })
        }),
        ...mismatch.unexpected.map((source) => Object.freeze({
            severity: 'error' as const, code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE, target: source,
            message: `a Compose service bind-mounts ${source}, which lies inside no mount = "always" sibling and is no environment.generated_host_paths entry, so cockpit will not hand it to a container`,
            fix: 'move the bind inside a mount = "always" sibling, declare it as one or as an environment.generated_host_paths entry, or remove the bind mount; then run npx --no cockpit sync --config <your cockpit.toml> and npx --no cockpit check --config <your cockpit.toml>',
        })),
    ])
}

/** Names the sibling a redirected bind sits in, so the refusal says which checkout holds the link. */
function redirectedMountDiagnostics(
    redirected: readonly Readonly<{ bind: string; holder: string }>[],
    config: CockpitConfig,
    siblingsRoot: string,
): readonly EnvironmentDiagnostic[] {
    const bySource = new Map(config.sibling.map((sibling) => [resolve(siblingsRoot, sibling.dir), sibling]))
    return Object.freeze(redirected.map(({ bind, holder }) => {
        const sibling = bySource.get(holder)
        return Object.freeze({
            severity: 'error' as const, code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE, target: bind,
            message: `a Compose service bind-mounts ${bind}, which resolves through a symbolic link to a path outside ${sibling ? `sibling ${sibling.slug}` : holder}, so cockpit will not hand that path to a container`,
            fix: `replace the link with a real directory, or bind the path it points at directly and declare it as a mount = "always" sibling or an environment.generated_host_paths entry; then run ${cockpitCommand('check')}`,
        })
    }))
}

export interface LifecycleCommandCompositionInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly sessionId: string
    readonly timeoutMs: number
    readonly activeProfiles?: readonly string[]
    readonly runtimeMeasurementProbeAuthority?: RuntimeMeasurementProbeAuthority | (() => RuntimeMeasurementProbeAuthority)
    // The `cockpit session` wrapper's own process, recorded with its hold so that the hold is
    // released once that process is gone.
    readonly holderProcess?: HolderProcess
}

export type LifecycleCommandAdapterComposition = Omit<UpCommandAdapters & SleepCommandAdapters, 'withRuntimeReadiness' | 'seed'> & {
    seed: NonNullable<UpCommandAdapters['seed']>
    withMachineFloorReadiness<T>(
        context: LifecycleRunContext,
        use: (observations: readonly import('./contract.js').EnvironmentObservation[]) => Promise<T>,
        refuse?: ReadinessRefusal<T>,
    ): Promise<T | undefined>
    withRuntimeReadiness<T>(
        context: LifecycleRunContext,
        use: (runtime: LifecycleRuntimeReadiness) => Promise<T>,
        ports?: PortLeaseProjection,
        refuse?: ReadinessRefusal<T>,
        purpose?: RuntimeReadinessPurpose,
    ): Promise<T | undefined>
}

interface LifecycleRuntimeReadiness {
    readonly topology: RuntimeTopologyEvidence
    readonly lifecycle: RuntimeLifecycleProjection
    readonly hostObservations: readonly import('./contract.js').EnvironmentObservation[]
    readonly runtimeObservations: readonly import('./contract.js').EnvironmentObservation[]
    readonly inputs: Readonly<Record<string, string>>
}

interface CompositionBinding {
    readonly config: ConsumedLoadedConfig['config']
    readonly checkoutRoot: string
    readonly siblingsRoot: string
    readonly machineFloorAuthority?: MachineFloorAuthority
}

function refusal(target: string, message = 'lifecycle composition authority is unavailable',
    code: EnvironmentDiagnostic['code'] = ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID): EnvironmentCommandOutcome<LifecycleRunContext> {
    return Object.freeze({
        kind: 'refusal' as const,
        status: 2 as const,
        result: null,
        diagnostics: Object.freeze([Object.freeze({
            severity: 'error' as const,
            code,
            message,
            target,
        })]),
    })
}

function captureInput(value: LifecycleCommandCompositionInput): LifecycleCommandCompositionInput | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const keys = ['configPath', 'env', 'sessionId', 'timeoutMs']
        const actualKeys = Reflect.ownKeys(descriptors)
        const optionalKeys = ['activeProfiles', 'runtimeMeasurementProbeAuthority', 'holderProcess'].filter((key) => descriptors[key] !== undefined)
        if (actualKeys.length !== keys.length + optionalKeys.length
            || keys.some((key) => !descriptors[key] || !('value' in descriptors[key]!))
            || optionalKeys.some((key) => !('value' in descriptors[key]!))) return undefined
        const configPath = descriptors.configPath!.value
        const rawEnvironment = descriptors.env!.value
        const sessionId = descriptors.sessionId!.value
        const timeoutMs = descriptors.timeoutMs!.value
        const activeProfiles = descriptors.activeProfiles?.value
        const runtimeMeasurementProbeAuthority = descriptors.runtimeMeasurementProbeAuthority?.value
        const holderProcess = descriptors.holderProcess?.value as HolderProcess | undefined
        if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0')
            || typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.includes('\0')
            || typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
            || activeProfiles !== undefined && (!Array.isArray(activeProfiles) || activeProfiles.length > 64
                || new Set(activeProfiles).size !== activeProfiles.length
                || activeProfiles.some((profile) => typeof profile !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/.test(profile)))
            || holderProcess !== undefined && (!holderProcess || typeof holderProcess !== 'object'
                || !Number.isSafeInteger(holderProcess.pid) || holderProcess.pid! < 1
                || holderProcess.processStart !== undefined && !isProcessStart(holderProcess.processStart))
            || !rawEnvironment || typeof rawEnvironment !== 'object' || Array.isArray(rawEnvironment)) return undefined
        const env: Record<string, string | undefined> = {}
        for (const [name, entry] of Object.entries(rawEnvironment as Record<string, unknown>)) {
            if (name.length === 0 || name.includes('\0') || name.includes('=')
                || entry !== undefined && (typeof entry !== 'string' || entry.includes('\0'))) return undefined
            env[name] = entry
        }
        return Object.freeze({ configPath: resolve(configPath), env: Object.freeze(env), sessionId, timeoutMs,
            ...(activeProfiles === undefined ? {} : { activeProfiles: Object.freeze([...activeProfiles].sort()) }),
            ...(runtimeMeasurementProbeAuthority === undefined ? {} : { runtimeMeasurementProbeAuthority }),
            ...(holderProcess === undefined ? {} : { holderProcess: Object.freeze({ pid: holderProcess.pid,
                ...(holderProcess.processStart === undefined ? {} : { processStart: holderProcess.processStart }) }) }) })
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

// Literals, so the diagnostic inventory captures each fix beside its code.
function seedFailed(context: LifecycleRunContext, message: string) {
    return Object.freeze({ kind: 'refusal' as const, diagnostics: Object.freeze([Object.freeze({
        severity: 'error' as const, code: 'DATA_SEED_FAILED' as const satisfies typeof ENVIRONMENT_CODES.DATA_SEED_FAILED,
        message, target: 'environment.seed',
        fix: `correct environment.seed in ${basename(context.source.path)} or the seed it runs, then rerun npx --no cockpit up --config <your cockpit.toml>`,
    })]) })
}

function seedUnavailable(context: LifecycleRunContext, message: string) {
    return Object.freeze({ kind: 'refusal' as const, diagnostics: Object.freeze([Object.freeze({
        severity: 'error' as const, code: 'DATA_SEED_UNAVAILABLE' as const satisfies typeof ENVIRONMENT_CODES.DATA_SEED_UNAVAILABLE,
        message: `cockpit could not tell whether the seed is due: ${message}`, target: context.stackId,
        fix: 'make sure the Docker daemon this stack runs on answers docker volume ls, then rerun npx --no cockpit up --config <your cockpit.toml>',
    })]) })
}

function runtimeEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(Object.entries(env)
        .filter((entry): entry is [string, string] => DOCKER_CLIENT_ENVIRONMENT.has(entry[0]) && typeof entry[1] === 'string')))
}

function confined(root: string, path: string): boolean {
    const relation = relative(root, path)
    return relation === '' || relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

async function composeArtifact(root: string, reference: string, expectedSha256?: string): Promise<ComposeArtifact | undefined> {
    if (typeof reference !== 'string' || reference.length === 0 || reference.includes('\0')) return undefined
    const expected = resolve(root, reference)
    if (!confined(root, expected)) return undefined
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        const canonicalPath = await realpath(expected)
        if (canonicalPath !== expected) return undefined
        const before = await lstat(canonicalPath)
        if (!before.isFile() || before.isSymbolicLink() || before.size > COMPOSE_BYTE_LIMIT) return undefined
        handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > COMPOSE_BYTE_LIMIT) return undefined
        const bytes = await handle.readFile()
        const after = await handle.stat()
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return undefined
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        if (expectedSha256 !== undefined && sha256 !== expectedSha256) return undefined
        return Object.freeze({ reference, canonicalPath, source, sha256 })
    } catch {
        // Callers treat any unreadable or changed artifact as no file authority and refuse or report unavailable.
        return undefined
    } finally {
        try { await handle?.close() } catch { /* No file authority survives an unavailable artifact. */ }
    }
}

async function composeArtifacts(root: string, references: readonly string[]): Promise<readonly ComposeArtifact[] | undefined> {
    const artifacts: ComposeArtifact[] = []
    for (const reference of references) {
        const artifact = await composeArtifact(root, reference)
        if (!artifact) return undefined
        artifacts.push(artifact)
    }
    return Object.freeze(artifacts)
}

async function occupiedPort(port: number, timeoutMs: number): Promise<boolean | undefined> {
    return new Promise((complete) => {
        const socket = createConnection({ host: '127.0.0.1', port })
        let settled = false
        const finish = (value: boolean | undefined) => {
            if (settled) return
            settled = true
            socket.destroy()
            complete(value)
        }
        socket.setTimeout(timeoutMs, () => finish(undefined))
        socket.once('connect', () => finish(true))
        socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' ? false : undefined))
    })
}

async function listenerEvidence(
    context: LifecycleRunContext,
    requestedAt: string,
    timeoutMs: number,
): Promise<readonly PortListenerEvidenceInput[]> {
    const deadline = Date.parse(requestedAt) + timeoutMs
    const candidates = Array.from({ length: context.ports.count }, (_, offset) => {
        const ports = Object.values(context.ports.bases).map((base) => base + offset * context.ports.step)
        return Object.freeze({ ports: Object.freeze(ports) })
    })
    const observed = candidates.map(({ ports }) => ports.map(() => undefined as boolean | undefined))
    const tasks = candidates.flatMap(({ ports }, family) => ports.map((port, index) => ({ family, index, port })))
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(LISTENER_CONCURRENCY, tasks.length) }, async () => {
        while (cursor < tasks.length) {
            const task = tasks[cursor++]!
            const remaining = deadline - Date.now()
            if (remaining <= 0) return
            observed[task.family]![task.index] = Number.isSafeInteger(task.port) && task.port >= 1 && task.port <= 65_535
                ? await occupiedPort(task.port, remaining)
                : undefined
        }
    }))
    const completedAt = Date.now()
    return Object.freeze(candidates.map(({ ports }, family) => {
        const familyObservation = observed[family]!
        const unavailable = completedAt > deadline || familyObservation.length !== ports.length
            || familyObservation.some((value) => value === undefined)
        return Object.freeze({
            ports,
            observation: unavailable
                ? Object.freeze({
                    state: 'unavailable' as const,
                    reason: 'bounded loopback listener observation is unavailable',
                    producer: OWNER,
                })
                : Object.freeze({
                    state: 'available' as const,
                    value: Object.freeze(ports.filter((_port, index) => familyObservation[index] === true)),
                    observedAt: new Date(Math.max(completedAt, Date.parse(requestedAt))).toISOString(),
                    producer: OWNER,
                }),
        })
    }))
}

export function createLifecycleCommandAdapters(
    rawInput: LifecycleCommandCompositionInput,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): LifecycleCommandAdapterComposition {
    const input = captureInput(rawInput)
    const bindings = new WeakMap<LifecycleRunContext, CompositionBinding>()
    const issuedRuntimeReadiness = new WeakSet<object>()

    const load: LifecycleCommandAdapterComposition['load'] = async (command) => {
        if (!input || typeof execute !== 'function' || command.configPath !== input.configPath) {
            return refusal(typeof command?.configPath === 'string' ? command.configPath : 'lifecycle')
        }
        const loaded = await loadCockpitConfig(input.configPath)
        if (loaded.kind === 'refusal') return loaded
        if (declaresNothingToRun(loaded.result.config.environment)) return Object.freeze({ kind: 'refusal' as const,
            status: 2 as const, result: null, diagnostics: Object.freeze([runtimeNotDeclared(loaded.result.source.path)]) })
        const setupEnvironment = Object.freeze(Object.fromEntries(Object.entries(input.env)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')))
        const git = await resolveGitExecutable(input.env)
        if (git.state !== 'available') return refusal(loaded.result.source.path, git.reason)
        const observedAt = new Date().toISOString()
        const checkoutObservation = await observeSetupCheckout({
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            observedAt,
            env: setupEnvironment,
            gitExecutable: git.value,
        })
        const machineConfiguration = projectMachineFloorConfig(loaded.result)
        const projected = await withSetupCheckoutProjection(checkoutObservation, {
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            evaluatedAt: Date.parse(observedAt),
        }, (projection) => machineConfiguration
            ? issueMachineFloorAuthority({ configuration: machineConfiguration, checkout: projection })
            : consumeSetupCheckoutProjection(projection))
        const checkout = projected && 'authority' in projected ? projected.checkout : projected
        if (!checkout || process.platform !== 'darwin' && process.platform !== 'linux') {
            return refusal(loaded.result.source.path, checkoutObservation.state === 'failed'
                ? checkoutObservation.reason : 'authenticated checkout evidence is unavailable')
        }
        const namespace = await selectStateRoot({
            platform: process.platform,
            home: input.env.HOME,
            xdgStateHome: input.env.XDG_STATE_HOME,
            checkoutRoots: [checkout.currentCheckoutPath, checkout.mainCheckoutPath],
            cockpitId: checkout.cockpitId,
        })
        // The state root's own refusal names the directory and the failed check; replacing it with a
        // generic one left a sandboxed agent no way to tell why every lifecycle command refused.
        if (namespace.kind === 'refusal') return refusal(namespace.target, namespace.message, namespace.code)
        if (namespace.kind !== 'complete') return refusal(loaded.result.source.path, 'state namespace is unavailable')
        const currentStackId = stackId({
            cockpitId: checkout.cockpitId,
            checkoutId: checkout.checkoutId,
            variant: { kind: 'shared' },
        })
        const currentHolderId = holderId({
            stackId: currentStackId,
            checkoutId: checkout.checkoutId,
            sessionId: input.sessionId,
        })
        const confirmedAt = new Date().toISOString()
        const confirmed = await observeSetupCheckout({
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            observedAt: confirmedAt,
            env: setupEnvironment,
            gitExecutable: git.value,
        })
        const issued = await withSetupCheckoutProjection(confirmed, {
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            evaluatedAt: Date.parse(confirmedAt),
        }, (projection) => issueLifecycleRunContext({
            configPath: input.configPath,
            checkout: projection,
            configuration: loaded.result,
            namespace: namespace.value,
            stackId: currentStackId,
            holderId: currentHolderId,
            sessionId: input.sessionId,
        }))
        if (!issued || issued.kind !== 'complete') return issued ?? refusal(loaded.result.source.path)
        bindings.set(issued.result, Object.freeze({
            config: loaded.result.config,
            checkoutRoot: dirname(loaded.result.source.path),
            siblingsRoot: resolve(dirname(loaded.result.source.path), loaded.result.config.cockpit.siblings_root),
            ...(projected && 'authority' in projected ? { machineFloorAuthority: projected.authority } : {}),
        }))
        return Object.freeze({ ...issued, diagnostics: loaded.diagnostics })
    }

    const hostStep = (id: string, executable: ResolvedExecutable, args: readonly string[], cwd: string,
        env: Readonly<Record<string, string>>, timeoutMs: number, stackId: string) => snapshotExecutionPlan({ steps: [Object.freeze({
        id, argv: Object.freeze([executable.canonicalPath, ...args]) as unknown as readonly [string, ...string[]],
        argv0: executable.invocationPath, cwd, env, timeoutMs,
        stdoutLimitBytes: 1_048_576, stderrLimitBytes: 65_536, outputOverflow: 'retain-tail' as const,
        paths: Object.freeze([]), ports: Object.freeze([]), labels: Object.freeze({ stackId }), expected: Object.freeze([]),
        consumedFiles: Object.freeze([Object.freeze({ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912,
            argvIndexes: Object.freeze([0]), executable: true, executionMode: executable.executionMode })]),
        filesystemChecks: Object.freeze([]), compensation: Object.freeze([]),
    })] })?.steps[0]

    // When each resettable volume of this stack was created, by its Compose key; a volume no service
    // has created yet has no entry. Undefined when Docker could not say.
    const resettableVolumesCreatedAt = async (context: LifecycleRunContext, binding: CompositionBinding): Promise<readonly number[] | undefined> => {
        if (!input) return undefined
        const docker = await resolveDockerExecutable(input.env)
        if (docker.state !== 'available') return undefined
        const env = runtimeEnvironment(input.env)
        const project = composeProjectName({ cockpitName: binding.config.cockpit.name, stackId: context.stackId })
        const listing = hostStep('seed:volume-list', docker.value, ['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`,
            '--format', '{{.Name}}\t{{.Label "com.docker.compose.volume"}}'], binding.checkoutRoot, env, input.timeoutMs, context.stackId)
        const listed = listing && authenticatedExecutionOutcome(await execute(listing), listing)
        if (!listed || listed.kind !== 'complete' || listed.execution.exitCode !== 0) return undefined
        const keys = new Set(binding.config.environment.resettable_volumes)
        const names = Buffer.from(listed.stdout).toString('utf8').split('\n').filter(Boolean)
            .map((line) => line.split('\t')).filter(([, key]) => key !== undefined && keys.has(key)).map(([name]) => name!)
        if (names.length === 0) return Object.freeze([])
        const inspection = hostStep('seed:volume-created', docker.value, ['volume', 'inspect', '--format', '{{json .CreatedAt}}', ...names],
            binding.checkoutRoot, env, input.timeoutMs, context.stackId)
        const inspected = inspection && authenticatedExecutionOutcome(await execute(inspection), inspection)
        if (!inspected || inspected.kind !== 'complete' || inspected.execution.exitCode !== 0) return undefined
        // `{{json .CreatedAt}}` prints one quoted instant per volume; anything else is unreadable.
        const created = Buffer.from(inspected.stdout).toString('utf8').trim().split('\n')
            .map((line) => /^"[^"\\]+"$/.test(line) ? Date.parse(line.slice(1, -1)) : Number.NaN)
        return created.length === names.length && created.every(Number.isFinite) ? Object.freeze(created) : undefined
    }

    const seed: LifecycleCommandAdapterComposition['seed'] = async (context, up) => {
        const binding = bindings.get(context)
        const declared = binding?.config.environment.seed
        if (!input || !binding) return seedUnavailable(context, 'the lifecycle binding is unavailable')
        if (!declared) return Object.freeze({ kind: 'none' as const })
        const [seededAt, created] = await Promise.all([readSeededAt(context.namespace, context.stackId),
            resettableVolumesCreatedAt(context, binding)])
        if (seededAt === undefined) return seedUnavailable(context, 'the record of the last seed is unreadable')
        if (created === undefined) return seedUnavailable(context, 'Docker did not report when the resettable volumes were created')
        if (!seedDue(seededAt, created)) return Object.freeze({ kind: 'current' as const })
        const env = Object.freeze({
            ...Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
            ...Object.fromEntries(Object.entries(up.ports).map(([name, port]) => [name, String(port)])),
            ...Object.fromEntries(up.entrypoints.map(({ name, value }) => [`COCKPIT_ENTRYPOINT_${name.toUpperCase().replaceAll('-', '_')}`, value])),
        })
        const executable = await resolveExecutable(declared.argv[0]!, env)
        if (executable.state !== 'available') return seedFailed(context, `environment.seed names ${declared.argv[0]}, which could not be run: ${executable.reason}`)
        const step = hostStep('seed:run', executable.value, declared.argv.slice(1), binding.checkoutRoot, env,
            declared.timeout_seconds * 1_000, context.stackId)
        if (!step) return seedFailed(context, 'the seed command could not be planned within the execution bounds')
        const ran = authenticatedExecutionOutcome(await execute(step), step)
        if (!ran || ran.kind !== 'complete' || ran.execution.exitCode !== 0) {
            const status = !ran ? 'did not run' : ran.execution.signal ? `was stopped by ${ran.execution.signal}`
                : ran.kind === 'refusal' && ran.code !== ENVIRONMENT_CODES.EXECUTION_STEP_FAILED ? `did not complete (${ran.code})`
                    : `exited with status ${ran.execution.exitCode}`
            return seedFailed(context, `the seed command ${status}; its data may be partly applied, and it runs again on the next up`)
        }
        const recorded = await recordSeeded({ namespace: context.namespace, stackId: context.stackId,
            holderId: context.holderId, seededAt: new Date().toISOString() })
        return recorded ? Object.freeze({ kind: 'ran' as const })
            : seedUnavailable(context, 'the seed ran, and its success could not be recorded, so the next up runs it again')
    }

    const withRuntimeReadiness: LifecycleCommandAdapterComposition['withRuntimeReadiness'] = (context, use, ports, refuse, purpose) =>
        runtimeReadiness(context, use, ports, refuse, purpose)

    // `resolvedMounts` is set only on a teardown retry: stopping or removing a stack must not depend
    // on its mounts matching cockpit.toml, or a stack whose declaration drifted could never be retired.
    const runtimeReadiness = async <T>(
        context: LifecycleRunContext,
        use: (runtime: LifecycleRuntimeReadiness) => Promise<T>,
        ports: PortLeaseProjection | undefined,
        refuse: ReadinessRefusal<T> | undefined,
        purpose: RuntimeReadinessPurpose | undefined,
        resolvedMounts?: readonly string[],
    ): Promise<T | undefined> => {
        const binding = bindings.get(context)
        if (!input || !binding) return undefined
        const currentBinding = binding
        // The machine floor bounds cold start and host capacity; without it there is nothing to hold
        // the runtime to, so say which table is missing instead of a generic evidence refusal.
        const machine = currentBinding.config.environment.machine
        if (!machine) {
            return refuse?.(ownerDiagnostics(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
                'cockpit.toml declares no [environment.machine] table; runtime commands need its runtime_memory_mb, runtime_cpus, free_disk_mb and cold_start_seconds',
                'environment.machine'))
        }
        const env = runtimeEnvironment(input.env)
        const docker = await resolveDockerExecutable(input.env)
        if (docker.state !== 'available') return refuse?.(runtimeUnavailable(docker.reason, context.stackId))
        let probeAuthority: RuntimeMeasurementProbeAuthority | undefined
        if (input.runtimeMeasurementProbeAuthority !== undefined) {
            try {
                probeAuthority = typeof input.runtimeMeasurementProbeAuthority === 'function'
                    ? input.runtimeMeasurementProbeAuthority() : input.runtimeMeasurementProbeAuthority
            } catch (error) {
                throw new RefusalError('runtime measurement probe authority supplier failed', { cause: error })
            }
        }
        const observed = input.runtimeMeasurementProbeAuthority === undefined
            ? await observeDockerRuntime({
                executable: docker.value,
                cwd: binding.checkoutRoot,
                env,
                timeoutMs: input.timeoutMs,
            }, execute)
            : (probeAuthority === undefined ? undefined : runtimeMeasurementProbeObservation(probeAuthority, docker.value.sha256))
                ?? Object.freeze({ kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, reason: 'runtime measurement probe authority is unavailable or expired' })
        if (observed.kind !== 'complete') return refuse?.(ownerDiagnostics(observed.code, observed.reason, context.stackId, 'fix' in observed ? observed.fix : undefined))
        const measured = admitRuntimeMeasurement(observed, await readLocalRuntimeMeasurements(context.namespace.root))
        const certifiedProbe = input.runtimeMeasurementProbeAuthority !== undefined
        if (measured.kind !== 'admitted' && !certifiedProbe) return refuse?.(ownerDiagnostics(measured.code, measured.reason, context.stackId))
        const measurementObservation = measured.kind === 'admitted'
            ? observeRuntimeMeasurement(measured, context.stackId) : undefined
        let artifacts: readonly ComposeArtifact[] | undefined
        let inputs: Readonly<Record<string, string>> = Object.freeze({ [basename(context.source.path)]: context.runtimeSha256 })
        const activeProfiles = input.activeProfiles ?? []
        let expectedMountSources: readonly string[]
        const declared = await composeArtifacts(currentBinding.checkoutRoot, currentBinding.config.environment.compose_files)
        if (!declared) return undefined
        // The cockpit's own Compose files carry no ownership labels; the override `sync`
        // publishes adds them, and it is admitted only while it equals a fresh render.
        const ownership = renderComposeOwnership({
            sources: declared.map(({ reference, source }) => ({ reference, source })),
            stackId: context.stackId, cockpitId: context.cockpitId, configSha256: context.runtimeSha256,
            resettableVolumes: currentBinding.config.environment.resettable_volumes,
        })
        if (ownership.kind !== 'complete') return refuse?.(ownerDiagnostics(ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE,
            `the ownership override cannot be rendered from environment.compose_files: ${ownership.reason}`, ownership.target))
        const override = await composeArtifact(currentBinding.checkoutRoot, COMPOSE_OWNERSHIP_FILE,
            createHash('sha256').update(ownership.bytes).digest('hex'))
        if (!override) return refuse?.(ownerDiagnostics(ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE,
            `${COMPOSE_OWNERSHIP_FILE} is missing or does not match the current Compose files and cockpit.toml; run ${cockpitCommand('sync')}`,
            COMPOSE_OWNERSHIP_FILE))
        artifacts = Object.freeze([...declared, override])
        inputs = Object.freeze({ ...inputs, ...Object.fromEntries(declared.map(({ reference, sha256 }) => [reference, sha256])) })
        expectedMountSources = Object.freeze([...new Set([
            ...currentBinding.config.sibling
                .filter((sibling) => sibling.mount === 'always')
                .map((sibling) => resolve(currentBinding.siblingsRoot, sibling.dir)),
            ...currentBinding.config.environment.generated_host_paths
                .map((path) => resolve(currentBinding.checkoutRoot, path)),
        ])].sort())
        if (!artifacts || artifacts.length === 0) return undefined
        if (resolvedMounts) expectedMountSources = resolvedMounts
        const siblingDirectories = Object.freeze(Object.fromEntries(currentBinding.config.sibling
            .map((sibling) => [sibling.var, resolve(currentBinding.siblingsRoot, sibling.dir)])))
        const batchId = randomBytes(32).toString('hex')
        const runtime = createRuntimeAdapter({
            runtime: observed.runtime,
            composeVersion: observed.composeVersion,
            executable: docker.value,
            operation: 'validate',
            cwd: currentBinding.checkoutRoot,
            composeFiles: artifacts,
            projectName: composeProjectName({ cockpitName: currentBinding.config.cockpit.name, stackId: context.stackId }),
            env,
            ports: ports ? Object.freeze(Object.values(ports.lease.ports)) : Object.freeze([]),
            labels: { stackId: context.stackId, cockpitId: context.cockpitId, configSha256: context.runtimeSha256, batchId },
            timeoutMs: input.timeoutMs,
            stackId: context.stackId,
            coldStartLimitMillis: machine.cold_start_seconds * 1_000,
            expectedMountSources,
            activeProfiles,
        // The stack reads its host ports from the [ports.bases] variables and its sibling checkouts
        // from the [[sibling]] var variables, so both reach Compose as those variables instead of the
        // `${VAR:-default}` fallback.
        }, { ownComposeFiles: true as const, cockpitId: context.cockpitId, stackId: context.stackId,
            ...(ports ? { portLeaseProjection: ports } : {}), siblingDirectories })
        if (runtime.kind !== 'preview') return runtime.kind === 'refusal' ? refuse?.(runtime.diagnostics) : undefined
        const startedAt = new Date().toISOString()
        const topologyPlan = createRuntimeTopologyPlan({
            runtimePlan: runtime.plan,
            stackId: context.stackId,
            configSha256: context.runtimeSha256,
            batchId,
            observationWindow: {
                startedAt,
                expiresAt: new Date(Date.parse(startedAt) + machine.cold_start_seconds * 1_000 + OBSERVATION_WINDOW_HEADROOM_MS).toISOString(),
            },
        })
        if (topologyPlan.kind !== 'planned') return undefined
        const topologyOutcome = await execute(topologyPlan.step)
        const topology = admitRuntimeTopology({ plan: topologyPlan, outcome: topologyOutcome })
        if (topology.kind !== 'complete') {
            const mismatch = topology.mounts
            if (!mismatch) return undefined
            if (purpose === 'teardown' && !resolvedMounts) {
                const resolved = [...expectedMountSources.filter((source) => !mismatch.missing.includes(source)), ...mismatch.unexpected].sort()
                return runtimeReadiness(context, use, ports, refuse, purpose, Object.freeze(resolved))
            }
            return refuse?.(mountMismatchDiagnostics(mismatch, currentBinding.config, currentBinding.siblingsRoot))
        }
        if (purpose !== 'teardown') {
            const redirected = await redirectedBindSources(
                topology.topology.services.flatMap(({ bindMountSources }) => bindMountSources), expectedMountSources)
            if (redirected.length > 0) return refuse?.(redirectedMountDiagnostics(redirected, currentBinding.config, currentBinding.siblingsRoot))
        }
        const disk = await resolveDiskCapacityExecutable()
        if (disk.state !== 'available') return undefined
        const floorPlan = createMachineFloorPlan({
            runtimePlan: runtime.plan,
            diskExecutable: disk.value,
            timeoutMs: input.timeoutMs,
            authority: currentBinding.machineFloorAuthority!,
        })
        if (floorPlan.kind !== 'preview') return undefined
        const machineEvidence = collectMachineFloorEvidence(floorPlan.plan, [
            await execute(floorPlan.plan.steps[0]!),
            await execute(floorPlan.plan.steps[1]!),
        ])
        if (!machineEvidence) return undefined
        const hostObservations = observeHostCapacity({ evidence: machineEvidence })
        const lifecycle = projectRuntimeLifecycle(topology.topology)
        if (!lifecycle) return undefined
        const readiness = Object.freeze({
            topology: topology.topology,
            lifecycle,
            hostObservations,
            runtimeObservations: Object.freeze(measurementObservation
                ? [measurementObservation, ...topology.observations] : [...topology.observations]),
            inputs,
        })
        issuedRuntimeReadiness.add(readiness)
        return use(readiness)
    }

    const withMachineFloorReadiness: LifecycleCommandAdapterComposition['withMachineFloorReadiness'] = async (context, use, refuse) => {
        const binding = bindings.get(context)
        if (!input || !binding?.machineFloorAuthority || !binding.config.environment.machine) return undefined
        const env = runtimeEnvironment(input.env)
        const [docker, disk] = await Promise.all([
            resolveDockerExecutable(input.env),
            resolveDiskCapacityExecutable(),
        ])
        if (docker.state !== 'available') return refuse?.(runtimeUnavailable(docker.reason, context.stackId))
        if (disk.state !== 'available') return refuse?.(runtimeUnavailable(disk.reason, context.stackId))
        const plan = createMachineFloorPlan({
            runtimeExecutable: docker.value,
            diskExecutable: disk.value,
            cwd: binding.checkoutRoot,
            env,
            timeoutMs: input.timeoutMs,
            authority: binding.machineFloorAuthority,
        })
        if (plan.kind !== 'preview') return plan.kind === 'refusal' ? refuse?.(plan.diagnostics) : undefined
        const evidence = collectMachineFloorEvidence(plan.plan, [
            await execute(plan.plan.steps[0]!),
            await execute(plan.plan.steps[1]!),
        ])
        return evidence ? use(observeHostCapacity({ evidence })) : undefined
    }

    const withLifecycleStage: LifecycleCommandAdapterComposition['withLifecycleStage'] = async (context, use, refuse) => {
        if (!bindings.has(context)) return undefined
        const observedAt = new Date().toISOString()
        const resolved = await resolveLifecycleStage({ namespace: context.namespace, stackId: context.stackId, observedAt })
        if (resolved.kind !== 'complete') return refuse?.(resolved.diagnostics)
        const projection = projectLifecycleStage({
            authority: resolved.authority,
            stackId: context.stackId,
            cockpitId: context.cockpitId,
            earliest: Date.parse(resolved.authority.observedAt),
            latest: Date.parse(resolved.authority.validThrough),
            evaluatedAt: Date.now(),
        })
        return projection ? use(projection) : undefined
    }

    const withAcquiredPorts: LifecycleCommandAdapterComposition['withAcquiredPorts'] = async (context, use, refuse) => {
        if (!bindings.has(context)) return undefined
        const holderProcess = input?.holderProcess
        const reaped = await releaseDeadSessionHolders({
            namespace: context.namespace, stackId: context.stackId,
            successor: { holderId: context.holderId, checkoutId: context.checkoutId, ...holderProcess },
            now: new Date().toISOString(), observe: (pid) => observeProcessStart(pid, processHost(execute)),
        })
        if (reaped.kind === 'refusal') return refuse?.(reaped.diagnostics)
        const now = new Date().toISOString()
        const listenerTimeoutMs = Math.min(input?.timeoutMs ?? 1, 30_000)
        const acquired = await acquirePortProjection({
            namespace: context.namespace,
            stackId: context.stackId,
            holderId: context.holderId,
            checkoutId: context.checkoutId,
            config: context.ports,
            now,
            listenerTimeoutMs,
            listenerEvidence: await listenerEvidence(context, now, listenerTimeoutMs),
            declarations: context.entrypointDerivatives,
            ...(holderProcess === undefined ? {} : { holderProcess }),
        })
        if (acquired.kind === 'refusal') return refuse?.(acquired.diagnostics)
        if (acquired.kind !== 'complete') return undefined
        let retainOnFailure = false
        const compensationFailure = (error: unknown, cleanup: unknown) => {
            return new RefusalError(
                `downstream port preparation failed: ${errorCause(error)}; acquired-holder compensation failed: ${errorCause(cleanup)}`,
                { cause: new AggregateError([error, cleanup]) },
            )
        }
        try {
            return await use(Object.freeze({
                leaseResult: acquired.leaseResult,
                projection: acquired.projection,
                retainOnFailure: () => { retainOnFailure = true },
            }))
        } catch (error) {
            if (!retainOnFailure && acquired.leaseResult.kind === 'complete' && acquired.leaseResult.change === 'acquired') {
                let compensated: Awaited<ReturnType<typeof compensateAcquiredPortHolder>>
                try {
                    compensated = await compensateAcquiredPortHolder({ namespace: context.namespace,
                        leaseResult: acquired.leaseResult, now: new Date().toISOString() })
                } catch (cleanup) {
                    throw compensationFailure(error, cleanup)
                }
                if (compensated.kind !== 'complete') {
                    const cleanup = new RefusalError(compensated.diagnostics
                        .map(({ code, message, target }) => `${code}: ${message}${target ? ` (${target})` : ''}`).join('; '))
                    throw compensationFailure(error, cleanup)
                }
            }
            throw error
        }
    }

    return Object.freeze({ load, execute, seed, withRuntimeReadiness, withMachineFloorReadiness, withLifecycleStage, withAcquiredPorts })
}
