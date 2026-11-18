import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { runCli, type CliIo } from './cli.js'
import type { OperatorPolicy } from './environment/operator-application.js'
import { PENDING_APPROVALS_PATH } from './pending-approvals.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// A cockpit root that sync has run in, so `.cockpit` exists for the pending list.
function cockpitRoot() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-approve-')))
    roots.push(root)
    mkdirSync(join(root, '.cockpit'))
    return { root, config: join(root, 'cockpit.toml'), pending: () => JSON.parse(readFileSync(join(root, PENDING_APPROVALS_PATH), 'utf8')).items as { argv: string[] }[] }
}

const quietPolicy = async (): Promise<OperatorPolicy> => ({ configSha256: 'a'.repeat(64), widened: [], unrecorded: false, seeded: false, approveMcp: async () => 'a'.repeat(64) })

// A person's terminal: it answers each prompt with the next of `answers`, and keeps what it showed.
function terminal(answers: string[]) {
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    let shown = ''
    const stderr = Object.assign(new Writable({ write: (bytes, _encoding, done) => {
        const text = String(bytes)
        shown += text
        if (text.includes('Approve? [y/N, d = details]') || text.includes('Note: ')) setImmediate(() => stdin.write(`${answers.shift() ?? ''}\n`))
        done()
    } }), { isTTY: true })
    let stdout = ''
    const io = { stdin, stderr, stdout: { write: (text: string) => ((stdout += text), true) } } as unknown as CliIo
    return { io, shown: () => shown, stdout: () => stdout, close: () => stdin.destroy() }
}

// A step only a person may take: its screen, and what a yes applies.
function retryStep(details: readonly string[] = ['Root cause given: a flaky fixture']) {
    const apply = vi.fn(async () => ({ status: 0, diagnostics: [], result: { attempts: 0 } }))
    const begin = vi.fn(async () => ({ approval: { title: 'Give WO-1 3 fresh attempts after 3 failed',
        why: 'only a person grants fresh attempts after failures', details }, approve: apply }))
    return { apply, begin }
}

// What an agent's run of a person's step leaves behind.
async function agentRuns(argv: readonly string[], begin: ReturnType<typeof retryStep>['begin']) {
    let stdout = ''
    const status = await runCli([...argv, '--json'], { stdout: { write: text => ((stdout += text), true) }, stderr: { write: () => true } },
        { beginOperatorWorkApplication: begin }, { env: { CLAUDECODE: '1' } })
    return { status, envelope: JSON.parse(stdout) }
}

it('refuses without a person at a terminal outside an agent, and says where to run it', async () => {
    const { config } = cockpitRoot()
    const begin = vi.fn()
    // An agent's pseudo-terminal passes for a person's, so its session variable refuses on its own.
    for (const [env, terminalStderr, args, reason] of [[{ CLAUDECODE: '1' }, true, [], 'CLAUDECODE is set'], [{ CODEX_THREAD_ID: 'synthetic' }, true, [], 'CODEX_THREAD_ID is set'],
        [{ OPENCODE: '1' }, true, [], 'OPENCODE is set'], [{ CI: '1' }, true, [], 'CI is set'],
        // A yes typed while the screen is redirected away approves something nobody saw.
        [{}, false, [], 'not both a terminal'], [{}, true, ['--json'], '--json']] as const) {
        let stdout = '', stderr = ''
        const io = { stdin: Object.assign(new PassThrough(), { isTTY: true }), stdout: { write: (text: string) => ((stdout += text), true) },
            stderr: { write: (text: string) => ((stderr += text), true), isTTY: terminalStderr } } as unknown as CliIo
        expect(await runCli(['approve', '--config', config, ...args], io, { beginOperatorWorkApplication: begin, loadPolicy: quietPolicy }, { env }), reason).toBe(2)
        const printed = args.length ? JSON.stringify(JSON.parse(stdout)) : stderr
        expect(printed, reason).toContain('APPROVE_TERMINAL_REQUIRED')
        expect(printed, reason).toContain(reason)
        expect(printed, reason).toContain('open a terminal outside the agent and run: npx --no cockpit approve')
    }
    expect(begin).not.toHaveBeenCalled()
})

it('leaves an agent\'s person step for approve, which shows it briefly and applies it on y', async () => {
    const { config, pending } = cockpitRoot()
    const { apply, begin } = retryStep()
    const agent = await agentRuns(['work', 'retry', '--work-order', 'WO-1', '--note', 'a flaky fixture', '--config', config], begin)
    expect(agent.status).toBe(2)
    expect(agent.envelope.diagnostics[0].code).toBe('WORK_PERSON_REQUIRED')
    expect(agent.envelope.guidance[0].text).toContain('npx --no cockpit approve')
    expect(apply).not.toHaveBeenCalled()
    expect(pending()).toEqual([expect.objectContaining({ argv: ['work', 'retry', '--work-order', 'WO-1', '--note', 'a flaky fixture', '--config', config] })])

    begin.mockClear()
    const person = terminal(['y'])
    expect(await runCli(['approve', '--config', config], person.io, { beginOperatorWorkApplication: begin, loadPolicy: quietPolicy }, { env: {} })).toBe(0)
    // The step runs again against the current state, with the person answering.
    expect(begin).toHaveBeenCalledExactlyOnceWith({ configPath: config, request: { operation: 'work-retry', workOrderId: 'WO-1', note: 'a flaky fixture' } })
    expect(apply).toHaveBeenCalledOnce()
    expect(person.shown()).toContain('1 of 1  Give WO-1 3 fresh attempts after 3 failed\nWhy you: only a person grants fresh attempts after failures\n  Root cause given: a flaky fixture\n')
    expect(pending()).toEqual([])
    person.close()
})

it('records nothing on n, and does not ask again', async () => {
    const { config, pending } = cockpitRoot()
    const { apply, begin } = retryStep()
    await agentRuns(['work', 'retry', '--config', config, '--work-order', 'WO-1', '--note', 'a flaky fixture'], begin)
    const person = terminal(['n'])
    expect(await runCli(['approve', '--config', config], person.io, { beginOperatorWorkApplication: begin, loadPolicy: quietPolicy }, { env: {} })).toBe(0)
    expect(apply).not.toHaveBeenCalled()
    expect(pending()).toEqual([])
    person.close()
    const again = terminal([])
    expect(await runCli(['approve', '--config', config], again.io, { beginOperatorWorkApplication: begin, loadPolicy: quietPolicy }, { env: {} })).toBe(0)
    expect(again.stdout()).toContain('Nothing waits for a person.')
    again.close()
})

it('shows each detail on one line, and the full text on d', async () => {
    const { config } = cockpitRoot()
    const long = `Failed AC1: ${'the checkout page renders the wrong total '.repeat(4)}`
    const { apply, begin } = retryStep([long])
    await agentRuns(['work', 'retry', '--config', config, '--work-order', 'WO-1', '--note', 'a flaky fixture'], begin)
    const person = terminal(['d', 'y'])
    expect(await runCli(['approve', '--config', config], person.io, { beginOperatorWorkApplication: begin, loadPolicy: quietPolicy }, { env: {} })).toBe(0)
    const [brief, ...rest] = person.shown().split('Approve? [y/N, d = details]')
    expect(brief).toContain(`  ${long.slice(0, 89)}…\n`)
    expect(brief).not.toContain(long)
    expect(rest.join('')).toContain(`  ${long}\n`)
    expect(apply).toHaveBeenCalledOnce()
    person.close()
})

it('asks for the note a retry records when the agent gave none', async () => {
    const { config } = cockpitRoot()
    const { apply, begin } = retryStep()
    const agent = await agentRuns(['work', 'retry', '--config', config, '--work-order', 'WO-1'], begin)
    expect(agent.envelope.diagnostics[0].code).toBe('WORK_PERSON_REQUIRED')
    expect(begin).not.toHaveBeenCalled()
    const person = terminal(['the fixture clock drifted', 'y'])
    expect(await runCli(['approve', '--config', config], person.io, { beginOperatorWorkApplication: begin, loadPolicy: quietPolicy }, { env: {} })).toBe(0)
    expect(begin).toHaveBeenCalledExactlyOnceWith({ configPath: config, request: { operation: 'work-retry', workOrderId: 'WO-1', note: 'the fixture clock drifted' } })
    expect(apply).toHaveBeenCalledOnce()
    person.close()
})

it('asks about an unsynced widening of cockpit.toml that nothing recorded', async () => {
    const { config } = cockpitRoot()
    const sync = vi.fn(async (input: { dryRun?: boolean }) => ({ status: 0, diagnostics: [],
        result: { action: 'sync', dryRun: input.dryRun === true, sourceSha256: 'a'.repeat(64), changes: [] } }))
    const person = terminal(['y'])
    expect(await runCli(['approve', '--config', config], person.io, { sync, loadPolicy: async () => ({ ...await quietPolicy(), widened: ['guards.allow'] }) }, { env: {} })).toBe(0)
    expect(person.shown()).toContain('1 of 1  Apply the cockpit.toml change\nWhy you: these changes widen what agents may do: guards.allow\n')
    expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ configPath: config, guardWidening: { configSha256: 'a'.repeat(64) } }))
    person.close()
})
