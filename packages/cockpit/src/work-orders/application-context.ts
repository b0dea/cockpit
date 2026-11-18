// What every work command shares: the request it takes, the outcome it returns, the state it reads an
// order in, and the steps several commands take (observing an order, passing a gate, running its
// checks), bound to one composition.
import { z } from 'zod'

import { RefusalError } from '../environment/contract.js'
import type { Approval } from '../operator-confirmation.js'
import { REPOSITORY_FILE } from '../repository-path.js'
import { GRADING } from '../schema.js'
import { WORK_ORDER_ID, workOrderDigest, type Decider, type WorkOrder } from './contract.js'
import type { CheckResult, WorkRecord, WorkStore } from './store.js'
import type { WorkApplicationComposition } from './composition.js'

const id = z.string().regex(WORK_ORDER_ID)
const note = z.string().trim().min(1).max(4_096).regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/)
const docsReference = z.string().max(1_024).regex(REPOSITORY_FILE)
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
    z.object({ operation: z.literal('work-grade'), workOrderId: id, verdict: z.enum(['met', 'unmet']).optional(), note: note.optional(), fromSubagent: z.literal(true).optional() }).strict(),
    z.object({ operation: z.literal('work-signoff'), workOrderId: id, close: z.enum(['done', 'partial', 'abandoned']), note: note.optional() }).strict(),
    z.object({ operation: z.literal('work-acknowledge'), workOrderId: id, note }).strict(),
    z.object({ operation: z.literal('work-retry'), workOrderId: id, note }).strict(),
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
export type Operation = WorkApplicationRequest['operation']

export function captureWorkApplicationRequest(value: unknown): WorkApplicationRequest | undefined {
    const parsed = Request.safeParse(value)
    return parsed.success ? parsed.data : undefined
}

// What a person reads before approving a step, and what their yes applies.
interface WorkApplicationContinuation { readonly approval: Approval; readonly approve: () => Promise<WorkApplicationOutcome> }
export type WorkApplicationOutcome =
    | Readonly<{ kind: 'complete'; operation: Operation; value: unknown }>
    | Readonly<{ kind: 'human-needed'; operation: Operation; continuation: WorkApplicationContinuation }>
    | Readonly<{ kind: 'refusal'; operation: Operation | 'invalid'; reason: string }>
    // The operation ran and its result does not meet the bar (a gate short of PASS, a failed check, an
    // unmet criterion); the result is the evidence to act on.
    // `weakening` is the part of the failure that is test weakening, which has its own diagnostic and fix.
    | Readonly<{ kind: 'unsatisfied'; operation: Operation; value: unknown; reason: string; weakening?: string }>

export const refusal = (operation: Operation | 'invalid', reason: string): WorkApplicationOutcome => ({ kind: 'refusal', operation, reason })
export const complete = (operation: Operation, value: unknown): WorkApplicationOutcome => ({ kind: 'complete', operation, value })
export const unsatisfied = (operation: Operation, value: unknown, reason: string, weakening?: string): WorkApplicationOutcome =>
    ({ kind: 'unsatisfied', operation, value, reason, ...weakening ? { weakening } : {} })
export const now = () => new Date().toISOString()
export const TERMINAL = new Set<WorkRecord['state']>(['done', 'partial', 'abandoned'])

// The state a person or agent reads: the record's, unless the file changed since acceptance (stale),
// an open question or the attempt cap holds it (blocked), or no acceptance exists yet (draft).
export type Observed = Readonly<{ id: string; order?: WorkOrder; problems: readonly string[]; record?: WorkRecord; digest?: string }>
export function displayState(row: Observed, attemptCap: number): string {
    if (!row.record) return row.order ? 'draft' : 'invalid'
    if (TERMINAL.has(row.record.state)) return row.record.state
    if (!row.order || row.digest !== row.record.accepted.digest) return 'stale'
    if (openQuestions(row.record).length || row.record.attempts >= attemptCap) return 'blocked'
    return row.record.state
}
export function openQuestions(record: WorkRecord): readonly number[] {
    return record.notes.flatMap((row, index) => row.kind === 'question' && !record.notes.some(answer => answer.answers === index + 1) ? [index + 1] : [])
}
// The id each check an order declares is recorded under: its criterion's, or its gate's with a prefix.
const gateCheckId = (gate: string) => `gate:${gate}`
export type WorkRequest = Exclude<WorkApplicationRequest, { operation: 'test-run' | `browser-${string}` }>

export interface WorkContext {
    readonly composition: WorkApplicationComposition
    readonly operation: WorkRequest['operation']
    readonly policy: WorkApplicationComposition['policy']
    readonly store: WorkStore
    readonly observe: (orderId: string) => Promise<Observed>
    /** How many accepted orders are not closed. */
    readonly wip: () => Promise<number>
    /** Failed checks and grades before an order reads as blocked. */
    readonly attemptCap: number
    /** The records under [docs] decisions, read once per command. */
    readonly decisionRecords: () => Promise<ReadonlyMap<string, string>>
    /** What clears an order at the attempt cap. */
    readonly capRemedy: (orderId: string) => string
    /** Applies a step the agent may take, or hands a person's step to the CLI to ask them. */
    readonly gated: (decider: Decider, approval: Approval, apply: (by: Decider) => Promise<WorkApplicationOutcome>) => Promise<WorkApplicationOutcome>
    /** The order and its record, refused unless it is accepted, open, unchanged and not blocked. */
    readonly current: (orderId: string) => Promise<Readonly<{ row: Observed; record: WorkRecord; order: WorkOrder }>>
    readonly runChecks: (order: Pick<WorkOrder, 'criteria' | 'gates'>) => Promise<readonly CheckResult[]>
}

export function workContext(composition: WorkApplicationComposition, operation: WorkRequest['operation']): WorkContext {
    const { policy, store } = composition
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
    // The cap counts failed checks and grades. Off counts none and lifts the cap, so an order an earlier mode capped can still close.
    // Only a judged grade spends attempts, so a mode where nothing judges has no cap.
    const attemptCap = GRADING[policy.grading].judged ? composition.caps.attempts : Infinity
    const wip = async () => (await store.list()).filter(record => !TERMINAL.has(record.state)).length
    let records: Promise<ReadonlyMap<string, string>> | undefined
    const decisionRecords = () => records ??= composition.decisionRecords()

    // Who passed a step: the agent, or a person who read it, where the step would otherwise let the
    // agent lower the bar its own work is held to.
    const gated = async (decider: Decider, approval: Approval, apply: (by: Decider) => Promise<WorkApplicationOutcome>): Promise<WorkApplicationOutcome> => {
        if (decider === 'agent') return apply('agent')
        let used = false
        return { kind: 'human-needed', operation, continuation: { approval, approve: async () => {
            if (used) return refusal(operation, `this step was already answered; rerun work ${operation.slice('work-'.length)}`)
            used = true
            return apply('person')
        } } }
    }
    // Fresh attempts are a person's: an amendment the agent accepts keeps the count, or the cap would not
    // stop an agent retrying its own failed work.
    const capRemedy = (orderId: string) => [
        `record the root cause with work note, then close it with ./node_modules/@b00dea/cockpit/bin/cockpit.mjs work signoff --config <your cockpit.toml> --work-order ${orderId} --partial|--abandon --note <why>`,
        `ask a person for fresh attempts: run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs work retry --config <your cockpit.toml> --work-order ${orderId} --note <the root cause>, then they run npx --no cockpit approve in <the cockpit root>, from a terminal outside the agent`].join(', or ')
    const current = async (orderId: string): Promise<Readonly<{ row: Observed; record: WorkRecord; order: WorkOrder }>> => {
        const row = await observe(orderId)
        if (!row.record) throw new RefusalError(`${orderId} is not accepted yet; run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs work accept --config <your cockpit.toml> --work-order ${orderId}`)
        const state = displayState(row, attemptCap)
        if (TERMINAL.has(row.record.state)) throw new RefusalError(`${orderId} is closed (${row.record.state})`)
        if (state === 'stale') throw new RefusalError(`${orderId} changed since it was accepted${row.problems.length ? ` and does not parse: ${row.problems.join('; ')}` : ''}; `
            + `run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs work accept --config <your cockpit.toml> --work-order ${orderId} to accept the change`)
        if (state === 'blocked') throw new RefusalError(openQuestions(row.record).length
            ? `${orderId} has open question ${openQuestions(row.record).join(', ')}; it is answered with work answer`
            : `${orderId} reached the attempt cap (${composition.caps.attempts}); ${capRemedy(orderId)}`)
        return { row, record: row.record, order: row.order! }
    }
    const runChecks = async (order: Pick<WorkOrder, 'criteria' | 'gates'>): Promise<readonly CheckResult[]> => {
        const results: CheckResult[] = []
        // Checks share the product's state, so they run in the order the contract lists them.
        for (const criterion of order.criteria) if (criterion.check) results.push(await composition.runCheck(criterion.id, criterion.check))
        for (const gate of order.gates) results.push(await composition.runCheck(gateCheckId(gate), { gate }))
        return results
    }
    return { composition, operation, policy, store, observe, wip, attemptCap, decisionRecords, capRemedy, gated, current, runChecks }
}
