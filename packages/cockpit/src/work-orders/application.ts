// Owns the work-order lifecycle: draft → accepted → checked → graded → done, with blocked and stale
// derived from the record and the current file, and partial and abandoned as closures. Each command
// that passes a gate asks the autonomy policy who may pass it; a person gate returns a continuation
// the CLI completes only with the digest a person types in a terminal. It also routes the browser and
// test-gate operations that share the work composition.
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { z } from 'zod'

import { decide, policyWeakening, runningInCi, type WorkGate } from '../autonomy.js'
import { executeBrowserCommand, type BrowserCommandReceipt, type BrowserCommandResult } from '../browser/commands.js'
import { evaluateUiGate } from '../browser/ui-gate.js'
import { errorCause, RefusalError } from '../environment/contract.js'
import type { GradingSubject, Verdict } from '../grading/grade.js'
import { DOCS_PATH, type Decider } from '../schema.js'
import { runGate } from '../testing/gates.js'
import { describeWeakening, testWeakeningDigest } from '../testing/weakening.js'
import { criteriaWeakening, scopeMatches, WORK_ORDER_ID, workOrderDigest, type WorkOrder, type WorkOrderCriterion } from './contract.js'
import { citedOrders, holdsPlaceholders, namesScope, nextRecordName, recordNumber, recordTitle, scaffoldRecord, withStatus } from './decisions.js'
import type { CheckResult, WorkRecord } from './store.js'
import { isWorkApplicationComposition, type WorkApplicationComposition } from './composition.js'

const id = z.string().regex(WORK_ORDER_ID)
const note = z.string().trim().min(1).max(4_096).regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/)
const docsReference = z.string().max(1_024).regex(DOCS_PATH)
const relativeFile = z.string().max(4_096).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+\-/]+$/)
const Request = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('work-status'), workOrderId: id.optional() }).strict(),
    z.object({ operation: z.literal('work-accept'), workOrderId: id }).strict(),
    z.object({ operation: z.literal('work-check'), workOrderId: id }).strict(),
    z.object({ operation: z.literal('work-note'), workOrderId: id, text: note, kind: z.enum(['note', 'question', 'decision']) }).strict(),
    z.object({ operation: z.literal('work-decide'), workOrderId: id, decision: z.number().int().min(1), resolution: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('record'), path: docsReference.optional(), supersedes: z.string().regex(/^\d{1,9}$/).optional() }).strict(),
        z.object({ kind: z.literal('none'), reason: note }).strict(),
    ]) }).strict(),
    z.object({ operation: z.literal('work-answer'), workOrderId: id, question: z.number().int().min(1), text: note }).strict(),
    z.object({ operation: z.literal('work-grade'), workOrderId: id, verdict: z.enum(['met', 'unmet']).optional(), note: note.optional() }).strict(),
    z.object({ operation: z.literal('work-signoff'), workOrderId: id, close: z.enum(['done', 'partial', 'abandoned']), note: note.optional() }).strict(),
    z.object({ operation: z.literal('work-acknowledge'), workOrderId: id, note }).strict(),
    z.object({ operation: z.literal('work-recover'), workOrderId: id, apply: z.boolean() }).strict(),
    z.object({ operation: z.literal('work-verify') }).strict(),
    z.object({ operation: z.literal('grade-criteria'), criteriaFile: relativeFile }).strict(),
    z.object({ operation: z.enum(['browser-drive', 'browser-screenshot']), role: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
        route: z.string().regex(/^(?:[a-z0-9][a-z0-9_-]{0,63}|\/(?!\/)[^\s#\x00-\x1f\x7f]{0,511})$/).optional(),
        failOnFindings: z.boolean().optional() }).strict(),
    z.object({ operation: z.literal('test-run'), gate: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), mode: z.enum(['canonical', 'full', 'staged']),
        select: z.object({ kind: z.enum(['spec', 'file', 'test', 'route']), value: z.string().min(1).refine(value => Buffer.byteLength(value) <= 4_096 && !/[\x00-\x1f\x7f]/.test(value)) }).strict().optional() }).strict(),
])
export type WorkApplicationRequest = z.infer<typeof Request>
type Operation = WorkApplicationRequest['operation']

export function captureWorkApplicationRequest(value: unknown): WorkApplicationRequest | undefined {
    const parsed = Request.safeParse(value)
    return parsed.success ? parsed.data : undefined
}

export interface WorkApplicationContinuation { readonly digest: string; readonly prompt: string; readonly decide: (answer: string) => Promise<WorkApplicationOutcome> }
export type WorkApplicationOutcome =
    | Readonly<{ kind: 'complete'; operation: Operation; value: unknown }>
    | Readonly<{ kind: 'human-needed'; operation: Operation; continuation: WorkApplicationContinuation }>
    | Readonly<{ kind: 'refusal'; operation: Operation | 'invalid'; reason: string }>
    // The operation ran and its result does not meet the bar (a gate short of PASS, a failed check, an
    // unmet criterion); the result is the evidence to act on.
    // `weakening` is the part of the failure that is test weakening, which has its own diagnostic and fix.
    | Readonly<{ kind: 'unsatisfied'; operation: Operation; value: unknown; reason: string; weakening?: string }>

const refusal = (operation: Operation | 'invalid', reason: string): WorkApplicationOutcome => ({ kind: 'refusal', operation, reason })
const complete = (operation: Operation, value: unknown): WorkApplicationOutcome => ({ kind: 'complete', operation, value })
const unsatisfied = (operation: Operation, value: unknown, reason: string, weakening?: string): WorkApplicationOutcome =>
    ({ kind: 'unsatisfied', operation, value, reason, ...weakening ? { weakening } : {} })
const now = () => new Date().toISOString()
// Agent-written text is shown to a person with its control and bidirectional-override characters
// replaced, so it can neither drive their terminal nor read in an order other than the one recorded.
const shown = (value: string) => value.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, '�')
const TERMINAL = new Set<WorkRecord['state']>(['done', 'partial', 'abandoned'])
const CLOSURE = Object.freeze({ independent: 'graded', checks: 'checks-passed', self: 'self-reported' } as const)

// The state a person or agent reads: the record's, unless the file changed since acceptance (stale),
// an open question or the attempt cap holds it (blocked), or no acceptance exists yet (draft).
type Observed = Readonly<{ id: string; order?: WorkOrder; problems: readonly string[]; record?: WorkRecord; digest?: string }>
function displayState(row: Observed, attemptCap: number): string {
    if (!row.record) return row.order ? 'draft' : 'invalid'
    if (TERMINAL.has(row.record.state)) return row.record.state
    if (!row.order || row.digest !== row.record.accepted.digest) return 'stale'
    if (openQuestions(row.record).length || row.record.attempts >= attemptCap) return 'blocked'
    return row.record.state
}
function openQuestions(record: WorkRecord): readonly number[] {
    return record.notes.flatMap((row, index) => row.kind === 'question' && !record.notes.some(answer => answer.answers === index + 1) ? [index + 1] : [])
}
// Decisions recorded on an order, each with its latest resolution.
const DECISIONS_UNDECLARED = 'decision records need a directory: declare one in cockpit.toml, for example [docs] decisions = "docs/adr", '
    + 'with decisions_index = "docs/adr/README.md" if the records have an index'
function decisions(record: WorkRecord) {
    return record.notes.flatMap((row, index) => row.kind !== 'decision' ? [] : [{ decision: index + 1, title: recordTitle(row.text),
        resolution: record.notes.findLast(note => note.kind === 'resolution' && note.resolves === index + 1) }])
}
// Why a cited record no longer stands for its decision; `filled` also requires that the template's placeholders are gone.
function recordProblem(text: string | undefined, reference: string, orderId: string, filled: boolean): string | undefined {
    if (text === undefined) return `its record ${reference} does not exist`
    if (!citedOrders(text).includes(orderId)) return `its record ${reference} does not cite ${orderId}; add the line "Work order: ${orderId}"`
    return filled && holdsPlaceholders(text) ? `its record ${reference} still holds the template's placeholders; replace each "<!-- cockpit: replace this ... -->" comment` : undefined
}
async function unresolvedDecisions(record: WorkRecord, composition: WorkApplicationComposition): Promise<readonly string[]> {
    const rows: string[] = []
    for (const row of decisions(record)) {
        const name = `decision ${row.decision} (${row.title})`
        if (!row.resolution) rows.push(`${name} is unresolved; run npx --no cockpit work decide --config <your cockpit.toml> --work-order ${record.id} --decision ${row.decision} --record, or with --none --reason "<why>"`)
        else if (row.resolution.record) {
            const problem = recordProblem(await composition.readDocsFile(row.resolution.record), row.resolution.record, record.id, true)
            if (problem) rows.push(`${name}: ${problem}`)
        }
    }
    return rows
}
// Standing criteria every grade carries once [docs] is declared: a model judges them in independent and
// self grading; under checks no model reads the change, so they stay instructions in the work skill.
const STANDING = Object.freeze({ decisions: 'decisions-recorded', docs: 'docs-updated' } as const)
function standingCriteria(docs: WorkApplicationComposition['docs'], record: WorkRecord): readonly WorkOrderCriterion[] {
    if (!docs) return []
    const recorded = decisions(record).map(row => `${row.decision} (${row.title})${row.resolution?.record ? ` in ${row.resolution.record}` : ''}`).join('; ')
    return [...docs.decisions ? [{ id: STANDING.decisions, text: ('Every lasting decision this change makes (a choice a later change must know about, such as a format, a boundary, '
        + `a dependency or a rejected option) is recorded on the work order or in a decision record under ${docs.decisions}. Recorded on this order: ${recorded || 'none'}.`).slice(0, 2_000) }] : [],
    { id: STANDING.docs, text: 'Documentation that describes behaviour this change alters is updated in the change, or no documentation describes it.' }]
}

// The grade's criterion-level finding for tests weakened since the base. An acknowledgement covers exactly
// the findings it was recorded for, so any further weakening fails again.
const PROTECTION_ID = 'test-protection'
type Weakening = Awaited<ReturnType<WorkApplicationComposition['testWeakening']>>
function protection(weak: Weakening, record: WorkRecord | undefined) {
    const rows = weak.findings.map(describeWeakening)
    const digest = testWeakeningDigest(weak.findings)
    const acknowledged = weak.findings.length ? record?.acknowledgements.find(row => row.digest === digest) : undefined
    const how = record ? 'a person records it with npx --no cockpit work acknowledge --config <your cockpit.toml> --work-order <id> --note <why this is not a weakening> --interactive'
        : 'a work order lets a person acknowledge it; there is none for this grade'
    const verdict: Verdict | undefined = !weak.findings.length ? undefined
        : acknowledged ? { id: PROTECTION_ID, verdict: 'met', note: `weakening acknowledged by ${acknowledged.by}: ${acknowledged.note}`.slice(0, 4_000) }
            : { id: PROTECTION_ID, verdict: 'unmet', note: `tests were weakened since the base (${rows.join('; ')}; test files from ${weak.patterns.source}); revert it, or ${how}`.slice(0, 4_000) }
    return { verdict, value: { testFiles: weak.patterns.source, findings: rows, ...acknowledged ? { acknowledgedBy: acknowledged.by } : {} } }
}
const split = (verdicts: readonly Verdict[]) => ({ others: verdicts.filter(row => row.verdict !== 'met' && row.id !== PROTECTION_ID),
    weakening: verdicts.find(row => row.id === PROTECTION_ID && row.verdict !== 'met')?.note })
const pendingCi = (record: WorkRecord) => [
    ...record.acknowledgements.filter(row => row.by === 'ci').map(() => 'acknowledge'),
    ...record.accepted.by === 'ci' ? ['accept'] : [], ...record.amendments.filter(row => row.by === 'ci').map(() => 'amend'),
    ...record.notes.filter(row => row.kind === 'answer' && row.by === 'ci').map(() => 'answer'), ...record.closure?.by === 'ci' ? ['signoff'] : [],
]

export async function runWorkApplication(request: WorkApplicationRequest, composition: WorkApplicationComposition): Promise<WorkApplicationOutcome> {
    const captured = captureWorkApplicationRequest(request)
    if (!captured) return refusal('invalid', 'Work application requests require a closed selector-only shape')
    if (!isWorkApplicationComposition(composition)) return refusal('invalid', 'An issued work application composition is required')
    const operation = captured.operation
    try {
        if (captured.operation === 'browser-drive' || captured.operation === 'browser-screenshot') {
            const kind = captured.operation === 'browser-screenshot' ? 'screenshot' : 'drive'
            return browserOutcome(captured.operation, await executeBrowserCommand(await composition.browser(kind, captured.role, captured.route)), captured.failOnFindings === true)
        }
        if (captured.operation === 'test-run') {
            const prepared = await composition.gate(captured)
            const run = await runGate(prepared.registry, prepared.request, prepared.dependencies)
            // A passing run proves nothing if the tests it ran were weakened, so it is checked against the base of each open order.
            const open = (await composition.store.list()).filter(row => !TERMINAL.has(row.state))
            const guards = await Promise.all(open.map(async row => ({ id: row.id, ...protection(await composition.testWeakening(row.accepted.base), row) })))
            const testProtection = guards.length ? { comparedWith: guards.map(row => `${row.id}'s base`), orders: guards.map(row => ({ id: row.id, ...row.value })) }
                : { comparedWith: [], note: 'no open work order records a base commit to compare tests with; accept an order before changing tests' }
            const weakening = guards.flatMap(row => row.verdict?.verdict === 'unmet' ? [`${row.id}: ${row.verdict.note}`] : []).join(' | ')
            const failure = run.satisfiesGate ? '' : `${run.verdict}: ${run.reasons.join('; ') || 'declared gate was not satisfied'}`
            return !failure && !weakening ? complete(operation, { ...run, testProtection }) : unsatisfied(operation, { ...run, testProtection }, failure, weakening || undefined)
        }
        // A policy weakened in cockpit.toml since the last sync is not in force until a person accepts it there.
        const recorded = await composition.recordedPolicy()
        const weakened = recorded ? policyWeakening(recorded, composition.policy) : []
        if (weakened.length) {
            return refusal(operation, `cockpit.toml weakens ${weakened.map(row => `${row.field} from ${row.from} to ${row.to}`).join(', ')} since the last sync; `
                + 'a person runs npx --no cockpit sync --config <your cockpit.toml> --interactive and accepts the weakening, or the change is reverted')
        }
        return await work(captured as WorkRequest, composition)
    } catch (error) { return refusal(operation, errorCause(error)) }
}

// Findings are evidence for the agent and the grader to weigh, so they fail the command only for a criterion that demands a clean route.
export function browserOutcome(operation: 'browser-drive' | 'browser-screenshot', result: BrowserCommandResult, failOnFindings: boolean): WorkApplicationOutcome {
    if (result.kind === 'refusal') return refusal(operation, result.reason)
    const gate = evaluateUiGate({ activating: operation === 'browser-screenshot' ? 'screenshot' : 'drive', receipts: [result.receipt] })
    if (gate.kind === 'refusal') return refusal(operation, gate.reason)
    if (failOnFindings && result.receipt.verdict === 'findings') return unsatisfied(operation, result, browserFindingsReason(result.receipt))
    return complete(operation, result)
}

function browserFindingsReason(receipt: BrowserCommandReceipt): string {
    return receipt.surfaces.flatMap(row => {
        const found = row.diagnostics
        if (!found || row.verdict !== 'findings') return []
        const parts = [[found.consoleErrors, 'console error'], [found.pageErrors, 'uncaught page error'], [found.failedRequests, 'failed request']]
            .flatMap(([count, noun]) => count ? [`${count} ${noun}${count === 1 ? '' : 's'}`] : [])
        return [`${row.name}: ${parts.join(', ')}`]
    }).join('; ')
}

type WorkRequest = Exclude<WorkApplicationRequest, { operation: 'test-run' | `browser-${string}` }>

async function work(request: WorkRequest, composition: WorkApplicationComposition): Promise<WorkApplicationOutcome> {
    const { policy, store } = composition
    const operation = request.operation
    const observe = async (orderId: string): Promise<Observed> => {
        const [parsed, record] = await Promise.all([composition.readOrder(orderId), store.read(orderId)])
        if (!parsed.ok) return { id: orderId, problems: parsed.problems, ...(record ? { record } : {}) }
        // A source that cannot be read leaves this order without a digest, and so stale, not the whole listing refused.
        let sources: Readonly<Record<string, string>>
        try { sources = await composition.sourceDigests(parsed.value) }
        catch (error) {
            if (!(error instanceof RefusalError)) throw error
            return { id: orderId, order: parsed.value, problems: [`a cited source cannot be read: ${error.message}`], ...(record ? { record } : {}) }
        }
        const base = record?.accepted.base ?? await composition.heads()
        return { id: orderId, order: parsed.value, problems: [], ...(record ? { record } : {}), digest: workOrderDigest(parsed.value, sources, base) }
    }
    const wip = async () => (await store.list()).filter(record => !TERMINAL.has(record.state)).length
    // Decision records whose text names a path the order may change, so earlier decisions about that code are in front of the agent.
    let records: Promise<ReadonlyMap<string, string>> | undefined
    const relatedDecisions = async (order: WorkOrder): Promise<Readonly<{ relatedDecisions?: readonly string[]; relatedDecisionsUnavailable?: string }>> => {
        const directory = composition.docs?.decisions
        if (!directory) return {}
        const prefix = /^[a-z0-9][a-z0-9-]{0,63}:/.exec(directory)?.[0] ?? ''
        let read: ReadonlyMap<string, string>
        // The listing is advice, so a directory cockpit cannot read is reported here and refused where a record is written.
        try { read = await (records ??= composition.decisionRecords()) }
        catch (error) { if (!(error instanceof RefusalError)) throw error; return { relatedDecisionsUnavailable: error.message } }
        return { relatedDecisions: [...read.entries()]
            .filter(([reference, text]) => reference !== composition.docs?.decisionsIndex && namesScope(text, order.scope, prefix)).map(([reference]) => reference) }
    }

    // Who passed a gate: the agent; a person, after typing the digest of exactly what they were shown;
    // or CI, which locally records the step as awaiting the `work verify` job and passes it there.
    const gated = async (gate: WorkGate, decider: Decider, lines: readonly string[], verb: string,
        apply: (by: Decider) => Promise<WorkApplicationOutcome>): Promise<WorkApplicationOutcome> => {
        const decision = decide(decider, composition.env)
        if (decision === 'proceed') return apply(decider === 'ci' ? 'ci' : 'agent')
        if (decision === 'ci-only') return apply('ci')
        const digest = createHash('sha256').update(JSON.stringify({ gate, lines })).digest('hex')
        let used = false
        return { kind: 'human-needed', operation, continuation: { digest,
            prompt: [...lines.map(shown), `[work.gates] ${gate} = person. To ${verb} exactly this, type ${verb} ${digest}`].join('\n'),
            decide: async (answer: string) => {
                if (used) return refusal(operation, `this prompt was already answered; rerun work ${operation.slice('work-'.length)}`)
                used = true
                return answer.trim() === `${verb} ${digest}` ? apply('person') : refusal(operation, `Nothing was recorded: the person did not type ${verb} ${digest}`)
            } } }
    }
    const current = async (orderId: string): Promise<Readonly<{ row: Observed; record: WorkRecord; order: WorkOrder }>> => {
        const row = await observe(orderId)
        if (!row.record) throw new RefusalError(`${orderId} is not accepted yet; run npx --no cockpit work accept --config <your cockpit.toml> --work-order ${orderId}`)
        const state = displayState(row, composition.caps.attempts)
        if (TERMINAL.has(row.record.state)) throw new RefusalError(`${orderId} is closed (${row.record.state})`)
        if (state === 'stale') throw new RefusalError(`${orderId} changed since it was accepted${row.problems.length ? ` and does not parse: ${row.problems.join('; ')}` : ''}; `
            + `run npx --no cockpit work accept --config <your cockpit.toml> --work-order ${orderId} to accept the change`)
        if (state === 'blocked') throw new RefusalError(openQuestions(row.record).length
            ? `${orderId} has open question ${openQuestions(row.record).join(', ')}; it is answered with work answer`
            : `${orderId} reached the attempt cap (${composition.caps.attempts}); record the root cause with work note, then a person closes it with work signoff --partial or --abandon, or amends the contract`)
        return { row, record: row.record, order: row.order! }
    }
    const runChecks = async (order: Pick<WorkOrder, 'criteria' | 'gates'>): Promise<readonly CheckResult[]> => {
        const results: CheckResult[] = []
        // Checks share the product's state, so they run in the order the contract lists them.
        for (const criterion of order.criteria) if (criterion.check) results.push(await composition.runCheck(criterion.id, criterion.check))
        for (const gate of order.gates) results.push(await composition.runCheck(`gate:${gate}`, { gate }))
        return results
    }

    if (request.operation === 'work-status') {
        const ids = request.workOrderId ? [request.workOrderId] : [...new Set([...await composition.orderIds(), ...(await store.list()).map(row => row.id)])].sort()
        const rows = await Promise.all(ids.map(observe))
        const closed = new Set(rows.filter(row => row.record?.state === 'done').map(row => row.id))
        return complete(operation, {
            grading: policy.grading, gates: policy.gates, wip: { open: await wip(), cap: composition.caps.wip },
            orders: await Promise.all(rows.map(async row => ({
                id: row.id, state: displayState(row, composition.caps.attempts),
                ...row.record?.closure ? { closedAs: row.record.closure.how, closedBy: row.record.closure.by } : {},
                ...row.record ? { attempts: row.record.attempts, acceptedBy: row.record.accepted.by, openQuestions: openQuestions(row.record),
                    acknowledgements: row.record.acknowledgements.map(({ by, note, findings }) => ({ by, note, findings })),
                    awaitingCi: pendingCi(row.record), ...row.record.grade ? { grade: { mode: row.record.grade.mode, passed: row.record.grade.passed,
                        criteria: row.record.grade.criteria, outOfScope: row.record.grade.outOfScope, ...row.record.grade.evaluator ? { evaluator: row.record.grade.evaluator } : {} } } : {} } : {},
                ...row.order ? { waitingOn: row.order.depends_on.filter(dependency => !closed.has(dependency)) } : {},
                ...row.record && !TERMINAL.has(row.record.state) ? { openDecisions: await unresolvedDecisions(row.record, composition) } : {},
                ...row.order && !TERMINAL.has(row.record?.state ?? 'accepted') ? await relatedDecisions(row.order) : {},
                ...row.problems.length ? { problems: row.problems } : {},
            }))),
        })
    }
    if (request.operation === 'work-accept') {
        const row = await observe(request.workOrderId)
        if (!row.order) return refusal(operation, `workorders/${request.workOrderId}.md is not a work order: ${row.problems.join('; ')}`)
        const order = row.order
        const shownOrder = [`Objective: ${order.objective}`, `Scope: ${order.scope.join(', ')}`, ...order.criteria.map(criterion =>
            `${criterion.id}: ${criterion.text}${criterion.check ? ` [check: ${JSON.stringify(criterion.check)}]` : ''}`),
            ...order.gates.length ? [`Gates: ${order.gates.join(', ')}`] : [], ...order.non_goals.map(goal => `Non-goal: ${goal}`)]
        if (!row.record) {
            if (await wip() >= composition.caps.wip) return refusal(operation, `the work-in-progress cap is reached (${composition.caps.wip} accepted orders unfinished); close one with work signoff first`)
            const sources = await composition.sourceDigests(order)
            const base = await composition.heads()
            const digest = workOrderDigest(order, sources, base)
            return gated('accept', policy.gates.accept, [`Accept ${order.id} (digest ${digest})`, ...shownOrder], 'accept', async by => store.update(order.id, async existing => {
                if (existing) throw new RefusalError(`${order.id} was accepted while this prompt was open; rerun work status`)
                const record: WorkRecord = { format: 'cockpit-work-order/v1', id: order.id, state: 'accepted',
                    accepted: { at: now(), by, digest, order, sources, base }, amendments: [], acknowledgements: [], attempts: 0, notes: [] }
                return { record, value: complete(operation, { id: order.id, state: 'accepted', by, digest, ...by === 'ci' ? { awaitingCi: ['accept'] } : {}, ...await relatedDecisions(order) }) }
            }))
        }
        const record = row.record
        if (TERMINAL.has(record.state)) return refusal(operation, `${order.id} is closed (${record.state}); write a new order for further work`)
        if (row.digest === record.accepted.digest) return refusal(operation, `${order.id} is already accepted and unchanged since`)
        const weakened = criteriaWeakening(record.accepted.order, order)
        // Removing or rewriting an accepted criterion moves the bar the work is held to, which an agent never certifies.
        const decider: Decider = weakened.length && policy.gates.amend === 'agent' ? 'person' : policy.gates.amend
        const sources = await composition.sourceDigests(order)
        const digest = workOrderDigest(order, sources, record.accepted.base)
        return gated('amend', decider, [`Amend ${order.id} (digest ${record.accepted.digest} -> ${digest})`,
            ...weakened.length ? [`This weakens the accepted contract: ${weakened.join('; ')}`] : [], ...shownOrder], 'amend', async by => store.update(order.id, async existing => {
            if (!existing || existing.accepted.digest !== record.accepted.digest) throw new RefusalError(`${order.id} changed while this prompt was open; rerun work accept`)
            const next: WorkRecord = { ...existing, state: 'accepted', attempts: 0, checks: undefined, grade: undefined,
                accepted: { at: now(), by, digest, order, sources, base: existing.accepted.base },
                amendments: [...existing.amendments, { at: now(), by, from: existing.accepted.digest, to: digest, weakened: [...weakened] }] }
            return { record: next, value: complete(operation, { id: order.id, state: 'accepted', by, digest, amended: true, weakened, ...await relatedDecisions(order) }) }
        }))
    }
    if (request.operation === 'work-check') {
        const { order, record } = await current(request.workOrderId)
        const results = await runChecks(order)
        if (!results.length) return refusal(operation, `${order.id} declares no check on any criterion and no gates; add a check, or close it under [work] grading = "self"`)
        const passed = results.every(row => row.passed)
        await store.update(order.id, async existing => {
            if (!existing || existing.accepted.digest !== record.accepted.digest) throw new RefusalError(`${order.id} changed while its checks ran; rerun work check`)
            return { record: { ...existing, state: passed ? 'checked' : 'accepted', attempts: existing.attempts + (passed ? 0 : 1), grade: undefined,
                checks: { at: now(), digest: record.accepted.digest, results: [...results] } }, value: undefined }
        })
        const value = { id: order.id, state: passed ? 'checked' : 'accepted', results }
        return passed ? complete(operation, value) : unsatisfied(operation, value, `${results.filter(row => !row.passed).map(row => `${row.criterion}: ${row.outcome}`).join('; ')}`)
    }
    if (request.operation === 'work-note') {
        if (request.kind === 'decision' && !composition.docs?.decisions) return refusal(operation, DECISIONS_UNDECLARED)
        await current(request.workOrderId).catch(async (error: unknown) => {
            // A note on a stale or blocked order is how its cause gets recorded, so only a closed or unaccepted one refuses.
            const record = await store.read(request.workOrderId)
            if (!record || TERMINAL.has(record.state)) throw error
        })
        const index = await store.update(request.workOrderId, async existing => {
            if (!existing) throw new RefusalError(`${request.workOrderId} is not accepted`)
            return { record: { ...existing, notes: [...existing.notes, { at: now(), by: 'agent', kind: request.kind, text: request.text }] }, value: existing.notes.length + 1 }
        })
        return complete(operation, { id: request.workOrderId, note: index, ...request.kind === 'question' ? { question: index, state: 'blocked' } : {},
            ...request.kind === 'decision' ? { decision: index, resolveWith: `npx --no cockpit work decide --config <your cockpit.toml> --work-order ${request.workOrderId} --decision ${index} --record` } : {} })
    }
    if (request.operation === 'work-decide') {
        const directory = composition.docs?.decisions
        if (!directory) return refusal(operation, DECISIONS_UNDECLARED)
        const orderId = request.workOrderId
        const record = await store.read(orderId)
        if (!record || TERMINAL.has(record.state)) return refusal(operation, `${orderId} has no open record to resolve a decision on`)
        const decision = record.notes[request.decision - 1]
        if (decision?.kind !== 'decision') return refusal(operation, `note ${request.decision} on ${orderId} is not a decision; work status lists each order's open decisions`)
        const resolve = (fields: Readonly<{ text: string; record?: string }>, writes?: () => Promise<void>) => store.update(orderId, async existing => {
            if (!existing || TERMINAL.has(existing.state)) throw new RefusalError(`${orderId} closed while its decision was being resolved`)
            await writes?.()
            return { record: { ...existing, notes: [...existing.notes, { at: now(), by: 'agent', kind: 'resolution', resolves: request.decision, ...fields }] }, value: undefined }
        })
        const resolution = request.resolution
        if (resolution.kind === 'none') {
            await resolve({ text: resolution.reason })
            return complete(operation, { id: orderId, decision: request.decision, resolution: 'none', reason: resolution.reason })
        }
        if (resolution.path !== undefined) {
            if (!resolution.path.startsWith(`${directory}/`)) return refusal(operation, `${resolution.path} is not inside [docs] decisions ${directory}; write the record there`)
            if (resolution.supersedes) return refusal(operation, '--supersedes applies when cockpit writes the record; with a path, write the Supersedes line and the old record\'s status yourself')
            const problem = recordProblem(await composition.readDocsFile(resolution.path), resolution.path, orderId, false)
            if (problem) return refusal(operation, `${resolution.path} cannot resolve decision ${request.decision}: ${problem}`)
            await resolve({ text: `recorded in ${resolution.path}`, record: resolution.path })
            return complete(operation, { id: orderId, decision: request.decision, record: resolution.path })
        }
        // Scaffold the record; the agent fills in its body, and signoff refuses while the template's placeholders remain.
        const existing = await (records ??= composition.decisionRecords())
        const names = [...existing.keys()].map(reference => reference.slice(directory.length + 1))
        const title = recordTitle(decision.text)
        const named = nextRecordName(names, title, now().slice(0, 10))
        const reference = `${directory}/${named.name}`
        const writes = [{ reference, create: true, text: '' }]
        let supersedes: string | undefined
        if (resolution.supersedes) {
            if (!named.number) return refusal(operation, `the records in ${directory} are named by date, so none has a number to supersede`)
            const old = names.filter(name => Number(recordNumber(name)) === Number(resolution.supersedes))
            if (old.length !== 1) return refusal(operation, `${directory} has ${old.length ? `${old.length} records` : 'no record'} numbered ${resolution.supersedes}; pass the number of exactly one`)
            supersedes = recordNumber(old[0]!)!
            const marked = withStatus(existing.get(`${directory}/${old[0]}`)!, `superseded by ${named.number}`)
            if (marked === undefined) return refusal(operation, `${directory}/${old[0]} has no Status line to mark superseded; add "Status: accepted" to it`)
            writes.push({ reference: `${directory}/${old[0]}`, create: false, text: marked })
        }
        writes[0]!.text = scaffoldRecord({ title, workOrder: orderId, ...named.number ? { number: named.number } : {}, ...supersedes ? { supersedes } : {} })
        const index = composition.docs?.decisionsIndex
        if (index !== undefined && await composition.readDocsFile(index) === undefined) return refusal(operation, `[docs] decisions_index ${index} does not exist; create it, or remove decisions_index from cockpit.toml`)
        const link = index === undefined ? undefined : posix.relative(posix.dirname(index.replace(/^[^:/]*:/, '')), reference.replace(/^[^:/]*:/, ''))
        await resolve({ text: `recorded in ${reference}`, record: reference },
            () => composition.writeDecisionRecords(writes, link === undefined ? undefined : `- [${named.number ? `${named.number}. ` : ''}${title}](${link})`))
        return complete(operation, { id: orderId, decision: request.decision, record: reference, written: writes.map(row => row.reference),
            next: `fill in ${reference}: signoff refuses while its "cockpit: replace this" placeholders remain` })
    }
    if (request.operation === 'work-answer') {
        const record = await store.read(request.workOrderId)
        if (!record || TERMINAL.has(record.state)) return refusal(operation, `${request.workOrderId} has no open record to answer on`)
        const question = record.notes[request.question - 1]
        if (!question || question.kind !== 'question' || !openQuestions(record).includes(request.question)) return refusal(operation, `note ${request.question} on ${request.workOrderId} is not an open question`)
        return gated('answer', policy.gates.answer, [`Open question ${request.question} on ${request.workOrderId}:`, `  ${question.text}`, 'Answer to record:', `  ${request.text}`], 'answer',
            async by => store.update(request.workOrderId, async existing => {
                if (!existing || !openQuestions(existing).includes(request.question)) throw new RefusalError(`question ${request.question} was answered while this prompt was open`)
                return { record: { ...existing, notes: [...existing.notes, { at: now(), by, kind: 'answer', text: request.text, answers: request.question }] },
                    value: complete(operation, { id: request.workOrderId, answered: request.question, by }) }
            }))
    }
    if (request.operation === 'work-grade') {
        const { order, record } = await current(request.workOrderId)
        if (policy.grading === 'self' ? !request.verdict || !request.note : request.verdict !== undefined || request.note !== undefined) {
            return refusal(operation, policy.grading === 'self' ? '[work] grading = "self": pass --verdict met|unmet and --note <what you checked>'
                : `--verdict and --note apply only under [work] grading = "self"; this cockpit grades with ${policy.grading}`)
        }
        let verdicts: readonly Verdict[]
        let evaluator: NonNullable<WorkRecord['grade']>['evaluator']
        const unchecked = order.criteria.filter(criterion => !criterion.check).map(criterion => criterion.id)
        if (policy.grading === 'checks' && unchecked.length) return refusal(operation, `[work] grading = "checks" closes an order only when cockpit ran a check for every criterion; ${unchecked.join(', ')} declare none`)
        // Checks and scope bind in every mode, so an agent's own `met` covers neither a failed check nor a
        // change outside scope. Changes are read after the checks, so files a check writes count too.
        const checks = await runChecks(order)
        const changes = await composition.changes(record.accepted.base)
        // The decision records an order is required to write are part of its work wherever scope points.
        const decisionFiles = [composition.docs?.decisions, composition.docs?.decisionsIndex].filter((path): path is string => path !== undefined)
        const outOfScope = changes.map(change => change.path).filter(path => !scopeMatches([...order.scope, ...decisionFiles], path))
        const standing = policy.grading === 'checks' ? [] : standingCriteria(composition.docs, record)
        const taken = standing.filter(row => order.criteria.some(criterion => criterion.id === row.id)).map(row => row.id)
        if (taken.length) return refusal(operation, `${order.id} names a criterion ${taken.join(', ')}, which cockpit adds to every grade itself; rename it in workorders/${order.id}.md`)
        if (policy.grading === 'self') {
            verdicts = [...order.criteria, ...standing].map(criterion => ({ id: criterion.id, verdict: request.verdict!, note: request.note! }))
        } else if (policy.grading === 'checks') {
            verdicts = order.criteria.map(criterion => { const result = checks.find(row => row.criterion === criterion.id)!
                return { id: criterion.id, verdict: result.passed ? 'met' : 'unmet', note: `cockpit ran the check: ${result.outcome}` } })
        } else {
            const graded = await composition.evaluate({ objective: order.objective, criteria: [...order.criteria, ...standing], nonGoals: order.non_goals, scope: order.scope, checks, changes, outOfScope })
            if ('refusal' in graded) return refusal(operation, `${graded.refusal.code}: ${graded.refusal.message}; ${graded.refusal.fix}`)
            verdicts = graded.criteria
            evaluator = { tool: graded.evaluator.tool, fallbacks: graded.evaluator.fallbacks.map(row => ({ ...row })) }
        }
        // Weakened tests bind in every mode too: a grader or an agent that says met has not read the base's tests.
        const guarded = protection(await composition.testWeakening(record.accepted.base), record)
        if (guarded.verdict) verdicts = [...verdicts, guarded.verdict]
        const passed = verdicts.every(row => row.verdict === 'met') && checks.every(row => row.passed) && outOfScope.length === 0
        const grade: NonNullable<WorkRecord['grade']> = { at: now(), digest: record.accepted.digest, mode: policy.grading, passed,
            criteria: [...verdicts], outOfScope: [...outOfScope], ...evaluator ? { evaluator } : {}, ...request.note ? { note: request.note } : {} }
        await store.update(order.id, async existing => {
            if (!existing || existing.accepted.digest !== record.accepted.digest) throw new RefusalError(`${order.id} changed while it was graded; rerun work grade`)
            return { record: { ...existing, state: passed ? 'graded' : 'accepted', attempts: existing.attempts + (passed ? 0 : 1), grade,
                ...checks.length ? { checks: { at: now(), digest: record.accepted.digest, results: [...checks] } } : {} }, value: undefined }
        })
        const value = { id: order.id, state: passed ? 'graded' : 'accepted', mode: policy.grading, criteria: verdicts, checks, outOfScope, testProtection: guarded.value, ...evaluator ? { evaluator } : {} }
        if (passed) return complete(operation, value)
        return unsatisfied(operation, value, [...split(verdicts).others.map(row => `${row.id} ${row.verdict}: ${row.note}`),
            ...checks.filter(row => !row.passed).map(row => `check ${row.criterion}: ${row.outcome}`),
            ...outOfScope.length ? [`changed outside scope: ${outOfScope.join(', ')}`] : []].join('; '), split(verdicts).weakening)
    }
    if (request.operation === 'work-acknowledge') {
        const { order, record } = await current(request.workOrderId)
        const weak = await composition.testWeakening(record.accepted.base)
        if (!weak.findings.length) return refusal(operation, `${order.id} weakens no tests since its base, so there is nothing to acknowledge`)
        const digest = testWeakeningDigest(weak.findings)
        if (record.acknowledgements.some(row => row.digest === digest)) return refusal(operation, `this weakening of ${order.id} is already acknowledged; run work grade`)
        const rows = weak.findings.map(describeWeakening)
        return gated('acknowledge', policy.gates.acknowledge, [`Acknowledge that ${order.id} weakens tests since its base (test files from ${weak.patterns.source}):`,
            ...rows.map(row => `  ${row}`), 'Reason given:', `  ${request.note}`], 'acknowledge', async by => store.update(order.id, async existing => {
            if (!existing || existing.accepted.digest !== record.accepted.digest) throw new RefusalError(`${order.id} changed while this prompt was open; rerun work acknowledge`)
            if (testWeakeningDigest((await composition.testWeakening(existing.accepted.base)).findings) !== digest) {
                throw new RefusalError(`the test changes of ${order.id} changed while this prompt was open; rerun work acknowledge`)
            }
            return { record: { ...existing, acknowledgements: [...existing.acknowledgements, { at: now(), by, digest, findings: rows, note: request.note }] },
                value: complete(operation, { id: order.id, acknowledged: rows, by, digest }) }
        }))
    }
    if (request.operation === 'work-signoff') {
        const record = await store.read(request.workOrderId)
        if (!record) return refusal(operation, `${request.workOrderId} is not accepted`)
        if (TERMINAL.has(record.state)) return refusal(operation, `${request.workOrderId} is already closed (${record.state})`)
        let how: NonNullable<WorkRecord['closure']>['how']
        if (request.close === 'done') {
            const { order } = await current(request.workOrderId)
            if (record.state !== 'graded' || !record.grade?.passed || record.grade.digest !== record.accepted.digest) {
                return refusal(operation, `${order.id} is ${record.state}, not graded; run npx --no cockpit work grade --config <your cockpit.toml> --work-order ${order.id}`)
            }
            const open = await Promise.all(order.depends_on.map(async dependency => (await store.read(dependency))?.state === 'done' ? undefined : dependency))
            if (open.some(Boolean)) return refusal(operation, `${order.id} depends on ${open.filter(Boolean).join(', ')}, which ${open.filter(Boolean).length === 1 ? 'is' : 'are'} not done`)
            how = CLOSURE[record.grade.mode]
        } else {
            if (!request.note) return refusal(operation, `closing ${request.workOrderId} as ${request.close} needs --note saying what was and was not done`)
            how = request.close
        }
        // Every closure, partial and abandoned too, settles the order's decisions: work that stops still made them.
        const open = await unresolvedDecisions(record, composition)
        if (open.length) return refusal(operation, `${request.workOrderId} cannot close while ${open.join('; ')}`)
        return gated('signoff', policy.gates.signoff, [`Close ${request.workOrderId} as ${request.close} (${how})`, ...request.note ? [`Note: ${request.note}`] : [],
            ...record.grade ? record.grade.criteria.map(row => `${row.id}: ${row.verdict} — ${row.note}`) : [],
            ...decisions(record).map(row => `Decision ${row.decision} (${row.title}): ${row.resolution!.record ? `recorded in ${row.resolution!.record}` : `no lasting decision — ${row.resolution!.text}`}`)],
        'signoff', async by => store.update(request.workOrderId, async existing => {
            if (!existing || existing.state !== record.state || existing.accepted.digest !== record.accepted.digest || existing.notes.length !== record.notes.length) {
                throw new RefusalError(`${request.workOrderId} changed while this prompt was open`)
            }
            const state: WorkRecord['state'] = request.close
            return { record: { ...existing, state, closure: { at: now(), by, how, ...request.note ? { note: request.note } : {} } },
                value: complete(operation, { id: request.workOrderId, state, closedAs: how, by }) }
        }))
    }
    if (request.operation === 'work-recover') return complete(operation, await store.recover(request.workOrderId, request.apply))
    if (request.operation === 'work-verify') {
        const problems: string[] = []
        const awaiting: string[] = []
        for (const record of await store.list()) {
            const row = await observe(record.id)
            if (!TERMINAL.has(record.state) && row.digest !== record.accepted.digest) problems.push(`${record.id} changed since it was accepted; accept the change or revert it`)
            if (record.state === 'done' && (!record.grade?.passed || record.grade.digest !== record.accepted.digest || !record.closure)) problems.push(`${record.id} is done without a passing grade of its accepted contract`)
            for (const row of decisions(record)) {
                const cited = row.resolution?.record
                const problem = cited && recordProblem(await composition.readDocsFile(cited), cited, record.id, false)
                if (problem) problems.push(`${record.id} decision ${row.decision}: ${problem}`)
            }
            awaiting.push(...pendingCi(record).map(step => `${record.id} ${step}`))
        }
        const ci = runningInCi(composition.env)
        const value = { ci, problems, ...ci ? { confirmed: awaiting } : { awaitingCi: awaiting } }
        return problems.length ? unsatisfied(operation, value, problems.join('; ')) : complete(operation, value)
    }
    // grade-criteria: the quick path, an independent grade of uncommitted work with no order and no record.
    const parsed = await composition.readCriteriaFile(request.criteriaFile)
    if (!parsed.ok) return refusal(operation, `${request.criteriaFile} is not a criteria file: ${parsed.problems.join('; ')}`)
    const file = parsed.value
    const checks = await runChecks(file)
    // The criteria file is the request, not part of the change it grades.
    const changes = (await composition.changes(await composition.heads())).filter(change => change.path !== posix.normalize(request.criteriaFile))
    const outOfScope = file.scope.length ? changes.map(change => change.path).filter(path => !scopeMatches(file.scope, path)) : []
    const subject: GradingSubject = { ...file.objective ? { objective: file.objective } : {}, criteria: file.criteria, nonGoals: [], scope: file.scope, checks, changes, outOfScope }
    const graded = await composition.evaluate(subject)
    if ('refusal' in graded) return refusal(operation, `${graded.refusal.code}: ${graded.refusal.message}; ${graded.refusal.fix}`)
    // With no order there is no recorded base, so the change since HEAD is what is compared, and nobody can acknowledge it.
    const guarded = protection(await composition.testWeakening(await composition.heads()), undefined)
    const criteria = guarded.verdict ? [...graded.criteria, guarded.verdict] : graded.criteria
    const passed = criteria.every(row => row.verdict === 'met') && checks.every(row => row.passed) && outOfScope.length === 0
    const value = { criteria, checks, outOfScope, testProtection: guarded.value, evaluator: graded.evaluator }
    return passed ? complete(operation, value) : unsatisfied(operation, value, split(criteria).others.map(row => `${row.id} ${row.verdict}: ${row.note}`)
        .concat(checks.filter(row => !row.passed).map(row => `check ${row.criterion}: ${row.outcome}`), outOfScope.length ? [`changed outside scope: ${outOfScope.join(', ')}`] : []).join('; '), split(criteria).weakening)
}
