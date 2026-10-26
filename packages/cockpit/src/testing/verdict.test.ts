import { describe, expect, it } from 'vitest'
import { classifyRun, RUN_VERDICTS, type RunInput, type StageObservation } from './verdict.js'

const passed: StageObservation = { id: 'unit', kind: 'executed', exitCode: 0, signal: null, outputBytes: 1, assertion: 'passed' }
const input = (overrides: Partial<RunInput> = {}): RunInput => ({
    declared: ['unit'], selected: ['unit'], observations: [passed], scope: 'full', stability: 'stable', ...overrides,
})

describe('run verdicts', () => {
    it('reserves PASS for complete current evidence and keeps grading vocabulary separate', () => {
        expect(RUN_VERDICTS).toEqual(['PASS', 'FAIL', 'PARTIAL', 'DEGRADED', 'VOID'])
        expect(classifyRun(input())).toMatchObject({ verdict: 'PASS', satisfiesGate: true, executed: 1 })
        for (const scope of ['subset', 'staged'] as const) {
            expect(classifyRun(input({ scope }))).toMatchObject({ verdict: 'PARTIAL', satisfiesGate: false })
        }
        expect(classifyRun(input({ declared: ['unit', 'browser'] })).verdict).toBe('PARTIAL')
    })

    it('orders executed failure above unavailable, drift, subset and pass in every mixture', () => {
        const failure: StageObservation = { ...passed, assertion: 'failed', exitCode: 1 }
        const unavailable: StageObservation = { id: 'browser', kind: 'unavailable', reason: 'stack is down' }
        expect(classifyRun(input({ declared: ['unit', 'browser'], selected: ['unit', 'browser'], observations: [failure, unavailable], stability: 'void', scope: 'subset' })).verdict).toBe('FAIL')
        expect(classifyRun(input({ observations: [failure], stability: 'unavailable' })).verdict).toBe('FAIL')
        expect(classifyRun(input({ observations: [{ ...failure, signal: 'SIGTERM', outputBytes: 0 }] })).verdict).toBe('FAIL')
        expect(classifyRun(input({ observations: [{ ...passed, exitCode: 2 }] })).verdict).toBe('FAIL')
        expect(classifyRun(input({ observations: [{ ...passed, assertion: 'failed' }] })).verdict).toBe('FAIL')
        expect(classifyRun(input({ declared: ['unit', 'browser'], selected: ['unit', 'browser'], observations: [passed, unavailable], stability: 'void' })).verdict).toBe('DEGRADED')
        for (const stability of ['void', 'stale'] as const) {
            expect(classifyRun(input({ stability, scope: 'subset' }))).toMatchObject({ verdict: 'VOID', satisfiesGate: false })
        }
    })

    it('refuses absent or inconsistent stage evidence and never counts duplicates as coverage', () => {
        for (const change of [
            { observations: [] }, { selected: [] }, { selected: ['unknown'] },
            { selected: ['unit', 'unit'] }, { observations: [passed, passed] },
            { observations: [{ ...passed, assertion: 'missing' as const }] },
            { observations: [{ ...passed, signal: 'SIGPIPE' }] },
            { observations: [{ ...passed, outputBytes: 0 }] },
            { scope: 'unknown' as never }, { stability: 'unknown' as never },
            { stability: 'unavailable' as const },
        ]) expect(classifyRun(input(change))).toMatchObject({ verdict: 'DEGRADED', satisfiesGate: false })
        expect(classifyRun(input({ observations: [passed, passed] })).executed).toBe(1)
    })
})
