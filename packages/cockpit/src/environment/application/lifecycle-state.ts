import { dirname, join, resolve } from 'node:path'
import { cleanupFencedExecution } from '../../environment-exec/execute.js'
import {
    ENVIRONMENT_CODES,
    type EnvironmentCommandOutcome,
    type EnvironmentDiagnostic,
    type ExecutionFence,
    type HolderId,
    snapshotJson,
    forwardedRefusal,
} from '../contract.js'
import { cockpitCommand } from '../../fix-catalogue.js'
import { abortStateTransaction, readState, transactState, type StateRecord, type StateResult, type SkippedStateNamespace } from '../state.js'
import { decodeLifecycleRecord, resolveLifecycleStage, type CurrentLifecycleRecord, type LifecycleRecordValue } from '../lifecycle-stage.js'
import { inspectPortLeaseTransfer, revalidatePortLeaseProjection, type PortLeaseProjection } from '../ports.js'
import { commitDrainOutcome, decodeCoordinationRecord, type DrainOutcome } from '../claims.js'
import { lifecycleRefusal, ownerDiagnostic, shellQuote } from './shared.js'
import { type LifecycleRunContext, type SleepCommandResult, type UpCommandResult, withLifecycleConfiguration } from './lifecycle-context.js'

export function lifecycleSuggestion(context: LifecycleRunContext, command: 'up' | 'down'): string {
    return cockpitCommand(command, { config: context.source.path })
}

export async function readLifecycleRecord(context: LifecycleRunContext): Promise<CurrentLifecycleRecord | null | UpCommandResult> {
    const address = context.namespace.paths.lifecycle(context.stackId)
    const result = await readState(address)
    if (result.kind === 'missing') {
        const stage = await resolveLifecycleStage({
            namespace: context.namespace, stackId: context.stackId, observedAt: new Date().toISOString(),
        })
        if (stage.kind !== 'complete') return forwardedRefusal(stage.diagnostics)
        return stage.authority.stage === 'steady'
            ? lifecycleRefusal(ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID,
                'seeded lifecycle history requires persisted progress', address.path)
            : null
    }
    if (result.kind !== 'complete') {
        return lifecycleRefusal(result.code, result.message, result.target)
    }
    return decodeLifecycleRecord(result.value, context) ?? lifecycleRefusal(
        ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
        'lifecycle progress record is malformed',
        address.path,
    )
}

function lifecycleStateRecord(
    context: LifecycleRunContext,
    current: StateRecord | null,
    value: LifecycleRecordValue,
    updatedAt: string,
): StateRecord {
    return {
        format: 'cockpit-state/v1',
        kind: 'lifecycle',
        cockpitId: context.cockpitId,
        subjectId: context.stackId,
        revision: current === null ? 0 : current.revision + 1,
        updatedAt,
        value: snapshotJson(value)! as StateRecord['value'],
    }
}

export async function publishLifecycleRecord(
    context: LifecycleRunContext,
    expected: StateRecord | null,
    value: LifecycleRecordValue,
    transfer?: Readonly<{ readonly previousHolderId: HolderId; readonly projection: PortLeaseProjection }>,
    rebind?: PortLeaseProjection,
): Promise<StateResult<StateRecord> | UpCommandResult> {
    const address = context.namespace.paths.lifecycle(context.stackId)
    const expectedBytes = JSON.stringify(expected)
    const result = await transactState(
        context.namespace,
        address,
        { ownerId: context.holderId },
        async (current) => {
            if (JSON.stringify(current) !== expectedBytes) return abortStateTransaction(lifecycleRefusal(
                ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID,
                'lifecycle progress changed during execution',
                address.path,
            ))
            if (transfer) {
                const ownership = await inspectPortLeaseTransfer({
                    namespace: context.namespace,
                    stackId: context.stackId,
                    holderId: context.holderId,
                    checkoutId: context.checkoutId,
                    previousHolderId: transfer.previousHolderId,
                    projection: transfer.projection,
                })
                if (ownership.kind === 'refusal') return abortStateTransaction({
                    kind: 'refusal' as const,
                    status: 2 as const,
                    result: null,
                    diagnostics: ownership.diagnostics.map((diagnostic) => diagnostic.code === ENVIRONMENT_CODES.CLAIM_CO_TENANT
                        ? ownerDiagnostic(diagnostic.code,
                            `lifecycle progress belongs to another active session; run \`${lifecycleSuggestion(context, 'up')}\` to resume it or \`${lifecycleSuggestion(context, 'down')}\` to release it`,
                            diagnostic.target ?? context.stackId)
                        : diagnostic),
                })
            }
            if (rebind && (!await withLifecycleConfiguration(context, async () => true)
                || !await revalidatePortLeaseProjection({ projection: rebind, namespace: context.namespace }))) {
                return abortStateTransaction(lifecycleRefusal(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
                    `configuration or sole-holder lease changed before generated lifecycle refresh; rerun \`${lifecycleSuggestion(context, 'up')}\``, context.stackId,
                    'rerun npx --no cockpit up --config <your cockpit.toml> once nothing else is changing cockpit.toml or bringing the stack up'))
            }
            return lifecycleStateRecord(context, current, value, new Date().toISOString())
        },
    )
    if ('aborted' in result) return result.value
    if (result.kind === 'complete' || result.kind === 'indeterminate') return result
    return result.kind === 'missing'
        ? lifecycleRefusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'lifecycle progress publication returned no record', result.path)
        : lifecycleRefusal(result.code, result.message, result.target)
}

// Port leases are machine-wide, so up reads every cockpit's state. Another cockpit's namespace this
// version cannot read is skipped there rather than refused; this cockpit's own unreadable state still
// refuses in the command itself. The skipped ones are named in a single warning with one cleanup
// command, and only by doctor: the folders belong to other cockpits, usually ones an earlier version
// left behind, and repeating them on every up (and so every session) buried each result under lines
// about cockpits the person was not working on. A port they still hold fails up on its own.
export function unreadableStateWarning(skipped: readonly SkippedStateNamespace[]): EnvironmentDiagnostic | undefined {
    if (skipped.length === 0) return undefined
    const directory = dirname(skipped[0]!.path)
    const reasons = [...new Set(skipped.map(({ reason }) => reason))].join('; ')
    const count = skipped.length === 1 ? '1 state folder of another cockpit' : `${skipped.length} state folders of other cockpits`
    return {
        severity: 'warning',
        code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
        message: `${count} under ${directory} cannot be read by this cockpit version (${reasons}), so their claims and port leases were ignored`,
        target: directory,
        fix: `ask the person who owns this machine whether any cockpit still uses them; if none does, stop any stack they started (docker compose ls lists them), then delete them: rm -rf ${skipped.map(({ path }) => shellQuote(path)).join(' ')}`,
    }
}

// `up` keeps a holder whenever containers may exist, so a stack no session holds has nothing running.
// Sleep then has nothing to stop; refusing with a co-tenant error sent people looking for a session
// that did not exist, after an `up` that never started anything or a second `sleep`.
export async function unheldStack(context: LifecycleRunContext): Promise<SleepCommandResult | undefined> {
    const stored = await readState(context.namespace.paths.coordination(context.stackId))
    if (stored.kind !== 'complete') return undefined
    const coordination = decodeCoordinationRecord(stored.value, context.stackId)
    if (!coordination || coordination.holders.length > 0) return undefined
    const reserved = coordination.lease !== null && !coordination.lease.released
    return {
        kind: 'complete', status: 0,
        diagnostics: [{
            severity: 'warning' as const, code: ENVIRONMENT_CODES.STACK_NOT_RUNNING, target: context.stackId,
            message: reserved
                ? `no session holds this stack, so nothing is running and sleep has nothing to stop; its port family stays reserved for the next up until \`${lifecycleSuggestion(context, 'down')}\` releases it`
                : 'the stack is already asleep: no session holds it and its services are stopped, so sleep has nothing to do',
        }],
        result: { stackId: context.stackId, change: 'unchanged' as const },
    }
}

export function repairRequired(context: LifecycleRunContext): Extract<SleepCommandResult, { kind: 'refusal' }> {
    return lifecycleRefusal(
        ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED,
        'cockpit cannot prove the interrupted sleep executor stopped, so it will not overlap it with another destructive action; preserve the coordination state for explicit repair',
        context.stackId,
    )
}

export async function invalidateCompletedLifecycle(
    context: LifecycleRunContext,
    workBasisSha256: string,
    operationGeneration: string,
    purpose: 'sleep' | 'down',
): Promise<Extract<SleepCommandResult, { kind: 'refusal' }> | undefined> {
    const current = await readLifecycleRecord(context)
    if (current !== null && 'kind' in current) return forwardedRefusal(current.diagnostics)
    const stored = current as CurrentLifecycleRecord | null
    // `up` writes the lifecycle record before it starts a service, so without one nothing ever ran
    // and there is no identity to retire. Writing one here left a record without lifecycle history,
    // which the next `up` refused as malformed state.
    if (stored === null) return undefined
    if (purpose === 'down' && stored.value.teardownComplete === true
        && stored.value.holderId === context.holderId && stored.value.workBasisSha256 === workBasisSha256
        && stored.value.operationGeneration === operationGeneration) return undefined
    // Sleep retains containers, so its replay still guards resume. Only a reconciled down
    // retires that identity, before the final drain publication can release its claim.
    const value: LifecycleRecordValue = {
        holderId: context.holderId,
        workBasisSha256,
        operationGeneration,
        completedServices: [],
        ...(purpose === 'down' ? { teardownComplete: true as const } : {
            ...(stored.value.runtimeInputs ? { runtimeInputs: stored.value.runtimeInputs } : {}),
        }),
    }
    const publication = await publishLifecycleRecord(context, stored.record, value)
    if ('status' in publication) return forwardedRefusal(publication.diagnostics)
    if (publication.kind === 'indeterminate') return lifecycleRefusal(
        ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
        publication.message,
        publication.target,
    )
    if (publication.kind !== 'complete' || !decodeLifecycleRecord(publication.value, context)) {
        return lifecycleRefusal(
            ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
            'stopped lifecycle invalidation could not be verified',
            context.namespace.paths.lifecycle(context.stackId).path,
        )
    }
    return undefined
}

export async function publishDrainOutcomeRecord(
    context: LifecycleRunContext,
    outcome: DrainOutcome,
): Promise<Extract<SleepCommandResult, { kind: 'refusal' }> | undefined> {
    const publication = await commitDrainOutcome({
        outcome,
        namespace: context.namespace,
        stackId: context.stackId,
    })
    if ('diagnostics' in publication) {
        return forwardedRefusal(publication.diagnostics)
    }
    if (publication.kind === 'indeterminate') return lifecycleRefusal(
        ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
        publication.message,
        publication.target,
    )
    if (publication.kind !== 'complete') {
        return publication.kind === 'missing'
            ? lifecycleRefusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'drain outcome publication returned no record', publication.path)
            : lifecycleRefusal(publication.code, publication.message, publication.target)
    }
    return undefined
}

export async function publishDrainOutcome(
    context: LifecycleRunContext,
    outcome: DrainOutcome,
    fence: ExecutionFence,
): Promise<SleepCommandResult | undefined> {
    const published = await publishDrainOutcomeRecord(context, outcome)
    if (published) return published
    return await cleanupFencedExecution(fence) ? undefined : lifecycleRefusal(
        ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
        'the drain outcome was published but its durable execution fence could not be removed',
        fence.markerPath,
    )
}

export function exactCommandConfigPath(input: unknown): string | undefined {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 1 || !descriptors.configPath || !('value' in descriptors.configPath)
            || typeof descriptors.configPath.value !== 'string' || descriptors.configPath.value.length === 0
            || descriptors.configPath.value.includes('\0')) return undefined
        return resolve(descriptors.configPath.value)
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}
