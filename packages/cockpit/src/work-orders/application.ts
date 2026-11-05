// Owns the work-order lifecycle: draft → accepted → checked → graded → done, with blocked and stale
// derived from the record and the current file, and partial and abandoned as closures. Each command
// that passes a gate asks the autonomy policy who may pass it; a person gate returns a continuation
// the CLI completes only with the digest a person types in a terminal. It also routes the browser and
// test-gate operations that share the work composition. Decisions, grading and closure are owned by the
// application-* modules beside it, on the shared steps application-context.ts binds.
import { executeBrowserCommand, type BrowserCommandReceipt, type BrowserCommandResult } from '../browser/commands.js'
import { evaluateUiGate } from '../browser/ui-gate.js'
import { policyWeakening } from '../autonomy.js'
import { personConfirmationFix } from '../guards/answer-confirmation.js'
import { errorCause, RefusalError } from '../environment/contract.js'
import { GRADING, isGradeMode, type Decider } from '../schema.js'
import { describeWeakening, testWeakeningDigest } from '../testing/weakening.js'
import { checksBindsField, contractAmendment, workOrderDigest } from './contract.js'
import type { WorkRecord } from './store.js'
import { isWorkApplicationComposition, type WorkApplicationComposition } from './composition.js'
import { captureWorkApplicationRequest, complete, displayState, now, openQuestions, refusal, TERMINAL, unsatisfied, workContext,
    type WorkApplicationOutcome, type WorkApplicationRequest, type WorkRequest } from './application-context.js'
import { checkFacts, pendingCi, signoff, verify } from './application-closure.js'
import { decideOrder, DECISIONS_UNDECLARED, relatedDecisions, unresolvedDecisions } from './application-decisions.js'
import { acknowledgeRule, gradeCriteriaFile, gradeOrder, testRun } from './application-grading.js'

export { captureWorkApplicationRequest, type WorkApplicationOutcome, type WorkApplicationRequest } from './application-context.js'

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
        if (captured.operation === 'test-run') return await testRun(captured, composition)
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

async function work(request: WorkRequest, composition: WorkApplicationComposition): Promise<WorkApplicationOutcome> {
    const context = workContext(composition, request.operation)
    const { operation, policy, store, observe, wip, attemptCap, gated, current, runChecks } = context
    if (request.operation === 'work-status') {
        const ids = request.workOrderId ? [request.workOrderId] : [...new Set([...await composition.orderIds(), ...(await store.list()).map(row => row.id)])].sort()
        const rows = await Promise.all(ids.map(observe))
        const closed = new Set(rows.filter(row => row.record?.state === 'done').map(row => row.id))
        return complete(operation, {
            grading: policy.grading, ...composition.held.length ? { awaitingConfirmation: composition.held.map(row => ({ ...row, confirm: personConfirmationFix([row.field]) })) } : {},
            gates: policy.gates, wip: { open: await wip(), cap: composition.caps.wip },
            orders: await Promise.all(rows.map(async row => ({
                id: row.id, state: displayState(row, attemptCap),
                ...row.record?.closure ? { closedAs: row.record.closure.how, closedBy: row.record.closure.by, ...row.record.closure.how === 'ungraded' ? checkFacts(row.record) : {} } : {},
                ...row.record ? { attempts: row.record.attempts, acceptedBy: row.record.accepted.by, openQuestions: openQuestions(row.record),
                    acknowledgements: row.record.acknowledgements.map(({ by, note, findings }) => ({ by, note, findings })),
                    awaitingCi: pendingCi(row.record), ...row.record.grade ? { grade: { mode: row.record.grade.mode, passed: row.record.grade.passed,
                        criteria: row.record.grade.criteria, outOfScope: row.record.grade.outOfScope, ...row.record.grade.evaluator ? { evaluator: row.record.grade.evaluator } : {} } } : {} } : {},
                ...row.order ? { waitingOn: row.order.depends_on.filter(dependency => !closed.has(dependency)) } : {},
                ...row.record && !TERMINAL.has(row.record.state) ? { openDecisions: await unresolvedDecisions(row.record, composition) } : {},
                ...row.order && !TERMINAL.has(row.record?.state ?? 'accepted') ? await relatedDecisions(context, row.order) : {},
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
                return { record, value: complete(operation, { id: order.id, state: 'accepted', by, digest, ...by === 'ci' ? { awaitingCi: ['accept'] } : {}, ...await relatedDecisions(context, order) }) }
            }))
        }
        const record = row.record
        if (TERMINAL.has(record.state)) return refusal(operation, `${order.id} is closed (${record.state}); write a new order for further work`)
        if (row.digest === record.accepted.digest) return refusal(operation, `${order.id} is already accepted and unchanged since`)
        const { removed: weakened, review } = contractAmendment(record.accepted.order, order)
        // Removing a criterion or gate lowers the bar in every reading, so an agent never certifies it. A rewrite may
        // only clarify: where a model grades, the next grade judges it; under checks nothing could, so a person does.
        // So does the amendment after a grade that found the agent's earlier ones lowered the bar.
        const unjudgeable = policy.grading === 'checks' ? review.filter(row => checksBindsField(row.field)) : []
        const failedReview = record.amendmentsFailedReview
        const decider: Decider = policy.gates.amend === 'agent' && (weakened.length || unjudgeable.length || failedReview) ? 'person' : policy.gates.amend
        const sources = await composition.sourceDigests(order)
        const digest = workOrderDigest(order, sources, record.accepted.base)
        return gated('amend', decider, [`Amend ${order.id} (digest ${record.accepted.digest} -> ${digest})`,
            ...weakened.length ? [`This weakens the accepted contract: ${weakened.join('; ')}`] : [],
            ...failedReview ? [`A grade found the agent's earlier amendments lower the bar: ${failedReview.note}`] : [],
            ...review.map(row => `Changed ${row.field}: "${row.before}" -> "${row.after}"`), ...shownOrder], 'amend', async by => store.update(order.id, async existing => {
            if (!existing || existing.accepted.digest !== record.accepted.digest) throw new RefusalError(`${order.id} changed while this prompt was open; rerun work accept`)
            const next: WorkRecord = { ...existing, state: 'accepted', attempts: 0, checks: undefined, grade: undefined,
                ...by === 'agent' ? {} : { amendmentsFailedReview: undefined, evaluatorFailed: undefined },
                accepted: { at: now(), by, digest, order, sources, base: existing.accepted.base },
                amendments: [...existing.amendments, { at: now(), by, from: existing.accepted.digest, to: digest, weakened: [...weakened], review: [...review] }] }
            return { record: next, value: complete(operation, { id: order.id, state: 'accepted', by, digest, amended: true, weakened,
                ...by === 'agent' && review.length && GRADING[policy.grading].judged ? { judgedAtGrade: review.map(row => row.field) } : {}, ...await relatedDecisions(context, order) }) }
        }))
    }
    if (request.operation === 'work-check') {
        const { order, record } = await current(request.workOrderId)
        const results = await runChecks(order)
        if (!results.length) return refusal(operation, `${order.id} declares no check on any criterion and no gates; add a check, or close it under [work] grading = "self" or "off"`)
        const passed = results.every(row => row.passed)
        await store.update(order.id, async existing => {
            if (!existing || existing.accepted.digest !== record.accepted.digest) throw new RefusalError(`${order.id} changed while its checks ran; rerun work check`)
            return { record: { ...existing, state: passed ? 'checked' : 'accepted', attempts: existing.attempts + (passed || !isGradeMode(policy.grading) ? 0 : 1), grade: undefined,
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
    if (request.operation === 'work-decide') return decideOrder(request, context)
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
    if (request.operation === 'work-grade') return gradeOrder(request, context)
    if (request.operation === 'work-acknowledge') {
        const { order, record } = await current(request.workOrderId)
        const weak = await composition.testWeakening(record.accepted.base)
        if (!weak.findings.length) return refusal(operation, `${order.id} weakens no tests since its base, so there is nothing to acknowledge`)
        const digest = testWeakeningDigest(weak.findings)
        const rule = acknowledgeRule(policy)
        if (record.acknowledgements.some(row => row.digest === digest && rule.counts(row))) return refusal(operation, `this weakening of ${order.id} is already acknowledged${isGradeMode(policy.grading) ? '; run work grade' : ''}`)
        const rows = weak.findings.map(describeWeakening)
        return gated('acknowledge', rule.decider, [`Acknowledge that ${order.id} weakens tests since its base (test files from ${weak.patterns.source}):`,
            ...rows.map(row => `  ${row}`), 'Reason given:', `  ${request.note}`], 'acknowledge', async by => store.update(order.id, async existing => {
            if (!existing || existing.accepted.digest !== record.accepted.digest) throw new RefusalError(`${order.id} changed while this prompt was open; rerun work acknowledge`)
            if (testWeakeningDigest((await composition.testWeakening(existing.accepted.base)).findings) !== digest) {
                throw new RefusalError(`the test changes of ${order.id} changed while this prompt was open; rerun work acknowledge`)
            }
            return { record: { ...existing, acknowledgements: [...existing.acknowledgements, { at: now(), by, digest, findings: rows, note: request.note }] },
                value: complete(operation, { id: order.id, acknowledged: rows, by, digest }) }
        }))
    }
    if (request.operation === 'work-signoff') return signoff(request, context)
    if (request.operation === 'work-recover') {
        // A pid probe sees only this machine's processes, so the command looks where it cannot first: the
        // lock's host and the containers cockpit labels. Applied, it removes nothing it has not shown gone.
        const recovered = await store.recover(request.workOrderId, request.apply, composition.containers)
        if (!request.apply || recovered.lock === 'none' || recovered.lock === 'removed') return complete(operation, recovered)
        return refusal(operation, `the lock on ${request.workOrderId} was left in place: its holder ${recovered.lock === 'live' ? 'is still running' : 'cannot be shown gone'} `
            + `(${recovered.checked?.join('; ')}); wait for it to finish, or stop it on the host that holds it, then rerun work recover --apply`)
    }
    if (request.operation === 'work-verify') return verify(context)
    return gradeCriteriaFile(request, context)
}
