import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseComparisonFixture } from './contract.js'
import { validateRealUseLedger, type RealUseLedgerInput, type RealUseLedgerRow } from './ledger.js'

const parsedFixture = parseComparisonFixture(JSON.parse(readFileSync(
    new URL('../../../../fixtures/comparison/command-set.json', import.meta.url), 'utf8')))
if (parsedFixture.kind !== 'complete') throw new Error(parsedFixture.message)
const fixture = parsedFixture.fixture
const sha = (value: string): string => value.repeat(64)
const dates = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16',
    '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']

function signedRow(index: number): RealUseLedgerRow {
    const unsigned = {
        date: dates[index]!, provenance: 'operator' as const, operatorId: 'operator-one',
        mode: (['empty', 'seeded', 'restored'] as const)[index % 3]!, revisions: fixture.subject.revisions,
        commands: [...fixture.commands.shared, ...fixture.commands.extras].map((command, commandIndex) => ({
            command, receiptSha256: createHash('sha256').update(`${index}:${commandIndex}`).digest('hex'),
        })),
        startup: { receiptSha256: sha('a'), verdict: 'PASS' as const },
        differences: index === 4 ? [{ command: 'doctor', receiptSha256: sha('b'),
            explanation: 'Declared output differs only by the accepted isolated root.', accepted: true as const }] : [],
    }
    return { ...unsigned, signoff: { signedAt: `${unsigned.date}T17:00:00.000Z`,
        attestationSha256: createHash('sha256').update(JSON.stringify({ fixtureId: fixture.fixtureId, ...unsigned })).digest('hex') } }
}

const ledger = (): RealUseLedgerInput => ({
    format: 'cockpit-real-use/v1', fixtureId: fixture.fixtureId, rows: dates.map((_, index) => signedRow(index)),
})

describe('real-use ledger integrity', () => {
    it('validates ten consecutive signed working days and all modes without authenticating operator presence or cutover', () => {
        expect(validateRealUseLedger(ledger(), fixture, '2026-10-23T17:00:00.000Z')).toEqual({
            kind: 'complete', verdict: 'PARTIAL', satisfiesGate: false, days: 10,
            modes: ['empty', 'seeded', 'restored'], operatorAuthentication: 'required',
            reason: 'ledger structure is valid; trusted operator presence and cutover authorization remain external',
        })
    })

    it('refuses ledger evidence dated after its evaluation time', () => {
        expect(validateRealUseLedger(ledger(), fixture, '2026-10-23T16:59:59.999Z')).toMatchObject({
            kind: 'refusal', verdict: 'DEGRADED', satisfiesGate: false,
            reasons: expect.arrayContaining([expect.stringContaining('later than the evaluation time')]),
        })
    })

    it.each([
        ['duplicate day', 'duplicate real-use date', (value: RealUseLedgerInput) => value.rows[1] = value.rows[0]!],
        ['working-day gap', 'sequence is gapped', (value: RealUseLedgerInput) => value.rows[5] = { ...value.rows[5]!, date: '2026-10-20' }],
        ['synthetic provenance', 'synthetic evidence', (value: RealUseLedgerInput) => value.rows[0] = { ...value.rows[0]!, provenance: 'synthetic' }],
        ['stale revision', 'compared revisions are stale', (value: RealUseLedgerInput) => value.rows[0] = { ...value.rows[0]!, revisions: { ...value.rows[0]!.revisions, cockpit: 'f'.repeat(40) } }],
        ['unsigned mutation', 'sign-off does not bind', (value: RealUseLedgerInput) => value.rows[0] = { ...value.rows[0]!, mode: 'restored' }],
        ['missing mode', 'does not cover empty, seeded and restored', (value: RealUseLedgerInput) => value.rows = value.rows.map(row => ({ ...row, mode: 'empty' }))],
        ['unexplained difference', 'difference is unexplained', (value: RealUseLedgerInput) => value.rows[4] = { ...value.rows[4]!, differences: [{
            command: 'doctor', receiptSha256: sha('b'), explanation: '', accepted: false,
        }] }],
    ])('refuses %s as real-use completion evidence', (_label, reason, mutate) => {
        const value = structuredClone(ledger())
        mutate(value)
        expect(validateRealUseLedger(value, fixture)).toMatchObject({ kind: 'refusal', verdict: 'DEGRADED', satisfiesGate: false,
            reasons: expect.arrayContaining([expect.stringContaining(reason)]) })
    })
})
