import { validateWorkOrderPolicy } from './intake.js'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseWorkOrder } from './contract.js'
import { workOrderFixture } from '../test-support/work-order.js'
import { createWorkOrderState, encodeWorkOrderState, persistWorkOrderProgress } from './state.js'
import { resumeWorkOrder } from './resume.js'
import { executePlan } from '../environment-exec/execute.js'

const defaultPolicyResult = validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1 })
if (defaultPolicyResult.kind !== 'policy') throw new Error('default policy refused')
const defaultPolicy = defaultPolicyResult.policy

it('resumes from durable consumer bytes alone while keeping every evidence layer separate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'work-order-resume-'))
    try {
        const text = workOrderFixture({ status: 'active' }).replace('## Evidence\n- none', '## Evidence\n- source | src/cache.ts | Implementation inspected.')
        const parsed = parseWorkOrder(Buffer.from(text))
        assert(parsed.ok)
        const contract = parsed.value
        const repositories = [{ path: 'product', revision: 'a'.repeat(40) }]
        const writer = { actor: 'executor', at: '2026-01-03T00:00:00.000Z' }
        const created = createWorkOrderState(contract, { writer, repositories, steps: contract.plan.map((_, index) => ({ command: contract.verification[index].argv, requires: index ? [1] : [] })) })
        assert(created.kind === 'complete')
        const state = created.value
        const path = join(directory, 'execution.json')
        await writeFile(join(directory, 'order.md'), text)
        await writeFile(path, encodeWorkOrderState(contract, state))
        const store = {
            read: () => readFile(path),
            compareAndSwap: async (expected: Uint8Array, next: Uint8Array) => {
                if (!(await readFile(path)).equals(Buffer.from(expected))) return false
                await writeFile(path, next)
                return true
            },
        }
        for (const layer of ['local', 'ci', 'runtime', 'deployment']) {
            const result = await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'evidence', layer, reference: `proof:${layer}`, contractDigest: contract.digest, repositories }, writer, store)
            expect(result.kind).toBe('complete')
        }
        for (const event of [
            { kind: 'attempt', step: 1, approach: 'refresh the old key', outcome: 'failed' },
            { kind: 'root-cause', step: 1, approach: 'refresh the old key', detail: 'The refresh must invalidate the current key.' },
            { kind: 'gap', id: 'fixture', step: 2, question: 'Which fixture should verification use?' },
            { kind: 'resolve-gap', id: 'fixture', answer: 'Use the seeded fixture.' },
            { kind: 'decision', decision: { date: '2026-01-03', decision: 'Preserve caller keys', disposition: 'accepted', reason: 'Existing callers depend on them.', impact: 'No migration.' } },
        ]) {
            const result = await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), event, writer, store)
            assert(result.kind === 'complete')
        }
        const checked = await persistWorkOrderProgress(contract, defaultPolicy, await store.read(), { kind: 'check', step: 1, proof: { layer: 'local', reference: 'test:targeted', contractDigest: contract.digest, repositories, command: state.steps[0].command } }, writer, store)
        expect(checked.kind).toBe('complete')

        const freshContract = parseWorkOrder(await readFile(join(directory, 'order.md')))
        if (!freshContract.ok) throw new Error('durable contract invalid')
        const result = resumeWorkOrder({ orders: [{ contract: freshContract.value, state: await readFile(path) }], repositories }, defaultPolicy)
        expect(result).toMatchObject({ kind: 'ready', step: 2, command: "'npm' 'test' '--' 'cache-2'", replay: false })
        assert(result.kind === 'ready')
        expect(result.layers.source).toMatchObject([{ reference: 'src/cache.ts', freshness: 'unbound' }])
        for (const layer of ['ci', 'runtime', 'deployment'] as const) expect(result.layers[layer]).toMatchObject([{ reference: `proof:${layer}`, freshness: 'current' }])
        expect(result.layers.local.map((entry: { reference: string }) => entry.reference)).toEqual(['proof:local', 'test:targeted'])
        expect(result.state.attempts[0].rootCause).toEqual({ detail: 'The refresh must invalidate the current key.', writer })
        expect(result.state.gaps[0].answer).toEqual({ detail: 'Use the seeded fixture.', writer })
        expect(result.state.decisions[0].writer).toEqual(writer)

        const output = join(directory, 'resumed.json')
        const script = `
            import { readFile, writeFile } from 'node:fs/promises';
            import { parseWorkOrder } from ${JSON.stringify(new URL('./contract.ts', import.meta.url).href)};
            import { resumeWorkOrder } from ${JSON.stringify(new URL('./resume.ts', import.meta.url).href)};
            const contract = parseWorkOrder(await readFile(${JSON.stringify(join(directory, 'order.md'))}));
            if (!contract.ok) throw new Error('Durable contract refused');
            import { validateWorkOrderPolicy } from ${JSON.stringify(new URL('./intake.ts', import.meta.url).href)};
            const issuedPolicy = validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1 });
            if (issuedPolicy.kind !== 'policy') throw new Error('policy refused');
            const result = resumeWorkOrder({ orders: [{ contract: contract.value, state: await readFile(${JSON.stringify(path)}) }], repositories: ${JSON.stringify(repositories)} }, issuedPolicy.policy);
            await writeFile(${JSON.stringify(output)}, JSON.stringify(result));
        `
        const execution = await executePlan({ steps: [{
            id: 'consumer-cold-resume', argv: [process.execPath, '--import', 'tsx', '--input-type=module', '--eval', script],
            argv0: process.execPath, cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' },
            timeoutMs: 10_000, stdoutLimitBytes: 1_024, stderrLimitBytes: 4_096,
            paths: [], ports: [], labels: {}, expected: [], consumedFiles: [], filesystemChecks: [], compensation: [],
        }] })
        expect(execution).toMatchObject({ kind: 'complete', status: 0 })
        expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(JSON.parse(JSON.stringify(result)))
        const withoutRuntime = JSON.parse((await readFile(path)).toString())
        withoutRuntime.evidence = withoutRuntime.evidence.filter((entry: { layer: string }) => !['runtime', 'deployment'].includes(entry.layer))
        const weaker = resumeWorkOrder({ orders: [{ contract: freshContract.value, state: Buffer.from(JSON.stringify(withoutRuntime)) }], repositories }, defaultPolicy)
        assert(weaker.kind === 'ready')
        expect(weaker.layers.runtime).toEqual([])
        expect(weaker.layers.deployment).toEqual([])
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
