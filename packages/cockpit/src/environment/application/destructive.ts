import { dirname } from 'node:path'
import { ENVIRONMENT_CODES, type EnvironmentCommandOutcome, type EnvironmentDiagnostic, forwardedRefusal } from '../contract.js'
import { compensateAcquiredPortHolder } from '../ports.js'
import { stopRuntime } from '../runtime.js'
import { decodeCoordinationRecord, liveHolderMessage, releaseStoppedStack, withStackTeardown } from '../claims.js'
import { keptTeardownResources, planReset, planTeardown, remainingTargets, removeTargets, type RemovalTarget, type ResetPlan } from '../reclaim.js'
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
    lifecycleContextRefusal,
    withLifecycleRunNotices,
} from './lifecycle-context.js'
import { exactCommandConfigPath, invalidateCompletedLifecycle, lifecycleSuggestion } from './lifecycle-state.js'
import { lifecycleRefusal, uniqueDiagnostics } from './shared.js'
import { forgetStackInputs } from '../stack-inputs.js'
import { cockpitCommand } from '../../fix-catalogue.js'

type Refusal = Extract<DownCommandResult, { kind: 'refusal' }>

// A stack no session holds is claimed only so down or reset can read it. A run that does not finish
// (a preview, a decline, a refusal) gives it back, or the next up meets a holder it did not take and
// refuses on every retry; a finished run released it with the stack.
async function settleProvisionalClaim<Outcome extends Readonly<{ kind: string; diagnostics: readonly EnvironmentDiagnostic[] }>>(
    context: DestructiveRunContext,
    outcome: Outcome,
): Promise<Outcome | Refusal> {
    const claim = context.provisionalClaim
    if (!claim) return outcome
    context.provisionalClaim = undefined
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
    if (loaded.result.configPath !== configPath) {
        return lifecycleRefusal(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'destructive run context names another configuration',
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

// The re-read after a removal needs only reclaim evidence: re-measuring the runtime and re-listing
// the daemon made `down` take minutes on a busy shared daemon.
async function observeDestructiveReclaim(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
): Promise<DestructiveReclaimObservation | DestructiveObservationRefusal | undefined> {
    const observed = adapters.observeReclaim ? await adapters.observeReclaim(context) : await adapters.observe(context)
    return observed && 'diagnostics' in observed ? observed : selectedObservation(context, observed)
}

function observationRefusal(context: DestructiveRunContext, observed: DestructiveObservationRefusal | undefined): Refusal {
    return observed ?? lifecycleRefusal(
        ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
        'destructive preconditions (configuration, retained ports, runtime readiness or reclaim discovery) could not be observed',
        context.stackId,
    )
}

function rerunFix(context: DestructiveRunContext, purpose: 'down' | 'reset'): string {
    return `fix what the message names, then run \`${cockpitCommand(purpose, { config: context.source.path })}\` again: it stops the stack and removes only what is still there`
}

// Down and reset never displace another session, so they run only while this checkout is the
// stack's one holder.
function coTenantRefusal(context: DestructiveRunContext, observation: DestructiveReclaimObservation): Refusal | undefined {
    const record = observation.down.coordinationRecord
    const coordination = record === null ? undefined : decodeCoordinationRecord(record, context.stackId)
    if (!coordination) return lifecycleRefusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', context.stackId)
    const others = coordination.holders.filter(({ holderId }) => holderId !== context.holderId)
    return others.length === 0 ? undefined : lifecycleRefusal(ENVIRONMENT_CODES.CLAIM_CO_TENANT, liveHolderMessage(others), context.stackId)
}

async function stopStack(context: DestructiveRunContext, adapters: DestructiveCommandAdapters, observation: DestructiveObservation,
    purpose: 'down' | 'reset'): Promise<Refusal | undefined> {
    const stopped = await stopRuntime({ topology: observation.runtime.topology, execute: (step) => adapters.execute(step) })
    return stopped.kind === 'stopped' ? undefined
        : lifecycleRefusal(ENVIRONMENT_CODES.EXECUTION_STEP_FAILED, `the stack could not be stopped: ${stopped.reason}`, context.stackId, rerunFix(context, purpose))
}

function describeTargets(targets: readonly RemovalTarget[]): string {
    return targets.map(({ kind, name, id }) => `${kind} ${name} (${id})`).join('; ')
}

// Docker or rm reporting success is not proof; a later discovery that no longer lists the target is.
// That discovery is planned again, because a container started meanwhile (a leftover or concurrent
// `docker compose up`) would otherwise run on ports this command is about to release.
async function removeAndConfirm(
    context: DestructiveRunContext,
    adapters: DestructiveCommandAdapters,
    targets: readonly RemovalTarget[],
    purpose: 'down' | 'reset',
    replan: (after: DestructiveReclaimObservation) => Promise<readonly RemovalTarget[] | Refusal>,
): Promise<DestructiveReclaimObservation | Refusal> {
    const failed = await removeTargets(targets, (step) => adapters.execute(step))
    if (failed) return forwardedRefusal(failed.diagnostics)
    const after = await observeDestructiveReclaim(context, adapters)
    if (!after || 'diagnostics' in after) return observationRefusal(context, after)
    const remaining = remainingTargets(targets, after.down.discovery)
    if (remaining.length > 0) return lifecycleRefusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH,
        `${purpose} was told each removal succeeded, but a fresh discovery still lists ${describeTargets(remaining)}`,
        context.stackId, rerunFix(context, purpose))
    const appeared = await replan(after)
    if ('status' in appeared) return appeared
    return appeared.length === 0 ? after : lifecycleRefusal(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        `the stack changed during ${purpose}: a fresh discovery lists ${describeTargets(appeared)}, which it had not planned to remove`,
        context.stackId, rerunFix(context, purpose))
}

async function teardownTargets(observed: DestructiveReclaimObservation): Promise<readonly RemovalTarget[] | Refusal> {
    const plan = planTeardown(observed.down)
    return plan.kind === 'complete' ? plan.targets : forwardedRefusal(plan.diagnostics)
}

// Teardown removes only what it can prove is this stack's and unused, so a finished teardown can
// still leave the stack's own resources in place. Reporting `removed` then told the operator the
// stack was gone while its containers and network stayed, so down refuses and names each one.
function downKeptRefusal(context: DestructiveRunContext, observed: DestructiveReclaimObservation): Refusal | undefined {
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

async function releaseStack(context: DestructiveRunContext): Promise<Refusal | undefined> {
    const released = await releaseStoppedStack({ namespace: context.namespace, stackId: context.stackId, holderId: context.holderId })
    if (released.kind !== 'complete') return forwardedRefusal(released.diagnostics)
    context.provisionalClaim = undefined
    return undefined
}

export async function runDown(
    input: DownCommandInput,
    adapters: DownCommandAdapters,
): Promise<DownCommandResult> {
    const loaded = await loadDestructiveContext(input, adapters)
    if (loaded.kind !== 'complete') return loaded as DownCommandResult
    const context = loaded.result
    const outcome = await settleProvisionalClaim(context,
        await withStackTeardown(context.namespace, context.stackId, context.holderId, () => downWithContext(context, adapters)))
    const result: DownCommandResult = 'status' in outcome ? outcome : forwardedRefusal(outcome.diagnostics)
    // A removed stack runs nothing a later doctor could call stale.
    const forgotten = result.kind === 'complete' && result.result.change === 'removed' ? await forgetStackInputs(dirname(context.source.path)) : []
    return withLifecycleRunNotices(context, forgotten.length === 0 ? result : { ...result, diagnostics: uniqueDiagnostics([...result.diagnostics, ...forgotten]) })
}

// Every step reads what Docker reports now, so a down that was interrupted anywhere is finished by
// running it again: the stop is a no-op, and only what is still there is removed.
async function downWithContext(context: DestructiveRunContext, adapters: DownCommandAdapters): Promise<DownCommandResult> {
    const observation = await observeDestructive(context, adapters)
    if (!observation || 'diagnostics' in observation) return observationRefusal(context, observation)
    const coTenant = coTenantRefusal(context, observation)
    if (coTenant) return coTenant
    const stopped = await stopStack(context, adapters, observation, 'down')
    if (stopped) return stopped
    const plan = planTeardown(observation.down)
    if (plan.kind !== 'complete') return forwardedRefusal(plan.diagnostics)
    const after = await removeAndConfirm(context, adapters, plan.targets, 'down', teardownTargets)
    if ('status' in after) return after
    const kept = downKeptRefusal(context, after)
    if (kept) return kept
    const invalidated = await invalidateCompletedLifecycle(context, 'down')
    if (invalidated) return invalidated
    return await releaseStack(context) ?? {
        kind: 'complete', status: 0, diagnostics: [],
        result: { stackId: context.stackId, change: 'removed' },
    }
}

async function resetPreview(
    context: DestructiveRunContext,
    adapters: ResetCommandAdapters,
): Promise<ResetPlan | Refusal> {
    const observation = await observeDestructive(context, adapters)
    if (!observation || 'diagnostics' in observation) return observationRefusal(context, observation)
    const plan = await planReset(observation.reset)
    return plan.kind === 'complete' ? plan : forwardedRefusal(plan.diagnostics)
}

function publicResetPreview(context: DestructiveRunContext, preview: ResetPlan): Extract<ResetCommandResult, { kind: 'preview' }> {
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
    // A session decides once; a second decision finds it spent.
    let pending: Readonly<{ context: DestructiveRunContext; adapters: ResetCommandAdapters; preview: ResetPlan }> | undefined = { context, adapters, preview }
    return {
        preview: withLifecycleRunNotices(context, publicResetPreview(context, preview)),
        decide: async (decision: 'approve' | 'decline') => {
            const session = pending
            pending = undefined
            const unapproved = forwardedRefusal([{
                severity: 'error', code: ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
                message: decision === 'decline' ? 'reset was declined' : 'reset operator session is unavailable', target: 'reset',
            }])
            if (!session) return unapproved
            const applied = decision === 'approve'
                ? await withStackTeardown(session.context.namespace, session.context.stackId, session.context.holderId,
                    () => applyReset(session.context, session.adapters, session.preview))
                : unapproved
            return settleProvisionalClaim(session.context, 'status' in applied ? applied : forwardedRefusal(applied.diagnostics))
        },
    }
}

// The approval names the exact targets the preview showed. Reset reads the stack again and acts only
// while it still finds those targets; an interrupted reset is finished by running it again.
async function applyReset(context: DestructiveRunContext, adapters: ResetCommandAdapters, approved: ResetPlan): Promise<OperatorResetResult> {
    const observation = await observeDestructive(context, adapters)
    if (!observation || 'diagnostics' in observation) return observationRefusal(context, observation)
    const coTenant = coTenantRefusal(context, observation)
    if (coTenant) return coTenant
    const plan = await planReset(observation.reset)
    if (plan.kind !== 'complete') return forwardedRefusal(plan.diagnostics)
    if (plan.digest !== approved.digest) {
        return lifecycleRefusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
            'the stack changed after the preview, so the approved targets are no longer exactly what reset would delete', 'reset-confirmation',
            'run reset again to see and approve the current targets')
    }
    if (plan.noop) return { kind: 'complete', status: 0, diagnostics: [], result: { stackId: context.stackId, change: 'unchanged' } }
    const stopped = await stopStack(context, adapters, observation, 'reset')
    if (stopped) return stopped
    // Reset deletes the declared data and leaves the stopped stack, so what must not appear meanwhile
    // is a target of its own or a container that was not there when it started.
    const before = new Set(observation.down.discovery.resources.map(({ kind, id }) => `${kind}:${id}`))
    const after = await removeAndConfirm(context, adapters, plan.removals, 'reset', async (observed) => {
        const replanned = await planReset(observed.reset)
        if (replanned.kind !== 'complete') return forwardedRefusal(replanned.diagnostics)
        const teardown = await teardownTargets(observed)
        if ('status' in teardown) return teardown
        return [...replanned.removals, ...teardown.filter(({ kind, id }) => kind === 'container' && !before.has(`${kind}:${id}`))]
    })
    if ('status' in after) return after
    return await releaseStack(context) ?? {
        kind: 'complete', status: 0, diagnostics: [],
        result: { stackId: context.stackId, change: 'reset', targets: plan.targets.map((target) => ({ ...target })) },
    }
}
