// Owns what the independent grader is asked and how its answer is read: the request names each
// criterion with the result of the check cockpit ran for it and the change since the order's base,
// and an answer is kept only where its evidence is real. The evaluator process itself runs behind
// grading/evaluate.ts; this module never starts one.
import type { WorkOrderCriterion } from '../work-orders/contract.js'
import type { CheckResult } from '../work-orders/store.js'

export interface ChangedFile { readonly path: string; readonly status: string; readonly diff: string }
export interface GradingSubject {
    readonly objective?: string
    readonly criteria: readonly WorkOrderCriterion[]
    readonly nonGoals: readonly string[]
    readonly scope: readonly string[]
    readonly checks: readonly CheckResult[]
    readonly changes: readonly ChangedFile[]
    readonly outOfScope: readonly string[]
}
export type Verdict = Readonly<{ id: string; verdict: 'met' | 'unmet' | 'unclear'; note: string }>

export function gradingDocument(instruction: string, repositoryRoot: string, subject: GradingSubject): Readonly<Record<string, unknown>> {
    return Object.freeze({
        protocol: 'cockpit-independent-grade/v1', instruction, repositoryRoot,
        // No evaluator command line wires a browser, so a criterion about what a person sees cannot be observed.
        browser: 'unavailable',
        order: { objective: subject.objective ?? null, criteria: subject.criteria.map(row => ({ id: row.id, text: row.text, check: row.check ?? null })),
            nonGoals: subject.nonGoals, scope: subject.scope },
        checks: subject.checks, changes: subject.changes, outOfScope: subject.outOfScope,
    })
}

export function gradingSchema(criteria: readonly WorkOrderCriterion[]): Readonly<Record<string, unknown>> {
    const string = { type: 'string' }
    return Object.freeze({ type: 'object', additionalProperties: false, required: ['criteria'], properties: {
        criteria: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'verdict', 'note', 'evidence'], properties: {
            id: { type: 'string', enum: criteria.map(row => row.id) },
            verdict: { type: 'string', enum: ['met', 'unmet', 'unclear'] },
            note: string,
            evidence: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['source', 'quote'], properties: { source: string, quote: string } } },
        } } },
    } })
}

// A quote is evidence only when it is specific: at least this long, unless it is the whole text, and
// found exactly once in what it cites. A short or repeated quote matches almost anything, and would
// let a grader claim support it never observed.
const MIN_QUOTE_LENGTH = 8

function quoted(textCited: string, quote: string): boolean {
    const trimmed = quote.trim()
    if (!trimmed || trimmed.length < MIN_QUOTE_LENGTH && trimmed !== textCited.trim()) return false
    const first = textCited.indexOf(quote)
    return first >= 0 && textCited.indexOf(quote, first + 1) < 0
}

/**
 * The grade an answer supports. Each criterion must be answered once; a `met` verdict stands only
 * when every quote it cites is found in the cited change (`<path>`) or check output (`check:<id>`),
 * and otherwise reads as unclear with the reason.
 */
export function readGradingAnswer(answer: Readonly<Record<string, unknown>>, subject: GradingSubject): Readonly<{ criteria: readonly Verdict[] }> | Readonly<{ problem: string }> {
    const rows = answer.criteria as readonly { id: string; verdict: Verdict['verdict']; note: string; evidence: readonly { source: string; quote: string }[] }[]
    const ids = rows.map(row => row.id)
    if (new Set(ids).size !== ids.length || subject.criteria.some(row => !ids.includes(row.id))) {
        return { problem: 'the grader did not answer each criterion exactly once' }
    }
    const cited = (source: string): string | undefined => source.startsWith('check:')
        ? subject.checks.find(row => row.criterion === source.slice('check:'.length))?.output
        : subject.changes.find(row => row.path === source)?.diff
    return { criteria: subject.criteria.map(criterion => {
        const row = rows.find(candidate => candidate.id === criterion.id)!
        if (row.verdict !== 'met') return Object.freeze({ id: row.id, verdict: row.verdict, note: row.note })
        const unsupported = row.evidence.length === 0 ? 'cites no evidence'
            : row.evidence.find(item => { const textCited = cited(item.source); return textCited === undefined || !quoted(textCited, item.quote) })
        return unsupported === undefined ? Object.freeze({ id: row.id, verdict: 'met' as const, note: row.note })
            : Object.freeze({ id: row.id, verdict: 'unclear' as const, note: `the grader said met but ${typeof unsupported === 'string' ? unsupported
                : `its quote from ${unsupported.source} is not found exactly once there`}: ${row.note}` })
    }) }
}
