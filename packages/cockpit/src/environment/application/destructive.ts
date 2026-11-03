import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import { cleanupFencedExecution, repairFencedExecution } from '../../environment-exec/execute.js'
import { ENVIRONMENT_CODES, type EnvironmentCommandOutcome, type EnvironmentDiagnostic, type ExecutionFence, forwardedRefusal } from '../contract.js'
import { readState } from '../state.js'
import { compensateAcquiredPortHolder } from '../ports.js'
import { consumeLifecycleIssuance, planDown, planResetLifecycle } from '../lifecycle.js'
import { stopRuntime, type RuntimeTopologyEvidence } from '../runtime.js'
import {
    inspectDestructiveDrainRecovery,
    settleInterruptedDrainRepair,
    recoverDrainReservation,
    reserveDrain,
    reserveDrainAttempt,
    type DrainOutcome,
    type DrainReservationRequest,
} from '../claims.js'
import {
    executeReclaimAction,
    keptTeardownResources,
    planReset,
    planTeardown,
    reconcileReclaimAction,
    type ResetPreview,
    type ResetPlanResult,
    type TeardownPlanResult,
} from '../reclaim.js'
import { selectDestructiveInstance } from '../instance.js'
import {
    type DestructiveCommandAdapters,
    type DestructiveObservation,
    type DestructiveObservationRefusal,
    type DestructiveReclaimObservation,
    type DestructiveRunContext,
    type DownCommandAdapters,
    type DownCommandInput,
    type DownCommandResult,
    type OperatorResetResult,
    type OperatorResetSession,
    type ResetCommandAdapters,
    type ResetCommandInput,
    type ResetCommandResult,
    issuedDestructiveRuns,
    lifecycleContextRefusal,
    provisionalClaims,
    withLifecycleRunNotices,
} from './lifecycle-context.js'
import {
    exactCommandConfigPath,
    invalidateCompletedLifecycle,
    lifecycleRefusal,
    lifecycleSuggestion,
    publishDrainOutcome,
    publishDrainOutcomeRecord,
} from './lifecycle-state.js'
import { uniqueDiagnostics } from './shared.js'

type DestructivePlan = Extract<TeardownPlanResult | ResetPlanResult, { kind: 'complete' }>

function destructiveRepairRequired(context: DestructiveRunContext): Extract<DownCommandResult, { kind: 'refusal' }> {
    return lifecycleRefusal(
        ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED,
        'cockpit cannot prove the interrupted destructive executor stopped, so it will not overlap it with another destructive action; preserve the coordination state for explicit repair',
        context.stackId,
    )
}

// A stack no session holds is claimed only so down or reset can read it, and the claim belongs to
// the drain the run reserves, which releases it. A run that reserves no drain (a preview, a decline,
// a refusal before the drain) gives it back, or the next up meets a holder it did not take and
// refuses on every retry.
async function settleProvisionalClaim<Outcome extends Readonly<{ kind: string; diagnostics: readonly EnvironmentDiagnostic[] }>>(
    context: DestructiveRunContext,
    outcome: Outcome,
): Promise<Outcome | Extract<DownCommandResult, { kind: 'refusal' }>> {
    const claim = provisionalClaims.get(context)
    if (!claim) return outcome
    provisionalClaims.delete(context)
    const released = await compensateAcquiredPortHolder({ namespace: context.namespace, leaseResult: claim, now: new Date().toISOString() })
    if (released.kind === 'complete') return outcome
    return forwardedRefusal(uniqueDiagnostics([...outcome.kind === 'refusal' ? outcome.diagnostics : [], ...released.diagnostics]))
}

async function loadDestructiveContext(
    input: DownCommandInput | ResetCommandInput,
    adapters: DestructiveCommandAdapters,
): Promise<EnvironmentCommandOutcome<DestructiveRunContext>> {
    const configPath = exactCommandConfigPath(input)
    if (!configPath) return lifecycleContextRefusal()
    const loaded = await adapters.load({ configPath })
    if (loaded.kind !== 'complete') return loaded.kind === 'refusal' ? loaded : lifecycleContextRefusal()
    if (loaded.result.configPath !== configPath || !issuedDestructiveRuns.delete(loaded.result)) {
        return lifecycleRefusal(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'destructive run authority is unavailable',
            configPath,
        )
    }
    return loaded
}

function selectedObservation<Observation extends DestructiveReclaimObservation>(
    context: DestructiveRunContext,
    observation: Observation | undefined,
): Observation | undefined {
    if (!observation) return undefined
    try {
        const selected = selectDestructiveInstance(observation.instance)
        return selected.kind === 'selected' && selected.stackId === context.stackId
            && selected.checkoutId === context.checkoutId ? observation : undefined
    } catch {
        // An observation whose instance cannot be read is not this run's, which the caller refuses.
        return undefined
    }
}

async function observeDestructive(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
): Promise<DestructiveObservation | DestructiveObservationRefusal | undefined> {
    const observed = await adapters.observe(context)
    return observed && 'diagnostics' in observed ? observed : selectedObservation(context, observed)
}

// Each removal is proven by a fresh discovery, but re-measuring the runtime and re-listing the
// daemon twice per removal made `down` take minutes on a busy shared daemon. A reserved drain's
// steps re-read only reclaim evidence, and one discovery both reconciles a removal and plans the next.
async function observeDestructiveReclaim(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
): Promise<DestructiveReclaimObservation | DestructiveObservationRefusal | undefined> {
    const observed = adapters.observeReclaim ? await adapters.observeReclaim(context) : await adapters.observe(context)
    return observed && 'diagnostics' in observed ? observed : selectedObservation(context, observed)
}

// Before this run reserves a drain there is no attempt of its own to repair, so a missing
// observation is an evidence failure. Reporting DRAIN_ATTEMPT_REPAIR_REQUIRED here sent the
// operator of a stopped runtime looking for an interrupted attempt that did not exist.
function destructivePreconditionRefusal(
    context: DestructiveRunContext,
    observed: DestructiveObservationRefusal | undefined,
): Extract<DownCommandResult, { kind: 'refusal' }> {
    return observed ?? lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'destructive preconditions (configuration, retained ports, runtime readiness or reclaim discovery) could not be observed; this run reserved no destructive attempt',
        context.stackId,
    )
}

// After a reservation the attempt is real and must be repaired; the owner's own diagnostics
// still say why the observation failed.
function destructiveRepairAfterObservation(
    context: DestructiveRunContext,
    observed: DestructiveObservationRefusal | undefined,
): Extract<DownCommandResult, { kind: 'refusal' }> {
    const repair = destructiveRepairRequired(context)
    return observed ? forwardedRefusal(uniqueDiagnostics([...repair.diagnostics, ...observed.diagnostics])) : repair
}

async function publishDestructiveOutcome(
    context: DestructiveRunContext,
    outcome: DrainOutcome,
    fence: ExecutionFence,
): Promise<Extract<DownCommandResult, { kind: 'refusal' }> | undefined> {
    const result = await publishDrainOutcome(context, outcome, fence)
    return result?.kind === 'refusal' ? result : undefined
}

async function executeRuntimeDrain(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
    topology: RuntimeTopologyEvidence,
    attempt: Awaited<ReturnType<typeof reserveDrainAttempt>>,
): Promise<{ readonly outcome: DrainOutcome; readonly fence: ExecutionFence } | Extract<DownCommandResult, { kind: 'refusal' }>> {
    if (attempt.kind !== 'complete') return forwardedRefusal(attempt.diagnostics)
    const stopped = await stopRuntime({ topology, attempt, execute: (step) => adapters.execute(step) })
    if (stopped.kind === 'unavailable') return destructiveRepairRequired(context)
    const { outcome, fence } = stopped
    if (stopped.kind === 'not-started') return { outcome, fence }
    const reservation = attempt.reservation
    if (reservation.purpose === 'down' && reservation.actions.length === 1) {
        const invalidated = await invalidateCompletedLifecycle(context, reservation.operationBasis, reservation.generation, 'down')
        if (invalidated) return invalidated
    }
    return { outcome, fence }
}

// Teardown removes only what it can prove is this stack's and unused, so a finished drain can
// still leave the stack's own resources in place. Reporting `removed` then told the operator the
// stack was gone while its containers and network stayed, so down refuses and names each one.
function downKeptRefusal(
    context: DestructiveRunContext,
    observed: DestructiveReclaimObservation,
): Extract<DownCommandResult, { kind: 'refusal' }> | undefined {
    const kept = keptTeardownResources(observed.down)
    if (kept === undefined) return lifecycleRefusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH,
        'down finished its removals, but its last resource discovery could not be classified, so it cannot confirm the stack is gone; inspect the stack with docker compose ls and docker ps --all',
        context.stackId)
    if (kept.length === 0) return undefined
    const listed = kept.slice(0, 8).map(({ kind, id, name, reason }) => `${kind} ${name} (${id}): ${reason}`).join('; ')
    return forwardedRefusal([{
        severity: 'error' as const, code: ENVIRONMENT_CODES.DOWN_RESOURCES_KEPT, target: context.stackId,
        message: `down removed what it could, but kept ${kept.length} of this stack's own resources: ${listed}${kept.length > 8 ? `; and ${kept.length - 8} more` : ''}`,
        fix: `release each kept resource as its reason says (remove the image's other tag, stop the container still attached to the network), then run \`${lifecycleSuggestion(context, 'down')}\``,
    }])
}

async function executeDestructivePlan(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
    purpose: 'down' | 'reset',
    lifecyclePlan: ReturnType<typeof planDown>,
    firstPlan: DestructivePlan,
    plannedFrom: DestructiveReclaimObservation,
    recoveredReservation?: Extract<Awaited<ReturnType<typeof recoverDrainReservation>>, { kind: 'complete' }>,
    recoveredRequest?: DrainReservationRequest,
): Promise<DownCommandResult | OperatorResetResult> {
    if (lifecyclePlan.kind !== 'drain') return forwardedRefusal(lifecyclePlan.diagnostics)
    const issuance = consumeLifecycleIssuance(lifecyclePlan.plan)
    if (!issuance?.drainRequest || !issuance.reclaim || issuance.reclaim.purpose !== purpose) {
        return destructiveRepairRequired(context)
    }
    const request = recoveredRequest ?? lifecyclePlan.request
    // From here the drain owns the stack's claim: it releases it on completion, and keeps it for repair.
    provisionalClaims.delete(context)
    const reserved = recoveredReservation ?? await reserveDrain({ namespace: context.namespace, request })
    if (reserved.kind !== 'complete') return forwardedRefusal(reserved.diagnostics)
    let availableReservation = reserved.reservation.completedActionCount === 0 ? undefined : reserved
    if (reserved.reservation.completedActionCount === 0) {
        const runtimeAttempt = await reserveDrainAttempt({ namespace: context.namespace, reservation: reserved.reservation })
        const runtimeOutcome = await executeRuntimeDrain(context, adapters, issuance.topology, runtimeAttempt)
        if ('kind' in runtimeOutcome) return runtimeOutcome
        const runtimePublished = await publishDestructiveOutcome(context, runtimeOutcome.outcome, runtimeOutcome.fence)
        if (runtimePublished) return runtimePublished
    }

    let plan = firstPlan
    // The latest discovery: what the stack still holds once the last removal is reconciled.
    let observed = plannedFrom
    while (plan.action !== null) {
        const recovered = availableReservation ?? await recoverDrainReservation({ namespace: context.namespace, request })
        availableReservation = undefined
        if (recovered.kind !== 'complete') return forwardedRefusal(recovered.diagnostics)
        const attempt = await reserveDrainAttempt({ namespace: context.namespace, reservation: recovered.reservation })
        if (attempt.kind !== 'complete') return forwardedRefusal(attempt.diagnostics)
        const ran = await executeReclaimAction({ action: plan.action, attempt, execute: (step) => adapters.execute(step) })
        if (ran.kind === 'unavailable') return destructiveRepairRequired(context)
        if (ran.kind === 'not-started') {
            const published = await publishDestructiveOutcome(context, ran.outcome, ran.fence)
            return published ?? forwardedRefusal([{
                severity: 'error', code: ran.code,
                message: 'destructive action did not start', target: context.stackId,
            }])
        }
        const postAction = await observeDestructiveReclaim(context, adapters)
        if (!postAction || 'diagnostics' in postAction) return destructiveRepairAfterObservation(context, postAction)
        observed = postAction
        const reconciled = await reconcileReclaimAction({
            executed: ran.executed,
            discovery: purpose === 'down' ? postAction.down.discovery : postAction.reset.discovery,
        })
        if (reconciled.kind === 'refusal') {
            // An already-absent target ran nothing, so the owner's reason is the whole story.
            return ran.executed.receipt === null ? forwardedRefusal(reconciled.diagnostics) : destructiveRepairRequired(context)
        }
        if (purpose === 'down' && reconciled.continuation === null) {
            const invalidated = await invalidateCompletedLifecycle(context, request.operationBasis, request.generation, 'down')
            if (invalidated) return invalidated
        }
        const fence = ran.executed.fence
        const published = fence === null
            ? await publishDrainOutcomeRecord(context, reconciled.outcome)
            : await publishDestructiveOutcome(context, reconciled.outcome, fence)
        if (published) return published
        if (reconciled.continuation === null) break
        // The discovery that reconciled this removal plans the next; only the coordination record
        // moved since, by the outcome just published, so it is read again.
        const coordination = await readState(context.namespace.paths.coordination(context.stackId))
        if (coordination.kind !== 'complete') return destructiveRepairRequired(context)
        const next = purpose === 'down'
            ? await planTeardown({ ...postAction.down, coordinationRecord: coordination.value,
                expectedDiscoveryDigest: request.planDigest, continuation: reconciled.continuation })
            : await planReset({ ...postAction.reset, coordinationRecord: coordination.value,
                expectedCoordinationRevision: coordination.value.revision,
                confirmationDigest: request.planDigest, continuation: reconciled.continuation })
        if (next.kind !== 'complete') return next.kind === 'refusal'
            ? forwardedRefusal(next.diagnostics) : destructiveRepairRequired(context)
        plan = next
    }
    return purpose === 'down'
        ? downKeptRefusal(context, observed) ?? {
            kind: 'complete' as const, status: 0 as const, diagnostics: lifecyclePlan.plan.diagnostics,
            result: { stackId: context.stackId, change: 'removed' as const },
        }
        : {
            kind: 'complete' as const, status: 0 as const, diagnostics: lifecyclePlan.plan.diagnostics,
            result: { stackId: context.stackId, change: 'reset' as const },
        }
}

function destructivePlanningBasis(request: DrainReservationRequest | undefined): Readonly<{
    generation: string
    runtimeStopValidForMs: number
    reclaimValidForMs: number
}> {
    const runtimeStop = request?.actions.find(({ stage }) => stage === 'runtime-stop')
    const reclaim = request?.actions.find(({ stage }) => stage === 'reclaim')
    return {
        generation: request?.generation ?? randomBytes(32).toString('hex'),
        runtimeStopValidForMs: runtimeStop?.validForMs ?? 60_000,
        reclaimValidForMs: reclaim?.validForMs ?? 60_000,
    }
}

function matchesPersistedDrainRequest(
    planned: DrainReservationRequest,
    persisted: DrainReservationRequest | undefined,
): boolean {
    if (persisted === undefined) return true
    const { expectedCoordinationRevision: plannedRevision, ...plannedWork } = planned
    const { expectedCoordinationRevision: persistedRevision, ...persistedWork } = persisted
    return plannedRevision >= persistedRevision && isDeepStrictEqual(plannedWork, persistedWork)
}

async function prepareDown(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
    recovered?: Extract<Awaited<ReturnType<typeof recoverDrainReservation>>, { kind: 'complete' }>,
): Promise<{
    runtime: DestructiveObservation['runtime']
    ports: DestructiveObservation['ports']
    observation: DestructiveReclaimObservation
    preview: Extract<TeardownPlanResult, { kind: 'complete' }>
} | Extract<DownCommandResult, { kind: 'refusal' }>> {
    const previewObservation = await observeDestructive(context, adapters)
    if (!previewObservation || 'diagnostics' in previewObservation) return destructivePreconditionRefusal(context, previewObservation)
    const preview = await planTeardown({ ...previewObservation.down,
        ...(recovered ? { recoveredReservation: recovered.reservation } : {}) })
    if (preview.kind !== 'complete') return forwardedRefusal(preview.diagnostics)
    // The plan needs a discovery after the preview's consent; the runtime the preview measured
    // seconds ago still stands for planning the drain.
    const observation = await observeDestructiveReclaim(context, adapters)
    if (!observation || 'diagnostics' in observation) return destructivePreconditionRefusal(context, observation)
    return { runtime: previewObservation.runtime, ports: previewObservation.ports, observation, preview }
}

async function inspectDestructiveRecoveryWithRepair(context: DestructiveRunContext, purpose: 'down' | 'reset') {
    let inspection = await inspectDestructiveDrainRecovery({
        namespace: context.namespace, stackId: context.stackId, holderId: context.holderId, purpose,
    })
    if (inspection.kind !== 'repairable') return inspection
    const terminated = await repairFencedExecution(inspection.fence)
    if (terminated.kind !== 'complete') return inspection
    const repaired = await settleInterruptedDrainRepair({ namespace: context.namespace, record: inspection.record, evidence: terminated.evidence })
    if (repaired.kind !== 'complete') return inspection
    if (!await cleanupFencedExecution(inspection.fence)) return inspection
    inspection = await inspectDestructiveDrainRecovery({
        namespace: context.namespace, stackId: context.stackId, holderId: context.holderId, purpose,
    })
    return inspection
}

export async function runDown(
    input: DownCommandInput,
    adapters: DownCommandAdapters,
): Promise<DownCommandResult> {
    const loaded = await loadDestructiveContext(input, adapters)
    if (loaded.kind !== 'complete') return loaded as DownCommandResult
    return withLifecycleRunNotices(loaded.result, await settleProvisionalClaim(loaded.result, await downWithContext(loaded.result, adapters)))
}

async function downWithContext(context: DestructiveRunContext, adapters: DownCommandAdapters): Promise<DownCommandResult> {
    const inspection = await inspectDestructiveRecoveryWithRepair(context, 'down')
    if (inspection.kind === 'refusal') return forwardedRefusal(inspection.diagnostics)
    if (inspection.kind === 'repairable') return destructiveRepairRequired(context)
    const persistedRequest = inspection.kind === 'recoverable' ? inspection.request : undefined
    const recovered = persistedRequest === undefined ? undefined
        : await recoverDrainReservation({ namespace: context.namespace, request: persistedRequest })
    if (recovered?.kind === 'refusal') return forwardedRefusal(recovered.diagnostics)
    const prepared = await prepareDown(context, adapters, recovered)
    if ('diagnostics' in prepared) return prepared
    const basis = destructivePlanningBasis(persistedRequest)
    const lifecycle = planDown({
        runtime: prepared.runtime,
        ports: prepared.ports,
        reclaim: prepared.preview.envelope,
        operationGeneration: basis.generation,
        runtimeStopValidForMs: basis.runtimeStopValidForMs,
        reclaimValidForMs: basis.reclaimValidForMs,
    })
    if (lifecycle.kind !== 'drain') return forwardedRefusal(lifecycle.diagnostics)
    if (!matchesPersistedDrainRequest(lifecycle.request, persistedRequest)) return destructiveRepairRequired(context)
    const plan = await planTeardown({
        ...prepared.observation.down,
        expectedDiscoveryDigest: prepared.preview.discoveryDigest,
        ...(recovered?.kind === 'complete'
            ? { recoveredReservation: recovered.reservation }
            : prepared.preview.consent === null ? {} : { consent: prepared.preview.consent }),
    })
    if (plan.kind !== 'complete') return forwardedRefusal(plan.diagnostics)
    return await executeDestructivePlan(
        context, adapters, 'down', lifecycle, plan, prepared.observation,
        recovered?.kind === 'complete' ? recovered : undefined,
        persistedRequest,
    ) as DownCommandResult
}

interface PrivateResetSession {
    readonly context: DestructiveRunContext
    readonly adapters: ResetCommandAdapters
    readonly preview: ResetPreview
}

const privateResetSessions = new WeakMap<object, PrivateResetSession>()

async function resetPreview(
    context: DestructiveRunContext,
    adapters: ResetCommandAdapters,
): Promise<ResetPreview | Extract<ResetCommandResult, { kind: 'refusal' }>> {
    const observation = await observeDestructive(context, adapters)
    if (!observation || 'diagnostics' in observation) return destructivePreconditionRefusal(context, observation)
    const preview = await planReset(observation.reset)
    return preview.kind === 'preview' ? preview : preview.kind === 'refusal'
        ? forwardedRefusal(preview.diagnostics) : destructivePreconditionRefusal(context, undefined)
}

function publicResetPreview(context: DestructiveRunContext, preview: ResetPreview): Extract<ResetCommandResult, { kind: 'preview' }> {
    return {
        kind: 'preview', status: 0, diagnostics: [],
        result: {
            stackId: context.stackId, planDigest: preview.digest,
            targets: preview.targets.map((target) => ({ ...target })),
            noop: preview.noop,
        },
    }
}

export async function runReset(
    input: ResetCommandInput,
    adapters: ResetCommandAdapters,
): Promise<ResetCommandResult> {
    const loaded = await loadDestructiveContext(input, adapters)
    if (loaded.kind !== 'complete') return loaded as ResetCommandResult
    const preview = await resetPreview(loaded.result, adapters)
    return withLifecycleRunNotices(loaded.result,
        await settleProvisionalClaim(loaded.result, 'status' in preview ? preview : publicResetPreview(loaded.result, preview)))
}

export async function beginOperatorReset(
    input: ResetCommandInput,
    adapters: ResetCommandAdapters,
): Promise<OperatorResetSession | Extract<ResetCommandResult, { kind: 'refusal' }>> {
    const loaded = await loadDestructiveContext(input, adapters)
    if (loaded.kind !== 'complete') return loaded as Extract<ResetCommandResult, { kind: 'refusal' }>
    const context = loaded.result
    const preview = await resetPreview(context, adapters)
    if ('status' in preview) return withLifecycleRunNotices(context, await settleProvisionalClaim(context, preview))
    const token = {}
    privateResetSessions.set(token, Object.freeze({ context, adapters, preview }))
    const session = {
        preview: withLifecycleRunNotices(context, publicResetPreview(context, preview)),
        decide: (decision: 'approve' | 'decline') => continueOperatorReset(token, decision),
    }
    return session
}

async function continueOperatorReset(token: object, decision: 'approve' | 'decline'): Promise<OperatorResetResult> {
    const session = privateResetSessions.get(token)
    privateResetSessions.delete(token)
    const unapproved = forwardedRefusal([{
        severity: 'error', code: ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
        message: decision === 'decline' ? 'reset was declined' : 'reset operator session is unavailable', target: 'reset',
    }])
    if (!session) return unapproved
    return settleProvisionalClaim(session.context, decision === 'approve' ? await approveOperatorReset(session) : unapproved)
}

async function approveOperatorReset(session: PrivateResetSession): Promise<OperatorResetResult> {
    const inspection = await inspectDestructiveRecoveryWithRepair(session.context, 'reset')
    if (inspection.kind === 'refusal') return forwardedRefusal(inspection.diagnostics)
    if (inspection.kind === 'repairable') return destructiveRepairRequired(session.context)
    const persistedRequest = inspection.kind === 'recoverable' ? inspection.request : undefined
    const recovered = persistedRequest === undefined ? undefined
        : await recoverDrainReservation({ namespace: session.context.namespace, request: persistedRequest })
    if (recovered?.kind === 'refusal') return forwardedRefusal(recovered.diagnostics)
    const observation = await observeDestructive(session.context, session.adapters)
    if (!observation || 'diagnostics' in observation) return destructivePreconditionRefusal(session.context, observation)
    if (session.preview.noop && !persistedRequest) {
        const noop = await planReset({
            ...observation.reset,
            confirmationDigest: session.preview.digest,
            consent: session.preview.consent,
        })
        if (noop.kind !== 'complete' || !noop.noop || noop.action !== null) {
            return noop.kind === 'refusal' ? forwardedRefusal(noop.diagnostics) : destructivePreconditionRefusal(session.context, undefined)
        }
        const finalInspection = await inspectDestructiveDrainRecovery({ namespace: session.context.namespace,
            stackId: session.context.stackId, holderId: session.context.holderId, purpose: 'reset' })
        if (finalInspection.kind !== 'none') return finalInspection.kind === 'refusal'
            ? forwardedRefusal(finalInspection.diagnostics) : destructiveRepairRequired(session.context)
        return {
            kind: 'complete', status: 0, diagnostics: [],
            result: { stackId: session.context.stackId, change: 'unchanged' },
        }
    }
    const recoveryPlan = recovered ? await planReset({ ...observation.reset,
        confirmationDigest: persistedRequest!.planDigest,
        recoveredReservation: recovered.reservation, operatorApproval: session.preview }) : undefined
    if (recoveryPlan && recoveryPlan.kind !== 'complete') return recoveryPlan.kind === 'refusal'
        ? forwardedRefusal(recoveryPlan.diagnostics) : destructiveRepairRequired(session.context)
    const basis = destructivePlanningBasis(persistedRequest)
    const lifecycle = planResetLifecycle({
        runtime: observation.runtime,
        ports: observation.ports,
        reclaim: recoveryPlan ? recoveryPlan.envelope : session.preview.envelope,
        operationGeneration: basis.generation,
        runtimeStopValidForMs: basis.runtimeStopValidForMs,
        reclaimValidForMs: basis.reclaimValidForMs,
    })
    if (lifecycle.kind !== 'drain') return forwardedRefusal(lifecycle.diagnostics)
    if (!matchesPersistedDrainRequest(lifecycle.request, persistedRequest)) return destructiveRepairRequired(session.context)
    const actionablePlan = recoveryPlan ?? await planReset({
        ...observation.reset,
        confirmationDigest: session.preview.digest,
        ...(recovered?.kind === 'complete'
            ? { recoveredReservation: recovered.reservation }
            : { consent: session.preview.consent }),
    })
    if (actionablePlan.kind !== 'complete') return actionablePlan.kind === 'refusal'
        ? forwardedRefusal(actionablePlan.diagnostics) : destructiveRepairRequired(session.context)
    const applied = await executeDestructivePlan(
        session.context, session.adapters, 'reset', lifecycle, actionablePlan, observation,
        recovered?.kind === 'complete' ? recovered : undefined,
        persistedRequest,
    ) as OperatorResetResult
    return applied.kind === 'complete' ? { ...applied, result: { ...applied.result,
        targets: publicResetPreview(session.context, session.preview).result.targets } } : applied
}
