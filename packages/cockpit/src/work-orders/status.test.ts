import { describe, expect, it } from 'vitest'
import { parseWorkOrder } from './contract.js'
import { workOrderFixture } from '../test-support/work-order.js'
import { projectWorkOrderStatus } from './status.js'
import { createWorkOrderState, encodeWorkOrderState } from './state.js'

describe('work-order status', () => {
    it('reads status exclusively from the issued parsed frontmatter', () => {
        const parsed = parseWorkOrder(Buffer.from(workOrderFixture().replace('Return current values after a cache refresh.', 'status: active\nThe prose says completed.')))
        if (!parsed.ok) throw new Error('fixture invalid')
        const result = projectWorkOrderStatus({ orders: [{ contract: parsed.value, state: null }], repositories: [] })
        expect(result).toMatchObject({ kind: 'complete', active: [], orders: [{ id: 'WO-001', status: 'draft' }] })
    })

    it('refuses unissued contracts and duplicate identities rather than trusting copied status', () => {
        const parsed = parseWorkOrder(Buffer.from(workOrderFixture()))
        if (!parsed.ok) throw new Error('fixture invalid')
        expect(projectWorkOrderStatus({ orders: [{ contract: { ...parsed.value }, state: null }], repositories: [] })).toMatchObject({ kind: 'refusal', code: 'WO_CONTRACT_INVALID' })
        expect(projectWorkOrderStatus({ orders: [{ contract: parsed.value, state: null }, { contract: parsed.value, state: null }], repositories: [] })).toMatchObject({ kind: 'refusal', code: 'WO_STATUS_AMBIGUOUS' })
    })

    it('does not report an active order with missing or malformed execution state as healthy', () => {
        const parsed = parseWorkOrder(Buffer.from(workOrderFixture({ status: 'active' })))
        if (!parsed.ok) throw new Error('fixture invalid')
        for (const state of [null, Buffer.from('{}')]) {
            expect(projectWorkOrderStatus({ orders: [{ contract: parsed.value, state }], repositories: [] }).kind).toBe('refusal')
        }
    })

    it('reports same-HEAD worktree drift separately from revision drift', () => {
        const parsed = parseWorkOrder(Buffer.from(workOrderFixture({ status: 'active' })))
        if (!parsed.ok) throw new Error('fixture invalid')
        const repositories = [{ path: 'product', revision: 'a'.repeat(40), worktreeDigest: 'b'.repeat(64) }]
        const created = createWorkOrderState(parsed.value, { writer: { actor: 'fixture', at: '2026-01-03T00:00:00.000Z' }, repositories,
            steps: parsed.value.plan.map((_, index) => ({ command: parsed.value.verification[index]!.argv, requires: index ? [1] : [] })) })
        if (created.kind !== 'complete') throw new Error(created.message)
        expect(projectWorkOrderStatus({ orders: [{ contract: parsed.value, state: encodeWorkOrderState(parsed.value, created.value) }],
            repositories: [{ ...repositories[0]!, worktreeDigest: 'c'.repeat(64) }] })).toMatchObject({ kind: 'complete', orders: [{ drift: [{
                path: 'product', expected: 'a'.repeat(40), actual: 'a'.repeat(40),
                expectedWorktreeDigest: 'b'.repeat(64), actualWorktreeDigest: 'c'.repeat(64),
            }] }] })
    })
})
