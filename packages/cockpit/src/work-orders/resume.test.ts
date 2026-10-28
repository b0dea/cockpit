import { validateWorkOrderPolicy } from './intake.js'
import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { parseWorkOrder } from './contract.js'
import { workOrderFixture } from '../test-support/work-order.js'
import { createWorkOrderState, encodeWorkOrderState, persistWorkOrderProgress } from './state.js'
import { resumeWorkOrder } from './resume.js'

const defaultPolicyResult = validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1 })
if (defaultPolicyResult.kind !== 'policy') throw new Error('default policy refused')
const defaultPolicy = defaultPolicyResult.policy

function executionFixture(text = workOrderFixture({ status: 'active' })) {
    const parsed = parseWorkOrder(Buffer.from(text))
    assert(parsed.ok)
    const contract = parsed.value
    const repositories = [{ path: 'product', revision: 'a'.repeat(40), worktreeDigest: 'b'.repeat(64) }]
    const writer = { actor: 'executor', at: '2026-01-03T00:00:00.000Z' }
    const created = createWorkOrderState(contract, { writer, repositories, steps: contract.plan.map((_, index) => ({ command: contract.verification[index].argv, requires: index ? [1] : [] })) })
    assert(created.kind === 'complete')
    return { contract, repositories, writer, state: created.value }
}

function memoryStore(initial: Uint8Array) {
    let bytes = Buffer.from(initial)
    return {
        read: async () => Buffer.from(bytes),
        compareAndSwap: async (expected: Uint8Array, next: Uint8Array) => {
            if (!bytes.equals(Buffer.from(expected))) return false
            bytes = Buffer.from(next)
            return true
        },
    }
}

describe('consumer resume decisions', () => {
    it('selects exactly one literal command and preserves the execution boundary', () => {
        const { contract, state, repositories } = executionFixture()
        const result = resumeWorkOrder({ orders: [{ contract, state: encodeWorkOrderState(contract, state) }], repositories }, defaultPolicy)
        expect(result).toMatchObject({ kind: 'ready', id: 'WO-001', step: 1, command: "'npm' 'test' '--' 'cache-1'", argv: ['npm', 'test', '--', 'cache-1'], authority: contract.authority, drift: [] })
        assert(result.kind === 'ready')
        expect(result.layers).toEqual({ source: [], local: [], ci: [], runtime: [], deployment: [] })
        expect(result).toMatchObject({ contract, state })
    })

    it('refuses zero or multiple active orders and contradictory state', () => {
        expect(resumeWorkOrder({ orders: [], repositories: [] }, defaultPolicy)).toMatchObject({ kind: 'refusal', code: 'WO_RESUME_NO_ACTIVE' })
        const first = executionFixture()
        const second = executionFixture(workOrderFixture({ status: 'active' }).replace('WO-001', 'WO-002'))
        const orders = [first, second].map(({ contract, state }) => ({ contract, state: encodeWorkOrderState(contract, state) }))
        expect(resumeWorkOrder({ orders, repositories: first.repositories }, defaultPolicy)).toMatchObject({ kind: 'refusal', code: 'WO_RESUME_AMBIGUOUS' })
        expect(resumeWorkOrder({ orders: [{ contract: first.contract, state: Buffer.from(JSON.stringify({ ...first.state, contractDigest: '0'.repeat(64) })) }], repositories: first.repositories }, defaultPolicy).kind).toBe('refusal')
    })

    it('skips current checked proof and replays the checked step when its repository binding is stale', async () => {
        const { contract, state, repositories, writer } = executionFixture()
        const store = memoryStore(encodeWorkOrderState(contract, state))
        await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), {
            kind: 'check', step: 1,
            proof: { layer: 'local', reference: 'test:cache', contractDigest: contract.digest, repositories, command: state.steps[0].command },
        }, writer, store)
        const orders = [{ contract, state: await store.read() }]
        expect(resumeWorkOrder({ orders, repositories }, defaultPolicy)).toMatchObject({ kind: 'ready', step: 2, replay: false })
        const stale = resumeWorkOrder({ orders, repositories: [{ path: 'product', revision: 'b'.repeat(40), worktreeDigest: 'c'.repeat(64) }] }, defaultPolicy)
        expect(stale).toMatchObject({ kind: 'ready', step: 1, replay: true, layers: { local: [{ freshness: 'stale' }], runtime: [], deployment: [] } })
        assert(stale.kind === 'ready')
        expect(stale.drift).toEqual([{ path: 'product', expected: 'a'.repeat(40), actual: 'b'.repeat(40),
            expectedWorktreeDigest: 'b'.repeat(64), actualWorktreeDigest: 'c'.repeat(64) }])
    })

    it('stops for a human gap or repeated failure without emitting an executable next command', async () => {
        const { contract, state, repositories, writer } = executionFixture()
        const store = memoryStore(encodeWorkOrderState(contract, state))
        const update = async (event: unknown) => persistWorkOrderProgress(contract, defaultPolicy, await store.read(), event, writer, store)
        await update({ kind: 'gap', id: 'fixture', step: 1, question: 'Which synthetic account should be used?' })
        expect(resumeWorkOrder({ orders: [{ contract, state: await store.read() }], repositories }, defaultPolicy)).toMatchObject({ kind: 'refusal', code: 'WO_RESUME_BLOCKED' })
        await update({ kind: 'resolve-gap', id: 'fixture', answer: 'Use the seeded fixture.' })
        await update({ kind: 'attempt', step: 1, approach: 'refresh', outcome: 'failed' })
        await update({ kind: 'attempt', step: 1, approach: 'refresh', outcome: 'failed' })
        expect(resumeWorkOrder({ orders: [{ contract, state: await store.read() }], repositories }, defaultPolicy)).toMatchObject({ kind: 'refusal', code: 'WO_ROOT_CAUSE_REQUIRED', message: 'Record root-cause analysis and choose a different approach for Plan steps 1' })
    })

    it('withholds a command until an interrupted execution reservation is reconciled', async () => {
        const { contract, state, repositories, writer } = executionFixture()
        const store = memoryStore(encodeWorkOrderState(contract, state))
        const reserved = await persistWorkOrderProgress(contract, defaultPolicy, await store.read(),
            { kind: 'reserve-execution', step: 1, approach: 'declared verification' }, writer, store)
        assert(reserved.kind === 'complete')
        const result = resumeWorkOrder({ orders: [{ contract, state: await store.read() }], repositories }, defaultPolicy)
        expect(result).toMatchObject({ kind: 'refusal', code: 'WO_RESUME_BLOCKED', message: expect.stringContaining('declared verification') })
        expect(result).not.toHaveProperty('command')
    })

    it('quotes literal argv without interpolating shell syntax', () => {
        const parsed = parseWorkOrder(Buffer.from(workOrderFixture({ status: 'active' }).replace('["npm","test","--","cache-1"]', JSON.stringify(['node', "a'b; $(echo unsafe)"]))))
        if (!parsed.ok) throw new Error('fixture invalid')
        const contract = parsed.value
        const repositories = [{ path: 'product', revision: 'a'.repeat(40), worktreeDigest: 'b'.repeat(64) }]
        const created = createWorkOrderState(contract, { writer: { actor: 'executor', at: '2026-01-03T00:00:00.000Z' }, repositories, steps: contract.plan.map((_, index) => ({ command: contract.verification[index].argv, requires: [] })) })
        if (created.kind !== 'complete') throw new Error('state invalid')
        expect(resumeWorkOrder({ orders: [{ contract, state: encodeWorkOrderState(contract, created.value) }], repositories }, defaultPolicy)).toMatchObject({ kind: 'ready', command: "'node' 'a'\\''b; $(echo unsafe)'" })
    })

    it('reports unavailable repository observations without emitting a command', () => {
        const { contract, state } = executionFixture()
        const result = resumeWorkOrder({ orders: [{ contract, state: encodeWorkOrderState(contract, state) }], repositories: [] }, defaultPolicy)
        expect(result).toMatchObject({ kind: 'refusal', code: 'WO_RESUME_BLOCKED', drift: [{ path: 'product', expected: 'a'.repeat(40), actual: null }], layers: { local: [], ci: [], runtime: [], deployment: [] } })
        expect(result).not.toHaveProperty('command')
    })

    it('emits the first independent unblocked step and does not silently complete checked work', async () => {
        const { contract, state, writer, repositories } = executionFixture()
        const independent = { ...state, steps: state.steps.map((step) => ({ ...step, requires: [] })) }
        const store = memoryStore(encodeWorkOrderState(contract, independent))
        await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'gap', id: 'fixture', step: 1, question: 'Which fixture?' }, writer, store)
        expect(resumeWorkOrder({ orders: [{ contract, state: await store.read() }], repositories }, defaultPolicy)).toMatchObject({ kind: 'ready', step: 2 })
        await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'resolve-gap', id: 'fixture', answer: 'Seeded fixture.' }, writer, store)
        for (const step of state.steps) {
            const result = await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'check', step: step.number, proof: { layer: 'local', reference: `test:${step.number}`, contractDigest: contract.digest, repositories, command: step.command } }, writer, store)
            assert(result.kind === 'complete')
        }
        expect(resumeWorkOrder({ orders: [{ contract, state: await store.read() }], repositories }, defaultPolicy)).toMatchObject({ kind: 'refusal', code: 'WO_RESUME_AWAITING_GRADE' })
    })
})

it('requires root cause after one failure under the exact issued lower policy', () => {
    const issued = validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1, attemptCap: 1 })
    assert(issued.kind === 'policy')
    const { contract, state, writer, repositories } = executionFixture()
    const failed = { ...state, attempts: [{ step: 1, approach: 'refresh', count: 1, failures: 1, lastOutcome: 'failed' as const, writer }] }
    const input = { orders: [{ contract, state: encodeWorkOrderState(contract, failed) }], repositories }
    expect(resumeWorkOrder(input, issued.policy)).toMatchObject({ kind: 'refusal', code: 'WO_ROOT_CAUSE_REQUIRED' })
    expect(resumeWorkOrder(input, { ...issued.policy })).toMatchObject({ kind: 'refusal', code: 'WO_POLICY_INVALID' })
})
