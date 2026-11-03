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
        const root = await cockpit('[work]\nevaluators = ["claudecode"]')
        const env = { ...process.env, PATH: `${syntheticEvaluator()}:${process.env.PATH ?? ''}` }
        writeFileSync(join(root, 'src/add.mjs'), 'export const add = (a, b) => b + a\n')
        writeFileSync(join(root, 'criteria.md'), '---\nscope: [src/]\ncriteria:\n  - id: AC1\n    text: add(2, 3) returns 5.\n    check: [node, test/add.test.mjs]\n---\n')
        const graded = await work(root, ['grade', '--criteria', 'criteria.md'], env)
        expect(graded).toMatchObject({ status: 2, diagnostics: [{ code: 'WORK_GRADE_UNSATISFIED' }],
            result: { outOfScope: [], checks: [{ criterion: 'AC1', passed: true }], criteria: [{ id: 'AC1', verdict: 'unclear' }], evaluator: { tool: 'claudecode' } } })
        // The fix names the command that was run, not an order this grade does not have.
        expect(graded.guidance?.[0]?.text).toContain(`npx --no cockpit grade --config ${join(root, 'cockpit.toml')} --criteria <file>`)
        expect(existsSync(join(root, '.cockpit/work-orders'))).toBe(false)
    })

    it('closes an order as checks-passed only after cockpit ran every check, failing changes outside scope and stale contracts', async () => {
        const root = await cockpit('[work]\ngrading = "checks"\n\n[work.gates]\naccept = "agent"')
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

    it('records a self-reported closure only with the agent\'s verdict and note', async () => {
        const root = await cockpit('[work]\ngrading = "self"')
        writeFileSync(join(root, 'workorders/WO-2.md'), order('WO-2', '  - id: AC1\n    text: The change reads well.'))
        expect((await work(root, ['work', 'accept', '--work-order', 'WO-2'])).status).toBe(0)
        expect((await work(root, ['work', 'grade', '--work-order', 'WO-2'])).diagnostics[0]?.message).toMatch(/pass --verdict met\|unmet and --note/)
        expect((await work(root, ['work', 'grade', '--work-order', 'WO-2', '--verdict', 'met', '--note', 'read the diff'])).result).toMatchObject({ state: 'graded', mode: 'self' })
        expect((await work(root, ['work', 'signoff', '--work-order', 'WO-2'])).result).toMatchObject({ closedAs: 'self-reported' })
    }, 120_000)

    it('passes a person gate only for the digest a person types, and never weakens a criterion on an agent\'s word', async () => {
        const root = await cockpit('[work]\ngrading = "checks"\n\n[work.gates]\namend = "agent"')
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
})
