import { describe, expect, it } from 'vitest'
import { parseWorkOrder, WORK_ORDER_LIMITS, type ParsedWorkOrder } from './contract.js'
import { workOrderFixture, padWorkOrder } from '../test-support/work-order.js'
import { validateWorkOrderPolicy, WORK_ORDER_WIP_MAXIMA, type WorkOrderCapacity } from './intake.js'
import { assessWorkPressure, assessWorkOrderSize, planWorkOrderSweep, applyWorkOrderSweep, reverseWorkOrderSweep } from './pressure.js'

function order(id: string, status = 'draft', programme?: string, padded = false): ParsedWorkOrder {
    const text = workOrderFixture({ status, programme }).replace('WO-001', id)
    const parsed = parseWorkOrder(Buffer.from(padded ? padWorkOrder(text, WORK_ORDER_LIMITS.bytes) : text))
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.findings))
    return parsed.value
}
function capacity(orders: WorkOrderCapacity['orders'] = [], cockpitCap = 3): WorkOrderCapacity {
    const result = validateWorkOrderPolicy({ cockpitCap, programmeCap: 1 })
    if (result.kind !== 'policy') throw new Error(result.message)
    return { policy: result.policy, orders }
}
const observation = (contract: ParsedWorkOrder, overrides = {}) => ({
    id: contract.frontmatter.id, digest: contract.digest, everStarted: false,
    humanAnswerHold: null, exemption: null, park: null, ...overrides,
})
const context = { actor: 'pressure-controller', at: '2026-02-01T00:00:00.000Z' }

describe('work pressure', () => {
    it('counts only open frontmatter states and refuses named unclassifiable state', () => {
        const active = order('WO-001', 'active', 'cache')
        const parked = order('WO-002', 'parked', 'cache')
        const input = capacity([{ id: 'WO-001', contract: active }, { id: 'WO-002', contract: parked }])
        expect(assessWorkPressure(input, 'cache')).toMatchObject({ kind: 'pressure', open: 1, programmeOpen: 1, cockpitRemaining: 2, programmeRemaining: 0 })
        expect(assessWorkPressure(capacity([...input.orders, { id: 'WO-003', contract: null }]), 'cache')).toMatchObject({ kind: 'refusal', code: 'WO_PRESSURE_UNCLASSIFIABLE', open: 2, programmeOpen: 2, unclassified: ['WO-003'] })
    })

    it('reuses immutable maxima and rejects missing, raised, fractional and duplicate policy/state inputs', () => {
        expect(Object.isFrozen(WORK_ORDER_WIP_MAXIMA)).toBe(true)
        for (const policy of [undefined, { cockpitCap: 4, programmeCap: 1 }, { cockpitCap: 2.5, programmeCap: 1 }, { cockpitCap: 3, programmeCap: 2 }]) {
            expect(assessWorkPressure({ policy, orders: [] } as unknown as WorkOrderCapacity)).toMatchObject({ kind: 'refusal', code: 'WO_POLICY_INVALID' })
        }
        const draft = order('WO-001')
        expect(assessWorkPressure(capacity([{ id: 'WO-001', contract: draft }, { id: 'WO-001', contract: draft }]))).toMatchObject({ kind: 'refusal', code: 'WO_PRESSURE_INVALID' })
        expect(assessWorkPressure(capacity([{ id: 'WO-001', contract: draft }], 1))).toMatchObject({ kind: 'pressure', cockpitRemaining: 0 })
    })

    it('measures live and retained size by status without changing findings under irrelevant padding', () => {
        for (const status of ['draft', 'active', 'parked']) {
            const small = order('WO-001', status)
            const large = order('WO-001', status, undefined, true)
            expect(assessWorkOrderSize(small, 'workorders/WO-001.md', 'workorders/WO-001-investigation.md')).toEqual(assessWorkOrderSize(large, 'workorders/WO-001.md', 'workorders/WO-001-investigation.md'))
        }
        expect(assessWorkOrderSize(order('WO-001', 'active'), 'workorders/WO-001.md', 'workorders/WO-001-investigation.md')).toMatchObject({ kind: 'size', livePlanSteps: 2, retainedPlanSteps: 0, investigationPath: 'workorders/WO-001-investigation.md' })
        expect(assessWorkOrderSize(order('WO-001', 'parked'), 'workorders/WO-001.md')).toMatchObject({ kind: 'size', livePlanSteps: 0, retainedPlanSteps: 2 })
        expect(assessWorkOrderSize(order('WO-001'), 'workorders/WO-001.md', 'elsewhere/research.md')).toMatchObject({ kind: 'refusal', code: 'WO_INVESTIGATION_PATH' })
    })
})

describe('ordered automatic sweep', () => {
    function candidates() {
        const orders = ['WO-001', 'WO-002', 'WO-003'].map((id) => order(id))
        return { capacity: capacity(orders.map((contract) => ({ id: contract.frontmatter.id, contract }))), observations: orders.map((contract) => observation(contract)) }
    }

    it('defaults to dry-run and parks only the surplus of a never-started same-day draft batch', async () => {
        const input = candidates()
        const plan = planWorkOrderSweep(input.capacity, input.observations, context)
        expect(plan).toMatchObject({ kind: 'sweep', dryRun: true, changes: [{ id: 'WO-002', priorStatus: 'draft' }, { id: 'WO-003', priorStatus: 'draft' }] })
        const writes: unknown[] = []
        expect(await applyWorkOrderSweep(plan, { write: async (value: unknown) => { writes.push(value) } })).toMatchObject({ kind: 'dry-run' })
        expect(writes).toEqual([])
    })

    it('writes durable reason and prior state before parked status, and reverses the exact prior state', async () => {
        const input = candidates()
        const plan = planWorkOrderSweep(input.capacity, input.observations, { ...context, apply: true })
        expect(plan).toMatchObject({ kind: 'sweep', dryRun: false })
        if (!plan || plan.kind !== 'sweep') throw new Error('sweep required')
        const writes: unknown[] = []
        const result = await applyWorkOrderSweep(plan, { write: async (value: unknown) => { writes.push(value) } })
        expect(result).toMatchObject({ kind: 'applied' })
        expect(writes).toEqual(plan.changes.flatMap((change) => [
            { kind: 'reason', id: change.id, expectedDigest: change.digest, record: change.record },
            { kind: 'status', id: change.id, expectedDigest: change.digest, from: 'draft', to: 'parked', record: change.record },
        ]))
        const change = plan.changes[0]
        const current = order(change.id, 'parked')
        const reverse = reverseWorkOrderSweep(current, change.record, change.record, context)
        expect(reverse).toMatchObject({ kind: 'reversal', id: change.id, from: 'parked', to: 'draft', prior: change.record.prior })
        expect(await applyWorkOrderSweep(plan, { write: async () => { throw new Error('replayed') } })).toMatchObject({ kind: 'refusal', code: 'WO_SWEEP_REPLAY' })
        expect(reverseWorkOrderSweep(current, { ...change.record, writer: 'human' }, change.record, context)).toMatchObject({ kind: 'refusal', code: 'WO_HUMAN_PARK' })
        expect(reverseWorkOrderSweep(order(change.id, 'active'), change.record, change.record, context)).toMatchObject({ kind: 'refusal', code: 'WO_SWEEP_STALE' })
    })

    it('enumerates human holds and explicit exemptions and is idempotent after parking', () => {
        const input = candidates()
        const held = input.observations.map((item, index) => index === 1 ? { ...item, humanAnswerHold: 'Awaiting storage owner answer' } : item)
        expect(planWorkOrderSweep(input.capacity, held, context)).toMatchObject({ kind: 'sweep', changes: [], exemptions: expect.arrayContaining([{ id: 'WO-002', reason: 'Awaiting storage owner answer' }]) })
        const exempt = input.observations.map((item, index) => index === 2 ? { ...item, exemption: 'Explicit operator priority' } : item)
        expect(planWorkOrderSweep(input.capacity, exempt, context)).toMatchObject({ kind: 'sweep', changes: [], exemptions: expect.arrayContaining([{ id: 'WO-003', reason: 'Explicit operator priority' }]) })
        const parked = [order('WO-001'), order('WO-002', 'parked'), order('WO-003', 'parked')]
        expect(planWorkOrderSweep(capacity(parked.map((contract) => ({ id: contract.frontmatter.id, contract }))), parked.map((contract) => observation(contract)), context)).toMatchObject({ kind: 'sweep', changes: [] })
        const started = input.observations.map((item) => ({ ...item, everStarted: true }))
        expect(planWorkOrderSweep(input.capacity, started, context)).toMatchObject({ kind: 'sweep', changes: [] })
    })

    it('refuses missing/stale observations and stops on a reason write failure before status', async () => {
        const input = candidates()
        expect(planWorkOrderSweep(input.capacity, [], context)).toMatchObject({ kind: 'refusal', code: 'WO_SWEEP_OBSERVATION' })
        expect(planWorkOrderSweep(input.capacity, input.observations.map((item) => ({ ...item, digest: 'stale' })), context)).toMatchObject({ kind: 'refusal', code: 'WO_SWEEP_OBSERVATION' })
        const plan = planWorkOrderSweep(input.capacity, input.observations, { ...context, apply: true })
        const writes: unknown[] = []
        expect(await applyWorkOrderSweep(plan, { write: async (value: unknown) => { writes.push(value); throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES', syscall: 'open' }) } })).toMatchObject({ kind: 'refusal', code: 'WO_SWEEP_WRITE_FAILED', message: expect.stringContaining('EACCES: permission denied') })
        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatchObject({ kind: 'reason' })
    })

    it('preserves draft work whose canonical plan or evidence contradicts a never-started observation', () => {
        for (const progressed of [
            workOrderFixture().replace('1. [ ]', '1. [x]'),
            workOrderFixture().replace('- none\n## Decisions', '- local | test:cache | A verification attempt ran.\n## Decisions'),
        ]) {
            const parsed = parseWorkOrder(Buffer.from(progressed.replace('WO-001', 'WO-002')))
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.findings))
            const orders = [order('WO-001'), parsed.value, order('WO-003')]
            expect(planWorkOrderSweep(capacity(orders.map((contract) => ({ id: contract.frontmatter.id, contract }))), orders.map((contract) => observation(contract)), context)).toMatchObject({
                kind: 'sweep', changes: [], exemptions: expect.arrayContaining([{ id: 'WO-002', reason: 'Canonical plan or evidence records prior work' }]),
            })
        }
    })

    it('refuses a policy never admitted by the policy owner', () => {
        expect(assessWorkPressure({ policy: { cockpitCap: 3, programmeCap: 1, attemptCap: 2 }, orders: [] })).toMatchObject({ kind: 'refusal', code: 'WO_POLICY_INVALID' })
    })

    it('refuses malformed park records instead of silently exempting them', () => {
        const input = candidates()
        expect(planWorkOrderSweep(input.capacity, input.observations.map((item) => ({ ...item, park: {} })) as unknown as Parameters<typeof planWorkOrderSweep>[1], context)).toMatchObject({ kind: 'refusal', code: 'WO_SWEEP_OBSERVATION' })
    })

    it('refuses a missing sweep context with a named finding', () => {
        const input = candidates()
        expect(planWorkOrderSweep(input.capacity, input.observations, undefined as unknown as Parameters<typeof planWorkOrderSweep>[2])).toMatchObject({ kind: 'refusal', code: 'WO_SWEEP_OBSERVATION' })
    })

    it('refuses a missing sweep plan without calling the writer', async () => {
        const writes: unknown[] = []
        expect(await applyWorkOrderSweep(undefined as unknown as Parameters<typeof applyWorkOrderSweep>[0], { write: async (value: unknown) => { writes.push(value) } })).toMatchObject({ kind: 'refusal', code: 'WO_SWEEP_REPLAY' })
        expect(writes).toEqual([])
    })
})
