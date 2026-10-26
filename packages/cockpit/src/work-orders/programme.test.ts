import { describe, expect, it } from 'vitest'
import { parseWorkOrder, type ParsedWorkOrder } from './contract.js'
import { workOrderFixture } from '../test-support/work-order.js'
import { validateWorkOrderPolicy, type WorkOrderCapacity } from './intake.js'
import { assessWorkPressure } from './pressure.js'
import { mintProgrammeWorkOrder } from './programme.js'

function order(id: string, status = 'draft', programme = 'cache'): ParsedWorkOrder {
    let text = workOrderFixture({ status, programme }).replace('WO-001', id)
    if (status === 'completed') text = text.replaceAll('[ ]', '[x]').replace('- none\n## Decisions', '- local | test:cache | Current proof.\n## Decisions')
    const parsed = parseWorkOrder(Buffer.from(text))
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.findings))
    return parsed.value
}
function input(orders: WorkOrderCapacity['orders'] = []) {
    const policy = validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1 })
    if (policy.kind !== 'policy') throw new Error(policy.message)
    const capacity = { policy: policy.policy, orders }
    const pressure = assessWorkPressure(capacity, 'cache')
    if (pressure.kind !== 'pressure') throw new Error(pressure.message)
    const ledger: { programme: string; items: { key: string; objective: string; independentlyShippable: boolean; orderId: string | null; orderDigest: string | null }[] } = { programme: 'cache', items: [
            { key: 'refresh', objective: 'Repair cache refresh', independentlyShippable: true, orderId: null, orderDigest: null },
            { key: 'expiry', objective: 'Repair expiry', independentlyShippable: true, orderId: null, orderDigest: null },
        ] }
    return {
        capacity, pressure, actor: 'programme-controller', ledger,
        candidate: order('WO-001'), itemKey: 'refresh',
    }
}

describe('programme minting', () => {
    it('mints exactly the next independently shippable draft and preserves ordered intent', () => {
        const request = input()
        const result = mintProgrammeWorkOrder(request)
        expect(result).toMatchObject({ kind: 'mint', actor: 'programme-controller', order: request.candidate, itemKey: 'refresh', expectedLedgerDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
        if (!result || result.kind !== 'mint') throw new Error('mint required')
        expect(result.ledger.items.map((item) => item.orderId)).toEqual(['WO-001', null])
        expect(request.ledger.items.map((item) => item.orderId)).toEqual([null, null])
        expect(mintProgrammeWorkOrder({ ...request, ledger: result.ledger })).toMatchObject({ kind: 'refusal', code: 'WO_PROGRAMME_CONTRACT' })
        const recorded = input([{ id: 'WO-001', contract: result.order }])
        expect(mintProgrammeWorkOrder({ ...recorded, ledger: result.ledger })).toMatchObject({ kind: 'existing', orderId: 'WO-001' })
    })

    it('refuses exhausted capacity, raised caps, forged/stale facts and unclassifiable state', () => {
        const request = input([{ id: 'WO-002', contract: order('WO-002', 'active') }])
        expect(mintProgrammeWorkOrder(request)).toMatchObject({ kind: 'refusal', code: 'WO_PROGRAMME_CAP' })
        const free = input()
        expect(mintProgrammeWorkOrder({ ...free, pressure: { ...free.pressure } })).toMatchObject({ kind: 'refusal', code: 'WO_PROGRAMME_PRESSURE' })
        expect(mintProgrammeWorkOrder({ ...free, capacity: { ...free.capacity, orders: [...free.capacity.orders, { id: 'WO-002', contract: order('WO-002', 'active') }] } })).toMatchObject({ kind: 'refusal', code: 'WO_PROGRAMME_PRESSURE' })
        expect(mintProgrammeWorkOrder({ ...input(), capacity: { policy: { cockpitCap: 4, programmeCap: 1, attemptCap: 2 }, orders: [] } })).toMatchObject({ kind: 'refusal', code: 'WO_PROGRAMME_PRESSURE' })
        expect(mintProgrammeWorkOrder({ ...input(), capacity: { ...input().capacity, orders: [{ id: 'WO-099', contract: null }] } })).toMatchObject({ kind: 'refusal', code: 'WO_PROGRAMME_PRESSURE' })
    })

    it('refuses skipping, unshippable items, duplicate identities and programme mismatch', () => {
        const request = input()
        expect(mintProgrammeWorkOrder({ ...request, itemKey: 'expiry' })).toMatchObject({ kind: 'refusal', code: 'WO_PROGRAMME_ORDER' })
        expect(mintProgrammeWorkOrder({ ...request, ledger: { ...request.ledger, items: request.ledger.items.map((item) => ({ ...item, independentlyShippable: false })) } })).toMatchObject({ kind: 'refusal', code: 'WO_PROGRAMME_SHIPPABILITY' })
        expect(mintProgrammeWorkOrder({ ...request, candidate: order('WO-001', 'draft', 'other') })).toMatchObject({ kind: 'refusal', code: 'WO_PROGRAMME_CONTRACT' })
        expect(mintProgrammeWorkOrder(input([{ id: 'WO-001', contract: order('WO-001', 'parked') }]))).toMatchObject({ kind: 'refusal', code: 'WO_PROGRAMME_CONTRACT' })
    })

    it('holds an unfinished predecessor even when parked capacity is free, then advances after completion', () => {
        for (const status of ['parked', 'completed']) {
            const prior = order('WO-001', status)
            const request = input([{ id: 'WO-001', contract: prior }])
            request.ledger.items[0].orderId = prior.frontmatter.id
            request.ledger.items[0].orderDigest = prior.digest
            request.candidate = order('WO-002')
            request.itemKey = 'expiry'
            expect(mintProgrammeWorkOrder(request)).toMatchObject(status === 'parked' ? { kind: 'refusal', code: 'WO_PROGRAMME_PREDECESSOR' } : { kind: 'mint', itemKey: 'expiry' })
        }
    })

    it('refuses missing top-level mint state with a named finding', () => {
        expect(mintProgrammeWorkOrder(undefined as unknown as Parameters<typeof mintProgrammeWorkOrder>[0])).toMatchObject({ kind: 'refusal', code: 'WO_PROGRAMME_LEDGER' })
    })
})
