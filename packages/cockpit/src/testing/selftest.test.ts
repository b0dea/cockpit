import { expect, it } from 'vitest'
import { createGateRegistry, runGate } from './gates.js'

it('uses the same stage aggregate for staged and complete selftest without early stopping', async () => {
    const registry = createGateRegistry({
        stages: ['contracts', 'surfaces', 'runtime'].map(id => ({ id, command: ['product-selftest', id] as const, requiresStack: false })),
        gates: [{ id: 'selftest', tier: 'full', stages: ['contracts', 'surfaces', 'runtime'], changes: 'Harness behavior' }],
    })
    const calls: string[] = []
    const deps = {
        subject: async () => 'a'.repeat(64),
        runProductTool: async (invocation: { stage: string }) => {
            calls.push(invocation.stage)
            return { kind: 'executed' as const, exitCode: 0, signal: null, outputBytes: 1, assertion: 'passed' as const }
        },
    }
    expect((await runGate(registry, { gate: 'selftest', staged: true }, deps)).verdict).toBe('PARTIAL')
    expect(calls).toEqual(['contracts', 'surfaces', 'runtime'])
    expect((await runGate(registry, { gate: 'selftest' }, deps))).toMatchObject({ verdict: 'PASS', satisfiesGate: true, executed: 3 })
})
