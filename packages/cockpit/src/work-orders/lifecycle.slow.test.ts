import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../cli.js'

// Each case is a real cockpit in a throwaway Git repository: sync publishes the work authority the
// commands require, and the checks run as real processes. Only the person is simulated, by the
// terminal answer `confirmWorkOrder` returns.
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

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
    expect((await work(root, ['sync'])).status).toBe(0)
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

// A synthetic Claude Code on PATH that answers every criterion `unclear`, so a grade runs end to end
// without a model and never passes.
function syntheticEvaluator(): string {
    const tools = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-work-evaluator-')))
    roots.push(tools)
    symlinkSync(process.execPath, join(tools, 'node'))
    writeFileSync(join(tools, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs'); const argv = process.argv.slice(2)
if (argv[0] === '--version') { process.stdout.write('claude 1.0.0\\n'); process.exit(0) }
if (argv.at(-1) === '--help') { process.stdout.write('--print --output-format --json-schema --no-session-persistence --safe-mode --strict-mcp-config --tools --permission-mode --add-dir\\n'); process.exit(0) }
const request = JSON.parse(fs.readFileSync(/request JSON at (\\S+) with SHA-256/.exec(argv.at(-1))[1], 'utf8'))
const answer = { criteria: request.order.criteria.map(row => ({ id: row.id, verdict: 'unclear', note: 'synthetic', evidence: [] })) }
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
        const env = { ...process.env, CLAUDECODE: undefined, CODEX_THREAD_ID: undefined, PATH: [syntheticEvaluator(), ...(process.env.PATH ?? '').split(':').filter(dir => dir && !existsSync(join(dir, 'codex')))].join(':') }
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
        expect(existsSync(join(root, '.cockpit/work-orders'))).toBe(false)
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

    it('records a self-reported closure only with the agent\'s verdict and note, and still fails a failed check or a change outside scope', async () => {
        const root = await cockpit('[work]\ngrading = "self"')
        writeFileSync(join(root, 'workorders/WO-2.md'), order('WO-2', '  - id: AC1\n    text: The change reads well.\n  - id: AC2\n    text: add(2, 3) returns 5.\n    check: [node, test/add.test.mjs]'))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-2'])).status).toBe(0)
        expect((await work(root, ['work', 'grade', '--work-order', 'WO-2'])).diagnostics[0]?.message).toMatch(/pass --verdict met\|unmet and --note/)
        // A check cockpit can run and the scope are facts, not the agent's judgement: its own `met` covers neither.
        writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => a - b\n')
        writeFileSync(join(root, 'README.md'), 'outside the scope\n')
        expect(await work(root, ['work', 'grade', '--work-order', 'WO-2', '--verdict', 'met', '--note', 'read the diff'])).toMatchObject({ status: 2,
            diagnostics: [{ code: 'WORK_GRADE_UNSATISFIED' }], result: { state: 'accepted', mode: 'self', checks: [{ criterion: 'AC2', passed: false }], outOfScope: ['README.md'] } })
        writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => a + b\n')
        rmSync(join(root, 'README.md'))
        expect((await work(root, ['work', 'grade', '--work-order', 'WO-2', '--verdict', 'met', '--note', 'read the diff'])).result).toMatchObject({ state: 'graded', mode: 'self' })
        expect((await work(root, ['work', 'signoff', '--work-order', 'WO-2'])).result).toMatchObject({ closedAs: 'self-reported' })
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
    }, 120_000)

    it('fails a grade that deletes or skips tests until a person acknowledges exactly that weakening', async () => {
        const root = await cockpit('[work]\ngrading = "checks"')
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
})
