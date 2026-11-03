import { createHash, randomUUID } from 'node:crypto'
import { snapshotJson, RefusalError, errorCause } from '../environment/contract.js'
import {
    checkPreparedWorkOrderCurrency, normalizeVerificationObservation, verificationObservationPassed, type PreparedWorkOrderVerification, type VerificationObservation, type WorkOrderSubjectDependencies,
} from '../grading/verifier.js'

export const mechanism = {
    id: 'work-order-review',
    module: 'packages/cockpit/src/work-orders/review.ts',
    exports: ['REQUIRED_GRADE_REVIEWS', 'isIssuedWorkOrderReviewSet', 'planWorkOrderReviews', 'reviewWorkOrderWave'],
} as const

export const REQUIRED_GRADE_REVIEWS = Object.freeze(['simplification', 'code-spec', 'security'] as const)
export interface CompletionReview {
    readonly kind: typeof REQUIRED_GRADE_REVIEWS[number]
    readonly reviewer: string
    readonly contractDigest: string
    readonly artifactDigest: string
    readonly accepted: boolean
    readonly openFindings: number
    readonly findings: readonly WorkOrderReviewFinding[]
    readonly dispositions: readonly WorkOrderReviewDisposition[]
    readonly reruns: readonly Readonly<{ argv: readonly string[]; result: VerificationObservation; digest: string }>[]
    readonly evidence: string
}
export type WorkOrderReviewKind = typeof REQUIRED_GRADE_REVIEWS[number]
export interface WorkOrderReviewFinding {
    readonly id: string
    readonly severity: 'blocking' | 'advisory'
    readonly summary: string
    readonly affectedVerification: readonly (readonly string[])[]
}
export interface WorkOrderReviewDisposition {
    readonly findingId: string
    readonly outcome: 'fixed' | 'accepted-risk'
    readonly reason: string
}
export interface WorkOrderReviewerContext {
    readonly runId: string
    readonly kind: WorkOrderReviewKind
    readonly subject: PreparedWorkOrderVerification
    readonly changedPaths: readonly string[]
}
export type WorkOrderReviewerResponse =
    | Readonly<{
        kind: 'review'
        runId: string
        reviewer: string
        contractDigest: string
        artifactDigest: string
        findings: readonly WorkOrderReviewFinding[]
        dispositions: readonly WorkOrderReviewDisposition[]
        evidence: string
    }>
    | Readonly<{ kind: 'error' | 'abstained' | 'never-ran'; reason: string }>
export interface WorkOrderReviewInput {
    readonly subject: PreparedWorkOrderVerification
    readonly author: string
    readonly changedPaths: readonly string[]
}
export interface WorkOrderReviewStore {
    readonly write: (bytes: string) => Promise<void>
    readonly read: () => Promise<string | null>
}
export interface WorkOrderReviewDependencies extends WorkOrderSubjectDependencies {
    readonly review: (context: WorkOrderReviewerContext) => Promise<WorkOrderReviewerResponse>
    readonly rerun: (argv: readonly string[]) => Promise<VerificationObservation>
    readonly store: WorkOrderReviewStore
}
export type WorkOrderReviewResult =
    | Readonly<{ kind: 'complete'; reviews: readonly CompletionReview[]; bytes: string }>
    | Readonly<{ kind: 'refusal'; reason: string; reviews?: readonly CompletionReview[]; bytes?: string }>

const issuedReviewSets = new WeakMap<object, PreparedWorkOrderVerification>()
const MAX_REVIEW_BYTES = 65_536
// Retained rerun output shares the generation owner's private-file ceiling.
const MAX_REVIEW_RECORD_BYTES = 8 * 1_048_576
const MAX_FINDINGS = 64

function boundedText(value: unknown, maximum = 4_096): value is string {
    return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= maximum
        && !/[\x00-\x1f\x7f]/.test(value)
}

function sameCommand(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
}

function immutable<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) immutable(child)
        Object.freeze(value)
    }
    return value
}

function validateReview(
    response: WorkOrderReviewerResponse,
    context: WorkOrderReviewerContext,
    author: string,
): Extract<WorkOrderReviewerResponse, { kind: 'review' }> | undefined {
    if (response?.kind !== 'review' || response.runId !== context.runId || response.contractDigest !== context.subject.contractDigest
        || response.artifactDigest !== context.subject.artifactDigest || !boundedText(response.reviewer, 256)
        || response.reviewer === author || !boundedText(response.evidence, MAX_REVIEW_BYTES)
        || !Array.isArray(response.findings) || response.findings.length > MAX_FINDINGS
        || !Array.isArray(response.dispositions) || response.dispositions.length > MAX_FINDINGS) return undefined
    const ids = new Set<string>()
    for (const finding of response.findings) {
        if (!boundedText(finding?.id, 256) || ids.has(finding.id)
            || !['blocking', 'advisory'].includes(finding.severity) || !boundedText(finding.summary)
            || !Array.isArray(finding.affectedVerification) || finding.affectedVerification.length === 0
            || finding.affectedVerification.some((command: readonly string[]) => !context.subject.verification.some(record => sameCommand(record.argv, command)))) return undefined
        ids.add(finding.id)
    }
    const dispositionIds = new Set<string>()
    for (const disposition of response.dispositions) {
        if (!ids.has(disposition?.findingId) || dispositionIds.has(disposition.findingId)
            || !['fixed', 'accepted-risk'].includes(disposition.outcome) || !boundedText(disposition.reason)) return undefined
        dispositionIds.add(disposition.findingId)
    }
    return response
}

function reviewEvidenceBytes(subject: PreparedWorkOrderVerification, reviews: readonly CompletionReview[]): string {
    return JSON.stringify({
        contractDigest: subject.contractDigest, artifactDigest: subject.artifactDigest,
        reviews, digest: createHash('sha256').update(JSON.stringify(reviews)).digest('hex'),
    })
}

export function planWorkOrderReviews(input: Readonly<{ kind: 'fix' | 'work-order' }>) {
    if (input.kind === 'fix') return Object.freeze({ kind: 'none' as const, reason: 'Fix-lane work remains proportional and creates no review artifact' })
    return Object.freeze({ kind: 'required' as const, reviews: REQUIRED_GRADE_REVIEWS })
}

export function isIssuedWorkOrderReviewSet(value: readonly CompletionReview[], subject?: PreparedWorkOrderVerification): boolean {
    const issued = issuedReviewSets.get(value)
    return issued !== undefined && (subject === undefined || issued === subject)
}

export async function reviewWorkOrderWave(input: WorkOrderReviewInput, dependencies: WorkOrderReviewDependencies): Promise<WorkOrderReviewResult> {
    const changedPaths = Object.freeze([...input.changedPaths])
    if (!boundedText(input.author, 256) || input.author !== input.subject.author || changedPaths.length === 0 || changedPaths.length > 1_024
        || new Set(changedPaths).size !== changedPaths.length || changedPaths.some(path => !boundedText(path) || path.startsWith('/')
            || path.split('/').some(part => !part || part === '.' || part === '..'))) {
        return { kind: 'refusal', reason: 'Review requires a bounded author and unique relative changed paths' }
    }
    const reviews: CompletionReview[] = []
    let persistedReviews: readonly CompletionReview[] = []
    let persistedBytes: string | undefined
    const refusal = (reason: string): WorkOrderReviewResult => persistedReviews.length > 0 && persistedBytes !== undefined
        ? Object.freeze({ kind: 'refusal' as const, reason, reviews: persistedReviews, bytes: persistedBytes })
        : Object.freeze({ kind: 'refusal' as const, reason })
    const persist = async () => {
        const bytes = reviewEvidenceBytes(input.subject, reviews)
        if (Buffer.byteLength(bytes) > MAX_REVIEW_RECORD_BYTES) throw new RefusalError('Review evidence exceeds its bounded persistence limit')
        await dependencies.store.write(bytes)
        if (await dependencies.store.read() !== bytes) throw new RefusalError('Persisted reviews differ from the current review evidence')
        persistedReviews = Object.freeze([...reviews])
        persistedBytes = bytes
    }
    try {
        const before = await checkPreparedWorkOrderCurrency(input.subject, dependencies)
        if (before) return refusal(before)
        const reviewers = new Set<string>()
        for (const kind of REQUIRED_GRADE_REVIEWS) {
            const context = Object.freeze({ runId: randomUUID(), kind, subject: input.subject, changedPaths })
            const captured = snapshotJson(await dependencies.review(context))
            const response = validateReview(captured as unknown as WorkOrderReviewerResponse, context, input.author)
            if (!response) {
                // An evaluator that could not run says why; that cause is what the person has to fix.
                const failed = captured as { kind?: unknown; reason?: unknown } | undefined
                return refusal(failed && ['error', 'abstained', 'never-ran'].includes(failed.kind as string) && typeof failed.reason === 'string'
                    ? `Independent ${kind} review ${failed.kind === 'never-ran' ? 'did not run' : failed.kind === 'abstained' ? 'abstained' : 'failed'}: ${failed.reason}`
                    : `Independent ${kind} review returned a response that does not match the current subject and review schema`)
            }
            if (reviewers.has(response.reviewer)) return refusal(`Independent ${kind} review came from a reviewer who already reviewed this subject`)
            reviewers.add(response.reviewer)
            const commands: readonly (readonly string[])[] = response.findings
                .filter(finding => response.dispositions.some(row => row.findingId === finding.id && row.outcome === 'fixed'))
                .flatMap(finding => finding.affectedVerification)
            const unique: (readonly string[])[] = []
            for (const command of commands) if (!unique.some(existing => sameCommand(existing, command))) unique.push(command)
            let failedCommand: readonly string[] | undefined
            let rerunError: string | undefined
            const reruns: CompletionReview['reruns'][number][] = []
            for (const command of unique) {
                let result: VerificationObservation
                try { result = normalizeVerificationObservation(await dependencies.rerun(command)) }
                catch (error) {
                    result = normalizeVerificationObservation({ kind: 'error',
                        reason: `Affected proof execution failed: ${errorCause(error)}` })
                }
                const argv = Object.freeze([...command])
                reruns.push(immutable({ argv, result, digest: createHash('sha256').update(JSON.stringify({
                    workOrderId: input.subject.workOrderId, contractDigest: input.subject.contractDigest,
                    artifactDigest: input.subject.artifactDigest, argv, result,
                })).digest('hex') }))
                if (!verificationObservationPassed(result)) {
                    failedCommand = command
                    rerunError = result.kind !== 'executed' ? result.reason
                        : `${JSON.stringify(argv)} ${result.exitCode !== 0 ? `exited ${result.exitCode}` : 'printed nothing'}`
                    break
                }
            }
            const open = new Set(response.findings.filter(finding => {
                const disposition = response.dispositions.find(row => row.findingId === finding.id)
                return disposition === undefined || finding.severity === 'blocking' && disposition.outcome !== 'fixed'
                    || failedCommand !== undefined && disposition.outcome === 'fixed'
                        && finding.affectedVerification.some(command => sameCommand(command, failedCommand!))
            }).map(finding => finding.id))
            reviews.push(Object.freeze({
                kind, reviewer: response.reviewer, accepted: open.size === 0, openFindings: open.size,
                contractDigest: input.subject.contractDigest, artifactDigest: input.subject.artifactDigest,
                findings: immutable(structuredClone(response.findings)),
                dispositions: immutable(structuredClone(response.dispositions)),
                reruns: Object.freeze(reruns), evidence: response.evidence,
            }))
            const current = await checkPreparedWorkOrderCurrency(input.subject, dependencies)
            if (current) return refusal(current)
            await persist()
            if (failedCommand) return refusal(`Affected proof failed after ${kind} review disposition${rerunError ? `: ${rerunError}` : ''}`)
            if (open.size > 0) return refusal(`Current independent ${kind} review has open findings: ${[...open].join(', ')}`)
        }
        const after = await checkPreparedWorkOrderCurrency(input.subject, dependencies)
        if (after) return refusal(after)
        const result = persistedReviews
        issuedReviewSets.set(result, input.subject)
        return Object.freeze({ kind: 'complete', reviews: result, bytes: persistedBytes! })
    } catch (error) {
        return refusal(`Review failed: ${errorCause(error)}`)
    }
}
