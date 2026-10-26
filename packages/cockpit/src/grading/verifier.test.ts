import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { CRITERION_OUTCOMES } from './verifier.js'

describe('criterion grading contract', () => {
    it('keeps exactly four criterion outcomes distinct from run verdicts', () => {
        expect(CRITERION_OUTCOMES).toEqual([
            'passed with current supporting evidence',
            'appears passed but evidence is insufficient or suspicious',
            'failed after execution',
            'never ran',
        ])
    })

    it('instructs the evaluator to bind evidence and retain browser reach without a tool allow-list', async () => {
        const body = await readFile(new URL('../../surfaces/agents/evaluator.agent.md', import.meta.url), 'utf8')
        for (const outcome of CRITERION_OUTCOMES) expect(body).toContain(outcome)
        for (const term of ['current criterion', 'current artifact', 'declaration', 'rerun', 'measurement date', 'product state', 'browser tools']) expect(body).toContain(term)
        expect(body).toContain('verifier-owned reruns')
        expect(body).toContain('additional observations')
        expect(body).not.toContain('rerun the declared verification yourself')
        expect(body).not.toMatch(/^tools:/m)
        expect(body).not.toMatch(/PASS_GROUNDED|SUSPICIOUS|NOT_RUN/)
    })
})
