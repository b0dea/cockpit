import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { parseWorkOrder } from './contract.js'
import { workOrderFixture } from '../test-support/work-order.js'
import {
    acceptWorkOrder, activateAcceptedWorkOrder, beginWorkOrderAcceptance, intakeWorkOrder,
    isCurrentWorkOrderAcceptance, routeWorkOrder, validateWorkOrderPolicy,
} from './intake.js'
import { executeWorkOrderStep, type WorkOrderExecutionDependencies } from './executor.js'
import { createWorkOrderState, encodeWorkOrderState, persistWorkOrderProgress, readWorkOrderState, type WorkOrderStateStore } from './state.js'

function harness(attemptCap = 2) {
    const source = workOrderFixture()
    const parsed = parseWorkOrder(Buffer.from(source))
    assert(parsed.ok)
    const policy = validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1, attemptCap })
    assert(policy.kind === 'policy')
    const draft = intakeWorkOrder({ contract: parsed.value,
        route: routeWorkOrder({ certification: true }, { policy: policy.policy, orders: [] }),
        sourceAudit: { sources: parsed.value.sources, gaps: [] }, installedSkills: [] })
    assert(draft.kind === 'draft')
    const admission = { interactive: true, json: false, ci: false, stdinIsTTY: true, stdoutIsTTY: true }
    const now = Date.parse('2026-01-03T00:00:00.000Z')
    const request = beginWorkOrderAcceptance(draft, admission, now)
    assert(request.kind === 'human_needed')
    const acceptedDraft = acceptWorkOrder(request.continuation, draft, {
        admission, now, actor: 'fixture-operator', answer: `accept ${request.digest}`,
    })
    assert(acceptedDraft.kind === 'accepted')
    expect(isCurrentWorkOrderAcceptance(acceptedDraft, parsed.value)).toBe(true)
    const activated = activateAcceptedWorkOrder(acceptedDraft, Buffer.from(source))
    assert(activated.kind === 'activated')
    expect(isCurrentWorkOrderAcceptance(acceptedDraft, parsed.value)).toBe(false)
    expect(isCurrentWorkOrderAcceptance(activated.accepted, activated.accepted.contract)).toBe(true)
    expect(Buffer.from(activated.bytes).toString()).toBe(source.replace('status: draft', 'status: active'))
    const repositories = [{ path: 'product', revision: 'a'.repeat(40), worktreeDigest: 'b'.repeat(64) }]
    let currentRepositories = repositories
    const state = createWorkOrderState(activated.accepted.contract, {
        writer: { actor: 'fixture-executor', at: new Date(now).toISOString() }, repositories,
        steps: activated.accepted.contract.plan.map((_, index) => ({
            command: activated.accepted.contract.verification[index].argv, requires: index ? [1] : [],
        })),
    })
    assert(state.kind === 'complete')
    let bytes = encodeWorkOrderState(activated.accepted.contract, state.value)
    let compareAndSwap: WorkOrderStateStore['compareAndSwap'] = async (expected, next) => {
        if (!Buffer.from(expected).equals(Buffer.from(bytes))) return false
        bytes = Buffer.from(next)
        return true
    }
    let read: WorkOrderStateStore['read'] = async () => Buffer.from(bytes)
    const store: WorkOrderStateStore = {
        read: () => read(),
        compareAndSwap: (expected, next) => compareAndSwap(expected, next),
    }
    const calls: string[][] = []
    let execute: WorkOrderExecutionDependencies['execute'] = async argv => {
        calls.push([...argv]); return { kind: 'executed', exitCode: 0, stdout: 'verification passed', stderr: '', truncated: false }
    }
    const dependencies: WorkOrderExecutionDependencies = { store, execute: argv => execute(argv) }
    const input = () => {
        const current = readWorkOrderState(activated.accepted.contract, bytes)
        assert(current.kind === 'complete')
        return { accepted: activated.accepted, policy: policy.policy,
        status: { orders: [{ contract: activated.accepted.contract, state: Buffer.from(bytes) }], repositories: currentRepositories },
        stateBytes: Buffer.from(bytes), writer: { actor: 'fixture-executor', at: new Date(now + 1_000).toISOString() }, approach: 'declared verification',
        }
    }
    return { parsed: parsed.value, acceptedDraft, accepted: activated.accepted, dependencies, calls, input,
        bytes: () => Buffer.from(bytes), execute: (next: typeof execute) => { execute = next },
        persist: (next: Uint8Array) => { bytes = Buffer.from(next) },
        compareAndSwap: (next: typeof compareAndSwap) => { compareAndSwap = next }, read: (next: typeof read) => { read = next },
        repositories: (next: typeof repositories) => { currentRepositories = next } }
}

describe('accepted execution boundary', () => {
    it('refuses unreadable status contracts before invoking a command', async () => {
        const h = harness()
        const input = h.input()
        await expect(executeWorkOrderStep({ ...input, status: { ...input.status,
            orders: [{ contract: null, state: input.stateBytes }],
        } }, h.dependencies)).resolves.toMatchObject({ kind: 'refusal' })
        expect(h.calls).toEqual([])
    })

    it('activates accepted draft bytes and executes only the declared next command', async () => {
        const h = harness()
        expect(h.input().stateBytes).toBeInstanceOf(Uint8Array)
        expect(h.input().stateBytes.byteLength).toBeGreaterThan(0)
        const result = await executeWorkOrderStep(h.input(), h.dependencies)
        expect(result).toEqual({ kind: 'complete', step: 1, replay: false })
        expect(h.calls).toEqual([[...h.accepted.contract.verification[0].argv]])
        const state = readWorkOrderState(h.accepted.contract, h.bytes())
        assert(state.kind === 'complete')
        expect(state.value.steps[0].checked).toMatchObject({ contractDigest: h.accepted.contract.digest, layer: 'local' })
        expect(state.value.attempts).toMatchObject([{ step: 1, lastOutcome: 'passed', failures: 0 }])
    })

    it('reserves execution atomically before dispatch so concurrent callers execute once', async () => {
        const h = harness()
        let release: () => void = () => { throw new Error('execution barrier was not installed') }
        const blocked = new Promise<void>(resolve => { release = resolve })
        h.execute(async argv => {
            h.calls.push([...argv])
            await blocked
            return { kind: 'executed', exitCode: 0, stdout: 'verification passed', stderr: '', truncated: false }
        })
        const first = executeWorkOrderStep(h.input(), h.dependencies)
        await new Promise(resolve => setTimeout(resolve, 0))
        await expect(executeWorkOrderStep(h.input(), h.dependencies)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('reconcile'),
        })
        expect(h.calls).toHaveLength(1)
        release()
        await expect(first).resolves.toEqual({ kind: 'complete', step: 1, replay: false })
    })

    it('requires explicit reconciliation after an interrupted durable reservation', async () => {
        const h = harness()
        const input = h.input()
        const reserved = await persistWorkOrderProgress(h.accepted.contract, input.policy, input.stateBytes,
            { kind: 'reserve-execution', step: 1, approach: input.approach }, input.writer, h.dependencies.store)
        assert(reserved.kind === 'complete')
        await expect(executeWorkOrderStep(h.input(), h.dependencies)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('reconcile'),
        })
        expect(h.calls).toEqual([])
        const current = h.input()
        const reconciled = await persistWorkOrderProgress(h.accepted.contract, current.policy, current.stateBytes,
            { kind: 'reconcile-execution', step: 1, approach: input.approach, reason: 'Previous process ended before an observation was recorded.' },
            current.writer, h.dependencies.store)
        assert(reconciled.kind === 'complete')
        await expect(executeWorkOrderStep(h.input(), h.dependencies)).resolves.toEqual({ kind: 'complete', step: 1, replay: false })
    })

    it('settles successful execution and proof in one durable write without a redispatch window', async () => {
        const h = harness()
        let writes = 0
        h.compareAndSwap(async (expected, next) => {
            writes += 1
            if (!Buffer.from(expected).equals(h.bytes())) return false
            h.persist(next)
            return true
        })
        // A long suite keeps only the tail of its output; its exit status still decides the step.
        h.execute(async argv => { h.calls.push([...argv]); return { kind: 'executed', exitCode: 0, stdout: '...12 passed', stderr: '', truncated: true } })
        await expect(executeWorkOrderStep(h.input(), h.dependencies)).resolves.toEqual({ kind: 'complete', step: 1, replay: false })
        expect(writes).toBe(2)
        expect(h.calls).toHaveLength(1)
        const settled = readWorkOrderState(h.accepted.contract, h.bytes())
        assert(settled.kind === 'complete')
        expect(settled.value.reservation).toBeUndefined()
        expect(settled.value.steps[0].checked).toMatchObject({ reference: 'execution:1' })
        await expect(executeWorkOrderStep(h.input(), h.dependencies)).resolves.toEqual({ kind: 'complete', step: 2, replay: false })
        expect(h.calls).toHaveLength(2)
        expect(writes).toBe(4)
    })

    it('persists a discovery before any command can change the subject', async () => {
        const h = harness()
        const result = await executeWorkOrderStep({ ...h.input(), discovery: { id: 'missing-owner', question: 'Who owns the external boundary?' } }, h.dependencies)
        expect(result).toMatchObject({ kind: 'paused', step: 1 })
        expect(h.calls).toEqual([])
        const state = readWorkOrderState(h.accepted.contract, h.bytes())
        assert(state.kind === 'complete')
        expect(state.value.gaps).toMatchObject([{ id: 'missing-owner', step: 1, question: 'Who owns the external boundary?' }])
    })

    it('replays stale checked proof once and replaces it with the current repository observation', async () => {
        const h = harness()
        const initial = h.input()
        const checked = await persistWorkOrderProgress(h.accepted.contract, initial.policy, initial.stateBytes, {
            kind: 'check', step: 1, proof: { layer: 'local', reference: 'old-proof', contractDigest: h.accepted.contract.digest,
                repositories: initial.status.repositories, command: h.accepted.contract.verification[0].argv },
        }, initial.writer, h.dependencies.store)
        assert(checked.kind === 'complete')
        h.repositories([{ path: 'product', revision: 'b'.repeat(40), worktreeDigest: 'c'.repeat(64) }])

        expect(await executeWorkOrderStep(h.input(), h.dependencies)).toEqual({ kind: 'complete', step: 1, replay: true })
        expect(await executeWorkOrderStep(h.input(), h.dependencies)).toEqual({ kind: 'complete', step: 2, replay: false })
        const current = readWorkOrderState(h.accepted.contract, h.bytes())
        assert(current.kind === 'complete')
        expect(current.value.steps[0].checked?.repositories).toEqual([{ path: 'product', revision: 'b'.repeat(40), worktreeDigest: 'c'.repeat(64) }])
    })

    it('records failed approaches and stops after the bounded repeated-failure limit', async () => {
        const h = harness()
        h.execute(async argv => { h.calls.push([...argv]); return { kind: 'executed', exitCode: 1, stdout: 'failure', stderr: '', truncated: false } })
        expect((await executeWorkOrderStep(h.input(), h.dependencies)).kind).toBe('paused')
        expect((await executeWorkOrderStep(h.input(), h.dependencies)).kind).toBe('paused')
        expect(await executeWorkOrderStep(h.input(), h.dependencies)).toMatchObject({ kind: 'refusal', reason: expect.stringContaining('Record root-cause analysis') })
        expect(h.calls).toHaveLength(2)
        const state = readWorkOrderState(h.accepted.contract, h.bytes())
        assert(state.kind === 'complete')
        expect(state.value.attempts).toMatchObject([{ count: 2, failures: 2, lastOutcome: 'failed' }])
    })

    it('refuses copied, draft-bound and mismatched state authority before execution', async () => {
        const h = harness()
        expect(await executeWorkOrderStep({ ...h.input(), accepted: { ...h.accepted } }, h.dependencies)).toMatchObject({ kind: 'refusal' })
        expect(await executeWorkOrderStep({ ...h.input(), accepted: h.acceptedDraft }, h.dependencies)).toMatchObject({ kind: 'refusal' })
        expect(h.calls).toEqual([])
        expect(isCurrentWorkOrderAcceptance(h.accepted, h.parsed)).toBe(false)
    })

    it('withholds advancement when persistence conflicts or exact readback differs', async () => {
        const conflict = harness()
        conflict.compareAndSwap(async () => false)
        expect(await executeWorkOrderStep(conflict.input(), conflict.dependencies)).toMatchObject({ kind: 'refusal' })

        const corrupt = harness()
        let reads = 0
        const valid = corrupt.bytes()
        corrupt.read(async () => ++reads > 1 ? Buffer.from('{}') : Buffer.from(valid))
        expect(await executeWorkOrderStep({ ...corrupt.input(), discovery: { id: 'question', question: 'Confirm boundary.' } }, corrupt.dependencies))
            .toMatchObject({ kind: 'refusal' })
    })

    it('refuses same-revision state replacement across the post-persistence read boundary', async () => {
        const h = harness()
        let reads = 0
        h.read(async () => {
            const currentBytes = h.bytes()
            if (++reads === 1) return currentBytes
            const current = readWorkOrderState(h.accepted.contract, currentBytes)
            assert(current.kind === 'complete')
            return encodeWorkOrderState(h.accepted.contract, {
                ...current.value, heartbeat: { ...current.value.heartbeat, actor: 'replacement-writer' },
            })
        })
        expect(await executeWorkOrderStep({ ...h.input(), discovery: { id: 'question', question: 'Confirm boundary.' } }, h.dependencies))
            .toMatchObject({ kind: 'refusal' })
    })

    it.each([
        { observation: { kind: 'error' as const, reason: 'executor disconnected' }, reason: 'Declared verification error: executor disconnected' },
        { observation: { kind: 'unavailable' as const, reason: 'runtime absent' }, reason: 'Declared verification unavailable: runtime absent' },
        { observation: { kind: 'executed' as const, exitCode: 1, stdout: 'failure details', stderr: '', truncated: false }, reason: 'Declared verification failed with exit 1' },
        { observation: { kind: 'executed' as const, exitCode: 0, stdout: '  ', stderr: '\n', truncated: false }, reason: 'Declared verification produced no usable stdout or stderr' },
        { observation: { kind: 'executed' as const, exitCode: 0, stdout: 'x'.repeat(70_000), stderr: 'y'.repeat(70_000), truncated: false }, reason: 'Declared verification error: Verification output exceeded the bounded capture' },
    ])('records non-passing execution observation $observation.kind as a failed attempt', async ({ observation, reason }) => {
        const h = harness()
        h.execute(async () => observation)
        expect(await executeWorkOrderStep(h.input(), h.dependencies)).toMatchObject({ kind: 'paused', reason })
        const state = readWorkOrderState(h.accepted.contract, h.bytes())
        assert(state.kind === 'complete')
        expect(state.value.attempts[0]).toMatchObject({ failures: 1, lastOutcome: 'failed' })
        expect(state.value.steps.some(step => step.checked !== undefined)).toBe(false)
    })
})

it('lowered cap stops redispatch before execution even after root cause', async () => {
    const h = harness(1)
    h.execute(async argv => { h.calls.push([...argv]); return { kind: 'executed', exitCode: 1, stdout: 'failure', stderr: '', truncated: false } })
    expect((await executeWorkOrderStep(h.input(), h.dependencies)).kind).toBe('paused')
    expect(await executeWorkOrderStep(h.input(), h.dependencies)).toMatchObject({ kind: 'refusal', reason: expect.stringContaining('Record root-cause analysis') })
    const input = h.input()
    const cause = await persistWorkOrderProgress(h.accepted.contract, input.policy, input.stateBytes, { kind: 'root-cause', step: 1, approach: input.approach, detail: 'Old cache key.' }, input.writer, h.dependencies.store)
    expect(cause.kind).toBe('complete')
    expect((await executeWorkOrderStep(h.input(), h.dependencies)).kind).toBe('refusal')
    expect(h.calls).toHaveLength(1)
    const fresh = harness(1)
    expect((await executeWorkOrderStep({ ...fresh.input(), policy: { ...fresh.input().policy } }, fresh.dependencies)).kind).toBe('refusal')
    expect(fresh.calls).toHaveLength(0)
    expect((await executeWorkOrderStep({ ...h.input(), approach: 'invalidate current key' }, h.dependencies)).kind).toBe('paused')
    expect(h.calls).toHaveLength(2)
})
