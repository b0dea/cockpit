import { describe, expect, it } from 'vitest'
import { parseWorkOrder, WORK_ORDER_LIMITS } from './contract.js'
import { padWorkOrder, workOrderFixture } from '../test-support/work-order.js'

const parse = (text: string) => parseWorkOrder(Buffer.from(text))
const codes = (text: string) => parse(text).findings.map((finding) => finding.code)

describe('work-order contract', () => {
    it('issues one immutable complete value with exact sources, Authority, criteria and argv', () => {
        const result = parse(workOrderFixture())
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error('valid contract refused')
        expect(result.exitCode).toBe(0)
        expect(result.value.frontmatter.status).toBe('draft')
        expect(result.value.authority).toEqual(['src/cache.ts', 'tests/cache.test.ts'])
        expect(result.value.criteria).toHaveLength(3)
        expect(result.value.sources.map((source) => source.provenance)).toEqual(['read', 'inferred', 'operator-confirmed'])
        expect(result.value.verification[0]).toEqual({ criterion: 'AC1', argv: ['npm', 'test', '--', 'cache-1'] })
        expect(Object.isFrozen(result.value)).toBe(true)
        expect(Object.isFrozen(result.value.verification[0].argv)).toBe(true)
    })

    it('retains the fixed sourced criterion range including seven', () => {
        expect(parse(workOrderFixture({ criteria: 7 })).ok).toBe(true)
        for (const criteria of [2, 8]) expect(codes(workOrderFixture({ criteria }))).toContain('WO_CRITERIA_INVALID')
    })

    it('gives identical valid and invalid findings at the supported maximum and padded intermediate sizes', () => {
        for (const text of [workOrderFixture(), workOrderFixture().replace('Source: S1', 'Source: missing')]) {
            const expected = parse(text)
            for (const size of [16_384, WORK_ORDER_LIMITS.bytes]) {
                const result = parse(padWorkOrder(text, size))
                expect({ ok: result.ok, exitCode: result.exitCode, findings: result.findings })
                    .toEqual({ ok: expected.ok, exitCode: expected.exitCode, findings: expected.findings })
            }
        }
        expect(codes(padWorkOrder(workOrderFixture(), WORK_ORDER_LIMITS.bytes + 1))).toEqual(['WO_SIZE_LIMIT'])
    })

    it('counts bytes rather than characters and refuses invalid encoding', () => {
        const full = padWorkOrder(workOrderFixture(), WORK_ORDER_LIMITS.bytes)
        expect(codes(full.slice(0, -2) + 'é\n')).toEqual(['WO_SIZE_LIMIT'])
        expect(parseWorkOrder(Uint8Array.from([0xff])).findings.map((finding) => finding.code)).toEqual(['WO_ENCODING_INVALID'])
    })

    it.each([
        ['duplicate frontmatter', (s: string) => s.replace('status: draft', 'status: draft\nstatus: completed'), 'WO_KEY_DUPLICATE'],
        ['unknown key', (s: string) => s.replace('title:', 'unexpected:'), 'WO_KEY_UNKNOWN'],
        ['malformed scalar', (s: string) => s.replace('status: draft', ' status: draft'), 'WO_FRONTMATTER_INVALID'],
        ['unknown status', (s: string) => s.replace('status: draft', 'status: mystery'), 'WO_FIELD_INVALID'],
        ['invalid date', (s: string) => s.replace('2026-01-02', '2026-02-30'), 'WO_FIELD_INVALID'],
        ['missing delimiter', (s: string) => s.replace('---\n## Objective', '## Objective'), 'WO_FRONTMATTER_INVALID'],
        ['duplicate section', (s: string) => s + '\n## Objective\nOther aim.\n', 'WO_SECTION_DUPLICATE'],
        ['missing section', (s: string) => s.replace('## Non-goals\nChanging the storage provider.\n', ''), 'WO_SECTION_MISSING'],
        ['unknown section', (s: string) => s.replace('## Non-goals', '## Other'), 'WO_SECTION_INVALID'],
        ['empty objective', (s: string) => s.replace('Return current values after a cache refresh.', ''), 'WO_SECTION_INVALID'],
        ['source without provenance', (s: string) => s.replace('S1 | read', 'S1 | guessed'), 'WO_SOURCE_INVALID'],
        ['duplicate source', (s: string) => s.replace('S2 | inferred', 'S1 | inferred'), 'WO_SOURCE_INVALID'],
        ['missing criterion source', (s: string) => s.replace('Source: S1', 'Source: unknown'), 'WO_CRITERIA_INVALID'],
        ['missing Then', (s: string) => s.replace('Then: Reading the cache returns the refreshed value.', ''), 'WO_CRITERIA_INVALID'],
        ['glob Authority', (s: string) => s.replace('- src/cache.ts', '- src/*.ts'), 'WO_AUTHORITY_INVALID'],
        ['escaped Authority', (s: string) => s.replace('- src/cache.ts', '- ../src/cache.ts'), 'WO_AUTHORITY_INVALID'],
        ['absolute Authority', (s: string) => s.replace('- src/cache.ts', '- /src/cache.ts'), 'WO_AUTHORITY_INVALID'],
        ['missing verification', (s: string) => s.replace('- AC1 | ["npm","test","--","cache-1"]', ''), 'WO_VERIFICATION_INVALID'],
        ['shell prose verification', (s: string) => s.replace('["npm","test","--","cache-1"]', 'npm test | true'), 'WO_VERIFICATION_INVALID'],
        ['verification of unknown criterion', (s: string) => s.replace('- AC1 |', '- AC9 |'), 'WO_VERIFICATION_INVALID'],
        ['unordered Plan', (s: string) => s.replace('2. [ ]', '3. [ ]'), 'WO_PLAN_INVALID'],
        ['undated decision', (s: string) => s.replace('- 2026-01-02 |', '- yesterday |'), 'WO_DECISION_INVALID'],
        ['decision without disposition', (s: string) => s.replace('| accepted |', '| undecided |'), 'WO_DECISION_INVALID'],
        ['unlayered evidence', (s: string) => s.replace('- none\n## Decisions', '- Passed tests\n## Decisions'), 'WO_EVIDENCE_INVALID'],
        ['contradictory completion', (s: string) => s.replace('status: draft', 'status: completed'), 'WO_CONTRADICTION'],
    ] as const)('refuses %s with a stable finding', (_name, change, code) => {
        expect(codes(change(workOrderFixture()))).toContain(code)
    })

    it('ignores body status text while retaining frontmatter status', () => {
        const result = parse(workOrderFixture().replace('Return current values after a cache refresh.', 'status: completed'))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.frontmatter.status).toBe('draft')
    })

    it('refuses independent line and line-byte bounds', () => {
        expect(codes(workOrderFixture() + '\n'.repeat(WORK_ORDER_LIMITS.lines))).toEqual(['WO_LINE_LIMIT'])
        expect(codes(workOrderFixture() + ' '.repeat(WORK_ORDER_LIMITS.lineBytes + 1))).toEqual(['WO_LINE_BYTES_LIMIT'])
    })

    it('accepts every independent structural maximum and rejects the next record', () => {
        const replaceSection = (name: string, lines: string[]) => workOrderFixture().replace(
            new RegExp(`(## ${name}\\n)[\\s\\S]*?(?=\\n## |$)`), `$1${lines.join('\n')}`,
        )
        const examples = [
            { name: 'Context and sources', limit: WORK_ORDER_LIMITS.sources, code: 'WO_SOURCE_INVALID',
                line: (index: number) => `- S${index + 1} | read | src/item-${index}.ts | Inspected current source.` },
            { name: 'Authority', limit: WORK_ORDER_LIMITS.authority, code: 'WO_AUTHORITY_INVALID',
                line: (index: number) => `- src/item-${index}.ts` },
            { name: 'Plan', limit: WORK_ORDER_LIMITS.planSteps, code: 'WO_PLAN_INVALID',
                line: (index: number) => `${index + 1}. [ ] Complete bounded step ${index + 1}.` },
            { name: 'Decisions', limit: WORK_ORDER_LIMITS.decisions, code: 'WO_DECISION_INVALID',
                line: (index: number) => `- 2026-01-02 | Decision ${index} | accepted | Existing behavior | Bounded change.` },
            { name: 'Verification', limit: WORK_ORDER_LIMITS.commands, code: 'WO_VERIFICATION_INVALID',
                line: (index: number) => `- AC${index % 3 + 1} | ["tool","check-${index}"]` },
        ]
        for (const example of examples) {
            const rows = Array.from({ length: example.limit }, (_, index) => example.line(index))
            expect(parse(replaceSection(example.name, rows)).ok, example.name).toBe(true)
            expect(codes(replaceSection(example.name, [...rows, example.line(example.limit)]))).toContain(example.code)
        }
        expect(parse(workOrderFixture({ programme: 'cache' })).ok).toBe(true)
        expect(codes(workOrderFixture({ programme: 'cache' }).replace('programme: cache', 'programme: cache\nextra: value'))).toContain('WO_FRONTMATTER_INVALID')
    })

    it('permits the declared argv byte and argument limits without exceeding the line limit', () => {
        const replace = (argv: string) => workOrderFixture().replace('["npm","test","--","cache-1"]', argv)
        const overhead = Buffer.byteLength(JSON.stringify(['tool', '']))
        expect(parse(replace(JSON.stringify(['tool', 'x'.repeat(WORK_ORDER_LIMITS.commandBytes - overhead)]))).ok).toBe(true)
        expect(codes(replace(JSON.stringify(['tool', 'x'.repeat(WORK_ORDER_LIMITS.commandBytes - overhead + 1)])))).toContain('WO_VERIFICATION_INVALID')
        expect(parse(replace(JSON.stringify(Array.from({ length: WORK_ORDER_LIMITS.arguments }, () => 'tool')))).ok).toBe(true)
        expect(codes(replace(JSON.stringify(Array.from({ length: WORK_ORDER_LIMITS.arguments + 1 }, () => 'tool'))))).toContain('WO_VERIFICATION_INVALID')
    })

    it('accepts the exact line and line-byte maxima', () => {
        const text = workOrderFixture()
        const missingLines = WORK_ORDER_LIMITS.lines - text.split('\n').length
        expect(parse(text + '\n'.repeat(missingLines)).ok).toBe(true)
        expect(parse(text.replace('Return current values after a cache refresh.', 'x'.repeat(WORK_ORDER_LIMITS.lineBytes))).ok).toBe(true)
    })

})
