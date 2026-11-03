import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionStep } from '../environment/contract.js'
import type { EvaluatorTool } from '../schema.js'
import { defaultEvaluatorOrder, evaluate, findEvaluators, locateEvaluators, type EvaluationRequest } from './evaluate.js'

const boundary = vi.hoisted(() => ({ steps: [] as ExecutionStep[], requests: [] as Record<string, unknown>[] }))
vi.mock('../environment-exec/execute.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../environment-exec/execute.js')>()
    const { readFileSync } = await import('node:fs')
    return { ...actual, executeProbe: async (step: ExecutionStep) => {
        boundary.steps.push(step)
        // The request file lives in the run directory, removed after the run.
        const request = step.labels.owner === 'independent-evaluator' ? /request JSON at (\S+) with SHA-256/.exec(step.argv.at(-1)!)?.[1] : undefined
        if (request) boundary.requests.push(JSON.parse(readFileSync(request, 'utf8')))
        return actual.executeProbe(step)
    } }
})

// One synthetic tool that answers as whichever tool it is installed as: the Codex CLI writes its answer
// to --output-last-message beside a JSON event stream, Claude Code prints one result object carrying
// structured_output, and OpenCode streams events whose last text part is the answer. The request's
// mode, or its mode for this tool, names the behaviour; the answer is the request's own `answer`.
const fake = `#!/usr/bin/env node
const fs = require('node:fs'); const crypto = require('node:crypto')
const tool = require('node:path').basename(process.argv[1]); const argv = process.argv.slice(2)
const flags = { codex: '--ephemeral --ignore-user-config --skip-git-repo-check --sandbox --cd --json --output-schema --output-last-message',
  claude: '--print --output-format --json-schema --no-session-persistence --safe-mode --strict-mcp-config --tools --permission-mode --add-dir',
  opencode: '--pure --format --print-logs --log-level' }[tool]
if (argv[0] === '--version') { process.stdout.write(tool + ' 1.0.0\\n'); process.exit(0) }
if (argv.at(-1) === '--help') { (tool === 'opencode' ? process.stderr : process.stdout).write((fs.existsSync(process.argv[1] + '.old') ? '--json' : flags) + '\\n'); process.exit(0) }
const prompt = argv.at(-1)
const request = JSON.parse(fs.readFileSync(/request JSON at (\\S+) with SHA-256/.exec(prompt)[1], 'utf8'))
const mode = request.modes?.[tool] ?? request.mode
const session = mode === 'replay' ? 'fixed-session' : crypto.randomUUID()
if (mode === 'signed-out') {
  if (tool === 'codex') process.stdout.write(JSON.stringify({ type: 'error', message: 'Not signed in' }) + '\\n')
  else if (tool === 'claude') process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login', session_id: session }))
  else {
    process.stderr.write('level=ERROR message=failed error="APIError: Authentication failed" cause="APIError\\\\n    at <anonymous>"\\n')
    process.stdout.write(JSON.stringify({ type: 'error', sessionID: session, error: { name: 'APIError', data: { message: 'Authentication failed' } } }) + '\\n')
  }
  process.exit(1)
}
if (mode === 'rate-limited') {
  // OpenCode logs a rejected request and retries it until it is stopped.
  process.stderr.write('level=ERROR message="stream error" error.error="AI_APICallError: Free usage limit reached"\\n')
  setTimeout(() => process.exit(0), 60_000)
  return
}
const answer = mode === 'extra' ? { ...request.answer, extra: true } : request.answer
if (tool === 'codex') {
  fs.writeFileSync(argv[argv.indexOf('--output-last-message') + 1], JSON.stringify(answer), { flag: 'wx' })
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: session }) + '\\n')
} else if (tool === 'claude') {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, session_id: session, result: JSON.stringify(answer), structured_output: answer }))
} else {
  const text = mode === 'prose' ? 'The work looks fine to me.' : JSON.stringify(answer)
  for (const event of [{ type: 'step_start' }, { type: 'text', part: { type: 'text', text } }, { type: 'step_finish' }]) process.stdout.write(JSON.stringify({ ...event, sessionID: session }) + '\\n')
}
`

const commands: Readonly<Record<EvaluatorTool, string>> = { codexcli: 'codex', claudecode: 'claude', opencode: 'opencode' }
const schema = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } } }
const prompt = expect.stringMatching(/^Read exactly the request JSON at \S+ with SHA-256 [a-f0-9]{64}; .* matches the JSON Schema at \S+\.$/)
const roots: string[] = []
afterEach(async () => {
    boundary.steps.length = 0; boundary.requests.length = 0
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function machine(installed: readonly EvaluatorTool[]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-evaluate-'))); roots.push(root)
    const tools = join(root, 'tools'); const repository = join(root, 'repository')
    await Promise.all([mkdir(tools), mkdir(repository)])
    await symlink(process.execPath, join(tools, 'node'))
    for (const tool of installed) { await writeFile(join(tools, commands[tool]), fake); await chmod(join(tools, commands[tool]), 0o700) }
    const directories = [tools]
    const request = async (evaluators: readonly EvaluatorTool[], document: Record<string, unknown>, overrides: Partial<EvaluationRequest> = {}): Promise<EvaluationRequest> => ({
        chain: await locateEvaluators(evaluators, directories), role: 'grader', document: { answer: { verdict: 'pass' }, ...document }, schema, repository,
        timeoutMs: 30_000, timeoutField: 'work.evaluator_timeout_seconds', executableDirectories: directories,
        environment: { HOME: '/synthetic-home', USER: 'synthetic', CODEX_HOME: '/synthetic-home/.codex', XDG_DATA_HOME: '/synthetic-home/.data', CLAUDE_CODE_SESSION_ID: 'worker-session', SECRET: 'x' },
        ...overrides,
    })
    return { root, tools, repository, request }
}

const runs = () => boundary.steps.filter(step => step.labels.owner === 'independent-evaluator')

describe('independent evaluation', () => {
    // Each tool's read-only mechanism, user-customisation switch and session spelling is what keeps the
    // evaluator apart from the agent that did the work, so each is pinned exactly.
    it.each([
        { tool: 'codexcli' as const, environment: ['CODEX_HOME', 'HOME', 'PATH'],
            argv: (step: ExecutionStep) => ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', step.cwd, '--json',
                '--output-schema', join(step.cwd, 'schema.json'), '--output-last-message', join(step.cwd, 'response.json'), prompt] },
        { tool: 'claudecode' as const, environment: ['HOME', 'PATH', 'USER'],
            argv: (_step: ExecutionStep, repository: string) => ['--print', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--no-session-persistence', '--safe-mode',
                '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--add-dir', repository, '--', prompt] },
        { tool: 'opencode' as const, environment: ['HOME', 'OPENCODE_PERMISSION', 'PATH', 'XDG_DATA_HOME'],
            argv: () => ['run', '--pure', '--format', 'json', '--print-logs', '--log-level', 'ERROR', prompt] },
    ])('runs $tool headless, read-only, from a private directory, passing only what it needs', async ({ tool, environment, argv }) => {
        const host = await machine([tool])
        const result = await evaluate(await host.request([tool], {}))
        expect(result).toMatchObject({ kind: 'answer', tool, value: { verdict: 'pass' }, sessionId: expect.any(String), fallbacks: [] })
        const [run] = runs()
        expect(runs()).toHaveLength(1)
        expect(run!.argv0).toBe(join(host.tools, commands[tool]))
        expect(run!.argv.slice(1)).toEqual(argv(run!, host.repository))
        expect(run!.cwd.startsWith(`${host.root}/`)).toBe(false)
        // The worker's session variables and anything secret never cross over.
        expect(Object.keys(run!.env).sort()).toEqual(environment)
        if (tool === 'opencode') expect(JSON.parse(run!.env.OPENCODE_PERMISSION!)).toEqual({ edit: 'deny', bash: 'deny', task: 'deny', todowrite: 'deny', question: 'deny',
            webfetch: 'deny', websearch: 'deny', lsp: 'deny', doom_loop: 'deny', skill: 'deny', external_directory: 'allow' })
        expect(boundary.requests[0]).toMatchObject({ answer: { verdict: 'pass' }, restriction: expect.stringContaining(commands[tool]) })
    })

    it.each([
        ['codexcli' as const, 'the Codex CLI exited with status 1: Not signed in; if it is not signed in, run codex login, then rerun'],
        ['claudecode' as const, 'Claude Code exited with status 1: Not logged in · Please run /login; if it is not signed in, run claude auth login, then rerun'],
        ['opencode' as const, 'OpenCode exited with status 1: Authentication failed (APIError: Authentication failed); if it is not signed in, run opencode auth login, then rerun'],
    ])('refuses a signed-out %s with the cause it reported and the sign-in that fixes it', async (tool, message) => {
        const host = await machine([tool])
        await expect(evaluate(await host.request([tool], { mode: 'signed-out' }))).resolves.toMatchObject({ kind: 'refusal', code: 'EVALUATOR_RUN_FAILED', message,
            fix: expect.stringContaining('sign in to it'), attempts: [{ tool, code: 'EVALUATOR_RUN_FAILED', message }] })
    })

    it('moves the tool running the command last in the default order, and only when exactly one runner is detected', () => {
        const listed: readonly EvaluatorTool[] = ['claudecode', 'codexcli', 'opencode']
        expect(defaultEvaluatorOrder(listed, { CLAUDECODE: '1' })).toEqual(['codexcli', 'opencode', 'claudecode'])
        expect(defaultEvaluatorOrder(listed, { CODEX_THREAD_ID: 'thread' })).toEqual(['claudecode', 'opencode', 'codexcli'])
        expect(defaultEvaluatorOrder(listed, {})).toEqual(listed)
        expect(defaultEvaluatorOrder(listed, { CLAUDECODE: '1', CODEX_THREAD_ID: 'thread' })).toEqual(listed)
        expect(defaultEvaluatorOrder(['claudecode'], { CLAUDECODE: '1' })).toEqual(['claudecode'])
    })

    it('falls through an outdated and a signed-out evaluator in order and records each it passed over', async () => {
        const host = await machine(['codexcli', 'claudecode', 'opencode'])
        await writeFile(join(host.tools, 'codex.old'), '')
        const answered = await evaluate(await host.request(['codexcli', 'claudecode', 'opencode'], { modes: { claude: 'signed-out' } }))
        expect(answered).toMatchObject({ kind: 'answer', tool: 'opencode', fallbacks: [
            { tool: 'codexcli', code: 'EVALUATOR_UNAVAILABLE', message: expect.stringContaining('does not offer codex exec --ephemeral') },
            { tool: 'claudecode', code: 'EVALUATOR_RUN_FAILED', message: expect.stringContaining('Not logged in') }] })
        expect(runs().map(step => step.labels.tool)).toEqual(['claudecode', 'opencode'])
        await expect(evaluate(await host.request(['claudecode', 'opencode'], { mode: 'signed-out' }))).resolves.toMatchObject({ kind: 'refusal', code: 'EVALUATOR_RUN_FAILED',
            message: expect.stringMatching(/^Claude Code exited .*; then OpenCode exited/), attempts: [{ tool: 'claudecode' }, { tool: 'opencode' }] })
    })

    it('refuses, naming the install and sign-in of each, when no listed evaluator is on PATH', async () => {
        const host = await machine(['opencode'])
        await expect(evaluate(await host.request(['codexcli', 'claudecode'], {}))).resolves.toMatchObject({ kind: 'refusal', code: 'EVALUATOR_UNAVAILABLE',
            fix: expect.stringContaining('npx --no cockpit doctor --config'),
            message: expect.stringMatching(/^the Codex CLI \(codex\) is not on PATH; install it with npm install -g @openai\/codex and sign in with codex login; then Claude Code \(claude\) is not on PATH/) })
        expect(runs()).toEqual([])
        // A tool that is simply absent names no path of its own: the last PATH entry tried is not its cause.
        await expect(evaluate(await host.request(['codexcli'], {}))).resolves.toMatchObject({ message: expect.not.stringContaining('ENOENT') })
        await expect(findEvaluators(['codexcli', 'opencode'], [host.tools])).resolves.toMatchObject({ found: ['opencode'], missing: [{ tool: 'codexcli' }] })
    })

    it('refuses an answer it cannot trust without trying the next evaluator, which would shop for a verdict', async () => {
        const host = await machine(['opencode', 'claudecode'])
        await expect(evaluate(await host.request(['opencode', 'claudecode'], { mode: 'prose' }))).resolves.toMatchObject({ kind: 'refusal', code: 'EVALUATOR_ANSWER_INVALID',
            message: expect.stringContaining('the evaluator answer') })
        // Nothing constrains OpenCode's answer but this check against the caller's schema.
        await expect(evaluate(await host.request(['opencode', 'claudecode'], { mode: 'extra' }))).resolves.toMatchObject({ kind: 'refusal', code: 'EVALUATOR_ANSWER_INVALID',
            message: 'the evaluator answer does not match its output schema: answer has the undeclared field extra' })
        await expect(evaluate(await host.request(['opencode'], { answer: { verdict: 'maybe' } }))).resolves.toMatchObject({ kind: 'refusal',
            message: 'the evaluator answer does not match its output schema: answer.verdict is not one of pass, fail' })
        expect(runs().map(step => step.labels.tool)).toEqual(['opencode', 'opencode', 'opencode'])
        await expect(evaluate(await host.request(['claudecode'], { mode: 'replay' }))).resolves.toMatchObject({ kind: 'answer' })
        await expect(evaluate(await host.request(['claudecode'], { mode: 'replay' }))).resolves.toMatchObject({ kind: 'refusal', code: 'EVALUATOR_ANSWER_INVALID',
            message: 'Claude Code answered in session fixed-session, which already answered another evaluation' })
    })

    it('stops an evaluator that keeps retrying at its timeout and names the last error it reported', async () => {
        const host = await machine(['opencode'])
        await expect(evaluate(await host.request(['opencode'], { mode: 'rate-limited' }, { timeoutMs: 1_000 }))).resolves.toMatchObject({ kind: 'refusal', code: 'EVALUATOR_RUN_FAILED',
            message: 'OpenCode timed out after 1 seconds after reporting: AI_APICallError: Free usage limit reached; raise work.evaluator_timeout_seconds' })
    })
})
