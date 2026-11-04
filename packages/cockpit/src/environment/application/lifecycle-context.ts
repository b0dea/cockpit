import { dirname, resolve } from 'node:path'
import type { ExecuteProbeOutcome, ForegroundProcessInput, ForegroundProcessOutcome } from '../../environment-exec/execute.js'
import {
    ENVIRONMENT_CODES,
    errorCause,
    type CheckoutId,
    type EnvironmentCommandOutcome,
    type EnvironmentDiagnostic,
    type EnvironmentObservation,
    type ExecutionStep,
    type HolderId,
    type SourceProvenance,
    type StackId,
} from '../contract.js'
import type { ExecutableResolution } from '../executable.js'
import { CockpitConfig, type EntrypointDerivative } from '../../schema.js'
import { authenticateStateNamespace, type StateNamespace } from '../state.js'
import type { RuntimeInputs, LifecycleStageProjection } from '../lifecycle-stage.js'
import { holderId as deriveHolderId, stackId as deriveStackId } from '../identity.js'
import { consumeSetupCheckoutProjection, type ConsumedSetupCheckoutObservation, type SetupCheckoutProjection } from '../setup-observation.js'
import { loadCockpitConfig, consumeLoadedConfigProjection, type LoadedConfigProjection } from '../../config/load.js'
import { deriveRegistry, type RegistryDerivationResult } from '../../registry-derivation.js'
import type { LeasePortFamilyResult, PortFamilyConfig, PortLeaseProjection } from '../ports.js'
import type { RuntimeLifecycleProjection, RuntimeTopologyEvidence } from '../runtime.js'
import type { PlanResetInput, PlanTeardownInput, ResetTargetInput } from '../reclaim.js'
import { selectDestructiveInstance, type SelectDestructiveInstanceInput } from '../instance.js'
import { ownerDiagnostic, sameSource } from './shared.js'

export interface UpCommandInput {
    readonly configPath: string
}

export interface SleepCommandInput {
    readonly configPath: string
}

export interface SessionCommandInput {
    readonly configPath: string
    readonly argv: readonly [string, ...string[]]
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
}

export interface LifecycleRunContext {
    readonly configPath: string
    readonly source: SourceProvenance
    /** Identifies the stack: its ownership labels, generation, saved progress and data history. */
    readonly runtimeSha256: string
    readonly namespace: StateNamespace
    readonly cockpitId: ConsumedSetupCheckoutObservation['cockpitId']
    readonly checkoutId: CheckoutId
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly ports: PortFamilyConfig
    readonly entrypointDerivatives: readonly EntrypointDerivative[]
}

export interface LifecycleRunContextInput {
    readonly configPath: string
    readonly checkout: SetupCheckoutProjection
    readonly configuration: LoadedConfigProjection
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly sessionId: string
}

export interface RuntimeReadiness {
    readonly topology: RuntimeTopologyEvidence
    readonly lifecycle: RuntimeLifecycleProjection
    readonly hostObservations: readonly EnvironmentObservation[]
    readonly runtimeObservations: readonly EnvironmentObservation[]
    /** The digest of each file this runtime is started from, by the name a person edits. */
    readonly inputs: RuntimeInputs
}

export interface AcquiredPorts {
    readonly leaseResult: LeasePortFamilyResult
    readonly projection: PortLeaseProjection
    readonly retainOnFailure: () => void
}

// Readiness adapters resolve to undefined when they cannot vouch for their evidence. When the
// owner they consulted refused with its own diagnostics (an occupied port family, a held state
// lock, a stopped runtime), they hand those to `refuse` instead: collapsing them into a generic
// evidence refusal left the user with no hint of which port, lock or daemon to fix.
export type ReadinessRefusal<T> = (diagnostics: readonly EnvironmentDiagnostic[]) => T

// A teardown (sleep, down) only stops and removes what the stack labelled, so the runtime it reads
// need not match the mounts cockpit.toml declares; bring-up and health still require that match.
export type RuntimeReadinessPurpose = 'teardown'

interface LifecycleCommandAdapters {
    load(input: UpCommandInput | SleepCommandInput): Promise<EnvironmentCommandOutcome<LifecycleRunContext>>
    execute(step: ExecutionStep): Promise<ExecuteProbeOutcome>
    withRuntimeReadiness<T>(context: LifecycleRunContext, use: (runtime: RuntimeReadiness) => Promise<T>, ports?: PortLeaseProjection, refuse?: ReadinessRefusal<T>, purpose?: RuntimeReadinessPurpose): Promise<T | undefined>
}

export type SeedOutcome =
    | Readonly<{ kind: 'none' | 'current' | 'ran' }>
    | Readonly<{ kind: 'refusal'; diagnostics: readonly EnvironmentDiagnostic[] }>

export interface UpCommandAdapters extends LifecycleCommandAdapters {
    /** Runs environment.seed once the stack is healthy, when a resettable volume is newer than the last seed. */
    seed?(context: LifecycleRunContext, up: Extract<UpCommandResult, { kind: 'complete' }>['result']): Promise<SeedOutcome>
    /**
     * Records the siblings' lockfiles and rebuild inputs the stack runs on; warnings when it cannot.
     * A resumed stack keeps the record of its start, because resuming restarts nothing.
     */
    recordStackInputs?(context: LifecycleRunContext, change: 'started' | 'resumed' | 'unchanged'): Promise<readonly EnvironmentDiagnostic[]>
    withLifecycleStage<T>(context: LifecycleRunContext, use: (stage: LifecycleStageProjection) => Promise<T>, refuse?: ReadinessRefusal<T>): Promise<T | undefined>
    withAcquiredPorts<T>(context: LifecycleRunContext, use: (ports: AcquiredPorts) => Promise<T>, refuse?: ReadinessRefusal<T>): Promise<T | undefined>
}

export interface SleepCommandAdapters extends LifecycleCommandAdapters {}

export interface SessionCommandAdapters {
    up(input: UpCommandInput): Promise<UpCommandResult>
    sleep(input: SleepCommandInput): Promise<SleepCommandResult>
    resolveExecutable(name: string, env: Readonly<Record<string, string>>): Promise<ExecutableResolution>
    executeForeground(input: ForegroundProcessInput, options: { signal?: AbortSignal }): Promise<ForegroundProcessOutcome>
    readonly signal?: AbortSignal
}

export interface DownCommandInput {
    readonly configPath: string
}

export interface ResetCommandInput {
    readonly configPath: string
}

export interface DestructiveRunContext extends LifecycleRunContext {
    readonly instance: SelectDestructiveInstanceInput
}

export interface DestructiveObservation {
    readonly instance: SelectDestructiveInstanceInput
    readonly runtime: RuntimeLifecycleProjection
    readonly ports: PortLeaseProjection
    readonly down: Omit<PlanTeardownInput, 'expectedDiscoveryDigest' | 'consent' | 'continuation' | 'recoveredReservation'>
    readonly reset: Omit<PlanResetInput, 'confirmationDigest' | 'consent' | 'continuation' | 'recoveredReservation'>
}

/** The evidence a step of an already-reserved drain re-reads: no runtime readiness, no ports. */
export type DestructiveReclaimObservation = Pick<DestructiveObservation, 'instance' | 'down' | 'reset'>

export interface DestructiveCommandAdapters {
    load(input: DownCommandInput | ResetCommandInput): Promise<EnvironmentCommandOutcome<DestructiveRunContext>>
    observe(context: DestructiveRunContext): Promise<DestructiveObservation | DestructiveObservationRefusal | undefined>
    /** Reclaim evidence only, after `observe` measured the runtime for the same context. */
    observeReclaim?(context: DestructiveRunContext): Promise<DestructiveReclaimObservation | DestructiveObservationRefusal | undefined>
    execute(step: ExecutionStep): Promise<ExecuteProbeOutcome>
}

export type DestructiveObservationRefusal = Extract<EnvironmentCommandOutcome<never>, { kind: 'refusal' }>

export interface DownCommandAdapters extends DestructiveCommandAdapters {}
export interface ResetCommandAdapters extends DestructiveCommandAdapters {}

export type DownCommandResult = EnvironmentCommandOutcome<Readonly<{
    stackId: StackId
    change: 'removed' | 'unchanged'
}>>

export interface ResetPreviewResult {
    readonly stackId: StackId
    readonly planDigest: string
    readonly targets: readonly ResetTargetInput[]
    readonly noop: boolean
}

export type ResetCommandResult =
    | Readonly<{ kind: 'preview'; status: 0; diagnostics: readonly EnvironmentDiagnostic[]; result: ResetPreviewResult }>
    | Readonly<{ kind: 'refusal'; status: 2; diagnostics: readonly EnvironmentDiagnostic[]; result: null }>

export type OperatorResetResult = EnvironmentCommandOutcome<Readonly<{
    stackId: StackId
    change: 'reset' | 'unchanged'
    /** On `reset`: what the approved plan removed, as its preview listed them. */
    targets?: readonly ResetTargetInput[]
}>>

export interface OperatorResetSession {
    readonly preview: Extract<ResetCommandResult, { kind: 'preview' }>
    decide(decision: 'approve' | 'decline'): Promise<OperatorResetResult>
}

export interface DestructiveRunContextInput {
    readonly lifecycle: LifecycleRunContext
    readonly instance: SelectDestructiveInstanceInput
    /** The holder claim the load took on a stack no session held, so this run could read it. */
    readonly claim?: LeasePortFamilyResult
}

export type UpCommandResult = EnvironmentCommandOutcome<Readonly<{
    stackId: StackId
    change: 'started' | 'resumed' | 'unchanged'
    /** Each `[ports.bases]` name with its leased port, the values the stack's Compose files read. */
    ports: PortLeaseProjection['lease']['ports']
    entrypoints: PortLeaseProjection['entrypoints']
    coldStart?: Readonly<{ measuredMillis: number; limitMillis: number; headroomMillis: number }>
    /** Present when environment.seed is declared: whether this up ran it or found the data current. */
    seed?: 'ran' | 'current'
}>>

export type SleepCommandResult = EnvironmentCommandOutcome<Readonly<{
    stackId: StackId
    change: 'retained' | 'released' | 'stopped' | 'unchanged'
}>>

export type SessionCommandResult =
    // A completed session exits with the supervised command's own status (128 plus the signal number
    // when a signal ended it); a refused one exits 2, or 130 when cancelled.
    | Readonly<{ kind: 'complete'; status: number; diagnostics: readonly EnvironmentDiagnostic[]; result: Readonly<{
        child: Readonly<{ exitCode: number; signal: NodeJS.Signals | null }>
        sleep: Extract<SleepCommandResult, { kind: 'complete' }>['result']
    }> }>
    | Readonly<{ kind: 'refusal'; status: number; diagnostics: readonly EnvironmentDiagnostic[]; result: null }>

export const issuedLifecycleRuns = new WeakSet<object>()
// Warnings an owner raised while a run held its context, such as an interrupted restore released
// with its data possibly half applied. The command's result carries them whatever its outcome:
// dropping one left a person working on partial data with nobody told.
const lifecycleRunNotices = new WeakMap<object, EnvironmentDiagnostic[]>()

export function noticeLifecycleRun(context: LifecycleRunContext, diagnostic: EnvironmentDiagnostic): void {
    const notices = lifecycleRunNotices.get(context) ?? []
    notices.push({ ...diagnostic })
    lifecycleRunNotices.set(context, notices)
}

export function withLifecycleRunNotices<Result extends { readonly diagnostics: readonly EnvironmentDiagnostic[] }>(
    context: LifecycleRunContext,
    result: Result,
): Result {
    const notices = lifecycleRunNotices.get(context)
    lifecycleRunNotices.delete(context)
    return notices ? { ...result, diagnostics: [...result.diagnostics, ...notices] } : result
}
const lifecycleConfigurationSources = new WeakMap<object, Readonly<{ source: SourceProvenance; siblingsRoot: string }>>()
export const issuedDestructiveRuns = new WeakSet<object>()
export const provisionalClaims = new WeakMap<DestructiveRunContext, LeasePortFamilyResult>()

type EffectiveConfigurationResult =
    | Readonly<{ kind: 'complete'; source: SourceProvenance; runtimeSha256: string; config: CockpitConfig }>
    | Readonly<{ kind: 'unavailable' }>
    | Extract<RegistryDerivationResult, { kind: 'refusal' }>

export function consumeEffectiveConfiguration(configuration: LoadedConfigProjection): EffectiveConfigurationResult {
    const loaded = consumeLoadedConfigProjection(configuration)
    if (!loaded) return { kind: 'unavailable' }
    const derived = deriveRegistry(loaded.config)
    return derived.kind === 'complete'
        ? { kind: 'complete', source: loaded.source, runtimeSha256: loaded.runtimeSha256, config: derived.result.config as CockpitConfig }
        : derived
}

export function registryRefusalMessage(result: Extract<EffectiveConfigurationResult, { kind: 'refusal' }>): string {
    return `effective registry refused (${result.code}): ${result.message}`
}

export function issueDestructiveRunContext(input: DestructiveRunContextInput): EnvironmentCommandOutcome<DestructiveRunContext> {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return lifecycleContextRefusal()
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== (descriptors.claim ? 3 : 2)
            || !('value' in descriptors.lifecycle!) || !('value' in descriptors.instance!)
            || descriptors.claim && !('value' in descriptors.claim)) return lifecycleContextRefusal()
        const lifecycle = descriptors.lifecycle!.value as LifecycleRunContext
        const instance = descriptors.instance!.value as SelectDestructiveInstanceInput
        const claim = descriptors.claim?.value as LeasePortFamilyResult | undefined
        const namespace = authenticateStateNamespace(lifecycle?.namespace)
        const selected = selectDestructiveInstance(instance)
        if (!namespace || selected.kind !== 'selected' || selected.stackId !== lifecycle.stackId
            || selected.checkoutId !== lifecycle.checkoutId || lifecycle.configPath !== resolve(lifecycle.configPath)) {
            return lifecycleContextRefusal()
        }
        const context = { ...lifecycle, namespace, instance }
        issuedDestructiveRuns.add(context)
        if (claim) provisionalClaims.set(context, claim)
        return { kind: 'complete', status: 0, diagnostics: [], result: context }
    } catch (error) {
        return lifecycleContextRefusal(`destructive run authority could not be read: ${errorCause(error)}`)
    }
}

export function issueLifecycleRunContext(input: LifecycleRunContextInput): EnvironmentCommandOutcome<LifecycleRunContext> {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return lifecycleContextRefusal()
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = ['checkout', 'configPath', 'configuration', 'namespace', 'stackId', 'holderId', 'sessionId']
        if (Reflect.ownKeys(descriptors).length !== keys.length
            || keys.some((key) => !descriptors[key] || !('value' in descriptors[key]!))) return lifecycleContextRefusal()
        const checkout = consumeSetupCheckoutProjection(descriptors.checkout!.value as SetupCheckoutProjection)
        const requestedConfigPath = descriptors.configPath!.value
        const loaded = consumeEffectiveConfiguration(descriptors.configuration!.value as LoadedConfigProjection)
        const namespace = authenticateStateNamespace(descriptors.namespace!.value)
        const stackId = descriptors.stackId!.value
        const holderId = descriptors.holderId!.value
        const sessionId = descriptors.sessionId!.value
        if (loaded.kind === 'refusal') return lifecycleContextRefusal(registryRefusalMessage(loaded))
        if (!checkout || loaded.kind !== 'complete' || !namespace || typeof requestedConfigPath !== 'string' || requestedConfigPath.length === 0
            || requestedConfigPath.includes('\0') || resolve(requestedConfigPath) !== loaded.source.path
            || typeof sessionId !== 'string'
            || !sameSource(checkout.source, loaded.source)
            || loaded.config.cockpit.name !== checkout.cockpitName) return lifecycleContextRefusal()
        const expectedStackId = deriveStackId({
            cockpitId: checkout.cockpitId,
            checkoutId: checkout.checkoutId,
            variant: { kind: 'shared' },
        })
        const expectedHolderId = deriveHolderId({
            stackId: expectedStackId,
            checkoutId: checkout.checkoutId,
            sessionId,
        })
        if (stackId !== expectedStackId || holderId !== expectedHolderId
            || namespace.paths.lifecycle(expectedStackId).cockpitId !== checkout.cockpitId) {
            return lifecycleContextRefusal()
        }
        const context = {
            configPath: resolve(requestedConfigPath),
            source: { ...loaded.source },
            runtimeSha256: loaded.runtimeSha256,
            namespace,
            cockpitId: checkout.cockpitId,
            checkoutId: checkout.checkoutId,
            stackId: expectedStackId,
            holderId: expectedHolderId,
            ports: {
                step: loaded.config.ports.step,
                count: loaded.config.ports.count,
                bases: { ...loaded.config.ports.bases },
            },
            entrypointDerivatives: loaded.config.environment.entrypoint_derivatives.map((value) => ({ ...value })),
        }
        issuedLifecycleRuns.add(context)
        lifecycleConfigurationSources.set(context, Object.freeze({ source: context.source,
            siblingsRoot: resolve(dirname(loaded.source.path), loaded.config.cockpit.siblings_root) }))
        return { kind: 'complete', status: 0, diagnostics: [], result: context }
    } catch (error) {
        return lifecycleContextRefusal(`lifecycle run authority could not be read: ${errorCause(error)}`)
    }
}

export async function withLifecycleConfiguration<T>(
    context: LifecycleRunContext,
    use: (configuration: LoadedConfigProjection) => Promise<T>,
): Promise<T | undefined> {
    if (!context || typeof context !== 'object') return undefined
    const expected = lifecycleConfigurationSources.get(context)
    if (!expected) return undefined
    // Each leaf consumes its own loader-issued handle; a copied parsed config has no authority.
    const loaded = await loadCockpitConfig(expected.source.path)
    if (loaded.kind !== 'complete' || !sameSource(expected.source, loaded.result.source)) return undefined
    try { return await use(loaded.result) }
    finally { consumeLoadedConfigProjection(loaded.result) }
}

export function lifecycleContextRefusal(
    message = 'lifecycle run authority is unavailable or does not match the loaded configuration',
): Extract<EnvironmentCommandOutcome<LifecycleRunContext>, { kind: 'refusal' }> {
    return {
        kind: 'refusal', status: 2, result: null,
        diagnostics: [ownerDiagnostic(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            message,
            'lifecycle',
        )],
    }
}
