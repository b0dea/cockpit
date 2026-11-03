import { describe, expect, it } from 'vitest'
import { gradingSchema, readGradingAnswer, type GradingSubject } from './grade.js'

const subject: GradingSubject = {
    criteria: [{ id: 'AC1', text: 'add(2, 3) returns 5.', check: ['node', 'test/add.test.mjs'] }, { id: 'AC2', text: 'add is exported.' }],
    nonGoals: [], scope: ['src/'],
    checks: [{ criterion: 'AC1', kind: 'argv', passed: true, outcome: 'exit 0', output: 'add(2, 3) returned 5\n' }],
    changes: [{ path: 'src/add.mjs', status: 'M', diff: '+export const add = (a, b) => a + b\n' }],
    outOfScope: [],
}

describe('independent grading answer', () => {
    it('keeps a met verdict only when each quote is found exactly once in the change or check output it cites', () => {
        const answer = (evidence: readonly { source: string; quote: string }[]) => readGradingAnswer({ criteria: [
            { id: 'AC1', verdict: 'met', note: 'the check ran', evidence },
            { id: 'AC2', verdict: 'met', note: 'exported', evidence: [{ source: 'src/add.mjs', quote: 'export const add' }] },
        ] }, subject)
        expect(answer([{ source: 'check:AC1', quote: 'add(2, 3) returned 5' }])).toEqual({ criteria: [
            { id: 'AC1', verdict: 'met', note: 'the check ran' }, { id: 'AC2', verdict: 'met', note: 'exported' }] })
        for (const evidence of [[], [{ source: 'check:AC1', quote: 'return' }], [{ source: 'check:AC1', quote: 'returned 6' }], [{ source: 'src/other.mjs', quote: 'export const add' }]]) {
            expect(answer(evidence), JSON.stringify(evidence)).toMatchObject({ criteria: [{ id: 'AC1', verdict: 'unclear' }, { id: 'AC2', verdict: 'met' }] })
        }
        expect(readGradingAnswer({ criteria: [{ id: 'AC1', verdict: 'met', note: '', evidence: [] }] }, subject)).toEqual({ problem: 'the grader did not answer each criterion exactly once' })
    })

    it('constrains the answer to the order\'s criterion ids', () => {
        expect(JSON.stringify(gradingSchema(subject.criteria))).toContain('"enum":["AC1","AC2"]')
    })
})
