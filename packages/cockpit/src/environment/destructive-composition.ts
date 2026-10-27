import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { loadCockpitConfig, consumeLoadedConfigProjection } from '../config/load.js'
import {
    beginOperatorReset,
    issueDestructiveRunContext,
    runDown,
    runSleep,
    runUp,
    type DestructiveObservation,
    type DestructiveObservationRefusal,
    type DestructiveRunContext,
    type DownCommandAdapters,
    type LifecycleRunContext,
    type ResetCommandAdapters,
} from './application.js'
import { ENVIRONMENT_CODES, type EnvironmentCommandOutcome, type EnvironmentDiagnostic, type ExecutionStep } from './contract.js'
import { readActiveStackInventory } from './claims.js'
import { declaresNothingToRun, runtimeNotDeclared } from './declaration.js'
import { resolveDockerExecutable, resolveExecutable, resolvePathRemovalExecutable,
    type ExecutableResolution, type ResolvedExecutable } from './executable.js'
import { createGitObservationStep } from './git-observation.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import {
    compensateAcquiredPortHolder,
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
import type { RuntimeMeasurementProbeAuthority } from './runtime.js'

export const mechanism = {
    id: 'destructive-adapter-composition',
    module: 'packages/cockpit/src/environment/destructive-composition.ts',
    exports: ['consumeComparisonPostState', 'createDestructiveCommandAdapters', 'withBoundedComparisonLifecycle'],
} as const

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
    readonly env: Readonly<Record<string, string>>
}

export interface BoundedComparisonLifecycle {
    readonly stack: LifecycleRunContext['stackId']
    readonly checkout: Readonly<{ id: LifecycleRunContext['checkoutId']; root: string }>
    readonly entrypoints: readonly Readonly<{ name: string; value: string }>[]
    resolveExecutable(name: string): Promise<ExecutableResolution>
    execute(step: ExecutionStep): Promise<ExecuteProbeOutcome>
    up(): ReturnType<typeof runUp>
    down(): ReturnType<typeof runDown>
    beginReset(): ReturnType<typeof beginOperatorReset>
    observePostState(implementation: 'legacy' | 'cockpit', command: string): Promise<ComparisonPostStateProjection | undefined>
    observeReleasedGit(executable: ResolvedExecutable): Promise<Readonly<{
        step: ExecutionStep
        outcome: ExecuteProbeOutcome
    }> | undefined>
    retainInspection(): void
}

declare const comparisonPostStateBrand: unique symbol
export type ComparisonPostStateProjection = Readonly<{ readonly [comparisonPostStateBrand]: true }>
type ComparisonPostStateRecord = Readonly<{
    stackId: LifecycleRunContext['stackId']
    checkoutId: LifecycleRunContext['checkoutId']
    implementation: 'legacy' | 'cockpit'
    command: string
    sha256: string
}>
const comparisonPostStates = new WeakMap<object, ComparisonPostStateRecord>()

export function consumeComparisonPostState(
    projection: ComparisonPostStateProjection | undefined,
    expected: Omit<ComparisonPostStateRecord, 'sha256'>,
): string | undefined {
    if (!projection || typeof projection !== 'object') return undefined
    const record = comparisonPostStates.get(projection)
    comparisonPostStates.delete(projection)
    return record?.stackId === expected.stackId && record.checkoutId === expected.checkoutId
        && record.implementation === expected.implementation && record.command === expected.command
        ? record.sha256 : undefined
}

export type BoundedComparisonLifecycleResult<T> =
    | Readonly<{ kind: 'complete'; result: T }>
    | Readonly<{ kind: 'refusal'; reason: string }>

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
        const env: Record<string, string> = {}
        for (const [name, entry] of Object.entries(rawEnvironment as Record<string, unknown>)) {
            if (entry === undefined) continue
            if (name.length === 0 || name.includes('\0') || name.includes('=')
                || typeof entry !== 'string' || entry.includes('\0')) return undefined
            env[name] = entry
        }
        if (env.DOCKER_HOST !== undefined || env.DOCKER_TLS_VERIFY !== undefined
            || env.DOCKER_CERT_PATH !== undefined
            || env.DOCKER_CONTEXT !== undefined && env.DOCKER_CONTEXT !== dockerContext) return undefined
        return Object.freeze({
            configPath: resolve(configPath),
            env: Object.freeze(env),
            sessionId,
            timeoutMs,
            dockerContext,
            ...(activeProfiles === undefined ? {} : { activeProfiles: Object.freeze([...activeProfiles].sort()) }),
            ...(runtimeMeasurementProbeAuthority === undefined ? {} : { runtimeMeasurementProbeAuthority }),
        })
    } catch {
        return undefined
    }
}

function observationRefusal(diagnostics: readonly EnvironmentDiagnostic[]): DestructiveObservationRefusal {
    return Object.freeze({ kind: 'refusal' as const, status: 2 as const, result: null, diagnostics })
}

function refusal(target: string): EnvironmentCommandOutcome<DestructiveRunContext> {
    return Object.freeze({
        kind: 'refusal' as const,
        status: 2 as const,
        result: null,
        diagnostics: Object.freeze([Object.freeze({
            severity: 'error' as const,
            code: ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            message: 'destructive run authority is unavailable or does not match current state',
            target,
        })]),
    })
}

function sameSource(
    left: LifecycleRunContext['source'],
    right: LifecycleRunContext['source'],
): boolean {
    return left.path === right.path && left.byteLength === right.byteLength && left.sha256 === right.sha256
}

function executionEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(
        Object.entries(env)
            .filter((entry): entry is [string, string] => (
                ['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].includes(entry[0]) && typeof entry[1] === 'string'
            ))
            .sort(([left], [right]) => left.localeCompare(right)),
    ))
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
    })
    if (!steps) return undefined
    const evidence = await Promise.all(steps.map(async (step) => Object.freeze({ step, outcome: await execute(step) })))
    return admitDockerSelection(steps, evidence)
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
    const attempts = await Promise.allSettled(steps.map(async (step) => Object.freeze({ step, outcome: await execute(step) })))
    if (attempts.some(({ status }) => status === 'rejected')) return undefined
    const evidence = attempts.map((attempt) => (attempt as PromiseFulfilledResult<Readonly<{
        step: ExecutionStep
        outcome: ExecuteProbeOutcome
    }>>).value)
    const overflow = evidence.map(({ step, outcome }) => inspectionOverflow(step, outcome)).find((message) => message !== undefined)
    if (overflow !== undefined) {
        return observationRefusal([Object.freeze({ severity: 'error' as const, code: ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT, message: overflow, target: kind })])
    }
    return kind === 'image'
        ? admitImageInspections(discovery, evidence)
        : kind === 'volume'
            ? admitVolumeInspections(discovery, evidence)
            : admitNetworkInspections(discovery, containerDiscovery, evidence)
}

async function observeReclaim(
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
    const outcomes = await Promise.all(steps.map(async (step) => Object.freeze({ step, outcome: await execute(step) })))
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
    return Object.freeze({ discovery, runtimeExecutable, pathExecutable, selectionAuthority: actionSelection })
}

export function createDestructiveCommandAdapters(
    rawInput: DestructiveCompositionInput,
    execute: Executor,
): DownCommandAdapters & ResetCommandAdapters {
    const input = captureInput(rawInput)
    if (!input || typeof execute !== 'function') return Object.freeze({
        // A cockpit with no runtime has nothing to stop or reset; that outranks any runtime-input problem.
        load: async (request: { readonly configPath: string }) => {
            const loaded = typeof request?.configPath === 'string' ? await loadCockpitConfig(request.configPath) : undefined
            return loaded?.kind === 'complete' && declaresNothingToRun(loaded.result.config.environment)
                ? Object.freeze({ kind: 'refusal' as const, status: 2 as const, result: null,
                    diagnostics: Object.freeze([runtimeNotDeclared(loaded.result.source.path)]) })
                : refusal(request?.configPath ?? 'destructive')
        },
        observe: async () => undefined,
        execute,
    }) as DownCommandAdapters & ResetCommandAdapters
    const lifecycleInput = Object.freeze({
        configPath: input.configPath,
        env: Object.freeze({ ...input.env, DOCKER_CONTEXT: input.dockerContext }),
        sessionId: input.sessionId,
        timeoutMs: input.timeoutMs,
        ...(input.activeProfiles === undefined ? {} : { activeProfiles: input.activeProfiles }),
        ...(input.runtimeMeasurementProbeAuthority === undefined ? {} : { runtimeMeasurementProbeAuthority: input.runtimeMeasurementProbeAuthority }),
    })
    const lifecycle = createLifecycleCommandAdapters(lifecycleInput, execute)
    const issued = new WeakMap<DestructiveRunContext, LifecycleRunContext>()

    return Object.freeze({
        async load(request: { readonly configPath: string }) {
            if (request.configPath !== resolve(input.configPath)) return refusal(request.configPath)
            const loaded = await lifecycle.load(request)
            if (loaded.kind !== 'complete') {
                return loaded.kind === 'refusal' ? loaded : refusal(request.configPath)
            }
            const context = loaded.result
            const inventory = await readActiveStackInventory(context.namespace)
            if (inventory.kind !== 'complete') return refusal(context.stackId)
            const currentRecord = inventory.value.find(({ stackId }) => stackId === context.stackId)?.record
            if (!currentRecord?.holders.some(({ holderId, checkoutId }) => (
                holderId === context.holderId && checkoutId === context.checkoutId
            ))) return refusal(context.stackId)
            const claimInventory = Object.freeze(inventory.value.flatMap(({ stackId, record }) => (
                record.holders.map(({ checkoutId }) => Object.freeze({ stackId, checkoutId }))
            )))
            const current = Object.freeze({ stackId: context.stackId, checkoutId: context.checkoutId })
            const destructive = issueDestructiveRunContext({
                lifecycle: context,
                instance: Object.freeze({
                    launcher: current,
                    claimInventory,
                }),
            })
            if (destructive.kind === 'complete') issued.set(destructive.result, context)
            return destructive
        },
        async observe(context: DestructiveRunContext): Promise<DestructiveObservation | DestructiveObservationRefusal | undefined> {
            const lifecycleContext = issued.get(context)
            if (!lifecycleContext) return undefined
            const loaded = await loadCockpitConfig(context.configPath)
            if (loaded.kind === 'refusal') return loaded
            if (loaded.kind !== 'complete') return undefined
            const configuration = consumeLoadedConfigProjection(loaded.result)
            if (!configuration || !sameSource(context.source, configuration.source)) return undefined
            const retained = await observeRetainedPortFamily({
                namespace: context.namespace,
                stackId: context.stackId,
                holderId: context.holderId,
                checkoutId: context.checkoutId,
                config: context.ports,
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
                (diagnostics) => { runtimeRefusal = observationRefusal(diagnostics); return undefined })
            if (runtimeRefusal) return runtimeRefusal
            if (!readiness) return undefined
            const coordinationAddress = context.namespace.paths.coordination(context.stackId)
            const stored = await readState(coordinationAddress)
            if (stored.kind !== 'complete') return undefined
            const reclaim = await observeReclaim(input, context, readiness.topology.cwd, execute)
            if (!reclaim) return undefined
            if ('diagnostics' in reclaim) return reclaim
            // Policy rows select installers. They do not identify an instantiated cache or
            // its owning root, so treating their logical volume names as cache authority
            // could authorize deletion of unrelated data.
            const declaredCacheIds = Object.freeze([])
            const dependencyCaches = Object.freeze([])
            const common = Object.freeze({
                stackId: context.stackId,
                cockpitId: context.cockpitId,
                configSha256: context.source.sha256,
                coordinationRecord: stored.value,
                coordinationAddress,
                requesterHolderId: context.holderId,
                declaredCacheIds,
                discovery: reclaim.discovery,
                cwd: readiness.topology.cwd,
                env: executionEnvironment(input.env),
                timeoutMs: input.timeoutMs,
                selectionAuthority: reclaim.selectionAuthority,
            })
            return Object.freeze({
                instance: context.instance,
                runtime: readiness.lifecycle,
                ports,
                down: Object.freeze({
                    ...common,
                    executable: reclaim.runtimeExecutable.value,
                    dependencyCaches,
                    pathExecutable: reclaim.pathExecutable.value,
                }),
                reset: Object.freeze({
                    ...common,
                    expectedCoordinationRevision: stored.value.revision,
                    resettableVolumes: Object.freeze([...configuration.config.environment.resettable_volumes]),
                    generatedHostPaths: Object.freeze(configuration.config.environment.generated_host_paths.map((declaration) => Object.freeze({
                        root: readiness.topology.cwd,
                        path: resolve(readiness.topology.cwd, declaration),
                        declaration,
                    }))),
                    runtimeExecutable: reclaim.runtimeExecutable.value,
                    pathExecutable: reclaim.pathExecutable.value,
                }),
            })
        },
        execute,
    })
}

export async function withBoundedComparisonLifecycle<T>(
    rawInput: DestructiveCompositionInput,
    execute: Executor,
    use: (lifecycle: BoundedComparisonLifecycle) => Promise<T>,
): Promise<BoundedComparisonLifecycleResult<T>> {
    const input = captureInput(rawInput)
    if (!input || typeof execute !== 'function' || typeof use !== 'function') {
        return Object.freeze({ kind: 'refusal', reason: 'bounded comparison authority is unavailable' })
    }
    const lifecycleInput = Object.freeze({
        configPath: input.configPath,
        env: Object.freeze({ ...input.env, DOCKER_CONTEXT: input.dockerContext }),
        sessionId: input.sessionId,
        timeoutMs: input.timeoutMs,
        ...(input.activeProfiles === undefined ? {} : { activeProfiles: input.activeProfiles }),
        ...(input.runtimeMeasurementProbeAuthority === undefined ? {} : { runtimeMeasurementProbeAuthority: input.runtimeMeasurementProbeAuthority }),
    })
    const lifecycle = createLifecycleCommandAdapters(lifecycleInput, execute)
    const loaded = await lifecycle.load(Object.freeze({ configPath: input.configPath }))
    if (loaded.kind !== 'complete') return Object.freeze({ kind: 'refusal', reason: 'comparison lifecycle could not be loaded' })
    const context = loaded.result
    const canonicalInput = Object.freeze({
        configPath: input.configPath, env: input.env, sessionId: input.sessionId, timeoutMs: input.timeoutMs,
        dockerContext: input.dockerContext,
        ...(input.activeProfiles === undefined ? {} : { activeProfiles: input.activeProfiles }),
        ...(input.runtimeMeasurementProbeAuthority === undefined ? {} : { runtimeMeasurementProbeAuthority: input.runtimeMeasurementProbeAuthority }),
    })
    const destructive = createDestructiveCommandAdapters(canonicalInput, execute)
    const result = await lifecycle.withAcquiredPorts(context, async acquired => {
        if (acquired.leaseResult.kind !== 'complete' || acquired.leaseResult.change !== 'acquired') {
            return Object.freeze({ kind: 'refusal' as const, reason: 'comparison requires one fresh acquired port holder' })
        }
        const acquiredLease = acquired.leaseResult
        let closureRan = false
        let downRan = false
        let downSucceeded = false
        let retainInspection = false
        const exactInventory = async (released: boolean) => {
            const inventory = await readActiveStackInventory(context.namespace)
            if (inventory.kind !== 'complete') return undefined
            const matches = inventory.value.filter(({ stackId }) => stackId === context.stackId)
            if (released) return matches.length === 0 ? inventory : undefined
            const record = matches.length === 1 ? matches[0]!.record : undefined
            if (!record || record.holders.length !== 1
                || record.holders[0]!.holderId !== context.holderId
                || record.holders[0]!.checkoutId !== context.checkoutId
                || !record.lease || record.lease.released
                || JSON.stringify(record.lease.ports) !== JSON.stringify(acquiredLease.lease.ports)) return undefined
            return inventory
        }
        const stillBound = async () => {
            const retained = await observeRetainedPortFamily({
                namespace: context.namespace, stackId: context.stackId, holderId: context.holderId,
                checkoutId: context.checkoutId, config: context.ports,
            })
            return retained.kind === 'complete' && await exactInventory(false) !== undefined
                && JSON.stringify(retained.lease.ports) === JSON.stringify(acquiredLease.lease.ports)
        }
        const exactlyReleased = async () => {
            return await exactInventory(true) !== undefined
        }
        const observePostState = async (implementation: 'legacy' | 'cockpit', command: string) => {
            if (!/^[a-z][a-z0-9-]{0,63}$/.test(command)) return undefined
            const loadedConfig = await loadCockpitConfig(input.configPath)
            if (loadedConfig.kind !== 'complete') return undefined
            const configuration = consumeLoadedConfigProjection(loadedConfig.result)
            if (!configuration || !sameSource(context.source, configuration.source)) return undefined
            const inventory = await exactInventory(implementation === 'cockpit' && command === 'down')
            if (!inventory) return undefined
            const snapshot = Object.freeze({
                config: configuration.source,
                stackId: context.stackId,
                checkoutId: context.checkoutId,
                entrypoints: Object.freeze(acquired.projection.entrypoints.map(({ name, value }) => Object.freeze({ name, value }))),
            })
            const projection = Object.freeze({}) as ComparisonPostStateProjection
            comparisonPostStates.set(projection, Object.freeze({
                stackId: context.stackId, checkoutId: context.checkoutId, implementation, command,
                sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
            }))
            return projection
        }
        const bound = Object.freeze({
            stack: context.stackId,
            checkout: Object.freeze({ id: context.checkoutId, root: dirname(input.configPath) }),
            entrypoints: Object.freeze(acquired.projection.entrypoints.map(({ name, value }) => Object.freeze({ name, value }))),
            resolveExecutable: (name: string) => resolveExecutable(name, input.env),
            execute: async (step: ExecutionStep) => {
                closureRan = true
                const outcome = await execute(step)
                if (!await stillBound()) throw new Error('comparison holder changed during execution')
                return outcome
            },
            up: async () => {
                closureRan = true
                const outcome = await runUp(Object.freeze({ configPath: input.configPath }), lifecycle)
                if (!await stillBound()) throw new Error('comparison holder changed during bring-up')
                return outcome
            },
            down: async () => {
                closureRan = true; downRan = true
                const outcome = await runDown(Object.freeze({ configPath: input.configPath }), destructive)
                downSucceeded = outcome.kind === 'complete' && await exactlyReleased()
                return outcome
            },
            beginReset: async () => {
                closureRan = true
                const session = await beginOperatorReset(Object.freeze({ configPath: input.configPath }), destructive)
                if (!('preview' in session)) return session
                return Object.freeze({
                    preview: session.preview,
                    decide: async (decision: 'approve' | 'decline') => {
                        const outcome = await session.decide(decision)
                        if (outcome.kind === 'complete' && !await stillBound()) {
                            throw new Error('comparison holder changed during reset')
                        }
                        return outcome
                    },
                })
            },
            observePostState,
            observeReleasedGit: async (executable: ResolvedExecutable) => {
                if (!downSucceeded || !await exactlyReleased()) return undefined
                const step = createGitObservationStep({ executable, checkoutRoot: dirname(input.configPath), env: Object.freeze({}),
                    timeoutMs: Math.min(input.timeoutMs, 30_000), stackId: context.stackId,
                    source: 'comparison-subject', checkoutId: context.checkoutId })
                if (!step) return undefined
                const outcome = await execute(step)
                return await exactlyReleased() ? Object.freeze({ step, outcome }) : undefined
            },
            retainInspection: () => { retainInspection = true },
        }) satisfies BoundedComparisonLifecycle
        try {
            const value = await use(bound)
            if (retainInspection) {
                const cleanup = await runSleep(Object.freeze({ configPath: input.configPath }), lifecycle)
                if (cleanup.kind !== 'complete') {
                    const callbackReason = value !== null && typeof value === 'object' && 'reason' in value
                        && typeof value.reason === 'string' && value.reason.length <= 512 ? ` after ${value.reason}` : ''
                    return Object.freeze({ kind: 'refusal' as const, reason: `comparison lifecycle cleanup failed${callbackReason}` })
                }
            } else if (closureRan && !downRan) {
                const cleanup = await bound.down()
                if (cleanup.kind !== 'complete') {
                    const callbackReason = value !== null && typeof value === 'object' && 'reason' in value
                        && typeof value.reason === 'string' && value.reason.length <= 512 ? ` after ${value.reason}` : ''
                    return Object.freeze({ kind: 'refusal' as const, reason: `comparison lifecycle cleanup failed${callbackReason}` })
                }
            }
            if (downRan && !downSucceeded) return Object.freeze({ kind: 'refusal' as const, reason: 'comparison lifecycle cleanup failed' })
            if (!closureRan && !retainInspection) {
                const compensated = await compensateAcquiredPortHolder({
                    namespace: context.namespace,
                    leaseResult: acquiredLease,
                    now: new Date().toISOString(),
                })
                if (compensated.kind !== 'complete') return Object.freeze({ kind: 'refusal' as const, reason: 'unused comparison lease compensation failed' })
            }
            return Object.freeze({ kind: 'complete' as const, result: value })
        } catch (error) {
            const cleanup = retainInspection ? await runSleep(Object.freeze({ configPath: input.configPath }), lifecycle)
                : !closureRan ? await compensateAcquiredPortHolder({
                namespace: context.namespace, leaseResult: acquiredLease, now: new Date().toISOString(),
            })
                : !downRan ? await bound.down() : undefined
            const cleanupFailed = cleanup !== undefined && cleanup.kind !== 'complete' || downRan && !downSucceeded
            const detail = error instanceof Error && error.message.length > 0 && error.message.length <= 512
                ? `: ${error.message}` : ''
            return Object.freeze({ kind: 'refusal' as const,
                reason: cleanupFailed ? `comparison callback failed${detail}; lifecycle cleanup failed` : `comparison callback failed${detail}` })
        }
    })
    return result ?? Object.freeze({ kind: 'refusal', reason: 'comparison port acquisition is unavailable' })
}
