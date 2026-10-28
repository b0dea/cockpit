import { validateWorkOrderPolicy } from './intake.js'
import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { parseWorkOrder } from './contract.js'
import { workOrderFixture } from '../test-support/work-order.js'
import { createWorkOrderState, encodeWorkOrderState, persistWorkOrderProgress, readWorkOrderState, validateWorkOrderRepositories, workOrderProofIsCurrent, type WorkOrderExecutionState } from './state.js'

const defaultPolicyResult = validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1 })
if (defaultPolicyResult.kind !== 'policy') throw new Error('default policy refused')
const defaultPolicy = defaultPolicyResult.policy

function executionFixture(text = workOrderFixture({ status: 'active' })) {
    const parsed = parseWorkOrder(Buffer.from(text))
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.findings))
    const contract = parsed.value
    const repositories = [{ path: 'product', revision: 'a'.repeat(40), worktreeDigest: 'b'.repeat(64) }]
    const writer = { actor: 'executor', at: '2026-01-03T00:00:00.000Z' }
    const created = createWorkOrderState(contract, {
        writer, repositories,
        steps: contract.plan.map((_, index) => ({ command: contract.verification[index].argv, requires: index ? [1] : [] })),
    })
    if (created.kind !== 'complete') throw new Error(created.message)
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

describe('durable work-order progress', () => {
    it('refuses null repository revisions', () => {
        expect(validateWorkOrderRepositories([{ path: 'product', revision: '0'.repeat(40) }])).toBeUndefined()
        expect(validateWorkOrderRepositories([{ path: 'product', revision: '0'.repeat(64) }])).toBeUndefined()
    })

    it('requires exact revision and worktree bytes for current proof', () => {
        const { contract, repositories } = executionFixture()
        const proof = { contractDigest: contract.digest, repositories }
        expect(workOrderProofIsCurrent(proof, contract, repositories)).toBe(true)
        expect(workOrderProofIsCurrent(proof, contract, [{ ...repositories[0]!, worktreeDigest: 'c'.repeat(64) }])).toBe(false)
    })

    it('refuses execution state without current worktree or reconciliation evidence', () => {
        const { contract, state } = executionFixture()
        expect(validateWorkOrderRepositories([{ path: 'product', revision: 'a'.repeat(40) }])).toBeUndefined()
        expect(readWorkOrderState(contract, Buffer.from(JSON.stringify({ ...state,
            repositories: state.repositories.map(({ worktreeDigest: _, ...repository }) => repository),
        })))).toMatchObject({ kind: 'refusal', code: 'WO_STATE_INVALID', message: expect.stringContaining('repositories.0.worktreeDigest') })
        const { reconciliations: _, ...withoutReconciliations } = state
        expect(readWorkOrderState(contract, Buffer.from(JSON.stringify(withoutReconciliations))))
            .toMatchObject({ kind: 'refusal', code: 'WO_STATE_INVALID', message: expect.stringContaining('reconciliations') })
    })

    it('round trips a bounded execution contract without process-local capabilities', () => {
        const { contract, state } = executionFixture()
        const loaded = readWorkOrderState(contract, encodeWorkOrderState(contract, state))
        expect(loaded).toEqual({ kind: 'complete', value: state })
        assert(loaded.kind === 'complete')
        expect(loaded.value.heartbeat.actor).toBe('executor')
    })

    it('publishes a checked step only after the complete state has persisted and read back', async () => {
        const { contract, state, repositories, writer } = executionFixture()
        const before = encodeWorkOrderState(contract, state)
        const store = memoryStore(before)
        const event = { kind: 'check', step: 1, proof: { layer: 'local', reference: 'test:cache', contractDigest: contract.digest, repositories, command: state.steps[0].command } }
        let release: () => void = () => { throw new Error('persistence barrier was not installed') }
        const durable = new Promise<void>((resolve) => { release = resolve })
        let returned = false
        const pending = persistWorkOrderProgress(contract, defaultPolicy, before, event, writer, {
            read: store.read,
            compareAndSwap: async (expected, next) => { await durable; return store.compareAndSwap(expected, next) },
        }).then((result) => { returned = true; return result })
        await Promise.resolve()
        expect(returned).toBe(false)
        expect(await store.read()).toEqual(Buffer.from(before))
        release()
        const result = await pending
        expect(result.kind).toBe('complete')
        const loaded = readWorkOrderState(contract, await store.read())
        expect(loaded.kind).toBe('complete')
        assert(loaded.kind === 'complete')
        expect(loaded.value.steps[0].checked).toMatchObject({ reference: 'test:cache' })
        expect(loaded.value.revision).toBe(1)
        expect(loaded.value.heartbeat).toEqual(writer)
        const failed = await persistWorkOrderProgress(contract, defaultPolicy, before, event, writer, {
            read: store.read,
            compareAndSwap: async () => { throw new Error('disk full') },
        })
        expect(failed).toMatchObject({ kind: 'refusal', code: 'WO_STATE_PERSIST_FAILED' })
        assert(failed.kind === 'refusal')
        expect(failed.message).toContain('disk full')
    })

    it('refuses concurrent updates and a successful write acknowledgement without readback', async () => {
        const { contract, state, writer } = executionFixture()
        const bytes = encodeWorkOrderState(contract, state)
        const event = { kind: 'heartbeat' }
        expect(await persistWorkOrderProgress(contract, defaultPolicy, bytes, event, writer, {
            read: async () => bytes, compareAndSwap: async () => false,
        })).toMatchObject({ kind: 'refusal', code: 'WO_STATE_CONFLICT' })
        expect(await persistWorkOrderProgress(contract, defaultPolicy, bytes, event, writer, {
            read: async () => bytes, compareAndSwap: async () => true,
        })).toMatchObject({ kind: 'refusal', code: 'WO_STATE_PERSIST_FAILED' })
    })

    it('persists an exclusive execution reservation and requires exact reconciliation', async () => {
        const { contract, state, writer } = executionFixture()
        const store = memoryStore(encodeWorkOrderState(contract, state))
        const update = async (event: unknown) => persistWorkOrderProgress(contract, defaultPolicy, await store.read(), event, writer, store)
        const reserved = await update({ kind: 'reserve-execution', step: 1, approach: 'declared verification' })
        expect(reserved).toMatchObject({ kind: 'complete', value: { reservation: { step: 1, approach: 'declared verification' } } })
        expect(await update({ kind: 'reserve-execution', step: 1, approach: 'another process' })).toMatchObject({
            kind: 'refusal', message: expect.stringContaining('reconciliation'),
        })
        expect(await update({ kind: 'reconcile-execution', step: 1, approach: 'wrong approach', reason: 'Process ended.' })).toMatchObject({ kind: 'refusal' })
        const reconciled = await update({ kind: 'reconcile-execution', step: 1, approach: 'declared verification', reason: 'Process ended before recording an observation.' })
        expect(reconciled).toMatchObject({ kind: 'complete', value: { reconciliations: [{ reason: 'Process ended before recording an observation.' }] } })
    })

    it('atomically settles a successful reserved execution with its current proof', async () => {
        const { contract, state, writer, repositories } = executionFixture()
        const store = memoryStore(encodeWorkOrderState(contract, state))
        const update = async (event: unknown) => persistWorkOrderProgress(contract, defaultPolicy, await store.read(), event, writer, store)
        await update({ kind: 'reserve-execution', step: 1, approach: 'declared verification' })
        const settled = await update({ kind: 'settle-execution', step: 1, approach: 'declared verification', proof: {
            layer: 'local', reference: 'execution:1', contractDigest: contract.digest, repositories, command: state.steps[0].command,
        } })
        assert(settled.kind === 'complete')
        expect(settled.value.attempts[0]).toMatchObject({ step: 1, approach: 'declared verification', lastOutcome: 'passed', failures: 0 })
        expect(settled.value.steps[0].checked).toMatchObject({ reference: 'execution:1' })
        expect(settled.value.reservation).toBeUndefined()
        expect(settled.value.revision).toBe(2)
    })

    it('refuses missing proof, unknown commands, malformed bytes and contradictory checks', () => {
        const { contract, state } = executionFixture()
        for (const bytes of [Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(262_145, 32),
            Buffer.from(JSON.stringify({ ...state, contractDigest: 'b'.repeat(64) })),
            Buffer.from(JSON.stringify({ ...state, steps: state.steps.map((step: object, i: number) => i ? { ...step, checked: true } : step) })),
            Buffer.from(JSON.stringify({ ...state, steps: state.steps.map((step: object, i: number) => i ? step : { ...step, command: ['unexpected'] }) })),
            Buffer.from(JSON.stringify({ ...state, revision: -1 })),
        ]) expect(readWorkOrderState(contract, bytes).kind).toBe('refusal')
        const checked = parseWorkOrder(Buffer.from(workOrderFixture({ status: 'active' }).replace('1. [ ]', '1. [x]')))
        if (!checked.ok) throw new Error('checked fixture invalid')
        expect(createWorkOrderState(checked.value, { writer: state.heartbeat, repositories: state.repositories, steps: state.steps }).kind).toBe('refusal')
    })

    it('names every durable writer and stops a repeated failing approach until root cause is recorded', async () => {
        const { contract, state, writer, repositories } = executionFixture()
        const store = memoryStore(encodeWorkOrderState(contract, state))
        const update = async (event: unknown) => persistWorkOrderProgress(contract, defaultPolicy, await store.read(), event, writer, store)
        expect((await update({ kind: 'attempt', step: 1, approach: 'refresh cache', outcome: 'failed' })).kind).toBe('complete')
        const stopped = await update({ kind: 'attempt', step: 1, approach: 'refresh cache', outcome: 'failed' })
        expect(stopped.kind).toBe('complete')
        assert(stopped.kind === 'complete')
        expect(stopped.value.attempts[0]).toMatchObject({ failures: 2, writer })
        const retry = await update({ kind: 'attempt', step: 1, approach: 'refresh cache', outcome: 'failed' })
        expect(retry).toMatchObject({ kind: 'refusal', code: 'WO_ROOT_CAUSE_REQUIRED' })
        expect((await update({ kind: 'root-cause', step: 1, approach: 'refresh cache', detail: 'Invalidation uses the old key.' })).kind).toBe('complete')
        expect((await update({ kind: 'gap', id: 'access', step: 2, question: 'Which fixture account can run verification?' })).kind).toBe('complete')
        expect((await update({ kind: 'evidence', layer: 'ci', reference: 'run:17', contractDigest: contract.digest, repositories })).kind).toBe('complete')
        expect((await update({ kind: 'decision', decision: { date: '2026-01-03', decision: 'Preserve keys', disposition: 'accepted', reason: 'Callers rely on them.', impact: 'No migration.' } })).kind).toBe('complete')
        const loaded = readWorkOrderState(contract, await store.read())
        assert(loaded.kind === 'complete')
        expect(loaded.value.attempts[0].rootCause).toEqual({ detail: 'Invalidation uses the old key.', writer })
        expect(loaded.value.gaps[0].writer).toEqual(writer)
        expect(loaded.value.evidence[0].writer).toEqual(writer)
        expect(loaded.value.decisions[0].writer).toEqual(writer)
        expect((await update({ kind: 'resolve-gap', id: 'access', answer: 'Use the seeded fixture account.' })).kind).toBe('complete')
        const resolved = readWorkOrderState(contract, await store.read())
        assert(resolved.kind === 'complete')
        expect(resolved.value.gaps[0].answer).toEqual({ detail: 'Use the seeded fixture account.', writer })
    })

    it('cannot check a blocked or dependent step or regress the heartbeat', async () => {
        const { contract, state, writer, repositories } = executionFixture()
        const store = memoryStore(encodeWorkOrderState(contract, state))
        const proof = { layer: 'local', reference: 'test:cache', contractDigest: contract.digest, repositories, command: state.steps[1].command }
        const bytes = await store.read()
        expect(await persistWorkOrderProgress(contract, defaultPolicy, bytes, { kind: 'check', step: 2, proof }, writer, store)).toMatchObject({ kind: 'refusal', code: 'WO_STATE_CONTRADICTION' })
        expect(await persistWorkOrderProgress(contract, defaultPolicy, bytes, { kind: 'heartbeat' }, { ...writer, at: '2026-01-02T00:00:00.000Z' }, store)).toMatchObject({ kind: 'refusal', code: 'WO_STATE_INVALID' })
    })

    it('rejects duplicate JSON keys instead of silently selecting a revision', () => {
        const { contract, state } = executionFixture()
        const bytes = Buffer.from(encodeWorkOrderState(contract, state)).toString()
        const ambiguous = bytes.replace('"revision":0', '"revision":99,"revision":0')
        expect(readWorkOrderState(contract, Buffer.from(ambiguous))).toMatchObject({ kind: 'refusal', code: 'WO_STATE_INVALID' })
    })

    it('invalidates dependent checked work when a replay fails', async () => {
        const { contract, state, writer, repositories } = executionFixture()
        const store = memoryStore(encodeWorkOrderState(contract, state))
        for (const step of state.steps) {
            const checked = await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'check', step: step.number, proof: { layer: 'local', reference: `test:${step.number}`, contractDigest: contract.digest, repositories, command: step.command } }, writer, store)
            assert(checked.kind === 'complete')
        }
        const failed = await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'attempt', step: 1, approach: 'replay verification', outcome: 'failed' }, writer, store)
        assert(failed.kind === 'complete')
        expect(failed.value.steps.map((step) => step.checked)).toEqual([undefined, undefined])
    })

    it('allows an answer to a blocked order without allowing its execution to advance', async () => {
        const { contract, state, writer } = executionFixture(workOrderFixture({ status: 'blocked' }))
        const blocked = { ...state, gaps: [{ id: 'fixture', step: 1, question: 'Which fixture?', writer }] }
        const store = memoryStore(encodeWorkOrderState(contract, blocked))
        const result = await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'resolve-gap', id: 'fixture', answer: 'Use the seeded fixture.' }, writer, store)
        expect(result.kind).toBe('complete')
        expect(await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'attempt', step: 1, approach: 'resume', outcome: 'passed' }, writer, store)).toMatchObject({ kind: 'refusal', code: 'WO_STATE_CONTRADICTION' })
    })

    it('refuses a checked step carrying an unanswered human gap on reload', () => {
        const { contract, state, writer, repositories } = executionFixture()
        const contradictory = {
            ...state, gaps: [{ id: 'fixture', step: 1, question: 'Which fixture?', writer }],
            steps: state.steps.map((step) => step.number !== 1 ? step : { ...step, checked: { layer: 'local', reference: 'test:cache', contractDigest: contract.digest, repositories, command: step.command, writer } }),
        }
        expect(readWorkOrderState(contract, Buffer.from(JSON.stringify(contradictory)))).toMatchObject({ kind: 'refusal', code: 'WO_STATE_CONTRADICTION' })
    })

    it('refuses an aggregate snapshot over its byte cap even when each record is individually valid', () => {
        const { contract, state, writer, repositories } = executionFixture()
        const oversized: WorkOrderExecutionState = { ...state, evidence: Array.from({ length: 64 }, (_, i) => ({ layer: 'local', reference: `${i}${'x'.repeat(4_000)}`, contractDigest: contract.digest, repositories, writer })) }
        expect(() => encodeWorkOrderState(contract, oversized)).toThrow('WO_STATE_INVALID')
        const input = { writer, repositories: Array.from({ length: 64 }, (_, i) => ({ path: `product-${i}/${'x'.repeat(4_080)}`, revision: 'a'.repeat(40), worktreeDigest: 'b'.repeat(64) })), steps: state.steps }
        expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(262_144)
        expect(createWorkOrderState(contract, input)).toMatchObject({ kind: 'refusal', code: 'WO_STATE_INVALID' })
    })

    it('recovers the last attempt outcome and count rather than treating success as another failure', async () => {
        const { contract, state, writer } = executionFixture()
        const store = memoryStore(encodeWorkOrderState(contract, state))
        await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'attempt', step: 1, approach: 'refresh', outcome: 'failed' }, writer, store)
        await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'root-cause', step: 1, approach: 'refresh', detail: 'Refresh used the old key.' }, writer, store)
        const later = { ...writer, at: '2026-01-03T00:00:01.000Z' }
        const result = await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'attempt', step: 1, approach: 'refresh', outcome: 'passed' }, later, store)
        assert(result.kind === 'complete')
        expect(result.value.attempts[0]).toMatchObject({ count: 2, lastOutcome: 'passed', failures: 0, writer: later, rootCause: { detail: 'Refresh used the old key.', writer } })
        expect(readWorkOrderState(contract, await store.read())).toEqual(result)
    })

    it('persists a newly discovered human gap before abandoning checked dependent work', async () => {
        const { contract, state, writer, repositories } = executionFixture()
        const store = memoryStore(encodeWorkOrderState(contract, state))
        await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'check', step: 1, proof: { layer: 'local', reference: 'test:cache', contractDigest: contract.digest, repositories, command: state.steps[0].command } }, writer, store)
        const result = await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'gap', id: 'fixture', step: 1, question: 'Which fixture can verify the newly discovered case?' }, writer, store)
        expect(result.kind).toBe('complete')
        assert(result.kind === 'complete')
        expect(result.value.gaps[0]).toMatchObject({ id: 'fixture', writer })
        expect(result.value.steps[0].checked).toBeUndefined()
    })
})

it('enforces an issued lower cap without narrowing historical decoding', async () => {
    const issued = validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1, attemptCap: 1 })
    assert(issued.kind === 'policy')
    const { contract, state, writer, repositories } = executionFixture()
    const bytes = encodeWorkOrderState(contract, state)
    const store = memoryStore(bytes)
    const event = { kind: 'attempt', step: 1, approach: 'refresh', outcome: 'failed' }
    expect((await persistWorkOrderProgress(contract, issued.policy, bytes, event, writer, store)).kind).toBe('complete')
    expect(await persistWorkOrderProgress(contract, issued.policy, await store.read(), event, writer, store)).toMatchObject({ kind: 'refusal', code: 'WO_ROOT_CAUSE_REQUIRED' })
    expect((await persistWorkOrderProgress(contract, { ...issued.policy }, await store.read(), { kind: 'heartbeat' }, writer, store)).kind).toBe('refusal')
    expect(await persistWorkOrderProgress(contract, issued.policy, await store.read(), { kind: 'check', step: 1, proof: { layer: 'local', reference: 'proof', contractDigest: contract.digest, repositories, command: state.steps[0].command } }, writer, store)).toMatchObject({ kind: 'refusal', code: 'WO_STATE_CONTRADICTION' })
    const historical = { ...state, attempts: [{ step: 1, approach: 'old', count: 2, failures: 2, lastOutcome: 'failed', writer }] }
    expect(readWorkOrderState(contract, Buffer.from(JSON.stringify(historical))).kind).toBe('complete')
})
