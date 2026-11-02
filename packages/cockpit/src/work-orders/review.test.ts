import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseWorkOrder } from './contract.js'
import { workOrderFixture } from '../test-support/work-order.js'
import { acceptWorkOrder, beginWorkOrderAcceptance, intakeWorkOrder, routeWorkOrder, validateWorkOrderPolicy } from './intake.js'
import {
    prepareWorkOrderVerification, type VerificationObservation, type WorkOrderSubjectDependencies,
} from '../grading/verifier.js'
import {
    isIssuedWorkOrderReviewSet, planWorkOrderReviews, reviewWorkOrderWave,
    type WorkOrderReviewDependencies, type WorkOrderReviewerResponse,
} from './review.js'

async function harness() {
    const parsed = parseWorkOrder(Buffer.from(workOrderFixture().replaceAll('[ ]', '[x]')))
    assert(parsed.ok)
    const policy = validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1 })
    assert(policy.kind === 'policy')
    const draft = intakeWorkOrder({ contract: parsed.value,
        route: routeWorkOrder({ certification: true }, { policy: policy.policy, orders: [] }),
        sourceAudit: { sources: parsed.value.sources, gaps: [] }, installedSkills: [] })
    assert(draft.kind === 'draft')
    const admission = { interactive: true, json: false, ci: false, stdinIsTTY: true, stdoutIsTTY: true }
    const request = beginWorkOrderAcceptance(draft, admission, Date.parse('2026-01-03T00:00:00Z'))
    assert(request.kind === 'human_needed')
    const accepted = acceptWorkOrder(request.continuation, draft, { admission, now: Date.parse('2026-01-03T00:00:00Z'),
        actor: 'fixture-operator', answer: `accept ${request.digest}` })
    assert(accepted.kind === 'accepted')
    let current = parsed.value
    const artifacts = new Map(parsed.value.authority.map(path => [path, "export function refresh() { return 'fresh' }\n"]))
    const subjectDependencies: WorkOrderSubjectDependencies = {
        readWorkOrder: async () => current,
        readArtifact: async path => Buffer.from(artifacts.get(path)!),
    }
    const subject = await prepareWorkOrderVerification({ accepted, author: 'fixture-author', grader: 'fixture-grader' }, subjectDependencies)
    let stored: string | null = null
    let readStored = async (): Promise<string | null> => stored
    const calls: string[][] = []
    const reviewerCalls: string[] = []
    let response: (kind: string, context: { runId: string }) => WorkOrderReviewerResponse = (kind, context) => ({
        kind: 'review', runId: context.runId, reviewer: `fixture-${kind}-reviewer`,
        contractDigest: subject.contractDigest, artifactDigest: subject.artifactDigest,
        findings: kind === 'code-spec' ? [{ id: 'F1', severity: 'blocking', summary: 'Rerun the affected proof.',
            affectedVerification: [subject.verification[0].argv] }] : [],
        dispositions: kind === 'code-spec' ? [{ findingId: 'F1', outcome: 'fixed', reason: 'The finding was corrected.' }] : [],
        evidence: `${kind} review accepted`,
    })
    let rerun: (argv: readonly string[]) => Promise<VerificationObservation> = async argv => {
        calls.push([...argv]); return { kind: 'executed', exitCode: 0, stdout: 'affected proof passed', stderr: '', truncated: false }
    }
    const dependencies: WorkOrderReviewDependencies = {
        ...subjectDependencies,
        review: async context => { reviewerCalls.push(context.kind); return response(context.kind, context) },
        rerun: async argv => rerun(argv),
        store: { write: async bytes => { stored = bytes }, read: () => readStored() },
    }
    return { subject, dependencies, calls, reviewerCalls,
        response: (next: typeof response) => { response = next }, rerun: (next: typeof rerun) => { rerun = next },
        stale: () => {
            const changed = parseWorkOrder(Buffer.from(workOrderFixture().replace('Refresh 1 completes.', 'Refresh changed.')))
            if (!changed.ok) throw new Error('Invalid changed fixture')
            current = changed.value
        },
        readback: (next: string | null) => { readStored = async () => next },
    }
}

describe('work-order review gate', () => {
    it('persists three current independent reviews and reruns affected proof', async () => {
        const h = await harness()
        const observation = { kind: 'executed' as const, exitCode: 0, stdout: 'x'.repeat(65_536), stderr: '', truncated: false }
        h.rerun(async argv => { h.calls.push([...argv]); return observation })
        const result = await reviewWorkOrderWave({ subject: h.subject, author: 'fixture-author', changedPaths: ['src/cache.ts'] }, h.dependencies)
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') throw new Error(result.reason)
        expect(result.reviews.map(review => review.kind)).toEqual(['simplification', 'code-spec', 'security'])
        expect(h.calls).toEqual([h.subject.verification[0].argv])
        const persisted = JSON.parse(result.bytes)
        const argv = h.subject.verification[0].argv
        const receipt = { argv, result: observation, digest: createHash('sha256').update(JSON.stringify({
            workOrderId: h.subject.workOrderId, contractDigest: h.subject.contractDigest, artifactDigest: h.subject.artifactDigest,
            argv, result: observation,
        })).digest('hex') }
        expect(result.reviews[1].reruns).toEqual([receipt])
        expect(persisted.reviews[1].reruns).toEqual([receipt])
        expect(Object.isFrozen(result.reviews[1].reruns[0])).toBe(true)
        expect(Object.isFrozen(result.reviews[1].reruns[0].argv)).toBe(true)
        expect(Object.isFrozen(result.reviews[1].reruns[0].result)).toBe(true)
        expect(persisted.reviews[1].findings).toEqual([{ id: 'F1', severity: 'blocking', summary: 'Rerun the affected proof.',
            affectedVerification: [h.subject.verification[0].argv] }])
        expect(persisted.reviews[1].dispositions).toEqual([{ findingId: 'F1', outcome: 'fixed', reason: 'The finding was corrected.' }])
        expect(Object.isFrozen(result.reviews[1].findings[0].affectedVerification)).toBe(true)
        expect(isIssuedWorkOrderReviewSet(result.reviews)).toBe(true)
        expect(isIssuedWorkOrderReviewSet([...result.reviews])).toBe(false)
    })

    it('keeps the fix lane proportional and artifact-free', () => {
        expect(planWorkOrderReviews({ kind: 'fix' })).toEqual({ kind: 'none', reason: 'Fix-lane work remains proportional and creates no review artifact' })
        expect(planWorkOrderReviews({ kind: 'work-order' })).toMatchObject({ kind: 'required', reviews: ['simplification', 'code-spec', 'security'] })
    })

    it('refuses an alternate author before invoking reviewers', async () => {
        const h = await harness()
        expect(await reviewWorkOrderWave({ subject: h.subject, author: 'author-alias', changedPaths: ['src/cache.ts'] }, h.dependencies))
            .toMatchObject({ kind: 'refusal' })
        expect(h.reviewerCalls).toEqual([])
    })

    it.each([
        ['self review', (_kind: string, context: { runId: string }, h: Awaited<ReturnType<typeof harness>>) => ({
            kind: 'review' as const, runId: context.runId, reviewer: 'fixture-author', contractDigest: h.subject.contractDigest,
            artifactDigest: h.subject.artifactDigest, findings: [], dispositions: [], evidence: 'self review' })],
        ['wrong run', (kind: string, _context: { runId: string }, h: Awaited<ReturnType<typeof harness>>) => ({
            kind: 'review' as const, runId: 'old-run', reviewer: `${kind}-reviewer`, contractDigest: h.subject.contractDigest,
            artifactDigest: h.subject.artifactDigest, findings: [], dispositions: [], evidence: 'old review' })],
        ['repeated reviewer', (_kind: string, context: { runId: string }, h: Awaited<ReturnType<typeof harness>>) => ({
            kind: 'review' as const, runId: context.runId, reviewer: 'one-reviewer', contractDigest: h.subject.contractDigest,
            artifactDigest: h.subject.artifactDigest, findings: [], dispositions: [], evidence: 'repeated reviewer' })],
        ['never ran', () => ({ kind: 'never-ran' as const, reason: 'reviewer unavailable' })],
    ])('refuses %s independent review evidence', async (_name, make) => {
        const h = await harness()
        h.response((kind, context) => make(kind, context, h))
        expect(await reviewWorkOrderWave({ subject: h.subject, author: 'fixture-author', changedPaths: ['src/cache.ts'] }, h.dependencies))
            .toMatchObject({ kind: 'refusal' })
    })

    it('refuses unresolved blocking findings, failed affected proof and corrupt persistence', async () => {
        const unresolved = await harness()
        unresolved.response((kind, context) => ({ kind: 'review', runId: context.runId, reviewer: `${kind}-reviewer`,
            contractDigest: unresolved.subject.contractDigest, artifactDigest: unresolved.subject.artifactDigest,
            findings: [{ id: 'F1', severity: 'blocking', summary: 'Blocking issue.', affectedVerification: [unresolved.subject.verification[0].argv] }],
            dispositions: [{ findingId: 'F1', outcome: 'accepted-risk', reason: 'Deferred.' }], evidence: 'review evidence' }))
        expect((await reviewWorkOrderWave({ subject: unresolved.subject, author: 'fixture-author', changedPaths: ['src/cache.ts'] }, unresolved.dependencies)).kind).toBe('refusal')

        const failed = await harness()
        failed.rerun(async () => ({ kind: 'executed', exitCode: 1, stdout: 'failed', stderr: '', truncated: false }))
        const failure = await reviewWorkOrderWave({ subject: failed.subject, author: 'fixture-author', changedPaths: ['src/cache.ts'] }, failed.dependencies)
        expect(failure).toMatchObject({ kind: 'refusal', reason: expect.stringContaining('exited 1') })
        assert(failure.kind === 'refusal' && failure.bytes && failure.reviews)
        const failedReceipt = { argv: failed.subject.verification[0].argv,
            result: { kind: 'executed', exitCode: 1, stdout: 'failed', stderr: '', truncated: false } }
        expect(failure.reviews[1].reruns).toMatchObject([failedReceipt])
        expect(JSON.parse(failure.bytes).reviews[1].reruns).toEqual(failure.reviews[1].reruns)


        // An evaluator that could not run names why; that cause is what the person has to fix.
        const unavailable = await harness()
        unavailable.response(() => ({ kind: 'never-ran', reason: 'the Codex CLI exited with status 1: Invalid schema for response_format' }))
        await expect(reviewWorkOrderWave({ subject: unavailable.subject, author: 'fixture-author', changedPaths: ['src/cache.ts'] }, unavailable.dependencies))
            .resolves.toMatchObject({ kind: 'refusal', reason: 'Independent simplification review did not run: the Codex CLI exited with status 1: Invalid schema for response_format' })

        const corrupt = await harness()
        corrupt.readback('different')
        expect((await reviewWorkOrderWave({ subject: corrupt.subject, author: 'fixture-author', changedPaths: ['src/cache.ts'] }, corrupt.dependencies)).kind).toBe('refusal')
    })

    it('persists valid open findings and retains completed lanes when a later reviewer fails', async () => {
        const unresolved = await harness()
        unresolved.response((kind, context) => ({ kind: 'review', runId: context.runId, reviewer: `${kind}-reviewer`,
            contractDigest: unresolved.subject.contractDigest, artifactDigest: unresolved.subject.artifactDigest,
            findings: [{ id: 'F1', severity: 'blocking', summary: 'Blocking issue.',
                affectedVerification: [unresolved.subject.verification[0].argv] }], dispositions: [], evidence: 'review evidence' }))
        const open = await reviewWorkOrderWave({ subject: unresolved.subject, author: 'fixture-author', changedPaths: ['src/cache.ts'] }, unresolved.dependencies)
        expect(open).toMatchObject({ kind: 'refusal', reviews: [{ kind: 'simplification', accepted: false, openFindings: 1,
            findings: [{ id: 'F1' }], dispositions: [] }] })
        assert(open.kind === 'refusal' && open.bytes && open.reviews)
        expect(JSON.parse(open.bytes).reviews).toMatchObject([{ kind: 'simplification', accepted: false,
            openFindings: 1, findings: [{ id: 'F1' }], dispositions: [] }])
        expect(isIssuedWorkOrderReviewSet(open.reviews)).toBe(false)

        const interrupted = await harness()
        interrupted.response((kind, context) => kind === 'code-spec'
            ? { kind: 'error', reason: 'reviewer unavailable' }
            : { kind: 'review', runId: context.runId, reviewer: `${kind}-reviewer`, contractDigest: interrupted.subject.contractDigest,
                artifactDigest: interrupted.subject.artifactDigest, findings: [], dispositions: [], evidence: 'review evidence' })
        const partial = await reviewWorkOrderWave({ subject: interrupted.subject, author: 'fixture-author', changedPaths: ['src/cache.ts'] }, interrupted.dependencies)
        expect(partial).toMatchObject({ kind: 'refusal', reviews: [{ kind: 'simplification', accepted: true, openFindings: 0 }] })
        assert(partial.kind === 'refusal' && partial.bytes && partial.reviews)
        expect(JSON.parse(partial.bytes).reviews).toMatchObject([{ kind: 'simplification', accepted: true }])
        expect(interrupted.reviewerCalls).toEqual(['simplification', 'code-spec'])
        expect(isIssuedWorkOrderReviewSet(partial.reviews)).toBe(false)
    })

    it('requires an explicit disposition for every advisory finding', async () => {
        const undisposed = await harness()
        undisposed.response((kind, context) => ({ kind: 'review', runId: context.runId, reviewer: `${kind}-reviewer`,
            contractDigest: undisposed.subject.contractDigest, artifactDigest: undisposed.subject.artifactDigest,
            findings: [{ id: 'A1', severity: 'advisory', summary: 'Consider a smaller name.',
                affectedVerification: [undisposed.subject.verification[0].argv] }],
            dispositions: [], evidence: 'review evidence' }))
        expect(await reviewWorkOrderWave({ subject: undisposed.subject, author: 'fixture-author', changedPaths: ['src/cache.ts'] }, undisposed.dependencies))
            .toMatchObject({ kind: 'refusal' })

        const acceptedRisk = await harness()
        acceptedRisk.response((kind, context) => ({ kind: 'review', runId: context.runId, reviewer: `${kind}-reviewer`,
            contractDigest: acceptedRisk.subject.contractDigest, artifactDigest: acceptedRisk.subject.artifactDigest,
            findings: [{ id: 'A1', severity: 'advisory', summary: 'Consider a smaller name.',
                affectedVerification: [acceptedRisk.subject.verification[0].argv] }],
            dispositions: [{ findingId: 'A1', outcome: 'accepted-risk', reason: 'The public name is already stable.' }],
            evidence: 'review evidence' }))
        expect(await reviewWorkOrderWave({ subject: acceptedRisk.subject, author: 'fixture-author', changedPaths: ['src/cache.ts'] }, acceptedRisk.dependencies))
            .toMatchObject({ kind: 'complete' })
        expect(acceptedRisk.calls).toEqual([])
    })

    it('refuses a copied or stale prepared subject before review', async () => {
        const h = await harness()
        expect(await reviewWorkOrderWave({ subject: structuredClone(h.subject), author: 'fixture-author', changedPaths: ['src/cache.ts'] }, h.dependencies))
            .toMatchObject({ kind: 'refusal' })
        h.stale()
        expect(await reviewWorkOrderWave({ subject: h.subject, author: 'fixture-author', changedPaths: ['src/cache.ts'] }, h.dependencies))
            .toMatchObject({ kind: 'refusal' })
    })
})
