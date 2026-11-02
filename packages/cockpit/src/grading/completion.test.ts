import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { parseWorkOrder, type ParsedWorkOrder } from '../work-orders/contract.js'
import { workOrderFixture } from '../test-support/work-order.js'
import { acceptWorkOrder, beginWorkOrderAcceptance, intakeWorkOrder, routeWorkOrder, validateWorkOrderPolicy } from '../work-orders/intake.js'
import { reviewWorkOrderWave, type WorkOrderReviewDependencies } from '../work-orders/review.js'
import { completeWorkOrder, type CompletionDependencies, type CompletionRecord, type CompletionReview } from './completion.js'
import { checkGradeCurrency, CRITERION_OUTCOMES, isIssuedWorkOrderGrade, verifyWorkOrder, type CriterionAssessment, type GraderContext, type GraderResponse, type VerificationObservation } from './verifier.js'

function harness() {
    const parsed = parseWorkOrder(Buffer.from(workOrderFixture().replaceAll('[ ]', '[x]')))
    if (!parsed.ok) throw new Error('Invalid synthetic contract')
    const policy = validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1 })
    if (policy.kind !== 'policy') throw new Error(policy.message)
    const draft = intakeWorkOrder({ contract: parsed.value, route: routeWorkOrder({ certification: true }, { policy: policy.policy, orders: [] }),
        sourceAudit: { sources: parsed.value.sources, gaps: [] }, installedSkills: [] })
    if (draft.kind !== 'draft') throw new Error(draft.message)
    const now = Date.parse('2026-01-03T00:00:00Z')
    const request = beginWorkOrderAcceptance(draft, now)
    if (request.kind !== 'human_needed') throw new Error(request.message)
    const accepted = acceptWorkOrder(request.continuation, draft, { now, actor: 'fixture-operator', answer: `accept ${request.digest}` })
    if (accepted.kind !== 'accepted') throw new Error(accepted.message)
    const input = { accepted, author: 'fixture-engineer', grader: 'fixture-grader' }
    const artifacts = new Map(parsed.value.authority.map(path => [path, "export function refresh() { return 'fresh' }\n// refresh is called here\n"]))
    let current: ParsedWorkOrder = parsed.value
    let storedGrade: string | null = null
    let sentinel: CompletionRecord | undefined
    let assessment: (claims: CriterionAssessment[], context: GraderContext) => GraderResponse = (criteria, context) => ({
        kind: 'assessment', runId: context.runId, grader: input.grader, integrity: 'clean', criteria,
    })
    const writes: string[] = []
    const calls: string[][] = []
    const order: string[] = []
    let storedReviews: string | null = null
    let run: (argv: readonly string[]) => Promise<VerificationObservation> = async argv => ({ kind: 'executed', exitCode: 0, stdout: `${argv.at(-1)}: fresh value observed`, stderr: '', truncated: false })
    const deps: { -readonly [K in keyof CompletionDependencies]: CompletionDependencies[K] } = {
        readWorkOrder: async () => current,
        readArtifact: async path => {
            const body = artifacts.get(path)
            if (body === undefined) throw new Error(`Missing artifact ${path}`)
            return Buffer.from(body)
        },
        runVerification: async argv => { calls.push([...argv]); return run(argv) },
        grade: async context => {
            order.push('grade')
            const artifact = context.artifacts[0]
            const quote = artifact.text.split('\n')[0]
            const claims: CriterionAssessment[] = context.criteria.map(({ criterion, digest }) => ({
                criterion: criterion.id, criterionDigest: digest, outcome: CRITERION_OUTCOMES[0],
                verificationDigests: context.verification.filter(record => record.criterion === criterion.id).map(record => record.digest),
                verificationEvidence: context.verification.filter(record => record.criterion === criterion.id).map((record): CriterionAssessment['verificationEvidence'][number] => ({ digest: record.digest,
                    stream: 'stdout', start: 0, end: record.result.kind === 'executed' ? record.result.stdout.length : 0,
                    quote: record.result.kind === 'executed' ? record.result.stdout : '' })),
                evidence: [{ path: artifact.path, digest: artifact.digest, start: 0, end: quote.length, quote, symbol: 'refresh' }],
                observation: 'The declared command observed the refreshed value.', alternative: 'The fixture may not cover the external storage provider.',
            }))
            return assessment(claims, context)
        },
        reviews: async subject => {
            const reviewDependencies: WorkOrderReviewDependencies = {
                ...deps,
                review: async context => {
                    order.push(`review:${context.kind}`)
                    return { kind: 'review', runId: context.runId,
                    reviewer: `fixture-${context.kind}-reviewer`, contractDigest: subject.contractDigest,
                    artifactDigest: subject.artifactDigest, findings: [], dispositions: [], evidence: `review:${context.kind}` }
                },
                rerun: deps.runVerification,
                store: { write: async bytes => { storedReviews = bytes }, read: async () => storedReviews },
            }
            const result = await reviewWorkOrderWave({ subject, author: input.author, changedPaths: [...parsed.value.authority] }, reviewDependencies)
            if (result.kind !== 'complete') throw new Error(result.reason)
            return result.reviews
        },
        withCompletionLock: async (_id, action) => action({
            writeGrade: async bytes => { writes.push('grade'); storedGrade = bytes },
            readGrade: async () => { writes.push('read-grade'); return storedGrade },
            compareAndWriteCompletion: async record => { writes.push('completion'); sentinel = record; return true },
        }),
    }
    return { input, deps, artifacts, writes, calls, order,
        assessment: (fn: typeof assessment) => { assessment = fn }, run: (fn: typeof run) => { run = fn },
        current: (contract: ParsedWorkOrder) => { current = contract },
        sentinel: () => sentinel, storedGrade: () => storedGrade,
    }
}

type Harness = ReturnType<typeof harness>
function alterClaim(h: Harness, fn: (claim: CriterionAssessment) => CriterionAssessment) {
    h.assessment((claims, context) => ({ kind: 'assessment', runId: context.runId, grader: h.input.grader, integrity: 'clean', criteria: claims.map(fn) }))
}

describe('production grading and completion', () => {
    it('reruns every declared command and persists current grade evidence before completion', async () => {
        const h = harness()
        // A long run keeps only the tail of its output; its exit status still decides the criterion.
        h.run(async argv => ({ kind: 'executed', exitCode: 0, stdout: `${argv.at(-1)}: fresh value observed`, stderr: '', truncated: true }))
        const grade = await verifyWorkOrder(h.input, h.deps)
        expect(grade.criteria.map(row => row.outcome)).toEqual(Array(3).fill(CRITERION_OUTCOMES[0]))
        h.order.length = 0
        const result = await completeWorkOrder(h.input, h.deps)
        expect(result.completed).toBe(true)
        expect(h.order).toEqual(['review:simplification', 'review:code-spec', 'review:security', 'grade'])
        expect(h.calls).toEqual([...h.input.accepted.contract.verification, ...h.input.accepted.contract.verification].map(command => [...command.argv]))
        expect(h.writes).toEqual(['grade', 'read-grade', 'completion'])
        expect(h.sentinel()?.gradeDigest).toBe(createHash('sha256').update(h.storedGrade()!).digest('hex'))
        expect(result.grade?.runId).not.toBe(grade.runId)
    })

    const adversaries: [string, (h: Harness) => void][] = [
        ['fabricated quote', h => alterClaim(h, claim => ({ ...claim, evidence: claim.evidence.map(row => ({ ...row, quote: 'fabricated observation' })) }))],
        ['unrelated artifact', h => alterClaim(h, claim => ({ ...claim, evidence: claim.evidence.map(row => ({ ...row, path: 'unrelated/cache.ts' })) }))],
        ['stale artifact', h => alterClaim(h, claim => ({ ...claim, evidence: claim.evidence.map(row => ({ ...row, digest: '0'.repeat(64) })) }))],
        ['out-of-bounds citation', h => alterClaim(h, claim => ({ ...claim, evidence: claim.evidence.map(row => ({ ...row, end: 10_000, quote: h.artifacts.get(row.path)! })) }))],
        ['changed criterion', h => alterClaim(h, claim => ({ ...claim, criterionDigest: '0'.repeat(64) }))],
        ['unrelated verification', h => alterClaim(h, claim => ({ ...claim, verificationDigests: ['0'.repeat(64)] }))],
        ['fabricated verification observation', h => alterClaim(h, claim => ({ ...claim, verificationEvidence: claim.verificationEvidence.map(row => ({ ...row, quote: 'invented command output' })) }))],
        ['missing verification observation', h => alterClaim(h, claim => ({ ...claim, verificationEvidence: [] }))],
        ['missing evidence', h => alterClaim(h, claim => ({ ...claim, evidence: [] }))],
        ['empty observation', h => alterClaim(h, claim => ({ ...claim, observation: '' }))],
        ['missing alternative hypothesis', h => alterClaim(h, claim => ({ ...claim, alternative: '' }))],
        ['contaminated assessment', h => h.assessment((criteria, context) => ({ kind: 'assessment', runId: context.runId, grader: h.input.grader, integrity: 'contaminated', criteria }))],
        ['wrong grader', h => h.assessment((criteria, context) => ({ kind: 'assessment', runId: context.runId, grader: 'another-grader', integrity: 'clean', criteria }))],
        ['self grading', h => { h.input.grader = h.input.author }],
        ['replayed assessment', h => h.assessment((criteria) => ({ kind: 'assessment', runId: 'previous-run', grader: h.input.grader, integrity: 'clean', criteria }))],
        ['duplicate criterion', h => h.assessment((criteria, context) => ({ kind: 'assessment', runId: context.runId, grader: h.input.grader, integrity: 'clean', criteria: [...criteria, criteria[0]] }))],
        ['unknown criterion', h => h.assessment((criteria, context) => ({ kind: 'assessment', runId: context.runId, grader: h.input.grader, integrity: 'clean', criteria: [...criteria, { ...criteria[0], criterion: 'AC7' }] }))],
        ['missing criterion', h => h.assessment((criteria, context) => ({ kind: 'assessment', runId: context.runId, grader: h.input.grader, integrity: 'clean', criteria: criteria.slice(1) }))],
        ['grader error', h => { h.deps.grade = async () => ({ kind: 'error', reason: 'grader transport failed' }) }],
        ['grader abstention', h => { h.deps.grade = async () => ({ kind: 'abstained', reason: 'unable to establish semantic support' }) }],
        ['grader never ran', h => { h.deps.grade = async () => ({ kind: 'never-ran', reason: 'launch refused' }) }],
        ['silent output', h => h.run(async () => ({ kind: 'executed', exitCode: 0, stdout: '', stderr: '', truncated: false }))],
        ['verification failure', h => h.run(async () => ({ kind: 'executed', exitCode: 1, stdout: 'stale', stderr: '', truncated: false }))],
        ['verification error', h => h.run(async () => ({ kind: 'error', reason: 'executor disconnected' }))],
        ['verification unavailable', h => h.run(async () => ({ kind: 'unavailable', reason: 'stack absent' }))],
        ['symbol mention', h => { h.artifacts.set('src/cache.ts', '// refresh is present in prose\n') }],
        ['symbol in a string', h => { h.artifacts.set('src/cache.ts', 'const note = "function refresh() {}"\n') }],
        ['symbol in a template', h => { h.artifacts.set('src/cache.ts', '`\nexport function refresh() {}\n`\n') }],
        ['symbol use instead of declaration', h => { h.artifacts.set('src/cache.ts', 'refresh()\n') }],
        ['unsupported outcome', h => alterClaim(h, claim => ({ ...claim, outcome: JSON.parse('"PASS"') }))],
    ]
    for (const outcome of CRITERION_OUTCOMES.slice(1)) adversaries.push([outcome, h => alterClaim(h, claim => ({ ...claim, outcome }))])
    it.each(adversaries)('refuses %s through the verifier and completion gate', async (_name, configure) => {
        const h = harness()
        configure(h)
        const grade = await verifyWorkOrder(h.input, h.deps)
        expect(grade.criteria.every(row => CRITERION_OUTCOMES.includes(row.outcome))).toBe(true)
        expect(grade.criteria.some(row => row.outcome !== CRITERION_OUTCOMES[0])).toBe(true)
        const result = await completeWorkOrder(h.input, h.deps)
        expect(result.completed).toBe(false)
        expect(h.sentinel()).toBeUndefined()
        if (result.completed) throw new Error('Unexpected completion')
        // Self grading and an unauthenticated grader are refused before any assessment exists, so nothing is kept.
        if (!result.grade || !isIssuedWorkOrderGrade(result.grade)) { expect(h.writes).toEqual([]); return }
        // The failed grade is the engineer's next input, so it is kept and its reason names each unmet criterion.
        expect(h.writes).toEqual(['grade', 'read-grade'])
        const unmet = result.grade.criteria.filter(row => row.outcome !== CRITERION_OUTCOMES[0])
        for (const row of unmet) expect(result.reason).toContain(`${row.criterion} ${row.outcome}`)
        expect(JSON.parse(h.storedGrade()!).grade.criteria).toEqual(expect.arrayContaining(unmet.map(row => expect.objectContaining({ criterion: row.criterion, outcome: row.outcome }))))
    })

    it.each(['during grading', 'during reviews', 'after grade persistence'])('refuses artifact drift %s', async when => {
        const h = harness()
        const change = () => h.artifacts.set('src/cache.ts', 'export function refresh() { return "stale" }\n')
        if (when === 'during grading') h.assessment((criteria, context) => { change(); return { kind: 'assessment', runId: context.runId, grader: h.input.grader, integrity: 'clean', criteria } })
        if (when === 'during reviews') {
            const reviews = h.deps.reviews
            h.deps.reviews = async grade => { const result = await reviews(grade); change(); return result }
        }
        if (when === 'after grade persistence') {
            const lock = h.deps.withCompletionLock
            h.deps.withCompletionLock = (id, action) => lock(id, writer => action({ ...writer, writeGrade: async bytes => { await writer.writeGrade(bytes); change() } }))
        }
        const result = await completeWorkOrder(h.input, h.deps)
        expect(result.completed).toBe(false)
        expect(h.sentinel()).toBeUndefined()
    })

    it('does not start the grader when final verification changes the reviewed subject', async () => {
        const h = harness()
        h.run(async argv => {
            h.artifacts.set('src/cache.ts', 'export function refresh() { return "changed by verification" }\n')
            return { kind: 'executed', exitCode: 0, stdout: `${argv.at(-1)} changed the subject`, stderr: '', truncated: false }
        })
        const result = await completeWorkOrder(h.input, h.deps)
        expect(result.completed).toBe(false)
        expect(h.order).toEqual(['review:simplification', 'review:code-spec', 'review:security'])
        expect(h.writes).toEqual([])
    })

    it('refuses a different current contract and a copied acceptance', async () => {
        const h = harness()
        const changed = parseWorkOrder(Buffer.from(workOrderFixture().replace('Refresh 1', 'Refresh changed')))
        if (!changed.ok) throw new Error('Invalid changed fixture')
        h.current(changed.value)
        expect((await completeWorkOrder(h.input, h.deps)).completed).toBe(false)
        h.current(h.input.accepted.contract)
        expect((await completeWorkOrder({ ...h.input, accepted: { ...h.input.accepted } }, h.deps)).completed).toBe(false)
        expect(h.writes).toEqual([])
    })

    const badReviews: [string, (reviews: readonly CompletionReview[]) => readonly CompletionReview[]][] = [
        ['missing', () => []], ['duplicate', reviews => [...reviews, reviews[0]]],
        ['stale', reviews => reviews.map(review => ({ ...review, artifactDigest: '0'.repeat(64) }))],
        ['different contract', reviews => reviews.map(review => ({ ...review, contractDigest: '0'.repeat(64) }))],
        ['unaccepted', reviews => reviews.map(review => ({ ...review, accepted: false }))],
        ['open finding', reviews => reviews.map(review => ({ ...review, openFindings: 1 }))],
        ['author review', reviews => reviews.map(review => ({ ...review, reviewer: 'fixture-engineer' }))],
        ['missing review evidence', reviews => reviews.map(review => ({ ...review, evidence: '' }))],
    ]
    it.each(badReviews)('refuses %s reviews before any grade write', async (_name, alter) => {
        const h = harness()
        const reviews = h.deps.reviews
        h.deps.reviews = async grade => alter(await reviews(grade))
        expect((await completeWorkOrder(h.input, h.deps)).completed).toBe(false)
        expect(h.writes).toEqual([])
        expect(h.sentinel()).toBeUndefined()
    })

    it.each(['copied set', 'repeated reviewer'])('refuses an unissued %s before completion', async mode => {
        const h = harness()
        const reviews = h.deps.reviews
        h.deps.reviews = async grade => {
            const current = await reviews(grade)
            return mode === 'copied set' ? [...current] : current.map(review => ({ ...review, reviewer: 'one-reviewer' }))
        }
        expect((await completeWorkOrder(h.input, h.deps)).completed).toBe(false)
        expect(h.writes).toEqual([])
        expect(h.sentinel()).toBeUndefined()
    })

    it.each(['verification', 'grader', 'artifact', 'reviews', 'grade-write', 'grade-read', 'completion-write'])('stays incomplete when %s throws', async point => {
        const h = harness()
        const crash = async (): Promise<never> => { throw new Error(`Injected ${point} failure`) }
        if (point === 'verification') h.deps.runVerification = crash
        if (point === 'grader') h.deps.grade = crash
        if (point === 'artifact') h.deps.readArtifact = crash
        if (point === 'reviews') h.deps.reviews = crash
        const lock = h.deps.withCompletionLock
        h.deps.withCompletionLock = (id, action) => lock(id, writer => action({ ...writer,
            ...(point === 'grade-write' ? { writeGrade: crash } : {}),
            ...(point === 'grade-read' ? { readGrade: crash } : {}),
            ...(point === 'completion-write' ? { compareAndWriteCompletion: crash } : {}),
        }))
        expect((await completeWorkOrder(h.input, h.deps)).completed).toBe(false)
        expect(h.sentinel()).toBeUndefined()
    })

    it('refuses corrupt persisted grade evidence and an atomic completion conflict', async () => {
        for (const corrupt of [true, false]) {
            const h = harness()
            const lock = h.deps.withCompletionLock
            h.deps.withCompletionLock = (id, action) => lock(id, writer => action({ ...writer,
                readGrade: async () => corrupt ? '{}' : writer.readGrade(), compareAndWriteCompletion: async () => false,
            }))
            const result = await completeWorkOrder(h.input, h.deps)
            expect(result.completed).toBe(false)
            if (result.completed) throw new Error('Unexpected completion')
            expect(result.reason).toContain(corrupt ? 'persisted grade' : 'Completion')
            expect(h.sentinel()).toBeUndefined()
        }
    })

    it('refuses a copied or hand-edited success as a current grade', async () => {
        const h = harness()
        const grade = await verifyWorkOrder(h.input, h.deps)
        expect(await checkGradeCurrency(grade, h.deps)).toBeUndefined()
        expect(await checkGradeCurrency(structuredClone(grade), h.deps)).toBe('Grade is not an issued strict success')
        expect(Object.isFrozen(grade.criteria[0].assessment?.evidence)).toBe(true)
    })
})
