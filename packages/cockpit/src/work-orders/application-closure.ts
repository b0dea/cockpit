// How an order closes: `work signoff` closes it as done, partial or abandoned, and `work verify`, the CI
// job, checks every closure and confirms the steps that awaited CI.
import { runningInCi } from '../autonomy.js'
import { RefusalError } from '../environment/contract.js'
import { GRADING, isGradeMode } from '../schema.js'
import type { WorkRecord } from './store.js'
import { checkIds, complete, now, refusal, TERMINAL, unsatisfied, type WorkApplicationOutcome, type WorkContext, type WorkRequest } from './application-context.js'
import { decisions, recordProblem, unresolvedDecisions } from './application-decisions.js'

export const pendingCi = (record: WorkRecord) => [
    ...record.acknowledgements.filter(row => row.by === 'ci').map(() => 'acknowledge'),
    ...record.accepted.by === 'ci' ? ['accept'] : [], ...record.amendments.filter(row => row.by === 'ci').map(() => 'amend'),
    ...record.notes.filter(row => row.kind === 'answer' && row.by === 'ci').map(() => 'answer'), ...record.closure?.by === 'ci' ? ['signoff'] : [],
]

// Off means nothing blocks on grading, not that facts are hidden: what the checks last showed stays in view.
export function checkFacts(record: WorkRecord) {
    const results = record.checks?.digest === record.accepted.digest ? record.checks.results : []
    const declared = checkIds(record.accepted.order)
    return { checksFailed: results.filter(row => !row.passed).map(row => `${row.criterion}: ${row.outcome}`),
        checksNotRun: declared.filter(id => !results.some(row => row.criterion === id)) }
}

export async function signoff(request: Extract<WorkRequest, { operation: 'work-signoff' }>, context: WorkContext): Promise<WorkApplicationOutcome> {
    const { composition, operation, policy, store, current, gated } = context
    const record = await store.read(request.workOrderId)
    if (!record) return refusal(operation, `${request.workOrderId} is not accepted`)
    if (TERMINAL.has(record.state)) return refusal(operation, `${request.workOrderId} is already closed (${record.state})`)
    let how: NonNullable<WorkRecord['closure']>['how']
    if (request.close === 'done') {
        const { order } = await current(request.workOrderId)
        const grade = record.state === 'graded' && record.grade?.passed === true && record.grade.digest === record.accepted.digest ? record.grade : undefined
        if (!grade && isGradeMode(policy.grading)) {
            return refusal(operation, `${order.id} is ${record.state}, not graded; run npx --no cockpit work grade --config <your cockpit.toml> --work-order ${order.id}`)
        }
        const open = await Promise.all(order.depends_on.map(async dependency => (await store.read(dependency))?.state === 'done' ? undefined : dependency))
        if (open.some(Boolean)) return refusal(operation, `${order.id} depends on ${open.filter(Boolean).join(', ')}, which ${open.filter(Boolean).length === 1 ? 'is' : 'are'} not done`)
        how = GRADING[grade?.mode ?? policy.grading].closure
    } else {
        if (!request.note) return refusal(operation, `closing ${request.workOrderId} as ${request.close} needs --note saying what was and was not done`)
        how = request.close
    }
    // Every closure, partial and abandoned too, settles the order's decisions: work that stops still made them.
    const open = await unresolvedDecisions(record, composition)
    if (open.length) return refusal(operation, `${request.workOrderId} cannot close while ${open.join('; ')}`)
    // A grade found the agent's own amendments lowered the bar; a re-grade must not let it close the order unseen.
    const failedReview = record.amendmentsFailedReview
    const decider = failedReview && policy.gates.signoff === 'agent' ? 'person' : policy.gates.signoff
    const facts = how === 'ungraded' ? checkFacts(record) : undefined
    return gated('signoff', decider, [`Close ${request.workOrderId} as ${request.close} (${how})`, ...request.note ? [`Note: ${request.note}`] : [],
        ...failedReview ? [`A grade found the agent's amendments lower the bar: ${failedReview.note}`] : [],
        ...facts?.checksFailed.map(row => `Check failed: ${row}`) ?? [], ...facts?.checksNotRun.map(row => `Check not run: ${row}`) ?? [],
        ...record.grade ? record.grade.criteria.map(row => `${row.id}: ${row.verdict} — ${row.note}`) : [],
        ...decisions(record).map(row => `Decision ${row.decision} (${row.title}): ${row.resolution!.record ? `recorded in ${row.resolution!.record}` : `no lasting decision — ${row.resolution!.text}`}`)],
    'signoff', async by => store.update(request.workOrderId, async existing => {
        if (!existing || existing.state !== record.state || existing.accepted.digest !== record.accepted.digest || existing.notes.length !== record.notes.length) {
            throw new RefusalError(`${request.workOrderId} changed while this prompt was open`)
        }
        const state: WorkRecord['state'] = request.close
        return { record: { ...existing, state, closure: { at: now(), by, how, ...request.note ? { note: request.note } : {} } },
            value: complete(operation, { id: request.workOrderId, state, closedAs: how, by, ...facts }) }
    }))
}

export async function verify(context: WorkContext): Promise<WorkApplicationOutcome> {
    const { composition, operation, store, observe } = context
    const problems: string[] = []
    const awaiting: string[] = []
    for (const record of await store.list()) {
        const row = await observe(record.id)
        if (!TERMINAL.has(record.state) && row.digest !== record.accepted.digest) problems.push(`${record.id} changed since it was accepted; accept the change or revert it`)
        // An ungraded closure has no grade to check by design; everything else that is done must have passed one.
        if (record.state === 'done' && (!record.closure || record.closure.how !== 'ungraded' && (!record.grade?.passed || record.grade.digest !== record.accepted.digest))) problems.push(`${record.id} is done without a passing grade of its accepted contract`)
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
