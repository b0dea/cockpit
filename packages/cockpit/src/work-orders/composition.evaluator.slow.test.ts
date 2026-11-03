import { existsSync } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionStep } from '../environment/contract.js'
import { runWorkApplication } from './application.js'
import { createConfiguredWorkApplicationComposition, type WorkApplicationComposition } from './composition.js'
import { createWorkCompositionFixtureSupport } from '../../test-support/work-composition-fixture.js'

const executionBoundary = vi.hoisted(() => ({ steps: [] as ExecutionStep[], evaluatorRequests: [] as Record<string, unknown>[] }))
vi.mock('../environment-exec/execute.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../environment-exec/execute.js')>()
    const { readFileSync } = await import('node:fs')
    return { ...actual, executeProbe: async (step: ExecutionStep) => {
        executionBoundary.steps.push(step)
        // The request file lives in the evaluator's private run directory, removed after the run.
        const request = step.labels.owner === 'independent-evaluator' ? /request JSON at (.+) with SHA-256/.exec(step.argv.at(-1)!)?.[1] : undefined
        if (request) executionBoundary.evaluatorRequests.push(JSON.parse(readFileSync(request, 'utf8')))
        return actual.executeProbe(step)
    } }
})

const roots: string[] = []
afterEach(async () => {
    executionBoundary.steps.length = 0
    executionBoundary.evaluatorRequests.length = 0
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const { configuredFixture } = createWorkCompositionFixtureSupport(roots)

async function executeBothSteps(composition: WorkApplicationComposition, label: string): Promise<void> {
    for (const step of ['one', 'two']) {
        const executed = await runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-001', approach: `${label} step ${step}` }, composition)
        expect(executed, executed.kind === 'refusal' ? executed.reason : executed.kind).toMatchObject({ kind: 'complete' })
    }
}

// The per-tool command lines, refusals and fallback rules are pinned at the evaluation seam; this pins
// that review and grading reach it, and what they keep of the tool that answered.
describe('work review and grade through the independent evaluation seam', () => {
    it('grades with the next listed evaluator when the first is missing, recording which answered and why', async () => {
        const fixture = await configuredFixture({ evaluators: ['codexcli', 'claudecode'] })
        await rm(join(fixture.root, 'tools/codex'))
        // A real agent tool elsewhere on this machine's PATH would answer in the fixture's place.
        const configured = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath,
            env: Object.freeze({ ...fixture.environment, PATH: [join(fixture.root, 'tools'), '/usr/bin', '/bin'].join(delimiter) }) })
        if (configured.kind !== 'complete') throw new Error(configured.reason)
        const composition = configured.composition
        const acceptance = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-001' }, composition)
        if (acceptance.kind !== 'human-needed') throw new Error(`acceptance continuation unavailable: ${acceptance.kind === 'refusal' ? acceptance.reason : acceptance.kind}`)
        await expect(acceptance.continuation.decide(`accept ${acceptance.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        await executeBothSteps(composition, 'fallback')

        await writeFile(join(fixture.root, '.native-mode'), 'signed-out')
        await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, composition)).resolves.toMatchObject({ kind: 'refusal',
            reason: expect.stringMatching(/did not run: the Codex CLI \(codex\) is not on PATH .*; then Claude Code exited with status 1: Not logged in .*; read the message for the cause each evaluator reported/) })
        await writeFile(join(fixture.root, '.native-mode'), 'complete')

        const graded = await runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, composition)
        expect(graded, graded.kind === 'refusal' ? graded.reason : graded.kind).toMatchObject({ kind: 'complete', value: { completed: true } })
        const runs = executionBoundary.steps.filter(step => step.labels.owner === 'independent-evaluator')
        expect(runs.slice(-4).map(step => [step.labels.tool, step.labels.role])).toEqual([['claudecode', 'simplification'], ['claudecode', 'code-spec'],
            ['claudecode', 'security'], ['claudecode', 'grader']])
        for (const request of executionBoundary.evaluatorRequests) expect(request).toMatchObject({ repositoryRoot: fixture.root, browser: 'unavailable' })
        // The grade record keeps the reviews it completed on, so it is where the answering tool is recorded.
        const orderDirectory = join(fixture.root, '.cockpit/work-orders/WO-001')
        const gradePath = (await readdir(orderDirectory)).filter(name => name.startsWith('generation-')).sort()
            .map(name => join(orderDirectory, name, 'grade.json')).filter(path => existsSync(path)).at(-1)!
        const reviews = JSON.parse(await readFile(gradePath, 'utf8')) as { grade: { grader: string }; reviews: { reviewer: string; evidence: string }[] }
        // The grader's identity is fixed before the run, so the grade names the tool that answered beside it.
        expect(reviews.grade).toMatchObject({ grader: expect.stringMatching(/^evaluator:grader:/), evaluator: { tool: 'claudecode',
            fallbacks: [{ tool: 'codexcli', code: 'EVALUATOR_UNAVAILABLE', message: expect.stringContaining('the Codex CLI (codex) is not on PATH') }] } })
        expect(reviews.reviews).toHaveLength(3)
        for (const review of reviews.reviews) {
            expect(review.reviewer).toMatch(/^claudecode:/)
            expect(review.evidence).toContain('[cockpit] answered by claudecode after: codexcli: the Codex CLI (codex) is not on PATH')
        }
    }, 180_000)
})
