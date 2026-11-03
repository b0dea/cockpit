import { normalizeVerificationObservation, verificationObservationPassed, type VerificationObservation } from '../grading/verifier.js'
import { isParsedWorkOrder } from './contract.js'
import { isCurrentWorkOrderAcceptance, isValidatedWorkOrderPolicy, type ValidatedWorkOrderPolicy, type AcceptedWorkOrder } from './intake.js'
import { resumeWorkOrder } from './resume.js'
import {
    encodeWorkOrderState, persistWorkOrderProgress, readWorkOrderState, type WorkOrderProgressEvent, type WorkOrderStateStore,
    type WorkOrderWriter,
} from './state.js'
import { type WorkOrderStatusInput } from './status.js'
import { errorCause } from '../environment/contract.js'

export const mechanism = {
    id: 'work-order-execution',
    module: 'packages/cockpit/src/work-orders/executor.ts',
    exports: ['executeWorkOrderStep'],
} as const

export interface WorkOrderExecutionInput {
    readonly policy: ValidatedWorkOrderPolicy
    readonly accepted: AcceptedWorkOrder
    readonly status: WorkOrderStatusInput
    readonly stateBytes: Uint8Array
    readonly writer: WorkOrderWriter
    readonly approach: string
    readonly discovery?: Readonly<{ id: string; question: string }>
}
export interface WorkOrderExecutionDependencies {
    readonly store: WorkOrderStateStore
    readonly execute: (argv: readonly string[]) => Promise<VerificationObservation>
}
export type WorkOrderExecutionResult =
    | Readonly<{ kind: 'complete'; step: number; replay: boolean }>
    | Readonly<{ kind: 'paused'; step: number; reason: string; verification?: VerificationTail }>
    | Readonly<{ kind: 'refusal'; reason: string }>

// What the failing command printed last, so the agent sees the failure without rerunning it.
type VerificationTail = Readonly<{ argv: readonly string[]; exitCode: number; stdout: string; stderr: string }>
const TAIL_CHARACTERS = 4_096

function boundedText(value: unknown, maximum = 4_096): value is string {
    return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= maximum
        && !/[\x00-\x1f\x7f]/.test(value)
}

async function persist(
    input: WorkOrderExecutionInput,
    event: WorkOrderProgressEvent,
    dependencies: WorkOrderExecutionDependencies,
): Promise<Readonly<{ kind: 'complete'; bytes: Uint8Array }> | Readonly<{ kind: 'refusal'; reason: string }>> {
    const result = await persistWorkOrderProgress(input.accepted.contract, input.policy, input.stateBytes, event, input.writer, dependencies.store)
    if (result.kind === 'refusal') return { kind: 'refusal', reason: result.message }
    try {
        const bytes = Buffer.from(await dependencies.store.read())
        const readback = readWorkOrderState(input.accepted.contract, bytes)
        if (readback.kind === 'refusal' || !bytes.equals(Buffer.from(encodeWorkOrderState(input.accepted.contract, result.value)))) {
            return { kind: 'refusal', reason: 'Persisted execution state changed before the next decision' }
        }
        return { kind: 'complete', bytes }
    } catch (error) {
        return { kind: 'refusal', reason: `Execution state readback failed: ${errorCause(error)}` }
    }
}

export async function executeWorkOrderStep(
    input: WorkOrderExecutionInput,
    dependencies: WorkOrderExecutionDependencies,
): Promise<WorkOrderExecutionResult> {
    if (!isValidatedWorkOrderPolicy(input.policy)) return { kind: 'refusal', reason: 'Execution requires an issued work-order policy' }
    if (!isCurrentWorkOrderAcceptance(input.accepted, input.accepted?.contract)
        || !boundedText(input.writer?.actor, 256) || !boundedText(input.approach)) {
        return { kind: 'refusal', reason: 'Execution requires current accepted work, a named writer and a bounded approach' }
    }
    const loaded = readWorkOrderState(input.accepted.contract, input.stateBytes)
    if (loaded.kind === 'refusal') return { kind: 'refusal', reason: loaded.message }
    // Only the selected order is resumed: several accepted orders may be active within the WIP cap.
    const status = { ...input.status, orders: input.status.orders.flatMap(row => isParsedWorkOrder(row.contract) && row.contract.frontmatter.id === input.accepted.contract.frontmatter.id
        ? [{ contract: input.accepted.contract, state: input.stateBytes }] : []) }
    const next = resumeWorkOrder(status, input.policy)
    if (next.kind !== 'ready') return { kind: 'refusal', reason: next.message }
    if (next.contract !== input.accepted.contract || next.state.contractDigest !== input.accepted.binding.digest
        || !next.authority.every((path, index) => path === input.accepted.binding.authority[index])
        || next.authority.length !== input.accepted.binding.authority.length) {
        return { kind: 'refusal', reason: 'Resume selected work outside the current accepted Authority boundary' }
    }
    if (next.state.attempts.some(attempt => attempt.step === next.step && attempt.approach === input.approach && attempt.failures >= input.policy.attemptCap)) {
        return { kind: 'refusal', reason: 'Root cause and a different approach or human input required before another dispatch' }
    }
    if (input.discovery !== undefined) {
        if (!boundedText(input.discovery.id, 256) || !boundedText(input.discovery.question)) {
            return { kind: 'refusal', reason: 'A discovery requires a bounded identity and question' }
        }
        const recorded = await persist(input, { kind: 'gap', id: input.discovery.id, step: next.step, question: input.discovery.question }, dependencies)
        return recorded.kind === 'complete'
            ? { kind: 'paused', step: next.step, reason: 'Discovery persisted before execution; human input is required' }
            : recorded
    }
    const reserved = await persist(input, { kind: 'reserve-execution', step: next.step, approach: input.approach }, dependencies)
    if (reserved.kind === 'refusal') return reserved
    const reservedInput = { ...input, stateBytes: reserved.bytes }
    let observation: VerificationObservation
    try {
        observation = normalizeVerificationObservation(await dependencies.execute(next.argv))
    } catch (error) {
        observation = { kind: 'error', reason: errorCause(error) }
    }
    const passed = verificationObservationPassed(observation)
    if (!passed) {
        const failed = await persist(reservedInput, { kind: 'attempt', step: next.step, approach: input.approach, outcome: 'failed' }, dependencies)
        if (failed.kind === 'refusal') return failed
        if (observation.kind !== 'executed') return { kind: 'paused', step: next.step, reason: `Declared verification ${observation.kind}: ${observation.reason}` }
        const verification = Object.freeze({ argv: Object.freeze([...next.argv]), exitCode: observation.exitCode,
            stdout: observation.stdout.slice(-TAIL_CHARACTERS), stderr: observation.stderr.slice(-TAIL_CHARACTERS) })
        return { kind: 'paused', step: next.step, verification, reason: observation.exitCode !== 0
            ? `Declared verification failed with exit ${observation.exitCode}`
            : 'Declared verification produced no usable stdout or stderr' }
    }
    const settled = await persist(reservedInput, {
        kind: 'settle-execution', step: next.step, approach: input.approach,
        proof: { layer: 'local', reference: `execution:${next.step}`, contractDigest: input.accepted.contract.digest,
            repositories: input.status.repositories.map(repository => ({ ...repository })), command: [...next.argv] },
    }, dependencies)
    if (settled.kind === 'refusal') return settled
    return Object.freeze({ kind: 'complete', step: next.step, replay: next.replay })
}
