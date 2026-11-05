import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli, type CliIo } from '../cli.js'

// The filesystem is the boundary: a case swaps a directory for a link around one open, as a concurrent writer could.
const opening = vi.hoisted(() => ({ around: undefined as undefined | ((path: string) => (() => void) | undefined) }))
vi.mock('node:fs/promises', async importOriginal => {
    const real = await importOriginal<typeof import('node:fs/promises')>()
    return { ...real, open: async (...args: Parameters<typeof real.open>) => {
        const after = opening.around?.(String(args[0]))
        try { return await real.open(...args) } finally { after?.() }
    } }
})

// Each case is a real cockpit in a throwaway Git repository, and the checks run as real processes.
// Only the person is simulated, by the terminal answer `confirmWorkOrder` returns.
const roots: string[] = []
afterEach(() => { opening.around = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], { cwd: root, stdio: 'pipe' })
const order = (id: string, criteria = '  - id: AC1\n    text: add(2, 3) returns 5.\n    check: [node, test/add.test.mjs]') =>
    `---\nid: ${id}\nobjective: add sums two numbers.\nscope: [src/, test/]\ncriteria:\n${criteria}\n---\n\nNotes.\n`

async function cockpit(policy: string): Promise<string> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-work-lifecycle-')))
    roots.push(root)
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'test')); mkdirSync(join(root, 'workorders'))
    writeFileSync(join(root, 'cockpit.toml'), ['[cockpit]', 'name = "lifecycle"', 'siblings_root = "."', '', '[[sibling]]', 'slug = "app"', 'dir = "."',
        'mount = "none"', 'acquire = "none"', 'var = "APP_DIR"', 'purpose = "The product"', '', '[ports]', 'bases = {}', '', policy, ''].join('\n'))
    writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => a + b\n')
    writeFileSync(join(root, 'test/add.test.mjs'), "import { add } from '../src/add.mjs'\nif (add(2, 3) !== 5) process.exit(1)\nconsole.log('add(2, 3) returned 5')\n")
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'cockpit')
    return root
}

async function work(root: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
    let stdout = ''
    const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: () => true } }
    const status = await runCli([...args, '--config', join(root, 'cockpit.toml'), '--json'], io, {}, { env })
    return { status, ...JSON.parse(stdout) as { result: Record<string, unknown> | null; diagnostics: readonly { code: string; message: string }[];
        guidance?: readonly { code: string; text: string }[] } }
}

// A synthetic Claude Code on PATH, so a grade runs end to end without a model. It answers every
// criterion with the verdict in the `verdict` file beside it (`unclear` unless a case writes another),
// quoting the first changed file's whole diff, which occurs exactly once there, as a `met`'s evidence.
function syntheticEvaluator(): string {
    const tools = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-work-evaluator-')))
    roots.push(tools)
    symlinkSync(process.execPath, join(tools, 'node'))
    writeFileSync(join(tools, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs'); const argv = process.argv.slice(2)
if (argv[0] === '--version') { process.stdout.write('claude 1.0.0\\n'); process.exit(0) }
if (argv.at(-1) === '--help') { process.stdout.write('--print --output-format --json-schema --no-session-persistence --safe-mode --strict-mcp-config --tools --permission-mode --add-dir\\n'); process.exit(0) }
const request = JSON.parse(fs.readFileSync(/request JSON at (\\S+) with SHA-256/.exec(argv.at(-1))[1], 'utf8'))
const verdict = fs.existsSync(__dirname + '/verdict') ? fs.readFileSync(__dirname + '/verdict', 'utf8').trim() : 'unclear'
const evidence = verdict === 'met' ? [{ source: request.changes[0].path, quote: request.changes[0].diff }] : []
const answer = { criteria: request.order.criteria.map(row => ({ id: row.id, verdict, note: 'synthetic: ' + row.text, evidence })) }
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, session_id: require('node:crypto').randomUUID(), result: JSON.stringify(answer), structured_output: answer }))
`)
    chmodSync(join(tools, 'claude'), 0o700)
    return tools
}
// A person at a terminal: no JSON, --interactive, and the answer they type to the prompt they read.
async function asPerson(root: string, args: readonly string[], answer: (prompt: string, digest: string) => string): Promise<number> {
    const io: CliIo = { stdout: { write: () => true }, stderr: { write: () => true }, confirmWorkOrder: async ({ prompt, digest }) => answer(prompt, digest) }
    return runCli([...args, '--config', join(root, 'cockpit.toml'), '--interactive'], io, {}, { env: { ...process.env, CI: '' } })
}
const record = (root: string, id: string) => JSON.parse(readFileSync(join(root, `.cockpit/work-orders/${id}.json`), 'utf8')) as Record<string, any>

describe('work-order lifecycle', () => {
    it('grades a criteria file against the uncommitted change without counting the file itself as outside scope', async () => {
        const root = await cockpit('[work]\nevaluators = ["claudecode", "codexcli"]')
        // Only the synthetic Claude Code answers: a Codex installed on this machine is left off PATH.
        const tools = syntheticEvaluator()
        const env = { ...process.env, CLAUDECODE: undefined, CODEX_THREAD_ID: undefined, PATH: [tools, ...(process.env.PATH ?? '').split(':').filter(dir => dir && !existsSync(join(dir, 'codex')))].join(':') }
        writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => b + a\n')
        writeFileSync(join(root, 'criteria.md'), '---\nscope: [src/]\ncriteria:\n  - id: AC1\n    text: add(2, 3) returns 5.\n    check: [node, test/add.test.mjs]\n---\n')
        const graded = await work(root, ['grade', '--criteria', 'criteria.md'], env)
        expect(graded).toMatchObject({ status: 2, diagnostics: [{ code: 'WORK_GRADE_UNSATISFIED' }],
            result: { outOfScope: [], checks: [{ criterion: 'AC1', passed: true }], criteria: [{ id: 'AC1', verdict: 'unclear' }], evaluator: { tool: 'claudecode' } } })
        // An absolute path inside the repository is the same file; one outside it is refused by name.
        expect(await work(root, ['grade', '--criteria', join(root, 'criteria.md')], env)).toMatchObject({ status: 2, diagnostics: [{ code: 'WORK_GRADE_UNSATISFIED' }], result: { checks: [{ passed: true }] } })
        for (const outside of ['../criteria.md', join(root, '..', 'criteria.md')]) {
            expect(await work(root, ['grade', '--criteria', outside], env)).toMatchObject({ status: 2, diagnostics: [{ code: 'CLI_USAGE_INVALID', message: expect.stringContaining('--criteria') }] })
        }
        // Graded by the tool running the command only because the other was passed over: a warning says so and how to change it.
        const sameTool = await work(root, ['grade', '--criteria', 'criteria.md'], { ...env, CLAUDECODE: '1' })
        expect(sameTool.result).toMatchObject({ evaluator: { tool: 'claudecode', fallbacks: [{ tool: 'codexcli' }] } })
        expect(sameTool.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'EVALUATOR_FELL_BACK_TO_RUNNING_TOOL',
            message: expect.stringContaining('the Codex CLI (codex) is not on PATH') }))
        expect(graded.diagnostics.map(row => row.code)).not.toContain('EVALUATOR_FELL_BACK_TO_RUNNING_TOOL')
        // The fix names the command that was run, not an order this grade does not have.
        expect(graded.guidance?.[0]?.text).toContain(`npx --no cockpit grade --config ${join(root, 'cockpit.toml')} --criteria <file>`)
        // A person who names the grader gets that tool or a refusal, never another listed tool that is available.
        const named = await work(root, ['grade', '--criteria', 'criteria.md', '--evaluator', 'codexcli'], env)
        expect(named).toMatchObject({ status: 2, result: null, diagnostics: [{ message: expect.stringMatching(/^EVALUATOR_UNAVAILABLE: the Codex CLI \(codex\) is not on PATH/) }] })
        // A change outside scope is the evaluator's to judge, not a failure by itself.
        writeFileSync(join(root, 'README.md'), 'add sums two numbers\n')
        writeFileSync(join(tools, 'verdict'), 'met')
        expect(await work(root, ['grade', '--criteria', 'criteria.md'], env)).toMatchObject({ status: 0,
            result: { outOfScope: ['README.md'], criteria: [{ id: 'AC1', verdict: 'met' }, { id: 'scope-changes-necessary', verdict: 'met' }] } })
        expect(existsSync(join(root, '.cockpit/work-orders'))).toBe(false)
    })

    it('runs no fsmonitor the repository configures while it observes an order', async () => {
        const root = await cockpit('[work]\ngrading = "checks"\n\n[work.gates]\naccept = "agent"')
        const tools = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-work-monitor-')))
        roots.push(tools)
        writeFileSync(join(tools, 'monitor.sh'), `#!/bin/sh\ntouch ${join(tools, 'monitor-ran')}\n`, { mode: 0o755 })
        git(root, 'config', 'core.fsmonitor', join(tools, 'monitor.sh'))
        writeFileSync(join(root, 'workorders/WO-1.md'), order('WO-1'))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-1'])).result).toMatchObject({ state: 'accepted' })
        expect(await work(root, ['work', 'check', '--work-order', 'WO-1'])).toMatchObject({ status: 0 })
        expect(await work(root, ['work', 'grade', '--work-order', 'WO-1'])).toMatchObject({ status: 0, result: { state: 'graded' } })
        expect(existsSync(join(tools, 'monitor-ran'))).toBe(false)
    })

    it('closes an order as checks-passed only after cockpit ran every check, failing changes outside scope and stale contracts', async () => {
        const root = await cockpit('[work]\ngrading = "checks"\n\n[work.gates]\naccept = "agent"\namend = "person"')
        writeFileSync(join(root, 'workorders/WO-1.md'), order('WO-1'))
        expect((await work(root, ['work', 'status'])).result).toMatchObject({ orders: [{ id: 'WO-1', state: 'draft' }], wip: { open: 0, cap: 3 } })
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-1'])).result).toMatchObject({ state: 'accepted', by: 'agent' })
        expect(record(root, 'WO-1')).toMatchObject({ state: 'accepted', accepted: { by: 'agent', base: { '.': expect.stringMatching(/^[a-f0-9]{40}$/) } } })
        expect(await work(root, ['work', 'check', '--work-order', 'WO-1'])).toMatchObject({ status: 0, result: { state: 'checked', results: [{ criterion: 'AC1', passed: true }] } })

        writeFileSync(join(root, 'README.md'), 'outside the scope\n')
        const outside = await work(root, ['work', 'grade', '--work-order', 'WO-1'])
        expect(outside).toMatchObject({ status: 2, diagnostics: [{ code: 'WORK_GRADE_UNSATISFIED' }], result: { outOfScope: ['README.md'], state: 'accepted' } })
        rmSync(join(root, 'README.md'))

        // An edited contract is stale until its change is accepted, and adding a criterion is the amend gate's.
        writeFileSync(join(root, 'workorders/WO-1.md'), order('WO-1', '  - id: AC1\n    text: add(2, 3) returns 5.\n    check: [node, test/add.test.mjs]\n  - id: AC2\n    text: add is exported.\n    check: [node, test/add.test.mjs]'))
        expect((await work(root, ['work', 'status'])).result).toMatchObject({ orders: [{ id: 'WO-1', state: 'stale' }] })
        expect((await work(root, ['work', 'check', '--work-order', 'WO-1'])).diagnostics[0]?.message).toMatch(/changed since it was accepted/)
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-1'])).diagnostics[0]?.code).toBe('WORK_PERSON_REQUIRED')
        expect(await asPerson(root, ['work', 'accept', '--work-order', 'WO-1'], (_prompt, digest) => `amend ${digest}`)).toBe(0)
        expect(record(root, 'WO-1').amendments).toEqual([expect.objectContaining({ by: 'person', weakened: [] })])

        expect(await work(root, ['work', 'grade', '--work-order', 'WO-1'])).toMatchObject({ status: 0, result: { state: 'graded', mode: 'checks', outOfScope: [] } })
        expect((await work(root, ['work', 'signoff', '--work-order', 'WO-1'])).result).toMatchObject({ state: 'done', closedAs: 'checks-passed', by: 'agent' })
        expect((await work(root, ['work', 'status'])).result).toMatchObject({ orders: [{ id: 'WO-1', state: 'done', closedAs: 'checks-passed', closedBy: 'agent' }], wip: { open: 0 } })
        expect((await work(root, ['work', 'verify'])).status).toBe(0)
    }, 120_000)

    it('records a self-reported closure only with the agent\'s verdict and a note that names each change outside scope, and still fails a failed check', async () => {
        const root = await cockpit('[work]\ngrading = "self"')
        writeFileSync(join(root, 'workorders/WO-2.md'), order('WO-2', '  - id: AC1\n    text: The change reads well.\n  - id: AC2\n    text: add(2, 3) returns 5.\n    check: [node, test/add.test.mjs]'))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-2'])).status).toBe(0)
        expect((await work(root, ['work', 'grade', '--work-order', 'WO-2'])).diagnostics[0]?.message).toMatch(/pass --verdict met\|unmet and --note/)
        // A check cockpit can run is a fact, not the agent's judgement: its own `met` does not cover it.
        writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => a - b\n')
        writeFileSync(join(root, 'README.md'), 'outside the scope\n')
        const grade = (note: string) => work(root, ['work', 'grade', '--work-order', 'WO-2', '--verdict', 'met', '--note', note])
        // Whether a change outside scope was needed is the agent's verdict, so its note must at least name it.
        expect((await grade('read the diff')).diagnostics[0]?.message).toMatch(/--note must name each path changed outside scope .* it does not name README\.md/)
        expect(await grade('read the diff; README.md documents add')).toMatchObject({ status: 2,
            diagnostics: [{ code: 'WORK_GRADE_UNSATISFIED' }], result: { state: 'accepted', mode: 'self', checks: [{ criterion: 'AC2', passed: false }], outOfScope: ['README.md'] } })
        writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => a + b\n')
        expect((await grade('read the diff; README.md documents add')).result).toMatchObject({ state: 'graded', mode: 'self', outOfScope: ['README.md'],
            criteria: [{ id: 'AC1' }, { id: 'AC2' }, { id: 'scope-changes-necessary', verdict: 'met', note: 'read the diff; README.md documents add' }] })
        expect((await work(root, ['work', 'signoff', '--work-order', 'WO-2'])).result).toMatchObject({ closedAs: 'self-reported' })
    }, 120_000)

    it('records a relayed subagent verdict as subagent-reported, saying cockpit cannot verify it, under the same rules as a self-reported one', async () => {
        const root = await cockpit('[work]\ngrading = "subagent"')
        writeFileSync(join(root, 'workorders/WO-2.md'), order('WO-2', '  - id: AC1\n    text: The change reads well.\n  - id: AC2\n    text: add(2, 3) returns 5.\n    check: [node, test/add.test.mjs]'))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-2'])).status).toBe(0)
        const grade = (...extra: string[]) => work(root, ['work', 'grade', '--work-order', 'WO-2', ...extra])
        // A submission states all of it or none of it: a verdict that does not say where it came from is refused.
        expect((await grade('--verdict', 'met', '--note', 'read the diff')).diagnostics[0]?.message).toMatch(/--from-subagent, --verdict met\|unmet and --note/)
        expect((await grade('--from-subagent')).diagnostics[0]?.message).toMatch(/--from-subagent, --verdict met\|unmet and --note/)
        const submit = (note: string) => grade('--from-subagent', '--verdict', 'met', '--note', note)
        writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => a - b\n')
        writeFileSync(join(root, 'README.md'), 'outside the scope\n')
        expect((await submit('read the diff')).diagnostics[0]?.message).toMatch(/\[work\] grading = "subagent": --note must name each path changed outside scope .* it does not name README\.md/)
        expect(await submit('read the diff; README.md documents add')).toMatchObject({ status: 2,
            diagnostics: [{ code: 'WORK_GRADE_UNSATISFIED' }], result: { state: 'accepted', mode: 'subagent', checks: [{ criterion: 'AC2', passed: false }] } })
        writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => a + b\n')
        const passed = await submit('read the diff; README.md documents add')
        expect(passed.result).toMatchObject({ state: 'graded', mode: 'subagent', criteria: [{ id: 'AC1' }, { id: 'AC2' }, { id: 'scope-changes-necessary', verdict: 'met' }],
            answeredBy: expect.stringMatching(/relayed .* cannot verify that one did, and read-only is instructed there, not enforced/) })
        expect(record(root, 'WO-2').grade).toMatchObject({ mode: 'subagent' })
        expect(record(root, 'WO-2').grade.evaluator).toBeUndefined()
        expect((await work(root, ['work', 'signoff', '--work-order', 'WO-2'])).result).toMatchObject({ closedAs: 'subagent-reported' })
        expect((await work(root, ['work', 'status'])).result).toMatchObject({ grading: 'subagent', orders: [{ id: 'WO-2', closedAs: 'subagent-reported', grade: { mode: 'subagent' } }] })
        expect((await work(root, ['work', 'verify'])).status).toBe(0)
        // Other modes take no such statement.
        const other = await cockpit('[work]\ngrading = "self"')
        writeFileSync(join(other, 'workorders/WO-3.md'), order('WO-3'))
        await work(other, ['work', 'accept', '--work-order', 'WO-3'])
        expect((await work(other, ['work', 'grade', '--work-order', 'WO-3', '--from-subagent', '--verdict', 'met', '--note', 'n'])).diagnostics[0]?.message).toMatch(/--from-subagent applies only under/)
        expect((await work(other, ['work', 'grade', '--work-order', 'WO-3', '--evaluator', 'claudecode', '--verdict', 'met', '--note', 'n'])).diagnostics[0]?.message).toMatch(/--evaluator .* cannot accompany a submitted --verdict/)
    }, 120_000)

    it('moves a subagent grade with nothing submitted up to a separate process, and refuses rather than falling to anything weaker, naming each cause and each choice', async () => {
        const root = await cockpit('[work]\ngrading = "subagent"\nevaluators = ["claudecode"]')
        const tools = syntheticEvaluator()
        const env = { ...process.env, CLAUDECODE: undefined, CODEX_THREAD_ID: undefined, PATH: [tools, process.env.PATH].join(':') }
        writeFileSync(join(tools, 'verdict'), 'met')
        writeFileSync(join(root, 'workorders/WO-4.md'), order('WO-4'))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-4'], env)).status).toBe(0)
        writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => b + a\n')
        const empty = { ...env, PATH: '/usr/bin:/bin' }
        // Nothing can answer: the order stays open, and the refusal says why and what can be done.
        const unavailable = await work(root, ['work', 'grade', '--work-order', 'WO-4'], empty)
        expect(unavailable).toMatchObject({ status: 2, result: null })
        expect(unavailable.diagnostics[0]?.message).toMatch(/^EVALUATOR_UNAVAILABLE: Claude Code \(claude\) is not on PATH.*sign in.*or list one you have in work\.evaluators; or have a person move \[work\] grading to checks, self or off/)
        expect(record(root, 'WO-4')).toMatchObject({ state: 'accepted' })
        expect(record(root, 'WO-4').grade).toBeUndefined()
        // A tool that starts and fails, as one refused by a sandbox or signed out does, names its cause too.
        const broken = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-work-broken-')))
        roots.push(broken)
        symlinkSync(process.execPath, join(broken, 'node'))
        writeFileSync(join(broken, 'claude'), readFileSync(join(tools, 'claude'), 'utf8').replace("const request = JSON.parse", "process.stderr.write('sandbox refused a nested run\\n'); process.exit(1)\nconst request = JSON.parse"), { mode: 0o700 })
        const failed = await work(root, ['work', 'grade', '--work-order', 'WO-4'], { ...env, PATH: [broken, process.env.PATH].join(':') })
        expect(failed.diagnostics[0]?.message).toMatch(/^EVALUATOR_RUN_FAILED: .*sandbox refused a nested run.*sign in to it.*list another tool in work\.evaluators.*have a person move \[work\] grading to checks, self or off/)
        expect(record(root, 'WO-4').grade).toBeUndefined()
        // Once the evaluator found the work unmet, a relayed pass cannot replace that.
        writeFileSync(join(tools, 'verdict'), 'unclear')
        expect(await work(root, ['work', 'grade', '--work-order', 'WO-4'], env)).toMatchObject({ status: 2, result: { state: 'accepted', mode: 'independent' } })
        expect((await work(root, ['work', 'grade', '--work-order', 'WO-4', '--from-subagent', '--verdict', 'met', '--note', 'read the diff'], env)).diagnostics[0]?.message)
            .toMatch(/a separate evaluator already found WO-4's accepted contract unmet, and a relayed verdict cannot replace that/)
        writeFileSync(join(tools, 'verdict'), 'met')
        // The record says what answered: the process, never the subagent the mode names.
        const graded = await work(root, ['work', 'grade', '--work-order', 'WO-4'], env)
        expect(graded.result).toMatchObject({ state: 'graded', mode: 'independent', evaluator: { tool: 'claudecode' }, answeredBy: expect.stringContaining('a separate claudecode process') })
        expect(record(root, 'WO-4').grade).toMatchObject({ mode: 'independent', evaluator: { tool: 'claudecode' } })
        expect((await work(root, ['work', 'signoff', '--work-order', 'WO-4'], env)).result).toMatchObject({ closedAs: 'graded' })
    }, 120_000)

    it('warns when the only evaluator is the tool running the command, as a separate process cockpit read', async () => {
        const root = await cockpit('[work]\nevaluators = ["claudecode"]')
        const tools = syntheticEvaluator()
        const env = { ...process.env, CLAUDECODE: undefined, CODEX_THREAD_ID: undefined, PATH: [tools, process.env.PATH].join(':') }
        writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => b + a\n')
        writeFileSync(join(root, 'criteria.md'), '---\nscope: [src/]\ncriteria:\n  - id: AC1\n    text: add(2, 3) returns 5.\n---\n')
        const grade = (extra: NodeJS.ProcessEnv) => work(root, ['grade', '--criteria', 'criteria.md'], { ...env, ...extra })
        const sameTool = await grade({ CLAUDECODE: '1' })
        expect(sameTool.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'EVALUATOR_IS_RUNNING_TOOL', message: expect.stringContaining('as a separate process') }))
        expect(sameTool.guidance).toContainEqual(expect.objectContaining({ code: 'EVALUATOR_IS_RUNNING_TOOL', text: expect.stringContaining('list a second tool in work.evaluators') }))
        expect((await grade({})).diagnostics.map(row => row.code)).not.toContain('EVALUATOR_IS_RUNNING_TOOL')
    }, 120_000)

    it('tracks an order with the grader off: it closes as ungraded whatever its checks showed, says so, and keeps the facts', async () => {
        const root = await cockpit('[work]\ngrading = "off"\nattempt_cap = 1')
        const criteria = '  - id: AC1\n    text: The change reads well.\n  - id: AC2\n    text: add(2, 3) returns 5.\n    check: [node, test/add.test.mjs]'
        writeFileSync(join(root, 'workorders/WO-8.md'), order('WO-8', criteria))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-8'])).status).toBe(0)
        expect((await work(root, ['work', 'note', '--work-order', 'WO-8', '--text', 'started'])).status).toBe(0)
        expect((await work(root, ['work', 'grade', '--work-order', 'WO-8'])).diagnostics[0]?.message).toMatch(/grading = "off": nothing grades an order; close it with .*work signoff/)
        // A criterion with no check and a check never run hold nothing up.
        const closed = await work(root, ['work', 'signoff', '--work-order', 'WO-8'])
        expect(closed).toMatchObject({ status: 0, result: { state: 'done', closedAs: 'ungraded', checksNotRun: ['AC2'], checksFailed: [] } })
        expect(record(root, 'WO-8')).toMatchObject({ state: 'done', closure: { how: 'ungraded', by: 'agent' } })
        expect(record(root, 'WO-8').grade).toBeUndefined()
        expect((await work(root, ['work', 'status'])).result).toMatchObject({ grading: 'off', orders: [{ id: 'WO-8', state: 'done', closedAs: 'ungraded', checksNotRun: ['AC2'] }] })
        expect((await work(root, ['work', 'verify'])).status).toBe(0)

        // A check that failed does not block, attempt cap included, and stays on the record.
        writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => a - b\n')
        writeFileSync(join(root, 'workorders/WO-9.md'), order('WO-9'))
        await work(root, ['work', 'accept', '--work-order', 'WO-9'])
        expect(await work(root, ['work', 'check', '--work-order', 'WO-9'])).toMatchObject({ status: 2, diagnostics: [{ code: 'WORK_CHECK_FAILED' }] })
        expect((await work(root, ['work', 'status', '--work-order', 'WO-9'])).result).toMatchObject({ orders: [{ id: 'WO-9', state: 'accepted', attempts: 0 }] })
        const failed = await work(root, ['work', 'signoff', '--work-order', 'WO-9', '--note', 'shipped with the failure known'])
        expect(failed.result).toMatchObject({ state: 'done', closedAs: 'ungraded', checksFailed: [expect.stringMatching(/^AC1: /)], checksNotRun: [] })
        expect(record(root, 'WO-9')).toMatchObject({ closure: { how: 'ungraded', note: 'shipped with the failure known' }, checks: { results: [{ criterion: 'AC1', passed: false }] } })
        expect((await work(root, ['work', 'status', '--work-order', 'WO-9'])).result).toMatchObject({ orders: [{ closedAs: 'ungraded', checksFailed: [expect.stringMatching(/^AC1: /)] }] })

        for (const close of ['--partial', '--abandon']) {
            const id = close === '--partial' ? 'WO-10' : 'WO-11'
            writeFileSync(join(root, `workorders/${id}.md`), order(id))
            await work(root, ['work', 'accept', '--work-order', id])
            expect((await work(root, ['work', 'signoff', '--work-order', id, close, '--note', 'stopped'])).result).toMatchObject({ closedAs: close === '--partial' ? 'partial' : 'abandoned' })
        }
        expect((await work(root, ['work', 'verify'])).status).toBe(0)
    }, 120_000)

    it('keeps the signoff gate with the grader off, and an earlier real grade closes as what it was', async () => {
        const person = await cockpit('[work]\ngrading = "off"\n\n[work.gates]\nsignoff = "person"')
        writeFileSync(join(person, 'workorders/WO-12.md'), order('WO-12'))
        await work(person, ['work', 'accept', '--work-order', 'WO-12'])
        expect(await work(person, ['work', 'signoff', '--work-order', 'WO-12'], { ...process.env, CI: '' })).toMatchObject({ status: 2, diagnostics: [{ code: 'WORK_PERSON_REQUIRED' }], guidance: [{ code: 'WORK_PERSON_REQUIRED', text: expect.stringContaining('--interactive') }] })
        expect(record(person, 'WO-12').closure).toBeUndefined()
        let shown = ''
        expect(await asPerson(person, ['work', 'signoff', '--work-order', 'WO-12'], (prompt, digest) => { shown = prompt; return `signoff ${digest}` })).toBe(0)
        expect(shown).toContain('(ungraded)')
        expect(shown).toContain('Check not run: AC1')
        expect(record(person, 'WO-12').closure).toMatchObject({ how: 'ungraded', by: 'person' })

        // A CI gate can pass with nothing graded: the verify job that confirms it does not ask for a grade.
        const ci = await cockpit('[work]\ngrading = "off"\n\n[work.gates]\nsignoff = "ci"')
        writeFileSync(join(ci, 'workorders/WO-13.md'), order('WO-13'))
        await work(ci, ['work', 'accept', '--work-order', 'WO-13'], { ...process.env, CI: '' })
        expect((await work(ci, ['work', 'signoff', '--work-order', 'WO-13'], { ...process.env, CI: '' })).result).toMatchObject({ closedAs: 'ungraded', by: 'ci' })
        expect((await work(ci, ['work', 'status'], { ...process.env, CI: '' })).result).toMatchObject({ orders: [{ awaitingCi: ['signoff'] }] })
        expect(await work(ci, ['work', 'verify'], { ...process.env, CI: 'true' })).toMatchObject({ status: 0, result: { confirmed: ['WO-13 signoff'], problems: [] } })

        // An order the attempt cap blocked under a stricter mode is not left stuck by moving to off.
        const capped = await cockpit('[work]\ngrading = "checks"\nattempt_cap = 1')
        writeFileSync(join(capped, 'src/add.mjs'), 'export const add = (a, b) => a - b\n')
        writeFileSync(join(capped, 'workorders/WO-15.md'), order('WO-15'))
        await work(capped, ['work', 'accept', '--work-order', 'WO-15'])
        await work(capped, ['work', 'check', '--work-order', 'WO-15'])
        expect((await work(capped, ['work', 'status', '--work-order', 'WO-15'])).result).toMatchObject({ orders: [{ state: 'blocked' }] })
        writeFileSync(join(capped, 'cockpit.toml'), readFileSync(join(capped, 'cockpit.toml'), 'utf8').replace('grading = "checks"', 'grading = "off"'))
        expect((await work(capped, ['work', 'signoff', '--work-order', 'WO-15'])).result).toMatchObject({ closedAs: 'ungraded', checksFailed: [expect.stringMatching(/^AC1: /)] })

        const graded = await cockpit('[work]\ngrading = "self"')
        writeFileSync(join(graded, 'workorders/WO-14.md'), order('WO-14'))
        await work(graded, ['work', 'accept', '--work-order', 'WO-14'])
        await work(graded, ['work', 'grade', '--work-order', 'WO-14', '--verdict', 'met', '--note', 'read it'])
        writeFileSync(join(graded, 'cockpit.toml'), readFileSync(join(graded, 'cockpit.toml'), 'utf8').replace('grading = "self"', 'grading = "off"'))
        expect((await work(graded, ['work', 'signoff', '--work-order', 'WO-14'])).result).toMatchObject({ closedAs: 'self-reported' })
    }, 120_000)

    it('holds an order with a recorded decision open until its record is written and filled in, and verifies the record still cites it', async () => {
        const root = await cockpit('[work]\ngrading = "self"\n\n[docs]\ndecisions = "docs/adr"\ndecisions_index = "docs/adr/README.md"')
        mkdirSync(join(root, 'docs/adr'), { recursive: true })
        writeFileSync(join(root, 'docs/adr/README.md'), '# Decisions\n\n- [0001. Keep add pure](0001-keep-add-pure.md)\n')
        writeFileSync(join(root, 'docs/adr/0001-keep-add-pure.md'), '# 0001. Keep add pure\n\nStatus: accepted\n\n`src/add.mjs` has no side effects.\n')
        writeFileSync(join(root, 'docs/adr/0002-name-tests.md'), '# 0002. Name tests\n\nStatus: accepted\n\nTests live beside `lib/`.\n')
        git(root, 'add', '-A'); git(root, 'commit', '-qm', 'decisions')
        writeFileSync(join(root, 'workorders/WO-6.md'), order('WO-6'))
        // Earlier decisions about the code an order may change are put in front of the agent.
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-6'])).result).toMatchObject({ relatedDecisions: ['docs/adr/0001-keep-add-pure.md'] })

        expect((await work(root, ['work', 'note', '--work-order', 'WO-6', '--decision', '--text', 'Sum with the + operator'])).result).toMatchObject({ decision: 1 })
        expect((await work(root, ['work', 'status'])).result).toMatchObject({ orders: [{ id: 'WO-6', openDecisions: [expect.stringContaining('decision 1 (Sum with the + operator) is unresolved')] }] })
        expect((await work(root, ['work', 'grade', '--work-order', 'WO-6', '--verdict', 'met', '--note', 'read the diff'])).result).toMatchObject({ state: 'graded',
            criteria: [{ id: 'AC1' }, { id: 'decisions-recorded', verdict: 'met' }, { id: 'docs-updated', verdict: 'met' }] })
        const signoff = () => work(root, ['work', 'signoff', '--work-order', 'WO-6'])
        expect((await signoff()).diagnostics[0]?.message).toMatch(/cannot close while decision 1 \(Sum with the \+ operator\) is unresolved/)

        // A decisions directory swapped for a link while the record is opened does not redirect the write outside the repository.
        const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-work-outside-')))
        roots.push(outside)
        opening.around = path => {
            if (!path.endsWith('0003-sum-with-the-operator.md')) return undefined
            opening.around = undefined
            renameSync(join(root, 'docs/adr'), join(root, 'docs/adr-held')); symlinkSync(outside, join(root, 'docs/adr'))
            return () => { unlinkSync(join(root, 'docs/adr')); renameSync(join(root, 'docs/adr-held'), join(root, 'docs/adr')) }
        }
        expect((await work(root, ['work', 'decide', '--work-order', 'WO-6', '--decision', '1', '--record', '--supersedes', '1'])).diagnostics[0]?.message)
            .toMatch(/changed while it was opened for writing; nothing was written/)
        expect(readdirSync(outside).map(name => readFileSync(join(outside, name), 'utf8')).join('')).toBe('')

        expect((await work(root, ['work', 'decide', '--work-order', 'WO-6', '--decision', '1', '--record', '--supersedes', '1'])).result)
            .toMatchObject({ record: 'docs/adr/0003-sum-with-the-operator.md' })
        const written = join(root, 'docs/adr/0003-sum-with-the-operator.md')
        expect(readFileSync(written, 'utf8')).toMatch(/^# 0003\. Sum with the \+ operator\n\nStatus: accepted\nWork order: WO-6\nSupersedes: 0001\n/)
        expect(readFileSync(join(root, 'docs/adr/0001-keep-add-pure.md'), 'utf8')).toContain('Status: superseded by 0003\n')
        expect(readFileSync(join(root, 'docs/adr/README.md'), 'utf8')).toMatch(/\n- \[0003\. Sum with the \+ operator\]\(0003-sum-with-the-operator\.md\)\n$/)
        // A record that is still the template does not resolve the decision.
        expect((await signoff()).diagnostics[0]?.message).toMatch(/still holds the template's placeholders/)
        writeFileSync(written, readFileSync(written, 'utf8').replace(/<!-- cockpit: replace this with ([^>]*) -->/g, 'Written: $1'))
        expect((await signoff()).result).toMatchObject({ state: 'done', closedAs: 'self-reported' })

        expect((await work(root, ['work', 'verify'])).status).toBe(0)
        writeFileSync(written, readFileSync(written, 'utf8').replace('Work order: WO-6\n', ''))
        expect(await work(root, ['work', 'verify'])).toMatchObject({ status: 2,
            diagnostics: [{ code: 'WORK_VERIFY_FAILED', message: expect.stringContaining('WO-6 decision 1: its record docs/adr/0003-sum-with-the-operator.md does not cite WO-6') }] })
    }, 120_000)

    it('passes a person gate only for the digest a person types, and never weakens a criterion on an agent\'s word', async () => {
        const root = await cockpit('[work]\ngrading = "checks"\n\n[work.gates]\naccept = "person"\namend = "agent"')
        writeFileSync(join(root, 'workorders/WO-3.md'), order('WO-3', '  - id: AC1\n    text: add(2, 3) returns 5.\n    check: [node, test/add.test.mjs]\n  - id: AC2\n    text: add(0, 0) returns 0.\n    check: [node, test/add.test.mjs]'))
        // The control: an agent's plain run, which has no terminal, is refused and records nothing.
        const refused = await work(root, ['work', 'accept', '--work-order', 'WO-3'])
        expect(refused).toMatchObject({ status: 2, diagnostics: [{ code: 'WORK_PERSON_REQUIRED' }] })
        expect(String(refused.result?.prompt)).toContain('AC2: add(0, 0) returns 0.')
        expect(existsSync(join(root, '.cockpit/work-orders/WO-3.json'))).toBe(false)
        expect(await asPerson(root, ['work', 'accept', '--work-order', 'WO-3'], () => `accept ${'0'.repeat(64)}`)).toBe(2)
        expect(existsSync(join(root, '.cockpit/work-orders/WO-3.json'))).toBe(false)
        expect(await asPerson(root, ['work', 'accept', '--work-order', 'WO-3'], (prompt, digest) => prompt.includes('AC2') ? `accept ${digest}` : '')).toBe(0)
        expect(record(root, 'WO-3').accepted.by).toBe('person')

        // Removing an accepted criterion moves the bar, so amend = "agent" still needs a person for it.
        writeFileSync(join(root, 'workorders/WO-3.md'), order('WO-3'))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-3'])).diagnostics[0]?.code).toBe('WORK_PERSON_REQUIRED')
        expect(await asPerson(root, ['work', 'accept', '--work-order', 'WO-3'], (prompt, digest) => prompt.includes('AC2 is removed') ? `amend ${digest}` : '')).toBe(0)
        expect(record(root, 'WO-3').amendments).toEqual([expect.objectContaining({ by: 'person', weakened: ['AC2 is removed'] })])

        // Under checks grading no model can judge a widened scope, so it is a person's too.
        writeFileSync(join(root, 'workorders/WO-3.md'), order('WO-3').replace('scope: [src/, test/]', 'scope: [src/, test/, docs/]'))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-3'])).diagnostics[0]?.code).toBe('WORK_PERSON_REQUIRED')
        expect(await asPerson(root, ['work', 'accept', '--work-order', 'WO-3'], (prompt, digest) => prompt.includes('Changed scope: "src/, test/" -> "src/, test/, docs/"') ? `amend ${digest}` : '')).toBe(0)
        expect(record(root, 'WO-3').amendments[1]).toMatchObject({ by: 'person', weakened: [], review: [{ field: 'scope', before: 'src/, test/', after: 'src/, test/, docs/' }] })
    }, 120_000)

    it('fails a checks grade that deletes or skips tests until it is acknowledged, by a person where the cockpit sets acknowledge = "person"', async () => {
        const root = await cockpit('[work]\ngrading = "checks"\n\n[work.gates]\nacknowledge = "person"')
        // A second test the order's check does not run, so only the protection can notice its loss.
        writeFileSync(join(root, 'test/extra.test.mjs'), "console.log('extra')\n")
        git(root, 'add', '-A'); git(root, 'commit', '-qm', 'extra test')
        writeFileSync(join(root, 'workorders/WO-4.md'), order('WO-4'))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-4'])).status).toBe(0)
        expect(await work(root, ['work', 'grade', '--work-order', 'WO-4'])).toMatchObject({ status: 0, result: { state: 'graded', testProtection: { findings: [] } } })

        rmSync(join(root, 'test/extra.test.mjs'))
        const weakened = await work(root, ['work', 'grade', '--work-order', 'WO-4'])
        expect(weakened).toMatchObject({ status: 2, diagnostics: [{ code: 'WORK_TEST_WEAKENED', message: expect.stringContaining('test/extra.test.mjs: test-file-removed') }],
            result: { state: 'accepted', criteria: [{ id: 'AC1', verdict: 'met' }, { id: 'test-protection', verdict: 'unmet' }],
                testProtection: { testFiles: expect.stringContaining('built-in') } } })

        // The agent's plain run has no terminal, so it cannot acknowledge for itself; a wrong digest records nothing.
        const note = ['work', 'acknowledge', '--work-order', 'WO-4', '--note', 'the extra test duplicated AC1']
        expect((await work(root, note)).diagnostics[0]?.code).toBe('WORK_PERSON_REQUIRED')
        expect(await asPerson(root, note, () => `acknowledge ${'0'.repeat(64)}`)).toBe(2)
        expect(record(root, 'WO-4').acknowledgements).toEqual([])
        expect(await asPerson(root, note, (prompt, digest) => prompt.includes('test/extra.test.mjs: test-file-removed') ? `acknowledge ${digest}` : '')).toBe(0)
        expect(record(root, 'WO-4').acknowledgements).toEqual([expect.objectContaining({ by: 'person', note: 'the extra test duplicated AC1' })])
        expect(await work(root, ['work', 'grade', '--work-order', 'WO-4'])).toMatchObject({ status: 0, result: { state: 'graded',
            criteria: [{ id: 'AC1' }, { id: 'test-protection', verdict: 'met' }], testProtection: { acknowledgedBy: 'person' } } })

        // The acknowledgement covers what the person read: a test skipped afterwards fails the grade again.
        writeFileSync(join(root, 'test/later.test.mjs'), "test.skip('later', () => {})\n")
        expect(await work(root, ['work', 'grade', '--work-order', 'WO-4'])).toMatchObject({ status: 2, diagnostics: [{ code: 'WORK_TEST_WEAKENED',
            message: expect.stringContaining('test/later.test.mjs: test-skipped') }] })
    }, 120_000)

    it('has the evaluator judge changes outside scope, flagged test changes and an agent\'s rewording, and leaves a lowered bar and a capped order to whom the policy names', async () => {
        const root = await cockpit(['[work]', 'evaluators = ["claudecode"]', 'attempt_cap = 1', '', '[work.gates]', 'signoff = "person"', '', '[testing]', '', '[[testing.stages]]', 'id = "unit"',
            'command = ["node", "test/add.test.mjs"]', 'requires_stack = false', '', '[[testing.gates]]', 'id = "quick"', 'tier = "targeted"', 'stages = ["unit"]', 'changes = "any change"'].join('\n'))
        writeFileSync(join(root, 'test/extra.test.mjs'), "console.log('extra')\n")
        git(root, 'add', '-A'); git(root, 'commit', '-qm', 'extra test')
        const tools = syntheticEvaluator()
        const env = { ...process.env, CLAUDECODE: undefined, CODEX_THREAD_ID: undefined, PATH: [tools, ...(process.env.PATH ?? '').split(':')].join(':') }
        const run = (args: readonly string[]) => work(root, args, env)
        writeFileSync(join(root, 'workorders/WO-7.md'), order('WO-7'))
        expect((await run(['work', 'accept', '--work-order', 'WO-7'])).status).toBe(0)
        // An agent may reword its contract under amend = "agent"; the next grade judges whether that lowered the bar.
        writeFileSync(join(root, 'workorders/WO-7.md'), order('WO-7', '  - id: AC1\n    text: add(2, 3) returns 5 for whole numbers.\n    check: [node, test/add.test.mjs]'))
        expect((await run(['work', 'accept', '--work-order', 'WO-7'])).result).toMatchObject({ amended: true, by: 'agent', judgedAtGrade: ['criteria.AC1'] })
        expect(record(root, 'WO-7').amendments).toEqual([expect.objectContaining({ by: 'agent', review: [{ field: 'criteria.AC1',
            before: 'add(2, 3) returns 5. [check: ["node","test/add.test.mjs"]]', after: 'add(2, 3) returns 5 for whole numbers. [check: ["node","test/add.test.mjs"]]' }] })])

        writeFileSync(join(root, 'README.md'), 'add sums two numbers\n')
        rmSync(join(root, 'test/extra.test.mjs'))
        // Where a model grades, a test-run reports the weakening for the grade to judge instead of failing on it.
        expect(await run(['test-run', '--gate', 'quick', '--mode', 'canonical'])).toMatchObject({ status: 0, result: { testProtection: {
            orders: [{ id: 'WO-7', findings: [expect.stringContaining('test/extra.test.mjs: test-file-removed')] }], note: expect.stringContaining('test-changes-justified') } } })
        writeFileSync(join(tools, 'verdict'), 'met')
        const graded = await run(['work', 'grade', '--work-order', 'WO-7'])
        expect(graded).toMatchObject({ status: 0, result: { state: 'graded', outOfScope: ['README.md'], criteria: [{ id: 'AC1', verdict: 'met' },
            { id: 'scope-changes-necessary', verdict: 'met', note: expect.stringContaining('Changed outside scope: README.md') },
            { id: 'test-changes-justified', verdict: 'met', note: expect.stringContaining('test/extra.test.mjs: test-file-removed') },
            { id: 'amendments-hold-bar', verdict: 'met', note: expect.stringContaining('criteria.AC1: "add(2, 3) returns 5. [check') }] } })

        writeFileSync(join(tools, 'verdict'), 'unmet')
        expect(await run(['work', 'grade', '--work-order', 'WO-7'])).toMatchObject({ status: 2, diagnostics: [{ code: 'WORK_TEST_WEAKENED' },
            { code: 'WORK_GRADE_UNSATISFIED', message: expect.stringContaining('the next amendment of WO-7 is a person\'s') }] })
        // The cap's remedy names whoever [work.gates] names: a person for signoff here, the agent for amend.
        expect((await run(['work', 'check', '--work-order', 'WO-7'])).diagnostics[0]?.message)
            .toMatch(/attempt cap \(1\); record the root cause with work note, then a person closes it with .*--partial\|--abandon --note <why> --interactive, or amend it with an edit to workorders\/WO-7\.md/)
        // A grade that found the agent's amendments lower the bar makes the next amendment a person's.
        writeFileSync(join(root, 'workorders/WO-7.md'), order('WO-7'))
        expect((await run(['work', 'accept', '--work-order', 'WO-7'])).diagnostics[0]?.code).toBe('WORK_PERSON_REQUIRED')
        expect(await asPerson(root, ['work', 'accept', '--work-order', 'WO-7'], (prompt, digest) => prompt.includes('lower the bar') ? `amend ${digest}` : '')).toBe(0)
        // A person's amendment settles the review, so the next grade carries no amendments criterion.
        writeFileSync(join(tools, 'verdict'), 'met')
        expect(((await run(['work', 'grade', '--work-order', 'WO-7'])).result?.criteria as { id: string }[]).map(row => row.id))
            .toEqual(['AC1', 'scope-changes-necessary', 'test-changes-justified'])
    }, 120_000)

    it('keeps the next amendment a person\'s after a grade finds the agent\'s amendments lower the bar, until a person amends', async () => {
        const root = await cockpit('[work]\nevaluators = ["claudecode"]')
        const tools = syntheticEvaluator()
        const env = { ...process.env, CLAUDECODE: undefined, CODEX_THREAD_ID: undefined, PATH: [tools, ...(process.env.PATH ?? '').split(':')].join(':') }
        const run = (args: readonly string[]) => work(root, args, env)
        const reworded = order('WO-10', '  - id: AC1\n    text: add(2, 3) returns 5 for whole numbers.\n    check: [node, test/add.test.mjs]')
        writeFileSync(join(root, 'workorders/WO-10.md'), order('WO-10'))
        expect((await run(['work', 'accept', '--work-order', 'WO-10'])).status).toBe(0)
        writeFileSync(join(root, 'workorders/WO-10.md'), reworded)
        expect((await run(['work', 'accept', '--work-order', 'WO-10'])).result).toMatchObject({ amended: true, by: 'agent' })
        writeFileSync(join(tools, 'verdict'), 'unmet')
        expect((await run(['work', 'grade', '--work-order', 'WO-10'])).result).toMatchObject({ criteria: expect.arrayContaining([{ id: 'amendments-hold-bar', verdict: 'unmet', note: expect.any(String) }]) })
        // A passing check replaces the failed grade; it does not settle what the grade found.
        expect((await run(['work', 'check', '--work-order', 'WO-10'])).result).toMatchObject({ state: 'checked' })
        // Nor may the agent close the order around it.
        expect((await run(['work', 'signoff', '--work-order', 'WO-10', '--abandon', '--note', 'stopping here'])).diagnostics[0]?.code).toBe('WORK_PERSON_REQUIRED')
        writeFileSync(join(root, 'workorders/WO-10.md'), order('WO-10'))
        expect((await run(['work', 'accept', '--work-order', 'WO-10'])).diagnostics[0]?.code).toBe('WORK_PERSON_REQUIRED')
        expect(await asPerson(root, ['work', 'accept', '--work-order', 'WO-10'], (prompt, digest) => prompt.includes('lower the bar') ? `amend ${digest}` : '')).toBe(0)
        // A person's amendment settles it: the agent may reword its contract again.
        writeFileSync(join(root, 'workorders/WO-10.md'), reworded)
        expect((await run(['work', 'accept', '--work-order', 'WO-10'])).result).toMatchObject({ amended: true, by: 'agent' })
    }, 120_000)

    it('removes a crashed command\'s lock only once its holder is shown gone, and records what it checked', async () => {
        const root = await cockpit('[work]\ngrading = "checks"')
        writeFileSync(join(root, 'workorders/WO-8.md'), order('WO-8'))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-8'])).status).toBe(0)
        // No Docker client on PATH: no container on this machine runs cockpit, which the record says.
        const env = { ...process.env, PATH: (process.env.PATH ?? '').split(':').filter(dir => dir && !existsSync(join(dir, 'docker'))).join(':') }
        const lock = join(root, '.cockpit/work-orders/WO-8.lock')
        const recover = (apply: boolean) => work(root, ['work', 'recover', '--work-order', 'WO-8', ...apply ? ['--apply'] : []], env)
        const exited = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString())
        // The control: on another host a pid that has exited here says nothing, so the lock stays.
        writeFileSync(lock, JSON.stringify({ pid: exited, host: 'elsewhere.example.test', container: false }))
        expect(await recover(true)).toMatchObject({ status: 2, diagnostics: [{ message: expect.stringContaining('was left in place: its holder cannot be shown gone') }] })
        expect(existsSync(lock)).toBe(true)
        // On this machine, outside a container, it is gone.
        writeFileSync(lock, JSON.stringify({ pid: exited, host: hostname(), container: false }))
        expect((await recover(false)).result).toMatchObject({ lock: 'dead' })
        expect(existsSync(lock)).toBe(true)
        // A Docker that is installed but cannot be read might hide the holder, so nothing is removed.
        const broken = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-work-docker-')))
        roots.push(broken)
        writeFileSync(join(broken, 'docker'), '#!/bin/sh\nexit 1\n')
        chmodSync(join(broken, 'docker'), 0o700)
        expect(await work(root, ['work', 'recover', '--work-order', 'WO-8', '--apply'], { ...env, PATH: `${broken}:${env.PATH}` })).toMatchObject({ status: 2,
            diagnostics: [{ message: expect.stringContaining('Docker could not be read') }] })
        expect(existsSync(lock)).toBe(true)
        expect((await recover(true)).result).toMatchObject({ lock: 'removed', recorded: true })
        expect(existsSync(lock)).toBe(false)
        expect(record(root, 'WO-8').recoveries).toEqual([expect.objectContaining({ checked: [`the lock was written by process ${exited} on host ${hostname()}`,
            `this machine is host ${hostname()}`, expect.stringMatching(/^no Docker client is installed/), `process ${exited} on this machine is gone`] })])
        expect((await recover(true)).result).toEqual({ id: 'WO-8', lock: 'none' })
    }, 120_000)

    it('judges tests by the declared test_files, and holds a passing test-run to the same protection', async () => {
        const root = await cockpit(['[work]', 'grading = "checks"', '', '[testing]', 'test_files = ["checks/**"]', '', '[[testing.stages]]', 'id = "unit"',
            'command = ["node", "test/add.test.mjs"]', 'requires_stack = false', '', '[[testing.gates]]', 'id = "quick"', 'tier = "targeted"', 'stages = ["unit"]', 'changes = "any change"'].join('\n'))
        mkdirSync(join(root, 'checks'))
        writeFileSync(join(root, 'checks/one.mjs'), "console.log('one')\n")
        git(root, 'add', '-A'); git(root, 'commit', '-qm', 'checks')
        writeFileSync(join(root, 'workorders/WO-5.md'), order('WO-5'))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-5'])).status).toBe(0)
        const run = () => work(root, ['test-run', '--gate', 'quick', '--mode', 'canonical'])
        expect(await run()).toMatchObject({ status: 0, result: { testProtection: { comparedWith: ["WO-5's base"], orders: [{ id: 'WO-5', findings: [], testFiles: '[testing] test_files in cockpit.toml' }] } } })

        // test/ is no longer a test directory once test_files names another; checks/ is.
        rmSync(join(root, 'test/add.test.mjs'))
        writeFileSync(join(root, 'test/add.test.mjs'), "console.log('add(2, 3) returned 5')\n")
        expect((await run()).status).toBe(0)
        rmSync(join(root, 'checks/one.mjs'))
        expect(await run()).toMatchObject({ status: 2, diagnostics: [{ code: 'WORK_TEST_WEAKENED', message: expect.stringContaining('checks/one.mjs: test-file-removed') }] })
    }, 120_000)

    // The stack runs a sibling from the worktree `cockpit use` names; a grade that read the declared
    // checkout instead passed work it never saw.
    it('grades a sibling where cockpit use serves it, not at its declared checkout', async () => {
        const estate = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-work-served-')))
        roots.push(estate)
        const root = join(estate, 'cockpit')
        const app = join(estate, 'app')
        mkdirSync(join(root, 'workorders'), { recursive: true }); mkdirSync(join(app, 'src'), { recursive: true })
        writeFileSync(join(app, 'src/add.mjs'), 'export const add = (a, b) => a + b\n')
        git(app, 'init', '-q', '-b', 'main'); git(app, 'add', '-A'); git(app, 'commit', '-qm', 'app')
        const worktree = join(estate, 'app-feature')
        git(app, 'worktree', 'add', '-q', '-b', 'feature', worktree)
        writeFileSync(join(root, 'cockpit.toml'), ['[cockpit]', 'name = "served"', 'siblings_root = ".."', '', '[[sibling]]', 'slug = "app"', 'dir = "app"',
            'mount = "none"', 'acquire = "none"', 'var = "APP_DIR"', 'purpose = "The product"', '', '[ports]', 'bases = {}', '', '[work]', 'grading = "checks"', ''].join('\n'))
        git(root, 'init', '-q', '-b', 'main')
        expect((await work(root, ['sync'])).status).toBe(0)
        git(root, 'add', '-A'); git(root, 'commit', '-qm', 'cockpit')
        expect((await work(root, ['use', 'app', worktree])).result).toMatchObject({ served: worktree })

        writeFileSync(join(root, 'workorders/WO-9.md'), '---\nid: WO-9\nobjective: add sums two numbers.\nscope: ["app:src/"]\ncriteria:\n'
            + '  - id: AC1\n    text: node runs.\n    check: [node, --version]\n---\n')
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-9'])).result).toMatchObject({ state: 'accepted' })
        writeFileSync(join(worktree, 'README.md'), 'outside the scope\n')
        expect(await work(root, ['work', 'grade', '--work-order', 'WO-9'])).toMatchObject({ status: 2, result: { outOfScope: ['app:README.md'] } })
    }, 120_000)
})
