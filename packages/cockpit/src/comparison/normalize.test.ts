import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeComparisonOutput } from './normalize.js'

const fixture = JSON.parse(readFileSync(new URL('../../../../fixtures/comparison/command-set.json', import.meta.url), 'utf8')) as { normalization: unknown }

describe('comparison normalization oracle', () => {
    it('normalizes only declared bounded candidates and keeps the raw output', () => {
        const raw = 'started=2026-01-02T03:04:05.000Z root=/workspace/synthetic/app port=43123 elapsed=18.50ms status=ready'
        expect(normalizeComparisonOutput(raw, fixture.normalization)).toEqual({
            kind: 'complete', raw,
            normalized: 'started=<timestamp> root=<absolute-path> port=<port> elapsed=<duration-ms> status=ready',
            applied: ['timestamp', 'absolute-path', 'port', 'duration-ms'],
        })
    })

    it.each(['refusal=credential-missing', 'owner=foreign', 'status=unknown', 'diagnostic=drift-detected'])
    ('preserves semantic output %s', (semantic) => {
        const result = normalizeComparisonOutput(`${semantic} port=43123`, fixture.normalization)
        expect(result).toMatchObject({ kind: 'complete', raw: `${semantic} port=43123`, normalized: `${semantic} port=<port>` })
    })

    it('leaves a planted semantic difference visible after equal noise is removed', () => {
        const before = normalizeComparisonOutput('status=ready port=43123', fixture.normalization)
        const after = normalizeComparisonOutput('status=refused port=43123', fixture.normalization)
        expect(before.kind === 'complete' && after.kind === 'complete' && before.normalized).not.toBe(after.kind === 'complete' ? after.normalized : '')
    })

    it.each([
        [[{ kind: 'port', candidate: '80' }], 'candidate outside the admitted port range'],
        [[{ kind: 'timestamp', candidate: 'not-a-time' }], 'candidate has the wrong shape'],
        [[{ kind: 'literal', candidate: 'refused' }], 'rule kind is not declared'],
        [[{ kind: 'port', candidate: '43123' }, { kind: 'port', candidate: '43123' }], 'candidate is duplicated'],
    ])('refuses an unsafe rule when %s', (rules, _reason) => {
        expect(normalizeComparisonOutput('status=refused', rules)).toMatchObject({ kind: 'refusal', code: 'COMPARISON_NORMALIZATION_INVALID' })
    })
})
