// Grading: the standing criteria cockpit adds to every grade, the test protection a grade and a test
// run apply, `work grade` against an order's accepted contract and `grade --criteria` with no order.
import { posix } from 'node:path'

import type { EffectivePolicy } from '../autonomy.js'
import { RefusalError } from '../environment/contract.js'
import type { GradingSubject, Verdict } from '../grading/grade.js'
import { GRADING, isGradeMode, type Decider, type GradeMode, type WorkGrading } from '../schema.js'
import { runGate } from '../testing/gates.js'
import { describeWeakening, testWeakeningDigest, type RepositoryWeakening } from '../testing/weakening.js'
import { scopeMatcher, type AmendmentReview, type WorkOrderCriterion } from './contract.js'
import type { WorkRecord } from './store.js'
import type { WorkApplicationComposition } from './composition.js'
import { complete, now, refusal, TERMINAL, unsatisfied, type WorkApplicationOutcome, type WorkApplicationRequest, type WorkContext, type WorkRequest } from './application-context.js'
import { decisions } from './application-decisions.js'

// A list in a criterion's text stays readable; the full list is in the grade's result beside it.
const listed = (rows: readonly string[], separator: string, limit = 3_000) => {
    const text = rows.join(separator)
    return text.length <= limit ? text : `${text.slice(0, limit)} (cut; ${rows.length} in all)`
}
const weakeningPath = (row: RepositoryWeakening) => row.repository === '.' ? row.path : `${row.repository}:${row.path}`
// The agent's contract amendments since a person or CI last accepted it, each still to be judged by the next grade.
function amendmentsToReview(record: WorkRecord): readonly AmendmentReview[] {
    const reviewed = record.amendments.findLastIndex(row => row.by !== 'agent')
    return record.amendments.slice(reviewed + 1).flatMap(row => row.review)
}
// The paths a self-reported note does not name, alone or by a directory above them.
const unaddressed = (note: string, paths: readonly string[]) => paths.filter(path => {
    const parts = path.split('/')
    return !parts.some((_, index) => note.includes(index === parts.length - 1 ? path : `${parts.slice(0, index + 1).join('/')}/`))
})

type Weakening = Awaited<ReturnType<WorkApplicationComposition['testWeakening']>>
const ACKNOWLEDGE = 'npx --no cockpit work acknowledge --config <your cockpit.toml> --work-order <id> --note <why this is not a weakening>'
export interface AcknowledgeRule {
    /** Who passes `work acknowledge`. */
    readonly decider: Decider
    /** Whether a recorded acknowledgement passes test protection now. */
    readonly counts: (row: Readonly<{ by: Decider }>) => boolean
}
// Under checks no model reads the change, so the acknowledgement alone passes test protection, and an
// agent acknowledging its own weakened tests would pass them unseen. There a person or CI acknowledges
// whatever [work.gates] says, and an acknowledgement the agent recorded under another mode does not count.
export function acknowledgeRule(policy: Pick<EffectivePolicy, 'grading' | 'gates'>): AcknowledgeRule {
    const checks = policy.grading === 'checks'
    return { decider: checks && policy.gates.acknowledge === 'agent' ? 'person' : policy.gates.acknowledge, counts: row => !checks || row.by !== 'agent' }
}
// Tests weakened since the base, judged by rule where no model reads the change. An acknowledgement
// covers exactly the findings it was recorded for, so any further weakening fails again.
function protection(weak: Weakening, record: WorkRecord | undefined, rule: AcknowledgeRule) {
    const rows = weak.findings.map(describeWeakening)
    const digest = testWeakeningDigest(weak.findings)
    const acknowledged = weak.findings.length ? record?.acknowledgements.find(row => row.digest === digest && rule.counts(row)) : undefined
    const gate = rule.decider
    const how = !record ? 'a work order lets it be acknowledged; there is none for this grade'
        : gate === 'person' ? `a person records it with ${ACKNOWLEDGE} --interactive` : gate === 'ci' ? `acknowledge it with ${ACKNOWLEDGE}, which the work verify job confirms in CI`
            : `acknowledge it with ${ACKNOWLEDGE}`
    const verdict: Pick<Verdict, 'verdict' | 'note'> | undefined = !weak.findings.length ? undefined
        : acknowledged ? { verdict: 'met', note: `weakening acknowledged by ${acknowledged.by}: ${acknowledged.note}`.slice(0, 4_000) }
            : { verdict: 'unmet', note: `tests were weakened since the base (${rows.join('; ')}; test files from ${weak.patterns.source}); revert it, or ${how}`.slice(0, 4_000) }
    return { verdict, value: { testFiles: weak.patterns.source, findings: rows, ...acknowledged ? { acknowledgedBy: acknowledged.by } : {} } }
}

type StandingInput = Readonly<{ docs?: WorkApplicationComposition['docs']; record?: WorkRecord; outOfScope: readonly string[]; weak: Weakening
    amendments: readonly AmendmentReview[]; acknowledge: AcknowledgeRule }>
// A criterion cockpit adds to every grade. Where a model grades, it judges `text` (the evaluator in
// independent grading, the agent's verdict in self grading, a verdict the agent relays in subagent
// grading). Under checks no model reads the change:
// a criterion with `underChecks` binds there by rule, under that id; the rest stay instructions in the
// work skill, and scope binds as its own rule, failing on any change outside it.
interface StandingCriterion {
    readonly id: string
    /** What a model judges, or undefined where the criterion does not apply to this change. */
    readonly text: (input: StandingInput) => string | undefined
    readonly underChecks?: Readonly<{ id: string; verdict: (input: StandingInput) => Pick<Verdict, 'verdict' | 'note'> | undefined }>
    /** A failure of it is test weakening, which has its own diagnostic and fix. */
    readonly weakening?: true
    /** What to do about it when unmet, appended to the grade's reason. */
    readonly remedy?: (orderId: string) => string
}
const TESTS_JUSTIFIED = 'test-changes-justified'
const AMENDMENTS_HOLD = 'amendments-hold-bar'
const STANDING: readonly StandingCriterion[] = [
    { id: 'decisions-recorded', text: ({ docs, record }) => {
        if (!docs?.decisions || !record) return undefined
        const recorded = decisions(record).map(row => `${row.decision} (${row.title})${row.resolution?.record ? ` in ${row.resolution.record}` : ''}`).join('; ')
        return ('Every lasting decision this change makes (a choice a later change must know about, such as a format, a boundary, '
            + `a dependency or a rejected option) is recorded on the work order or in a decision record under ${docs.decisions}. Recorded on this order: ${recorded || 'none'}.`).slice(0, 2_000)
    } },
    { id: 'docs-updated', text: ({ docs }) => docs ? 'Documentation that describes behaviour this change alters is updated in the change, or no documentation describes it.' : undefined },
    // Which paths changed outside scope is a git fact; whether each change was needed is a judgement.
    { id: 'scope-changes-necessary', text: ({ outOfScope }) => outOfScope.length ? 'Each change outside the scope is necessary to the objective and harmless, such as a lockfile, a regenerated '
        + 'reference or a changeset the in-scope change requires; any other is scope creep and fails this. The note names each path and says why. '
        + `Changed outside scope: ${listed(outOfScope, ', ')}.` : undefined },
    // The detector names candidates; whether each change keeps the tests' force is a judgement.
    { id: TESTS_JUSTIFIED, weakening: true, text: ({ weak, record }) => {
        if (!weak.findings.length) return undefined
        const acknowledged = record?.acknowledgements.map(row => `${row.by}: ${row.note}`) ?? []
        return 'Each test change flagged below keeps the tests\' force: a removed or loosened test is replaced by one at least '
            + 'as strict, or tested behaviour the change itself removes. A test weakened to make the change pass fails this. The note names each file and says why. '
            + `Flagged (test files from ${weak.patterns.source}): ${listed(weak.findings.map(describeWeakening), '; ')}. `
            + `Acknowledgements recorded on the order: ${acknowledged.length ? listed(acknowledged, '; ', 1_000) : 'none'}.`
    }, underChecks: { id: 'test-protection', verdict: ({ weak, record, acknowledge }) => protection(weak, record, acknowledge).verdict } },
    // An agent may reword its own contract; whether the rewording lowers the bar is a judgement. Under
    // checks nothing could judge it, so the amend gate passes such an amendment to a person instead.
    { id: AMENDMENTS_HOLD, text: ({ amendments }) => amendments.length ? 'The amendments an agent made to the accepted contract do not lower the bar the work is held to: each clarifies or '
        + 'tightens what it replaces, and none excuses work the original asked for. Before and after: '
        + `${listed(amendments.map(row => `${row.field}: "${row.before}" -> "${row.after}"`), '; ')}.` : undefined,
    remedy: id => `; the next amendment of ${id} is a person's: revert or rewrite workorders/${id}.md, then a person runs npx --no cockpit work accept --config <your cockpit.toml> --work-order ${id} --interactive` },
]
const RESERVED: ReadonlySet<string> = new Set(STANDING.map(row => row.id))
const standingCriteria = (input: StandingInput): readonly WorkOrderCriterion[] => STANDING.flatMap(row => {
    const text = row.text(input)
    return text === undefined ? [] : [{ id: row.id, text }]
})
const standingVerdictsUnderChecks = (input: StandingInput): readonly Verdict[] => STANDING.flatMap(row => {
    const reached = row.underChecks?.verdict(input)
    return reached ? [{ id: row.underChecks!.id, ...reached }] : []
})
const WEAKENING_IDS: ReadonlySet<string> = new Set(STANDING.flatMap(row => row.weakening ? [row.id, ...row.underChecks ? [row.underChecks.id] : []] : []))
const remedyOf = (id: string, orderId: string) => STANDING.find(row => row.id === id)?.remedy?.(orderId) ?? ''
const split = (verdicts: readonly Verdict[]) => ({ others: verdicts.filter(row => row.verdict !== 'met' && !WEAKENING_IDS.has(row.id)),
    weakening: verdicts.filter(row => WEAKENING_IDS.has(row.id) && row.verdict !== 'met').map(row => `${row.id} ${row.verdict}: ${row.note}`).join('; ') || undefined })

// A test run's result, held to the protection of every open order.
export async function testRun(captured: Extract<WorkApplicationRequest, { operation: 'test-run' }>, composition: WorkApplicationComposition): Promise<WorkApplicationOutcome> {
    const operation = captured.operation
    const prepared = await composition.gate(captured)
    const run = await runGate(prepared.registry, prepared.request, prepared.dependencies)
    // A passing run proves nothing if the tests it ran were weakened, so it is checked against the base of each open order.
    // Under checks grading an unacknowledged finding fails the run; where a model grades, the grade judges it.
    const open = (await composition.store.list()).filter(row => !TERMINAL.has(row.state))
    // Orders accepted at the same commits share one observation of what changed since.
    const observed = new Map<string, Promise<Weakening>>()
    const weakeningSince = (base: Readonly<Record<string, string>>) => {
        const key = JSON.stringify(Object.entries(base).sort(([left], [right]) => left < right ? -1 : 1))
        if (!observed.has(key)) observed.set(key, composition.testWeakening(base))
        return observed.get(key)!
    }
    const guards = await Promise.all(open.map(async row => ({ id: row.id, ...protection(await weakeningSince(row.accepted.base), row, acknowledgeRule(composition.policy)) })))
    const binding = composition.policy.grading === 'checks'
    const testProtection = guards.length ? { comparedWith: guards.map(row => `${row.id}'s base`), orders: guards.map(row => ({ id: row.id, ...row.value })),
        ...!binding && guards.some(row => row.value.findings.length) ? { note: !isGradeMode(composition.policy.grading)
            ? 'under [work] grading = "off" nothing judges these findings; they are reported only, and test protection in CI is a separate guard'
            : `under [work] grading = "${composition.policy.grading}" each order's grade judges these findings as ${TESTS_JUSTIFIED}` } : {} }
        : { comparedWith: [], note: 'no open work order records a base commit to compare tests with; accept an order before changing tests' }
    const weakening = binding ? guards.flatMap(row => row.verdict?.verdict === 'unmet' ? [`${row.id}: ${row.verdict.note}`] : []).join(' | ') : ''
    const failure = run.satisfiesGate ? '' : `${run.verdict}: ${run.reasons.join('; ') || 'declared gate was not satisfied'}`
    return !failure && !weakening ? complete(operation, { ...run, testProtection }) : unsatisfied(operation, { ...run, testProtection }, failure, weakening || undefined)
}

// Under subagent an order's grade either relays a subagent's verdict or, with nothing submitted, runs the
// separate evaluator, which is stronger, because not every agent can spawn a subagent.
const SUBAGENT_SUBMISSION = '[work] grading = "subagent": submit the evaluator subagent\'s verdict with --from-subagent, --verdict met|unmet and --note <what it checked>, '
    + 'or pass none of the three and cockpit runs a separate evaluator process instead'
function submissionProblem(grading: WorkGrading, request: Extract<WorkRequest, { operation: 'work-grade' }>): string | undefined {
    const parts = [request.verdict, request.note, request.fromSubagent].filter(row => row !== undefined).length
    const { submission } = GRADING[grading]
    if (submission === 'relayed-or-none') return parts === 0 || parts === 3 ? undefined : SUBAGENT_SUBMISSION
    if (request.fromSubagent) return `--from-subagent applies only under [work] grading = "subagent"; this cockpit grades with ${grading}`
    if (submission === 'verdict') return request.verdict && request.note ? undefined : `[work] grading = "${grading}": pass --verdict met|unmet and --note <what you checked>`
    return parts === 0 ? undefined : `--verdict and --note apply only under [work] grading = "self" or "subagent"; this cockpit grades with ${grading}`
}

export async function gradeOrder(request: Extract<WorkRequest, { operation: 'work-grade' }>, context: WorkContext): Promise<WorkApplicationOutcome> {
    const { composition, operation, policy, store, current, runChecks } = context
    if (!isGradeMode(policy.grading)) return refusal(operation, `[work] grading = "off": nothing grades an order; close it with npx --no cockpit work signoff --config <your cockpit.toml> --work-order ${request.workOrderId}`)
    const { order, record } = await current(request.workOrderId)
    const problem = submissionProblem(policy.grading, request)
    if (problem) return refusal(operation, problem)
    if (request.fromSubagent && record.evaluatorFailed) return refusal(operation,
        `a separate evaluator already found ${order.id}'s accepted contract unmet, and a relayed verdict cannot replace that, nor after an amendment the agent accepted; `
        + `fix the work and run work grade with none of --from-subagent, --verdict and --note, or have a person or CI accept an amendment of workorders/${order.id}.md`)
    // What actually answers, which the record keeps: `subagent` with nothing submitted is the evaluator's grade.
    const mode: GradeMode = policy.grading === 'subagent' && !request.fromSubagent ? 'independent' : policy.grading
    const reported = GRADING[mode].submission !== 'none'
    let verdicts: readonly Verdict[]
    let evaluator: NonNullable<WorkRecord['grade']>['evaluator']
    const unchecked = order.criteria.filter(criterion => !criterion.check).map(criterion => criterion.id)
    if (mode === 'checks' && unchecked.length) return refusal(operation, `[work] grading = "checks" closes an order only when cockpit ran a check for every criterion; ${unchecked.join(', ')} declare none`)
    const { judged } = GRADING[mode]
    const taken = judged ? order.criteria.filter(criterion => RESERVED.has(criterion.id)).map(criterion => criterion.id) : []
    if (taken.length) return refusal(operation, `${order.id} names a criterion ${taken.join(', ')}, which cockpit adds to grades itself; rename it in workorders/${order.id}.md`)
    // Checks bind in every mode, so an agent's own `met` never covers a failed check. Changes are read
    // after the checks, so files a check writes count too.
    const checks = await runChecks(order)
    const { changes, weakening: weak } = await composition.review(record.accepted.base)
    // The decision records an order is required to write are part of its work wherever scope points.
    const decisionFiles = [composition.docs?.decisions, composition.docs?.decisionsIndex].filter((path): path is string => path !== undefined)
    const inScope = scopeMatcher([...order.scope, ...decisionFiles])
    const outOfScope = changes.map(change => change.path).filter(path => !inScope(path))
    const guarded = protection(weak, record, acknowledgeRule(policy))
    const amendments = judged ? amendmentsToReview(record) : []
    const standingInput: StandingInput = { docs: composition.docs, record, outOfScope, weak, amendments, acknowledge: acknowledgeRule(policy) }
    const standing = judged ? standingCriteria(standingInput) : []
    if (reported) {
        // The reported verdict covers the standing criteria too, so its note must at least name what they list.
        const missing = unaddressed(request.note!, [...outOfScope, ...weak.findings.map(weakeningPath)])
        if (missing.length) return refusal(operation, `[work] grading = "${mode}": --note must name each path changed outside scope and each flagged test file, or a directory above it, `
            + `and say why its change is needed; it does not name ${listed(missing, ', ', 1_000)}`)
        verdicts = [...order.criteria, ...standing].map(criterion => ({ id: criterion.id, verdict: request.verdict!, note: request.note! }))
    } else if (mode === 'checks') {
        verdicts = order.criteria.map(criterion => { const result = checks.find(row => row.criterion === criterion.id)!
            return { id: criterion.id, verdict: result.passed ? 'met' : 'unmet', note: `cockpit ran the check: ${result.outcome}` } })
        // No model reads the change under checks, so weakened tests fail the grade until acknowledged.
        verdicts = [...verdicts, ...standingVerdictsUnderChecks(standingInput)]
    } else {
        // The contract's own change is shown to the evaluator as a changed file, so a verdict on the amendments can quote it.
        const contract = amendments.length ? [{ path: `workorders/${order.id}.md`, status: 'amended',
            diff: amendments.map(row => `${row.field}\n- ${row.before}\n+ ${row.after}`).join('\n') }] : []
        const graded = await composition.evaluate({ objective: order.objective, criteria: [...order.criteria, ...standing], nonGoals: order.non_goals, scope: order.scope,
            checks, changes: [...changes, ...contract], outOfScope })
        if ('refusal' in graded) return refusal(operation, `${graded.refusal.code}: ${graded.refusal.message}; ${graded.refusal.fix}`)
        verdicts = graded.criteria
        evaluator = { tool: graded.evaluator.tool, fallbacks: graded.evaluator.fallbacks.map(row => ({ ...row })) }
    }
    // Where a model grades, whether a change outside scope was needed is its standing criterion; under checks nothing can judge it, so any fails.
    const passed = verdicts.every(row => row.verdict === 'met') && checks.every(row => row.passed) && (judged || outOfScope.length === 0)
    const grade: NonNullable<WorkRecord['grade']> = { at: now(), digest: record.accepted.digest, mode, passed,
        criteria: [...verdicts], outOfScope: [...outOfScope], ...evaluator ? { evaluator } : {}, ...request.note ? { note: request.note } : {} }
    const loweredBar = verdicts.find(row => row.id === AMENDMENTS_HOLD && row.verdict !== 'met')
    await store.update(order.id, async existing => {
        if (!existing || existing.accepted.digest !== record.accepted.digest) throw new RefusalError(`${order.id} changed while it was graded; rerun work grade`)
        return { record: { ...existing, state: passed ? 'graded' : 'accepted', attempts: existing.attempts + (passed ? 0 : 1), grade,
            ...loweredBar ? { amendmentsFailedReview: { at: grade.at, note: loweredBar.note } } : {},
            ...mode === 'independent' && !passed ? { evaluatorFailed: { at: grade.at } } : {},
            ...checks.length ? { checks: { at: now(), digest: record.accepted.digest, results: [...checks] } } : {} }, value: undefined }
    })
    const answeredBy = GRADING[policy.grading].answeredBy?.(evaluator?.tool)
    const value = { id: order.id, state: passed ? 'graded' : 'accepted', mode, ...answeredBy ? { answeredBy } : {}, criteria: verdicts, checks, outOfScope, testProtection: guarded.value, ...evaluator ? { evaluator } : {} }
    if (passed) return complete(operation, value)
    return unsatisfied(operation, value, [...split(verdicts).others.map(row => `${row.id} ${row.verdict}: ${row.note}${remedyOf(row.id, order.id)}`),
        ...checks.filter(row => !row.passed).map(row => `check ${row.criterion}: ${row.outcome}`),
        ...!judged && outOfScope.length ? [`changed outside scope: ${outOfScope.join(', ')}`] : []].join('; '), split(verdicts).weakening)
}

// The quick path: an independent grade of uncommitted work with no order and no record.
export async function gradeCriteriaFile(request: Extract<WorkRequest, { operation: 'grade-criteria' }>, context: WorkContext): Promise<WorkApplicationOutcome> {
    const { composition, operation, policy, runChecks } = context
    const parsed = await composition.readCriteriaFile(request.criteriaFile)
    if (!parsed.ok) return refusal(operation, `${request.criteriaFile} is not a criteria file: ${parsed.problems.join('; ')}`)
    const file = parsed.value
    const taken = file.criteria.filter(criterion => RESERVED.has(criterion.id)).map(criterion => criterion.id)
    if (taken.length) return refusal(operation, `${request.criteriaFile} names a criterion ${taken.join(', ')}, which cockpit adds to grades itself; rename it`)
    const checks = await runChecks(file)
    // The criteria file is the request, not part of the change it grades.
    // With no order there is no recorded base, so the change since HEAD is compared, and the evaluator judges any test weakening.
    const review = await composition.review(await composition.heads())
    const changes = review.changes.filter(change => change.path !== posix.normalize(request.criteriaFile))
    const inScope = scopeMatcher(file.scope)
    const outOfScope = file.scope.length ? changes.map(change => change.path).filter(path => !inScope(path)) : []
    const weak = review.weakening
    const criteria = [...file.criteria, ...standingCriteria({ outOfScope, weak, amendments: [], acknowledge: acknowledgeRule(policy) })]
    const subject: GradingSubject = { ...file.objective ? { objective: file.objective } : {}, criteria, nonGoals: [], scope: file.scope, checks, changes, outOfScope }
    const graded = await composition.evaluate(subject)
    if ('refusal' in graded) return refusal(operation, `${graded.refusal.code}: ${graded.refusal.message}; ${graded.refusal.fix}`)
    const passed = graded.criteria.every(row => row.verdict === 'met') && checks.every(row => row.passed)
    const value = { criteria: graded.criteria, checks, outOfScope, testProtection: { testFiles: weak.patterns.source, findings: weak.findings.map(describeWeakening) }, evaluator: graded.evaluator }
    return passed ? complete(operation, value) : unsatisfied(operation, value, split(graded.criteria).others.map(row => `${row.id} ${row.verdict}: ${row.note}`)
        .concat(checks.filter(row => !row.passed).map(row => `check ${row.criterion}: ${row.outcome}`)).join('; '), split(graded.criteria).weakening)
}
