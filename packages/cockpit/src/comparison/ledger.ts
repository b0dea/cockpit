import { createHash } from 'node:crypto'
import { z } from 'zod'
import { snapshotJson } from '../environment/contract.js'
import type { RunVerdict } from '../testing/verdict.js'
import { parseComparisonFixture, type ComparisonFixture } from './contract.js'
import { COMPARISON_DATA_MODES } from './startup.js'

export const mechanism = {
    id: 'comparison-real-use-ledger',
    module: 'packages/cockpit/src/comparison/ledger.ts',
    exports: ['REAL_USE_LEDGER_FORMAT', 'validateRealUseLedger'],
} as const

export const REAL_USE_LEDGER_FORMAT = 'cockpit-real-use/v1' as const
const sha256 = /^[a-f0-9]{64}$/
const revision = /^[a-f0-9]{40}$/
const safeName = /^[a-z][a-z0-9-]{0,63}$/
const workingDate = /^\d{4}-\d{2}-\d{2}$/
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const RevisionSchema = z.object({ legacy: z.string().regex(revision), cockpit: z.string().regex(revision) }).strict()
const CommandSchema = z.object({ command: z.string().regex(safeName), receiptSha256: z.string().regex(sha256) }).strict()
const DifferenceSchema = z.object({
    command: z.string().regex(safeName), receiptSha256: z.string().regex(sha256),
    explanation: z.string().max(2_048), accepted: z.boolean(),
}).strict()
const SignoffSchema = z.object({ signedAt: z.string().regex(timestamp), attestationSha256: z.string().regex(sha256) }).strict()
const RealUseRowSchema = z.object({
    date: z.string().regex(workingDate),
    provenance: z.enum(['operator', 'synthetic']),
    operatorId: z.string().regex(safeName),
    mode: z.enum(COMPARISON_DATA_MODES),
    revisions: RevisionSchema,
    commands: z.array(CommandSchema).min(1).max(128),
    startup: z.object({ receiptSha256: z.string().regex(sha256), verdict: z.enum(['PASS', 'FAIL', 'DEGRADED']) }).strict(),
    differences: z.array(DifferenceSchema).max(128),
    signoff: SignoffSchema,
}).strict()
const RealUseLedgerSchema = z.object({
    format: z.literal(REAL_USE_LEDGER_FORMAT), fixtureId: z.string().regex(safeName),
    rows: z.array(RealUseRowSchema).min(10).max(366),
}).strict()

export type RealUseLedgerRow = z.input<typeof RealUseRowSchema>
export type RealUseLedgerInput = z.input<typeof RealUseLedgerSchema>
export type RealUseLedgerResult =
    | Readonly<{ kind: 'complete'; verdict: Extract<RunVerdict, 'PARTIAL'>; satisfiesGate: false; days: number;
        modes: readonly typeof COMPARISON_DATA_MODES[number][]; operatorAuthentication: 'required'; reason: string }>
    | Readonly<{ kind: 'refusal'; verdict: Extract<RunVerdict, 'DEGRADED'>; satisfiesGate: false; reasons: readonly string[] }>

function refusal(reasons: readonly string[]): RealUseLedgerResult {
    return Object.freeze({ kind: 'refusal', verdict: 'DEGRADED', satisfiesGate: false,
        reasons: Object.freeze([...reasons]) })
}

function canonicalDate(value: string): boolean {
    if (!workingDate.test(value)) return false
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function nextWorkingDate(value: string): string | undefined {
    const date = new Date(`${value}T00:00:00.000Z`)
    if (Number.isNaN(date.valueOf())) return undefined
    do date.setUTCDate(date.getUTCDate() + 1)
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6)
    return date.toISOString().slice(0, 10)
}

function canonicalTimestamp(value: string): boolean {
    const parsed = new Date(value)
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}

function attestationSha256(fixtureId: string, row: z.output<typeof RealUseRowSchema>): string {
    const { signoff: _signoff, ...unsigned } = row
    return createHash('sha256').update(JSON.stringify({ fixtureId, ...unsigned })).digest('hex')
}

export function validateRealUseLedger(input: unknown, expectedFixture: ComparisonFixture,
    evaluatedAt = new Date().toISOString()): RealUseLedgerResult {
    if (!canonicalTimestamp(evaluatedAt)) return refusal(['ledger evaluation time is not a canonical timestamp'])
    const fixtureResult = parseComparisonFixture(expectedFixture)
    if (fixtureResult.kind !== 'complete') return refusal(['comparison fixture is not a complete accepted structural input'])
    const fixture = fixtureResult.fixture
    const captured = snapshotJson(input)
    const parsed = RealUseLedgerSchema.safeParse(captured)
    if (!parsed.success) return refusal(['real-use ledger is not bounded strict structural evidence'])
    const ledger = parsed.data
    const reasons: string[] = []
    if (ledger.fixtureId !== fixture.fixtureId) reasons.push('ledger fixture identity is stale')
    const expectedCommands = [...fixture.commands.shared, ...fixture.commands.extras]
    const seenDates = new Set<string>()
    for (const [index, row] of ledger.rows.entries()) {
        if (!canonicalDate(row.date) || [0, 6].includes(new Date(`${row.date}T00:00:00.000Z`).getUTCDay())) {
            reasons.push(`${row.date}: real-use date is not a working day`)
        }
        if (seenDates.has(row.date)) reasons.push(`${row.date}: duplicate real-use date`)
        seenDates.add(row.date)
        if (index > 0 && row.date !== nextWorkingDate(ledger.rows[index - 1]!.date)) {
            reasons.push(`${row.date}: real-use working-day sequence is gapped or out of order`)
        }
        if (row.provenance !== 'operator') reasons.push(`${row.date}: synthetic evidence cannot count as operator real use`)
        if (row.revisions.legacy !== fixture.subject.revisions.legacy
            || row.revisions.cockpit !== fixture.subject.revisions.cockpit) reasons.push(`${row.date}: compared revisions are stale`)
        if (row.commands.length !== expectedCommands.length
            || row.commands.some((command, commandIndex) => command.command !== expectedCommands[commandIndex])) {
            reasons.push(`${row.date}: command receipts do not cover the frozen comparison commands exactly`)
        }
        if (row.startup.verdict !== 'PASS') reasons.push(`${row.date}: startup receipt is non-passing`)
        if (row.differences.some(difference => !expectedCommands.includes(difference.command)
            || !difference.accepted || difference.explanation.trim().length === 0)) {
            reasons.push(`${row.date}: comparison difference is unexplained or unaccepted`)
        }
        if (!row.signoff.signedAt.startsWith(`${row.date}T`)
            || !canonicalTimestamp(row.signoff.signedAt)
            || row.signoff.attestationSha256 !== attestationSha256(ledger.fixtureId, row)) {
            reasons.push(`${row.date}: operator sign-off does not bind the complete day evidence`)
        }
        if (row.signoff.signedAt > evaluatedAt) reasons.push(`${row.date}: operator sign-off is later than the evaluation time`)
    }
    const modes = COMPARISON_DATA_MODES.filter(mode => ledger.rows.some(row => row.mode === mode))
    if (modes.length !== COMPARISON_DATA_MODES.length) reasons.push('real-use ledger does not cover empty, seeded and restored modes')
    if (reasons.length) return refusal(reasons)
    return Object.freeze({ kind: 'complete', verdict: 'PARTIAL', satisfiesGate: false, days: ledger.rows.length,
        modes: Object.freeze([...modes]), operatorAuthentication: 'required',
        reason: 'ledger structure is valid; trusted operator presence and cutover authorization remain external' })
}
