import { describe, expect, it } from 'vitest'
import { criteriaWeakening, parseCriteriaFile, parseWorkOrder, scopeMatches, workOrderDigest } from './contract.js'

const order = (frontMatter: string, body = '\nNotes cockpit never reads.\n') => Buffer.from(`---\n${frontMatter}\n---\n${body}`)
const valid = [
    'id: WO-1', 'objective: Expired sessions return to the requested page.',
    'scope: [src/auth/, "tests/**", "web:src/routes/login.ts"]',
    'criteria:', '  - id: AC1', '    text: The person returns to the page they asked for.', '    check: { gate: unit, select: "test:returns" }',
    '  - id: AC2', '    text: The target is never another origin.', '    check: [npm, test]', '    source: docs/redirects.md',
].join('\n')

describe('work-order file', () => {
    it('reads the front-matter as the whole contract and never the body', () => {
        const parsed = parseWorkOrder(order(valid), 'WO-1')
        expect(parsed).toEqual({ ok: true, value: expect.objectContaining({ id: 'WO-1', depends_on: [], gates: [], non_goals: [],
            criteria: [expect.objectContaining({ id: 'AC1', check: { gate: 'unit', select: 'test:returns' } }), expect.objectContaining({ id: 'AC2', check: ['npm', 'test'], source: 'docs/redirects.md' })] }) })
        const other = parseWorkOrder(order(valid, '\n## Anything at all\n\nfree text\n'), 'WO-1')
        expect(other.ok && parsed.ok && workOrderDigest(other.value, {}, {}) === workOrderDigest(parsed.value, {}, {})).toBe(true)
    })

    it('names each field it refuses', () => {
        const problems = (text: string, id = 'WO-1') => { const parsed = parseWorkOrder(order(text), id); return parsed.ok ? [] : parsed.problems }
        expect(problems(valid, 'WO-2')).toEqual([expect.stringMatching(/^id: the file workorders\/WO-2.md declares id WO-1/)])
        expect(problems(`${valid}\nowner: someone`)).toEqual([expect.stringMatching(/unrecognized key/i)])
        expect(problems(valid.replace('scope: [src/auth/, "tests/**", "web:src/routes/login.ts"]', 'scope: [../outside]'))).toEqual([expect.stringMatching(/^scope\.0: /)])
        expect(problems(valid.replace('    check: [npm, test]', '    check: []'))).toEqual([expect.stringMatching(/^criteria\.1\.check/)])
        expect(problems(valid.replace('id: AC2', 'id: AC1'))).toEqual([expect.stringMatching(/each criterion id is used once/)])
        expect(problems(`${valid}\nid: WO-1`)).toEqual([expect.stringMatching(/^front-matter is not YAML/)])
        expect(parseWorkOrder(Buffer.from('id: WO-1\n'), 'WO-1')).toEqual({ ok: false, problems: [expect.stringMatching(/between two --- lines/)] })
        expect(parseCriteriaFile(order('criteria: [{ id: AC1, text: It works. }]'))).toMatchObject({ ok: true, value: { scope: [], gates: [] } })
    })

    it('binds the digest to the contract, each cited source and the base commits', () => {
        const parsed = parseWorkOrder(order(valid), 'WO-1')
        if (!parsed.ok) throw new Error(parsed.problems.join('; '))
        const digest = workOrderDigest(parsed.value, { 'docs/redirects.md': 'a'.repeat(64) }, { '.': 'b'.repeat(40) })
        expect(workOrderDigest(parsed.value, { 'docs/redirects.md': 'c'.repeat(64) }, { '.': 'b'.repeat(40) })).not.toBe(digest)
        expect(workOrderDigest(parsed.value, { 'docs/redirects.md': 'a'.repeat(64) }, { '.': 'd'.repeat(40) })).not.toBe(digest)
    })

    it('calls removing or rewriting an accepted criterion a weakening, and adding one not', () => {
        const parse = (text: string) => { const parsed = parseWorkOrder(order(text), 'WO-1'); if (!parsed.ok) throw new Error(parsed.problems.join('; ')); return parsed.value }
        const accepted = parse(valid)
        expect(criteriaWeakening(accepted, parse(`${valid}\n  - id: AC3\n    text: A third thing holds.`))).toEqual([])
        expect(criteriaWeakening(accepted, parse(valid.replace('never another origin', 'rarely another origin')))).toEqual(['AC2 is rewritten'])
        expect(criteriaWeakening(accepted, parse(valid.replace('    check: [npm, test]\n', '')))).toEqual(['AC2 is rewritten'])
        expect(criteriaWeakening(accepted, parse(valid.split('\n  - id: AC2')[0]!))).toEqual(['AC2 is removed'])
    })

    it('matches scope entries as directories, single-segment and recursive globs', () => {
        const scope = ['src/auth', 'tests/**', 'docs/*.md', 'web:src/routes/login.ts']
        expect(['src/auth/login.ts', 'tests/a/b/c.test.ts', 'docs/x.md', 'web:src/routes/login.ts'].every(path => scopeMatches(scope, path))).toBe(true)
        expect(['src/authz/login.ts', 'docs/a/x.md', 'web:src/routes/other.ts', 'src/routes/login.ts'].some(path => scopeMatches(scope, path))).toBe(false)
    })
})
