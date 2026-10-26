import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { isParsedWorkOrder, WORK_ORDER_LIMITS, WORK_ORDER_STATUSES, type ParsedWorkOrder, type WorkOrderStatus } from './contract.js'
import { routeWorkOrder, WORK_ORDER_INTAKE_LIMITS, type WorkOrderCapacity } from './intake.js'

export const mechanism = {
    id: 'work-order-pressure',
    module: 'packages/cockpit/src/work-orders/pressure.ts',
    exports: ['WORK_ORDER_WIP_MAXIMA', 'applyWorkOrderSweep', 'assessWorkOrderSize', 'assessWorkPressure', 'isCurrentWorkPressure', 'planWorkOrderSweep', 'reverseWorkOrderSweep', 'validateWorkOrderPolicy'],
} as const

export { validateWorkOrderPolicy, WORK_ORDER_WIP_MAXIMA } from './intake.js'
export type { ValidatedWorkOrderPolicy, WorkOrderCapacity } from './intake.js'

export interface WorkPressureRefusal {
    readonly kind: 'refusal'
    readonly code: 'WO_POLICY_INVALID' | 'WO_PRESSURE_INVALID' | 'WO_PRESSURE_UNCLASSIFIABLE'
        | 'WO_INVESTIGATION_PATH' | 'WO_SWEEP_OBSERVATION' | 'WO_SWEEP_REPLAY'
        | 'WO_SWEEP_WRITE_FAILED' | 'WO_SWEEP_STALE' | 'WO_HUMAN_PARK'
    readonly message: string
    readonly open?: number
    readonly programmeOpen?: number
    readonly unclassified?: readonly string[]
}
export interface WorkPressureFacts {
    readonly kind: 'pressure'
    readonly programme?: string
    readonly open: number
    readonly programmeOpen: number
    readonly cockpitRemaining: number
    readonly programmeRemaining: number
    readonly unclassified: readonly string[]
}
export interface WorkOrderSize {
    readonly kind: 'size'
    readonly status: WorkOrderStatus
    readonly criteria: number
    readonly livePlanSteps: number
    readonly retainedPlanSteps: number
    readonly evidenceRecords: number
    readonly decisionRecords: number
    readonly limits: typeof WORK_ORDER_LIMITS
    readonly investigationPath?: string
}
export interface WorkOrderPressureObservation {
    readonly id: string
    readonly digest: string
    readonly everStarted: boolean
    readonly humanAnswerHold: string | null
    readonly exemption: string | null
    readonly park: WorkOrderParkRecord | null
}
export interface WorkOrderParkRecord {
    readonly writer: 'automatic' | 'human'
    readonly actor: string
    readonly at: string
    readonly reason: string
    readonly id: string
    readonly sourceDigest: string
    readonly contentDigest: string
    readonly prior: Readonly<{
        status: WorkOrderStatus
        everStarted: boolean
        humanAnswerHold: string | null
        exemption: string | null
        park: null
    }>
}
export interface WorkOrderSweepContext { readonly actor: string; readonly at: string; readonly apply?: boolean }
export interface WorkOrderSweepChange {
    readonly id: string
    readonly digest: string
    readonly priorStatus: WorkOrderStatus
    readonly record: WorkOrderParkRecord
}
export interface WorkOrderSweepPlan {
    readonly kind: 'sweep'
    readonly dryRun: boolean
    readonly changes: readonly WorkOrderSweepChange[]
    readonly exemptions: readonly Readonly<{ id: string; reason: string }>[]
}
export type WorkOrderSweepWrite =
    | Readonly<{ kind: 'reason'; id: string; expectedDigest: string; record: WorkOrderParkRecord }>
    | Readonly<{ kind: 'status'; id: string; expectedDigest: string; from: WorkOrderStatus; to: 'parked'; record: WorkOrderParkRecord }>
export interface WorkOrderSweepWriter {
    // Each write must durably compare the document and human hold/park state before
    // changing it; a resolved write is the persistence adapter's acknowledgement.
    write(change: WorkOrderSweepWrite): Promise<void>
}
export interface WorkOrderSweepReversal {
    readonly kind: 'reversal'
    readonly id: string
    readonly expectedDigest: string
    readonly from: 'parked'
    readonly to: WorkOrderStatus
    readonly prior: WorkOrderParkRecord['prior']
    readonly actor: string
    readonly at: string
    readonly record: WorkOrderParkRecord
}

const pressureBindings = new WeakMap<WorkPressureFacts, string>()
const sweepPlans = new WeakSet<WorkOrderSweepPlan>()
const consumedSweeps = new WeakSet<WorkOrderSweepPlan>()
const closed = (status: WorkOrderStatus) => ['completed', 'cancelled', 'parked'].includes(status)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value) <= WORK_ORDER_LIMITS.lineBytes && !/[\x00-\x1f\x7f]/.test(value)
const exactPath = (value: string) => /^[A-Za-z0-9._/-]+$/.test(value)
    && !value.startsWith('/') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
const refusal = (code: WorkPressureRefusal['code'], message: string): WorkPressureRefusal => Object.freeze({ kind: 'refusal', code, message })
const validContext = (context: WorkOrderSweepContext) => context !== null && typeof context === 'object' && text(context.actor)
    && typeof context.at === 'string' && Number.isFinite(Date.parse(context.at)) && new Date(context.at).toISOString() === context.at
    && (context.apply === undefined || typeof context.apply === 'boolean')

function capacityBinding(capacity: WorkOrderCapacity, programme?: string): string {
    return JSON.stringify([capacity.policy, programme, capacity.orders.map((order) => [order.id, order.contract?.digest]).sort(([a], [b]) => a!.localeCompare(b!))])
}

export function assessWorkPressure(capacity: WorkOrderCapacity, programme?: string): WorkPressureFacts | WorkPressureRefusal {
    if (!capacity || !capacity.policy) return refusal('WO_POLICY_INVALID', 'Pressure requires an issued WIP policy')
    if (programme !== undefined && (typeof programme !== 'string' || !/^[a-z][a-z0-9-]*$/.test(programme))
        || !Array.isArray(capacity.orders) || capacity.orders.length > WORK_ORDER_INTAKE_LIMITS.inventory) {
        return refusal('WO_PRESSURE_INVALID', 'Pressure requires a bounded inventory and canonical programme slug')
    }
    if (capacity.orders.some((order) => !order || !text(order.id))) return refusal('WO_PRESSURE_INVALID', 'Pressure requires named orders')
    // The routing owner authenticates issued policies and counts the same canonical
    // inventory even at the cap. Never re-admit a copied policy to bypass issuance.
    const admission = routeWorkOrder({ certification: true, ...(programme === undefined ? {} : { programme }) }, capacity)
    if (admission.kind === 'fix') return refusal('WO_PRESSURE_INVALID', 'Pressure admission did not inspect work-order capacity')
    if (admission.kind === 'refusal' && admission.code !== 'WO_WIP_CAP') {
        return refusal(admission.code === 'WO_POLICY_INVALID' ? 'WO_POLICY_INVALID' : 'WO_PRESSURE_INVALID', admission.message)
    }
    const { open, programmeOpen, unclassified } = admission
    if (open === undefined || programmeOpen === undefined || unclassified === undefined) return refusal('WO_PRESSURE_INVALID', 'Capacity admission omitted pressure facts')
    if (unclassified.length) return Object.freeze({ ...refusal('WO_PRESSURE_UNCLASSIFIABLE', `Unclassifiable orders count as open: ${unclassified.join(', ')}`), open, programmeOpen, unclassified: Object.freeze([...unclassified].sort()) })
    const facts: WorkPressureFacts = Object.freeze({ kind: 'pressure', ...(programme === undefined ? {} : { programme }), open, programmeOpen,
        cockpitRemaining: Math.max(0, capacity.policy.cockpitCap - open),
        programmeRemaining: Math.max(0, capacity.policy.programmeCap - programmeOpen), unclassified: Object.freeze([]) })
    pressureBindings.set(facts, capacityBinding(capacity, programme))
    return facts
}

export function isCurrentWorkPressure(facts: WorkPressureFacts, capacity: WorkOrderCapacity, programme?: string): boolean {
    const current = assessWorkPressure(capacity, programme)
    return current.kind === 'pressure' && pressureBindings.get(facts) === capacityBinding(capacity, programme)
}

export function assessWorkOrderSize(contract: ParsedWorkOrder, orderPath: string, investigationPath?: string): WorkOrderSize | WorkPressureRefusal {
    if (!isParsedWorkOrder(contract)) return refusal('WO_PRESSURE_UNCLASSIFIABLE', 'Size requires an issued parsed work order')
    if (!text(orderPath) || !exactPath(orderPath) || investigationPath !== undefined
        && (!text(investigationPath) || !exactPath(investigationPath) || investigationPath === orderPath || posix.dirname(orderPath) !== posix.dirname(investigationPath))) {
        return refusal('WO_INVESTIGATION_PATH', 'Investigation must have a named exact path beside the work order')
    }
    const livePlanSteps = closed(contract.frontmatter.status) ? 0 : contract.plan.filter((step) => !step.checked).length
    return Object.freeze({ kind: 'size', status: contract.frontmatter.status, criteria: contract.criteria.length,
        livePlanSteps, retainedPlanSteps: contract.plan.length - livePlanSteps, evidenceRecords: contract.evidence.length,
        decisionRecords: contract.decisions.length, limits: WORK_ORDER_LIMITS,
        ...(investigationPath === undefined ? {} : { investigationPath }) })
}

function contentDigest(contract: ParsedWorkOrder): string {
    const { digest: _digest, frontmatter: { status: _status, ...frontmatter }, ...body } = contract
    return createHash('sha256').update(JSON.stringify({ frontmatter, ...body })).digest('hex')
}

function validParkRecord(record: WorkOrderParkRecord, id: string): boolean {
    return record !== null && typeof record === 'object' && ['human', 'automatic'].includes(record.writer)
        && record.id === id && text(record.actor) && text(record.reason) && validContext(record)
        && typeof record.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(record.sourceDigest)
        && typeof record.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(record.contentDigest)
        && record.prior !== null && typeof record.prior === 'object'
        && WORK_ORDER_STATUSES.includes(record.prior.status) && record.prior.status !== 'parked'
        && typeof record.prior.everStarted === 'boolean' && record.prior.park === null
        && [record.prior.humanAnswerHold, record.prior.exemption].every((value) => value === null || text(value))
        && (record.writer === 'human' || record.prior.status === 'draft' && record.prior.everStarted === false
            && record.prior.humanAnswerHold === null && record.prior.exemption === null)
}

export function planWorkOrderSweep(capacity: WorkOrderCapacity, observations: readonly WorkOrderPressureObservation[], context: WorkOrderSweepContext): WorkOrderSweepPlan | WorkPressureRefusal {
    const pressure = assessWorkPressure(capacity)
    if (pressure.kind === 'refusal') return pressure
    if (!validContext(context) || !Array.isArray(observations) || observations.length !== capacity.orders.length
        || observations.some((item) => item === null || typeof item !== 'object')
        || new Set(observations.map((item) => item.id)).size !== observations.length) return refusal('WO_SWEEP_OBSERVATION', 'Sweep requires a named writer, canonical time and one current observation per order')
    const groups = new Map<string, ParsedWorkOrder[]>()
    const exemptions: { id: string; reason: string }[] = []
    for (const entry of capacity.orders) {
        const contract = entry.contract!
        const observed = observations.find((item) => item.id === entry.id)
        if (!observed || observed.digest !== contract.digest || typeof observed.everStarted !== 'boolean'
            || observed.park !== null && !validParkRecord(observed.park, entry.id)
            || ![observed.humanAnswerHold, observed.exemption].every((value) => value === null || text(value))) {
            return refusal('WO_SWEEP_OBSERVATION', `Missing or stale pressure observation for ${entry.id}`)
        }
        const reason = observed.humanAnswerHold ?? observed.exemption
            ?? (contract.frontmatter.status !== 'draft' ? `Status ${contract.frontmatter.status} is exempt from automatic draft sweep` : null)
            ?? (observed.everStarted ? 'Previously started work is exempt' : null)
            ?? (contract.plan.some((step) => step.checked) || contract.evidence.length > 0 ? 'Canonical plan or evidence records prior work' : null)
            ?? (observed.park !== null ? `Existing ${observed.park.writer} park requires explicit reconciliation: ${observed.park.reason}` : null)
        if (reason !== null) { exemptions.push({ id: entry.id, reason }); continue }
        const key = JSON.stringify([contract.frontmatter.created, contract.frontmatter.programme])
        const group = groups.get(key) ?? []
        group.push(contract)
        groups.set(key, group)
    }
    const changes: WorkOrderSweepChange[] = []
    for (const group of groups.values()) {
        // A same-day batch of three untouched drafts is pressure, not evidence of
        // completion. Retain its earliest identity and preserve every prior field.
        if (group.length < 3) continue
        group.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id, 'en', { numeric: true }))
        for (const contract of group.slice(1)) {
            const record: WorkOrderParkRecord = Object.freeze({ writer: 'automatic', actor: context.actor, at: context.at,
                reason: 'Surplus of a same-day batch of at least three never-started drafts',
                id: contract.frontmatter.id, sourceDigest: contract.digest, contentDigest: contentDigest(contract),
                prior: Object.freeze({ status: contract.frontmatter.status, everStarted: false, humanAnswerHold: null, exemption: null, park: null }) })
            changes.push(Object.freeze({ id: contract.frontmatter.id, digest: contract.digest, priorStatus: contract.frontmatter.status, record }))
        }
    }
    const plan: WorkOrderSweepPlan = Object.freeze({ kind: 'sweep', dryRun: context.apply !== true,
        changes: Object.freeze(changes.sort((a, b) => a.id.localeCompare(b.id))),
        exemptions: Object.freeze(exemptions.sort((a, b) => a.id.localeCompare(b.id)).map((item) => Object.freeze(item))) })
    sweepPlans.add(plan)
    return plan
}

export async function applyWorkOrderSweep(plan: WorkOrderSweepPlan | WorkPressureRefusal, writer: WorkOrderSweepWriter): Promise<Readonly<{ kind: 'dry-run' | 'applied'; changes: readonly WorkOrderSweepChange[] }> | WorkPressureRefusal> {
    if (!plan || typeof plan !== 'object') return refusal('WO_SWEEP_REPLAY', 'Sweep application requires an issued plan')
    if (plan.kind === 'refusal') return plan
    if (!sweepPlans.has(plan) || consumedSweeps.has(plan)) return refusal('WO_SWEEP_REPLAY', 'Sweep plan is unknown or has already attempted writes; observe current state again')
    if (plan.dryRun) return Object.freeze({ kind: 'dry-run', changes: plan.changes })
    consumedSweeps.add(plan)
    for (const change of plan.changes) {
        try {
            await writer.write(Object.freeze({ kind: 'reason', id: change.id, expectedDigest: change.digest, record: change.record }))
            await writer.write(Object.freeze({ kind: 'status', id: change.id, expectedDigest: change.digest, from: change.priorStatus, to: 'parked', record: change.record }))
        } catch (error) {
            return refusal('WO_SWEEP_WRITE_FAILED', `Sweep write failed for ${change.id}; reconcile its reason/status before retry: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    return Object.freeze({ kind: 'applied', changes: plan.changes })
}

export function reverseWorkOrderSweep(contract: ParsedWorkOrder, currentPark: WorkOrderParkRecord, expectedPark: WorkOrderParkRecord, context: WorkOrderSweepContext): WorkOrderSweepReversal | WorkPressureRefusal {
    if (currentPark?.writer === 'human') return refusal('WO_HUMAN_PARK', 'A human-authored park cannot be reversed by automatic sweep reversal')
    if (!isParsedWorkOrder(contract) || !validContext(context) || contract.frontmatter.status !== 'parked'
        || !validParkRecord(currentPark, contract.frontmatter.id) || !validParkRecord(expectedPark, contract.frontmatter.id)
        || currentPark?.writer !== 'automatic' || currentPark.id !== contract.frontmatter.id
        || JSON.stringify(currentPark) !== JSON.stringify(expectedPark) || contentDigest(contract) !== currentPark.contentDigest
        || currentPark.prior?.status !== 'draft' || currentPark.prior.park !== null
        || currentPark.prior.humanAnswerHold !== null || currentPark.prior.exemption !== null || currentPark.prior.everStarted !== false) {
        return refusal('WO_SWEEP_STALE', 'Reversal requires the unchanged parked contract and exact automatic prior-state record')
    }
    return Object.freeze({ kind: 'reversal', id: contract.frontmatter.id, expectedDigest: contract.digest, from: 'parked', to: currentPark.prior.status,
        prior: currentPark.prior, record: currentPark, actor: context.actor, at: context.at })
}
