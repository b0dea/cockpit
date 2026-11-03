import { resolve } from 'node:path'
import { admitLocalDockerEndpoint } from './docker-endpoint.js'
import { selectLocalDockerDaemon } from './docker-daemon.js'
import { cockpitCommand } from '../fix-catalogue.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { loadCockpitConfig, consumeLoadedConfigProjection } from '../config/load.js'
import {
    issueDestructiveRunContext,
    noticeLifecycleRun,
    type DestructiveObservation,
    type DestructiveObservationRefusal,
    type DestructiveReclaimObservation,
    type DestructiveRunContext,
    type DownCommandAdapters,
    type LifecycleRunContext,
    type ResetCommandAdapters,
} from './application.js'
import { ENVIRONMENT_CODES, type Diagnostic, type EnvironmentCommandOutcome, type EnvironmentDiagnostic, type ExecutionStep } from './contract.js'
import { decodeCoordinationRecord, liveHolderMessage, observeProcessStart, processHost, readActiveStackInventory, releaseDeadSessionHolders } from './claims.js'
import { declaresNothingToRun, runtimeNotDeclared } from './declaration.js'
import { resolveDockerExecutable, resolvePathRemovalExecutable } from './executable.js'
import { composeProjectName } from './identity.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import {
    deriveEntrypoints,
    observeRetainedPortFamily,
    projectRetainedPortFamilyResult,
} from './ports.js'
import {
    admitDockerSelection,
    admitImageInspections,
    admitNetworkInspections,
    admitReclaimDiscovery,
    admitVolumeInspections,
    combineReclaimDiscoveries,
    createDockerSelectionSteps,
    createImageInspectionSteps,
    createNetworkInspectionSteps,
    createReclaimDiscoverySteps,
    createVolumeInspectionSteps,
    inspectionOverflow,
    type ReclaimDiscoverySnapshot,
    type ReclaimResourceKind,
} from './reclaim.js'
import { readState } from './state.js'
import { earlierNameRefusalMessage, findStackUnderEarlierName } from './lifecycle-stage.js'
import type { RuntimeMeasurementProbeAuthority } from './runtime.js'
import type { LeasePortFamilyResult } from './ports.js'

export interface DestructiveCompositionInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly sessionId: string
    readonly timeoutMs: number
    readonly dockerContext: string
    readonly activeProfiles?: readonly string[]
    readonly runtimeMeasurementProbeAuthority?: RuntimeMeasurementProbeAuthority | (() => RuntimeMeasurementProbeAuthority)
}

type Executor = (step: ExecutionStep) => Promise<ExecuteProbeOutcome>

const MAX_CONCURRENT_RECLAIM_INSPECTIONS = 4

function boundedExecutor(execute: Executor, concurrency: number): Executor {
    let active = 0
    const waiters: Array<() => void> = []
    const acquire = async () => {
        if (active < concurrency) {
            active += 1
            return
        }
        await new Promise<void>(resolveWaiter => waiters.push(resolveWaiter))
    }
    const release = () => {
        const next = waiters.shift()
        if (next) next()
        else active -= 1
    }
    return async (step) => {
        await acquire()
        try {
            return await execute(step)
        } finally {
            release()
        }
    }
}

type CapturedCompositionInput = Omit<DestructiveCompositionInput, 'env'> & {
    readonly env: Readonly<Record<string, string | undefined>>
}

function captureInput(value: DestructiveCompositionInput): CapturedCompositionInput | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const keys = ['configPath', 'env', 'sessionId', 'timeoutMs', 'dockerContext']
        const optionalKeys = ['activeProfiles', 'runtimeMeasurementProbeAuthority'].filter((key) => descriptors[key] !== undefined)
        if (Reflect.ownKeys(descriptors).length !== keys.length + optionalKeys.length
            || keys.some((key) => !descriptors[key] || !('value' in descriptors[key]!))
            || optionalKeys.some((key) => !('value' in descriptors[key]!))) return undefined
        const configPath = descriptors.configPath!.value
        const rawEnvironment = descriptors.env!.value
        const sessionId = descriptors.sessionId!.value
        const timeoutMs = descriptors.timeoutMs!.value
        const dockerContext = descriptors.dockerContext!.value
        const activeProfiles = descriptors.activeProfiles?.value
        const runtimeMeasurementProbeAuthority = descriptors.runtimeMeasurementProbeAuthority?.value
        if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0')
            || typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.includes('\0')
            || typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
            || typeof dockerContext !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(dockerContext)
            || activeProfiles !== undefined && (!Array.isArray(activeProfiles) || activeProfiles.length > 64
                || new Set(activeProfiles).size !== activeProfiles.length
                || activeProfiles.some((profile) => typeof profile !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/.test(profile)))
            || !rawEnvironment || typeof rawEnvironment !== 'object' || Array.isArray(rawEnvironment)) return undefined
        const env: Record<string, string | undefined> = {}
        for (const [name, entry] of Object.entries(rawEnvironment as Record<string, unknown>)) {
            if (name.length === 0 || name.includes('\0') || name.includes('=')
                || entry !== undefined && (typeof entry !== 'string' || entry.includes('\0'))) return undefined
            env[name] = entry
        }
        // A local DOCKER_HOST is selected through Docker's `default` context, which reports that
        // endpoint; dropping it addressed whatever the default context named instead. TLS and
        // remote hosts stay refused.
        if (env.DOCKER_HOST !== undefined && (admitLocalDockerEndpoint(env.DOCKER_HOST) === undefined
                || dockerContext !== 'default' || env.DOCKER_CONTEXT !== undefined)
            || env.DOCKER_TLS_VERIFY !== undefined || env.DOCKER_CERT_PATH !== undefined
            || env.DOCKER_CONTEXT !== undefined && env.DOCKER_CONTEXT !== dockerContext) return undefined
        return {
            configPath: resolve(configPath),
            env,
            sessionId,
            timeoutMs,
            dockerContext,
            ...(activeProfiles === undefined ? {} : { activeProfiles: [...activeProfiles].sort() }),
            ...(runtimeMeasurementProbeAuthority === undefined ? {} : { runtimeMeasurementProbeAuthority }),
        }
    } catch { // A throwing accessor or proxy trap makes the input malformed; the caller refuses it.
        return undefined
    }
}

function observationRefusal(diagnostics: readonly EnvironmentDiagnostic[]): DestructiveObservationRefusal {
    return { kind: 'refusal' as const, status: 2 as const, result: null, diagnostics }
}

function refusal(
    target: string,
    message = 'destructive run authority is unavailable or does not match current state',
    code: EnvironmentDiagnostic['code'] = ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
): EnvironmentCommandOutcome<DestructiveRunContext> {
    return {
        kind: 'refusal' as const,
        status: 2 as const,
        result: null,
        diagnostics: [{
            severity: 'error' as const,
            code,
            message,
            target,
        }],
    }
}

function sameSource(
    left: LifecycleRunContext['source'],
    right: LifecycleRunContext['source'],
): boolean {
    return left.path === right.path && left.byteLength === right.byteLength && left.sha256 === right.sha256
}

function executionEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
    return Object.fromEntries(
        Object.entries(env)
            .filter((entry): entry is [string, string] => (
                ['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].includes(entry[0]) && typeof entry[1] === 'string'
            ))
            .sort(([left], [right]) => left.localeCompare(right)),
    )
}

async function selectionAuthority(
    input: CapturedCompositionInput,
    executable: Awaited<ReturnType<typeof resolveDockerExecutable>> & { readonly state: 'available' },
    cwd: string,
    execute: Executor,
): Promise<object | undefined> {
    const steps = createDockerSelectionSteps({
        executable: executable.value,
        cwd,
        env: executionEnvironment(input.env),
        timeoutMs: input.timeoutMs,
        context: input.dockerContext,
        ...(input.env.DOCKER_HOST === undefined ? {} : { host: input.env.DOCKER_HOST }),
    })
    if (!steps) return undefined
    const evidence = await Promise.all(steps.map(async (step) => ({ step, outcome: await execute(step) })))
    return admitDockerSelection(steps, evidence)
}

export type DestructiveDaemonSelection =
    | Readonly<{ kind: 'complete'; dockerContext: string }>
    // Adapters whose load reports why no daemon was selected.
    | Readonly<{ kind: 'refusal'; adapters: DestructiveAdapters }>

/**
 * Names the one Docker context down and reset delete from, fixed before any adapter exists so
 * every discovery and deletion step of the command addresses that context.
 */
export async function selectDestructiveDaemon(
    env: Readonly<Record<string, string | undefined>>,
    timeoutMs: number,
    execute: Executor,
): Promise<DestructiveDaemonSelection> {
    const daemon = await selectLocalDockerDaemon(env, timeoutMs, execute,
        { command: 'down and reset', localOnly: 'down and reset never delete from a remote daemon' })
    return daemon.kind === 'refusal'
        ? { kind: 'refusal' as const, adapters: refusingAdapters(execute, daemon.diagnostic) }
        : { kind: 'complete' as const, dockerContext: daemon.dockerContext }
}

async function inspectDiscovery(
    discovery: ReclaimDiscoverySnapshot,
    containerDiscovery: ReclaimDiscoverySnapshot,
    kind: Exclude<ReclaimResourceKind, 'cache'>,
    execute: Executor,
): Promise<ReclaimDiscoverySnapshot | DestructiveObservationRefusal | undefined> {
    if (kind !== 'image' && kind !== 'volume' && kind !== 'network') return discovery
    const steps = kind === 'image'
        ? createImageInspectionSteps(discovery)
        : kind === 'volume'
            ? createVolumeInspectionSteps(discovery)
            : createNetworkInspectionSteps(discovery, containerDiscovery)
    if (!steps) return undefined
    const attempts = await Promise.allSettled(steps.map(async (step) => ({ step, outcome: await execute(step) })))
    if (attempts.some(({ status }) => status === 'rejected')) return undefined
    const evidence = attempts.map((attempt) => (attempt as PromiseFulfilledResult<Readonly<{
        step: ExecutionStep
        outcome: ExecuteProbeOutcome
    }>>).value)
    const overflow = evidence.map(({ step, outcome }) => inspectionOverflow(step, outcome)).find((message) => message !== undefined)
    if (overflow !== undefined) {
        return observationRefusal([{ severity: 'error' as const, code: ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT, message: overflow, target: kind }])
    }
    return kind === 'image'
        ? admitImageInspections(discovery, evidence)
        : kind === 'volume'
            ? admitVolumeInspections(discovery, evidence)
            : admitNetworkInspections(discovery, containerDiscovery, evidence)
}

type ReclaimObservation = Awaited<ReturnType<typeof discoverReclaimRound>>

// Discovery lists resources and then inspects what it listed. A listed resource can vanish in
// between, as Compose replacing one of this stack's containers does, and the round then fails
// closed on an id that no longer exists; inside a reserved drain that left the attempt for repair.
// One more complete round, authenticated from scratch, covers that race without admitting partial
// evidence.
async function observeReclaim(
    input: CapturedCompositionInput,
    context: DestructiveRunContext,
    cwd: string,
    execute: Executor,
): Promise<ReclaimObservation> {
    return await discoverReclaimRound(input, context, cwd, execute)
        ?? await discoverReclaimRound(input, context, cwd, execute)
}

async function discoverReclaimRound(
    input: CapturedCompositionInput,
    context: DestructiveRunContext,
    cwd: string,
    execute: Executor,
): Promise<Readonly<{
    discovery: ReclaimDiscoverySnapshot
    runtimeExecutable: Awaited<ReturnType<typeof resolveDockerExecutable>> & { readonly state: 'available' }
    pathExecutable: Awaited<ReturnType<typeof resolvePathRemovalExecutable>> & { readonly state: 'available' }
    selectionAuthority: object
}> | DestructiveObservationRefusal | undefined> {
    const [runtimeExecutable, pathExecutable] = await Promise.all([
        resolveDockerExecutable(input.env),
        resolvePathRemovalExecutable(),
    ])
    if (runtimeExecutable.state !== 'available' || pathExecutable.state !== 'available') return undefined
    const plannedSelection = await selectionAuthority(input, runtimeExecutable, cwd, execute)
    if (!plannedSelection) return undefined
    const steps = createReclaimDiscoverySteps({
        executable: runtimeExecutable.value,
        cwd,
        env: executionEnvironment(input.env),
        stackId: context.stackId,
        cockpitId: context.cockpitId,
        timeoutMs: input.timeoutMs,
        selectionAuthority: plannedSelection,
    })
    if (!steps) return undefined
    const outcomes = await Promise.all(steps.map(async (step) => ({ step, outcome: await execute(step) })))
    const currentSelection = await selectionAuthority(input, runtimeExecutable, cwd, execute)
    if (!currentSelection) return undefined
    const kinds = ['container', 'network', 'volume', 'image', 'build-cache'] as const
    const raw = kinds.map((kind) => {
        const evidence = outcomes.find(({ step }) => step.labels.resourceKind === kind)
        return evidence && admitReclaimDiscovery(evidence.step, evidence.outcome, kind, currentSelection)
    })
    if (raw.some((value) => value === undefined)) return undefined
    const container = raw[0]!
    // A discovery may legitimately contain thousands of resources. Each inspection launches
    // a Docker client, so one shared bound must cover every resource kind rather than letting
    // each kind independently saturate the daemon.
    const inspect = boundedExecutor(execute, MAX_CONCURRENT_RECLAIM_INSPECTIONS)
    const inspected = await Promise.all(raw.map((discovery, index) => (
        inspectDiscovery(discovery!, container, kinds[index]!, inspect)
    )))
    const refused = inspected.find((value): value is DestructiveObservationRefusal => value !== undefined && 'diagnostics' in value)
    if (refused) return refused
    if (inspected.some((value) => value === undefined)) return undefined
    const discovery = combineReclaimDiscoveries(inspected as readonly ReclaimDiscoverySnapshot[])
    if (!discovery) return undefined
    const actionSelection = await selectionAuthority(input, runtimeExecutable, cwd, execute)
    if (!actionSelection) return undefined
    return { discovery, runtimeExecutable, pathExecutable, selectionAuthority: actionSelection }
}

type DestructiveAdapters = DownCommandAdapters & ResetCommandAdapters

// Adapters that load nothing. A cockpit with no runtime has nothing to stop or reset; that
// outranks any runtime-input problem, so it is reported before `reason` or the generic refusal.
function refusingAdapters(execute: Executor, reason?: Diagnostic): DestructiveAdapters {
    return {
        load: async (request: { readonly configPath: string }) => {
            const loaded = typeof request?.configPath === 'string' ? await loadCockpitConfig(request.configPath) : undefined
            const diagnostic = loaded?.kind === 'complete' && declaresNothingToRun(loaded.result.config.environment)
                ? runtimeNotDeclared(loaded.result.source.path) : reason
            return diagnostic === undefined ? refusal(request?.configPath ?? 'destructive')
                : { kind: 'refusal' as const, status: 2 as const, result: null, diagnostics: [diagnostic] }
        },
        observe: async () => undefined,
        execute,
    } as DestructiveAdapters
}

export function createDestructiveCommandAdapters(
    rawInput: DestructiveCompositionInput,
    execute: Executor,
): DestructiveAdapters {
    const input = captureInput(rawInput)
    if (!input || typeof execute !== 'function') return refusingAdapters(execute)
    const lifecycleInput = {
        configPath: input.configPath,
        env: input.env.DOCKER_HOST === undefined ? { ...input.env, DOCKER_CONTEXT: input.dockerContext } : input.env,
        sessionId: input.sessionId,
        timeoutMs: input.timeoutMs,
        ...(input.activeProfiles === undefined ? {} : { activeProfiles: input.activeProfiles }),
        ...(input.runtimeMeasurementProbeAuthority === undefined ? {} : { runtimeMeasurementProbeAuthority: input.runtimeMeasurementProbeAuthority }),
    }
    const lifecycle = createLifecycleCommandAdapters(lifecycleInput, execute)
    const issued = new WeakMap<DestructiveRunContext, LifecycleRunContext>()
    // The checkout root runtime readiness resolved for each context, so a reclaim-only
    // observation reuses it instead of re-measuring the runtime.
    const readinessRoots = new WeakMap<DestructiveRunContext, string>()

    // Config, coordination and reclaim discovery, the evidence each destructive step re-reads.
    const observeReclaimTargets = async (
        context: DestructiveRunContext,
        configuration: NonNullable<ReturnType<typeof consumeLoadedConfigProjection>>,
        cwd: string,
    ): Promise<DestructiveReclaimObservation | DestructiveObservationRefusal | undefined> => {
        const coordinationAddress = context.namespace.paths.coordination(context.stackId)
        const stored = await readState(coordinationAddress)
        if (stored.kind !== 'complete') return undefined
        const reclaim = await observeReclaim(input, context, cwd, execute)
        if (!reclaim) return undefined
        if ('diagnostics' in reclaim) return reclaim
        // Policy rows select installers. They do not identify an instantiated cache or
        // its owning root, so treating their logical volume names as cache authority
        // could authorize deletion of unrelated data.
        const declaredCacheIds: readonly string[] = []
        const dependencyCaches: readonly never[] = []
        const common = {
            stackId: context.stackId,
            cockpitId: context.cockpitId,
            configSha256: context.runtimeSha256,
            coordinationRecord: stored.value,
            coordinationAddress,
            requesterHolderId: context.holderId,
            declaredCacheIds,
            discovery: reclaim.discovery,
            cwd,
            env: executionEnvironment(input.env),
            timeoutMs: input.timeoutMs,
            selectionAuthority: reclaim.selectionAuthority,
        }
        return {
            instance: context.instance,
            down: {
                ...common,
                executable: reclaim.runtimeExecutable.value,
                dependencyCaches,
                pathExecutable: reclaim.pathExecutable.value,
            },
            reset: {
                ...common,
                expectedCoordinationRevision: stored.value.revision,
                resettableVolumes: [...configuration.config.environment.resettable_volumes],
                composeProject: composeProjectName({ cockpitName: configuration.config.cockpit.name, stackId: context.stackId }),
                generatedHostPaths: configuration.config.environment.generated_host_paths.map((declaration) => ({
                    root: cwd,
                    path: resolve(cwd, declaration),
                    declaration,
                })),
                runtimeExecutable: reclaim.runtimeExecutable.value,
                pathExecutable: reclaim.pathExecutable.value,
            },
        }
    }
    const currentConfiguration = async (context: DestructiveRunContext) => {
        const loaded = await loadCockpitConfig(context.configPath)
        if (loaded.kind === 'refusal') return loaded
        if (loaded.kind !== 'complete') return undefined
        const configuration = consumeLoadedConfigProjection(loaded.result)
        return configuration && sameSource(context.source, configuration.source) ? configuration : undefined
    }

    return {
        async load(request: { readonly configPath: string }) {
            if (request.configPath !== resolve(input.configPath)) return refusal(request.configPath)
            const loaded = await lifecycle.load(request)
            if (loaded.kind !== 'complete') {
                return loaded.kind === 'refusal' ? loaded : refusal(request.configPath)
            }
            const context = loaded.result
            const reaped = await releaseDeadSessionHolders({
                namespace: context.namespace, stackId: context.stackId,
                successor: { holderId: context.holderId, checkoutId: context.checkoutId },
                now: new Date().toISOString(), observe: (pid) => observeProcessStart(pid, processHost(execute)),
            })
            if (reaped.kind === 'refusal') return { kind: 'refusal' as const, status: 2 as const, result: null, diagnostics: reaped.diagnostics }
            // A restore released above leaves data that may be half applied; the warning rides on
            // whatever this load returns.
            let claim: LeasePortFamilyResult | undefined
            const outcome = await (async (): Promise<EnvironmentCommandOutcome<DestructiveRunContext>> => {
                let inventory = await readActiveStackInventory(context.namespace)
                if (inventory.kind !== 'complete') return refusal(context.stackId)
                const currentRecord = inventory.value.find(({ stackId }) => stackId === context.stackId)?.record
                if (!currentRecord?.holders.some(({ holderId, checkoutId }) => (
                    holderId === context.holderId && checkoutId === context.checkoutId
                ))) {
                    // The active inventory omits a stack whose final holder released it, so the
                    // coordination record itself says whether this stack ever ran.
                    const stored = await readState(context.namespace.paths.coordination(context.stackId))
                    if (stored.kind === 'missing') {
                        const earlier = await findStackUnderEarlierName({ namespace: context.namespace, cockpitId: context.cockpitId, checkoutId: context.checkoutId })
                        if (earlier.kind === 'refusal') return refusal(earlier.target, earlier.message, earlier.code)
                        if (earlier.name !== undefined) return refusal(context.stackId,
                            earlierNameRefusalMessage(context.source.path, earlier.name), ENVIRONMENT_CODES.STACK_RECORDED_UNDER_EARLIER_NAME)
                        return refusal(context.stackId, `this checkout has never claimed the stack, so down and reset have nothing to act on; run \`${cockpitCommand('up')}\` first`)
                    }
                    const coordination = stored.kind === 'complete' ? decodeCoordinationRecord(stored.value, context.stackId) : undefined
                    if (!coordination) return refusal(context.stackId)
                    if (coordination.holders.length > 0) {
                        return refusal(context.stackId, liveHolderMessage(coordination.holders), ENVIRONMENT_CODES.CLAIM_CO_TENANT)
                    }
                    // `sleep` and an ended `session` release the final holder and stop the runtime,
                    // but its containers, networks and images remain. Claiming the stack here, as
                    // `up` would without starting anything, gives down the holder authority to retire
                    // them; refusing sent the operator to start a stack only to remove it. The
                    // application gives the claim back when the run reserves no drain.
                    let claimRefusal: readonly EnvironmentDiagnostic[] | undefined
                    claim = await lifecycle.withAcquiredPorts(context, async ({ leaseResult }) => leaseResult,
                        (diagnostics) => { claimRefusal = diagnostics; return undefined })
                    if (claimRefusal) return { kind: 'refusal' as const, status: 2 as const, result: null, diagnostics: claimRefusal }
                    if (claim?.kind !== 'complete' || claim.change !== 'acquired') return refusal(context.stackId, 'the stopped stack could not be claimed for down or reset')
                    inventory = await readActiveStackInventory(context.namespace)
                    if (inventory.kind !== 'complete') return refusal(context.stackId)
                }
                const claimInventory = inventory.value.flatMap(({ stackId, record }) => (
                    record.holders.map(({ checkoutId }) => ({ stackId, checkoutId }))
                ))
                const current = { stackId: context.stackId, checkoutId: context.checkoutId }
                const destructive = issueDestructiveRunContext({
                    lifecycle: context,
                    instance: {
                        launcher: current,
                        claimInventory,
                    },
                    ...claim ? { claim } : {},
                })
                if (destructive.kind === 'complete') issued.set(destructive.result, context)
                return destructive
            })()
            return outcome
        },
        async observe(context: DestructiveRunContext): Promise<DestructiveObservation | DestructiveObservationRefusal | undefined> {
            const lifecycleContext = issued.get(context)
            if (!lifecycleContext) return undefined
            const configuration = await currentConfiguration(context)
            if (!configuration || 'diagnostics' in configuration) return configuration
            const retained = await observeRetainedPortFamily({
                namespace: context.namespace,
                stackId: context.stackId,
                holderId: context.holderId,
                checkoutId: context.checkoutId,
                config: 'recorded',
            })
            if (retained.kind !== 'complete') return observationRefusal(retained.diagnostics)
            const entrypoints = deriveEntrypoints({
                lease: retained.lease,
                declarations: context.entrypointDerivatives,
            })
            if (entrypoints.kind !== 'complete') return observationRefusal(entrypoints.diagnostics)
            const ports = await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })
            if (!ports) return undefined
            let runtimeRefusal: DestructiveObservationRefusal | undefined
            const readiness = await lifecycle.withRuntimeReadiness(lifecycleContext, async (value) => value, ports,
                (diagnostics) => { runtimeRefusal = observationRefusal(diagnostics); return undefined }, 'teardown')
            if (runtimeRefusal) return runtimeRefusal
            if (!readiness) return undefined
            readinessRoots.set(context, readiness.topology.cwd)
            const targets = await observeReclaimTargets(context, configuration, readiness.topology.cwd)
            if (!targets || 'diagnostics' in targets) return targets
            return { ...targets, runtime: readiness.lifecycle, ports }
        },
        // Runtime readiness proves the runtime the plan was made for; the steps of a drain that
        // plan already reserved need only fresh reclaim evidence against the same checkout root.
        async observeReclaim(context: DestructiveRunContext): Promise<DestructiveReclaimObservation | DestructiveObservationRefusal | undefined> {
            const cwd = readinessRoots.get(context)
            if (!issued.has(context) || cwd === undefined) return undefined
            const configuration = await currentConfiguration(context)
            if (!configuration || 'diagnostics' in configuration) return configuration
            return observeReclaimTargets(context, configuration, cwd)
        },
        execute,
    }
}
