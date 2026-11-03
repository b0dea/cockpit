import { rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionStep } from '../environment/contract.js'
import type { EvaluatorTool } from '../schema.js'
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
const prompt = expect.stringMatching(/^Read exactly the request JSON at .+ with SHA-256 [a-f0-9]{64};/)

// Each tool's read-only mechanism, user-customisation switch and session spelling is what keeps the
// evaluator apart from the agent that did the work, so each is pinned exactly.
const tools: readonly Readonly<{ evaluator: EvaluatorTool; command: string; name: string; install: string; signIn: string; signedOut: string
    environment: readonly string[]; shape: (step: ExecutionStep, repository: string) => void }>[] = [
    { evaluator: 'codexcli', command: 'codex', name: 'the Codex CLI', install: 'npm install -g @openai/codex', signIn: 'codex login',
        signedOut: 'Not signed in; run codex login', environment: ['HOME', 'CODEX_HOME'],
        shape: step => expect(step.argv.slice(1)).toEqual(['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only',
            '--cd', step.cwd, '--json', '--output-schema', join(step.cwd, 'schema.json'), '--output-last-message', join(step.cwd, 'response.json'), prompt]) },
    { evaluator: 'claudecode', command: 'claude', name: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code', signIn: 'claude auth login',
        signedOut: 'Not logged in · Please run /login', environment: ['HOME', 'USER', 'CLAUDE_CONFIG_DIR'],
        shape: (step, repository) => expect(step.argv.slice(1)).toEqual(['--print', '--output-format', 'json', '--json-schema', expect.stringContaining('"additionalProperties":false'),
            '--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk',
            '--add-dir', repository, '--', prompt]) },
    { evaluator: 'opencode', command: 'opencode', name: 'OpenCode', install: 'npm install -g opencode-ai', signIn: 'opencode auth login',
        signedOut: 'Authentication failed (APIError: Authentication failed)', environment: ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'OPENCODE_PERMISSION'],
        shape: step => {
            expect(step.argv.slice(1)).toEqual(['run', '--pure', '--format', 'json', '--print-logs', '--log-level', 'ERROR', prompt])
            expect(JSON.parse(step.env.OPENCODE_PERMISSION!)).toEqual({ edit: 'deny', bash: 'deny', task: 'deny', todowrite: 'deny', question: 'deny',
                webfetch: 'deny', websearch: 'deny', lsp: 'deny', doom_loop: 'deny', skill: 'deny', external_directory: 'allow' })
        } },
]

async function executeBothSteps(composition: WorkApplicationComposition, label: string): Promise<void> {
    for (const step of ['one', 'two']) {
        const executed = await runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-001', approach: `${label} step ${step}` }, composition)
        expect(executed, executed.kind === 'refusal' ? executed.reason : executed.kind).toMatchObject({ kind: 'complete' })
    }
}

describe('selectable independent evaluator', () => {
    it.each(tools)('grades with $evaluator in its private run directory, read-only, and fails closed naming the fix', async tool => {
        const fixture = await configuredFixture({ evaluator: tool.evaluator })
        // A real agent tool elsewhere on this machine's PATH would answer once the fixture's is gone.
        const configured = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath,
            env: Object.freeze({ ...fixture.environment, PATH: [join(fixture.root, 'tools'), '/usr/bin', '/bin'].join(delimiter) }) })
        if (configured.kind !== 'complete') throw new Error(configured.reason)
        const composition = configured.composition
        const acceptance = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-001' }, composition)
        if (acceptance.kind !== 'human-needed') throw new Error(`acceptance continuation unavailable: ${acceptance.kind === 'refusal' ? acceptance.reason : acceptance.kind}`)
        await expect(acceptance.continuation.decide(`accept ${acceptance.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        // Another tool on PATH does not stand in for the selected one.
        const toolPath = join(fixture.root, 'tools', tool.command)
        await rename(toolPath, `${toolPath}.held`)
        await executeBothSteps(composition, 'missing-evaluator')
        const unavailable = await runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, composition)
        expect(unavailable).toMatchObject({ kind: 'refusal', reason: expect.stringContaining(`${tool.name} (${tool.command}) is not on PATH`) })
        expect(unavailable).toMatchObject({ reason: expect.stringContaining(`workorders.evaluator = "${tool.evaluator}" selects it to run work review and work grade; `
            + `install it with ${tool.install} and sign in with ${tool.signIn}`) })
        await rename(`${toolPath}.held`, toolPath)
        await executeBothSteps(composition, 'restored-evaluator')

        // The tool's own report of a missing sign-in reaches the person with the command that fixes it.
        await writeFile(join(fixture.root, '.native-mode'), 'signed-out')
        await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, composition)).resolves.toMatchObject({ kind: 'refusal',
            reason: expect.stringContaining(`${tool.name} exited with status 1: ${tool.signedOut}; if it is not signed in, run ${tool.signIn}, then rerun`) })
        if (tool.evaluator === 'opencode') {
            // Nothing constrains OpenCode's answer but cockpit's own check against the schema.
            await writeFile(join(fixture.root, '.native-mode'), 'prose')
            await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, composition)).resolves.toMatchObject({ kind: 'refusal',
                reason: expect.stringContaining('Independent evaluator response') })
            await writeFile(join(fixture.root, '.native-mode'), 'extra')
            await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, composition)).resolves.toMatchObject({ kind: 'refusal',
                reason: expect.stringContaining('Independent evaluator response does not match its output schema: response has the undeclared field extra') })
        }
        await writeFile(join(fixture.root, '.native-mode'), 'complete')

        executionBoundary.steps.length = 0; executionBoundary.evaluatorRequests.length = 0
        const graded = await runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, composition)
        expect(graded, graded.kind === 'refusal' ? graded.reason : graded.kind).toMatchObject({ kind: 'complete', value: { completed: true } })
        const runs = executionBoundary.steps.filter(step => step.labels.owner === 'independent-evaluator')
        expect(runs.map(step => step.labels.role)).toEqual(['simplification', 'code-spec', 'security', 'grader'])
        for (const run of runs) {
            expect(run.argv0).toBe(join(fixture.root, 'tools', tool.command))
            // Each run starts in its own private directory, never in the repository whose instruction files the graded agent can write.
            expect(run.cwd.startsWith(`${fixture.root}/`)).toBe(false)
            tool.shape(run, fixture.root)
            // Only what the tool needs to find its sign-in crosses over; the parent's session variables never do.
            expect(Object.keys(run.env).sort()).toEqual(['PATH', ...tool.environment.filter(name => name === 'OPENCODE_PERMISSION' || process.env[name])].sort())
        }
        expect(new Set(runs.map(run => run.cwd)).size).toBe(runs.length)
        for (const request of executionBoundary.evaluatorRequests) expect(request).toMatchObject({ repositoryRoot: fixture.root, browser: 'unavailable' })
    }, 180_000)

    it('stops an evaluator that keeps retrying at its timeout and names the last error it reported', async () => {
        const fixture = await configuredFixture({ evaluator: 'opencode', evaluatorTimeoutSeconds: 1 })
        const acceptance = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-001' }, fixture.composition)
        if (acceptance.kind !== 'human-needed') throw new Error(`acceptance continuation unavailable: ${acceptance.kind === 'refusal' ? acceptance.reason : acceptance.kind}`)
        await expect(acceptance.continuation.decide(`accept ${acceptance.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        await executeBothSteps(fixture.composition, 'rate-limited')
        await writeFile(join(fixture.root, '.native-mode'), 'rate-limited')
        await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({ kind: 'refusal',
            reason: expect.stringContaining('OpenCode timed out after 1 seconds after reporting: AI_APICallError: Free usage limit reached; raise workorders.evaluator_timeout_seconds') })
    }, 120_000)
})
