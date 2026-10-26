import { isValidatedWorkOrderPolicy, type ValidatedWorkOrderPolicy } from './intake.js'
import { projectWorkOrderStatus, type WorkOrderDrift, type WorkOrderEvidenceLayers, type WorkOrderStatusInput, type WorkOrderStatusResult } from './status.js'
import { type ParsedWorkOrder } from './contract.js'
import { workOrderProofIsCurrent, type WorkOrderExecutionState } from './state.js'

export const mechanism = {
    id: 'work-order-resume',
    module: 'packages/cockpit/src/work-orders/resume.ts',
    exports: ['resumeWorkOrder'],
} as const

export interface WorkOrderResumeRefusal {
    readonly kind: 'refusal'
    readonly code: 'WO_POLICY_INVALID' | 'WO_RESUME_NO_ACTIVE' | 'WO_RESUME_AMBIGUOUS' | 'WO_RESUME_BLOCKED' | 'WO_ROOT_CAUSE_REQUIRED' | 'WO_RESUME_AWAITING_GRADE'
    readonly message: string
    readonly drift?: readonly WorkOrderDrift[]
    readonly layers?: WorkOrderEvidenceLayers
}
export interface WorkOrderResumeReady {
    readonly kind: 'ready'; readonly id: string; readonly step: number; readonly item: string
    readonly command: string; readonly argv: readonly string[]; readonly replay: boolean
    readonly authority: readonly string[]; readonly drift: readonly WorkOrderDrift[]; readonly layers: WorkOrderEvidenceLayers
    readonly contract: ParsedWorkOrder; readonly state: WorkOrderExecutionState
}
export type WorkOrderResumeResult = WorkOrderResumeReady | WorkOrderResumeRefusal | Extract<WorkOrderStatusResult, { kind: 'refusal' }>

export function resumeWorkOrder(input: WorkOrderStatusInput, policy: ValidatedWorkOrderPolicy): WorkOrderResumeResult {
    if (!isValidatedWorkOrderPolicy(policy)) return { kind: 'refusal', code: 'WO_POLICY_INVALID', message: 'Resume requires an issued work-order policy' }
    const status = projectWorkOrderStatus(input)
    if (status.kind === 'refusal') return status
    if (!status.active.length) return { kind: 'refusal', code: 'WO_RESUME_NO_ACTIVE', message: 'No active work-order; explicitly select and activate accepted work before resuming' }
    if (status.active.length !== 1) return { kind: 'refusal', code: 'WO_RESUME_AMBIGUOUS', message: `Multiple active work-orders: ${status.active.join(', ')}` }
    const row = status.orders.find((entry) => entry.id === status.active[0])!
    const state = row.state!
    if (state.reservation) return {
        kind: 'refusal', code: 'WO_RESUME_BLOCKED',
        message: `Plan step ${state.reservation.step} approach ${JSON.stringify(state.reservation.approach)} has an interrupted execution reservation; reconcile it before redispatch`,
        drift: row.drift, layers: row.layers,
    }
    if (row.drift.some((entry) => entry.actual === null)) return { kind: 'refusal', code: 'WO_RESUME_BLOCKED', message: 'Required repository observations are unavailable; restore the execution boundary before resuming', drift: row.drift, layers: row.layers }
    const currentSteps = new Set<number>()
    for (const step of state.steps) {
        if (step.checked && workOrderProofIsCurrent(step.checked, row.contract, input.repositories) && step.requires.every((number) => currentSteps.has(number))) currentSteps.add(step.number)
    }
    const current = (number: number) => currentSteps.has(number)
    const pending = state.steps.filter((step) => !current(step.number))
    if (!pending.length) return { kind: 'refusal', code: 'WO_RESUME_AWAITING_GRADE', message: `${row.id} has current checked proof for every step; independent grading is required before completion` }
    const causes = state.attempts.filter((attempt) => pending.some((step) => step.number === attempt.step) && attempt.failures >= policy.attemptCap && !attempt.rootCause)
    const step = pending.find((step) => step.requires.every(current)
        && !state.gaps.some((gap) => gap.step === step.number && !gap.answer)
        && !causes.some((attempt) => attempt.step === step.number))
    if (!step) {
        if (causes.length) return { kind: 'refusal', code: 'WO_ROOT_CAUSE_REQUIRED', message: `Record root-cause analysis and choose a different approach for Plan steps ${causes.map((attempt) => attempt.step).join(', ')}` }
        return { kind: 'refusal', code: 'WO_RESUME_BLOCKED', message: `No unblocked step: ${state.gaps.filter((gap) => !gap.answer).map((gap) => `${gap.id}: ${gap.question}`).join('; ') || 'prerequisite proof is unavailable'}` }
    }
    const argv = Object.freeze([...step.command])
    const command = argv.map((argument) => `'${argument.replace(/'/g, "'\\''")}'`).join(' ')
    return Object.freeze({ kind: 'ready', id: row.id, step: step.number, item: step.text, command, argv, replay: !!step.checked, authority: row.contract.authority, drift: row.drift, layers: row.layers, contract: row.contract, state })
}
