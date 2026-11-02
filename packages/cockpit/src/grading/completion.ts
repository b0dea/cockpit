import { createHash } from 'node:crypto'
import {
    isIssuedWorkOrderReviewSet, REQUIRED_GRADE_REVIEWS, type CompletionReview,
} from '../work-orders/review.js'
import {
    CRITERION_OUTCOMES, checkGradeCurrency, checkPreparedWorkOrderCurrency, isIssuedWorkOrderGrade, prepareWorkOrderVerification, verifyPreparedWorkOrder,
    type GradingDependencies, type GradingInput, type PreparedWorkOrderVerification, type WorkOrderGrade,
} from './verifier.js'

export const mechanism = {
    id: 'work-order-completion',
    module: 'packages/cockpit/src/grading/completion.ts',
    exports: ['REQUIRED_GRADE_REVIEWS', 'completeWorkOrder'],
} as const

export { REQUIRED_GRADE_REVIEWS } from '../work-orders/review.js'
export type { CompletionReview } from '../work-orders/review.js'
export interface CompletionRecord {
    readonly workOrderId: string
    readonly contractDigest: string
    readonly artifactDigest: string
    readonly gradeDigest: string
    readonly runId: string
}
export interface CompletionWriter {
    readonly writeGrade: (bytes: string) => Promise<void>
    readonly readGrade: () => Promise<string | null>
    // The adapter atomically checks the bound subject and persisted grade before
    // writing the sentinel; the enclosing lock serializes completion attempts.
    readonly compareAndWriteCompletion: (record: CompletionRecord) => Promise<boolean>
}
export interface CompletionDependencies extends GradingDependencies {
    readonly reviews: (subject: PreparedWorkOrderVerification) => Promise<readonly CompletionReview[]>
    readonly withCompletionLock: <T>(id: string, action: (writer: CompletionWriter) => Promise<T>) => Promise<T>
}
export type CompletionResult =
    | Readonly<{ completed: true; grade: WorkOrderGrade; record: CompletionRecord }>
    | Readonly<{ completed: false; reason: string; grade?: WorkOrderGrade }>

export async function completeWorkOrder(input: GradingInput, dependencies: CompletionDependencies): Promise<CompletionResult> {
    input = Object.freeze({ ...input })
    let grade: WorkOrderGrade | undefined
    try {
        return await dependencies.withCompletionLock<CompletionResult>(input.accepted.contract.frontmatter.id, async writer => {
            const subject = await prepareWorkOrderVerification(input, dependencies)
            const issuedReviews = await dependencies.reviews(subject)
            if (!isIssuedWorkOrderReviewSet(issuedReviews, subject)) {
                return { completed: false, reason: 'Current issued independent reviews are required' }
            }
            const reviews = structuredClone(issuedReviews)
            if (!Array.isArray(reviews) || reviews.length !== REQUIRED_GRADE_REVIEWS.length
                || REQUIRED_GRADE_REVIEWS.some(kind => reviews.filter(review => review?.kind === kind).length !== 1)
                || new Set(reviews.map(review => review.reviewer)).size !== reviews.length
                || reviews.some(review => review.accepted !== true || review.openFindings !== 0
                    || typeof review.reviewer !== 'string' || !review.reviewer.trim() || Buffer.byteLength(review.reviewer) > 256 || review.reviewer === input.author
                    || review.contractDigest !== subject.contractDigest || review.artifactDigest !== subject.artifactDigest
                    || !Array.isArray(review.findings) || !Array.isArray(review.dispositions)
                    || typeof review.evidence !== 'string' || !review.evidence.trim() || Buffer.byteLength(review.evidence) > 65_536)) {
                return { completed: false, reason: 'Current accepted independent reviews are required' }
            }
            const reviewCurrency = await checkPreparedWorkOrderCurrency(subject, dependencies)
            if (reviewCurrency) return { completed: false, reason: reviewCurrency }
            const verifiedGrade = await verifyPreparedWorkOrder(subject, dependencies)
            grade = verifiedGrade
            if (!isIssuedWorkOrderGrade(verifiedGrade)) {
                return { completed: false, reason: verifiedGrade.criteria[0]?.reasons[0] ?? 'Grading did not produce an issued grade', grade: verifiedGrade }
            }
            const unmet = verifiedGrade.criteria.filter(criterion => criterion.outcome !== CRITERION_OUTCOMES[0])
            if (unmet.length) {
                // A failed grade is a result the engineer acts on, so it is kept and each criterion named.
                const bytes = JSON.stringify({ grade: verifiedGrade, reviews })
                await writer.writeGrade(bytes)
                if (await writer.readGrade() !== bytes) return { completed: false, reason: 'The persisted grade does not match current grading and review evidence', grade: verifiedGrade }
                return { completed: false, grade: verifiedGrade, reason: `Grade did not pass: ${unmet.map(criterion =>
                    `${criterion.criterion} ${criterion.outcome}${criterion.reasons.length ? ` (${criterion.reasons.join('; ')})` : ''}`).join('; ')}` }
            }
            const currency = await checkGradeCurrency(verifiedGrade, dependencies)
            if (currency) return { completed: false, reason: currency, grade: verifiedGrade }
            const bytes = JSON.stringify({ grade: verifiedGrade, reviews })
            await writer.writeGrade(bytes)
            if (await writer.readGrade() !== bytes) return { completed: false, reason: 'The persisted grade does not match current grading and review evidence', grade: verifiedGrade }
            const finalCurrency = await checkGradeCurrency(verifiedGrade, dependencies)
            if (finalCurrency) return { completed: false, reason: finalCurrency, grade: verifiedGrade }
            const record = Object.freeze({ workOrderId: verifiedGrade.workOrderId, contractDigest: verifiedGrade.contractDigest, artifactDigest: verifiedGrade.artifactDigest,
                gradeDigest: createHash('sha256').update(bytes).digest('hex'), runId: verifiedGrade.runId })
            if (await writer.compareAndWriteCompletion(record) !== true) return { completed: false, reason: 'Completion write refused because the subject or persisted evidence changed', grade: verifiedGrade }
            return { completed: true, grade: verifiedGrade, record }
        })
    } catch (error) {
        return { completed: false, reason: `Completion failed: ${error instanceof Error ? error.message : String(error)}`, ...(grade === undefined ? {} : { grade }) }
    }
}
