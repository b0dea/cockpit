import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { runCli, type CliIo } from './cli.js'
import type { OperatorPolicy } from './environment/operator-application.js'
import { PENDING_APPROVALS_PATH, recordPendingApproval } from './pending-approvals.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// A cockpit root that sync has run in, so `.cockpit` exists for the pending list.
function cockpitRoot() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-approve-')))
    roots.push(root)
    mkdirSync(join(root, '.cockpit'))
    const path = join(root, PENDING_APPROVALS_PATH)
    return { root, config: join(root, 'cockpit.toml'),
        pending: () => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).items as { argv: string[] }[] : [] }
}

const quietPolicy = async (): Promise<OperatorPolicy> => ({ configSha256: 'a'.repeat(64), widened: [], unrecorded: false, seeded: false, approveMcp: async () => 'a'.repeat(64) })

// A person's terminal: it answers each prompt with the next of `answers`, where null ends the input as
// Ctrl-D does, and keeps what it showed.
function terminal(answers: (string | null)[]) {
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    let shown = ''
    const stderr = Object.assign(new Writable({ write: (bytes, _encoding, done) => {
        const text = String(bytes)
        shown += text
        if (text.includes('Approve? [y/N, d = details]') || text.includes('Note: ')) setImmediate(() => {
            const answer = answers.shift()
            if (answer === null) stdin.end()
            else stdin.write(`${answer ?? ''}\n`)
        })
        done()
    } }), { isTTY: true })
    let stdout = ''
    const io = { stdin, stderr, stdout: { write: (text: string) => ((stdout += text), true) } } as unknown as CliIo
    return { io, shown: () => shown, stdout: () => stdout, close: () => stdin.destroy() }
}

// A step only a person may take: its screen, and what a yes applies.
function retryStep(details: readonly string[] = [], notes: readonly string[] = ['Root cause given: a flaky fixture']) {
    const apply = vi.fn(async () => ({ status: 0, diagnostics: [], result: { attempts: 0 } }))
    const begin = vi.fn(async (input: { request: object }) => {
        const note = 'note' in input.request ? String(input.request.note) : undefined
        return { approval: { title: 'Give WO-1 3 fresh attempts after 3 failed', why: 'only a person grants fresh attempts after failures',
            details, notes: note ? [`Root cause given: ${note}`] : notes }, approve: apply }
    })
    return { apply, begin }
}

// What an agent's run of a person's step leaves behind.
async function agentRuns(argv: readonly string[], overrides: Parameters<typeof runCli>[2]) {
    let stdout = ''
    const status = await runCli([...argv, '--json'], { stdout: { write: text => ((stdout += text), true) }, stderr: { write: () => true } },
        overrides, { env: { CLAUDECODE: '1' } })
    return { status, envelope: JSON.parse(stdout) }
}

const approve = (config: string, io: CliIo, overrides: Parameters<typeof runCli>[2]) =>
    runCli(['approve', '--config', config], io, { loadPolicy: quietPolicy, ...overrides }, { env: {} })

it('refuses without a person at a terminal outside an agent, and says where to run it', async () => {
    const { root, config } = cockpitRoot()
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
        expect(printed, reason).toContain(`open a terminal outside the agent and, in ${root}, run: npx --no cockpit approve`)
    }
    expect(begin).not.toHaveBeenCalled()
})

it('leaves an agent\'s person step for approve, which shows it briefly and applies it on y', async () => {
    const { root, config, pending } = cockpitRoot()
    const { apply, begin } = retryStep()
    const agent = await agentRuns(['work', 'retry', '--work-order', 'WO-1', '--note', 'a flaky fixture', '--config', config], { beginOperatorWorkApplication: begin })
    expect(agent.status).toBe(2)
    expect(agent.envelope.diagnostics[0].code).toBe('WORK_PERSON_REQUIRED')
    expect(agent.envelope.guidance[0].text).toContain(`npx --no cockpit approve in ${root}`)
    expect(apply).not.toHaveBeenCalled()
    expect(pending()).toEqual([expect.objectContaining({ argv: ['work', 'retry', '--work-order', 'WO-1', '--note', 'a flaky fixture', '--config', config] })])

    begin.mockClear()
    const person = terminal(['y'])
    expect(await approve(config, person.io, { beginOperatorWorkApplication: begin })).toBe(0)
    // The step runs again against the current state, with the person answering.
    expect(begin).toHaveBeenCalledExactlyOnceWith({ configPath: config, request: { operation: 'work-retry', workOrderId: 'WO-1', note: 'a flaky fixture' } })
    expect(apply).toHaveBeenCalledOnce()
    expect(person.shown()).toContain('1 of 1  Give WO-1 3 fresh attempts after 3 failed\nWhy you: only a person grants fresh attempts after failures\n  Root cause given: a flaky fixture\n')
    expect(pending()).toEqual([])
    person.close()
})

it('keeps a note that spans lines, and never records what approve could not read back', async () => {
    const { root, config, pending } = cockpitRoot()
    const { apply, begin } = retryStep()
    await agentRuns(['work', 'retry', '--work-order', 'WO-1', '--note', 'the clock\ndrifted\tby an hour', '--config', config], { beginOperatorWorkApplication: begin })
    expect(pending()).toHaveLength(1)
    // A word over the bound is refused before it is written, and the list stays readable.
    expect(await recordPendingApproval(root, { argv: ['work', 'retry', '--note', 'x'.repeat(5_000), '--config', config], config, title: 'Give WO-2 fresh attempts', at: 'now' }))
        .toMatch(/cannot be kept for a person: a word is over 4096 characters/)
    begin.mockClear()
    const person = terminal(['y'])
    expect(await approve(config, person.io, { beginOperatorWorkApplication: begin })).toBe(0)
    expect(begin).toHaveBeenCalledExactlyOnceWith({ configPath: config, request: { operation: 'work-retry', workOrderId: 'WO-1', note: 'the clock\ndrifted\tby an hour' } })
    expect(person.shown()).toContain('  Root cause given: the clock\\ndrifted\\tby an hour\n')
    expect(apply).toHaveBeenCalledOnce()
    person.close()
})

it('removes a step only on n, and stops on Ctrl-D keeping this step and the rest', async () => {
    const { config, pending } = cockpitRoot()
    const { apply, begin } = retryStep()
    for (const id of ['WO-1', 'WO-2']) await agentRuns(['work', 'retry', '--config', config, '--work-order', id, '--note', 'a flaky fixture'], { beginOperatorWorkApplication: begin })
    const stopped = terminal(['n', null])
    expect(await approve(config, stopped.io, { beginOperatorWorkApplication: begin })).toBe(130)
    expect(apply).not.toHaveBeenCalled()
    expect(pending().map(item => item.argv[3])).toEqual(['WO-2'])
    expect(stopped.stdout()).toContain('Stopped; 1 step still waits')
    stopped.close()
    // A note left unanswered stops too, and keeps the step.
    await agentRuns(['work', 'retry', '--config', config, '--work-order', 'WO-3'], { beginOperatorWorkApplication: begin })
    const unanswered = terminal(['n', null])
    expect(await approve(config, unanswered.io, { beginOperatorWorkApplication: begin })).toBe(130)
    expect(pending().map(item => item.argv[3])).toEqual(['WO-3'])
    unanswered.close()
})

it('shows what runs or changes in full, and cuts an explanatory note to one line until d', async () => {
    const { config } = cockpitRoot()
    const command = `MCP server docs runs node ${'tools/'.repeat(20)}docs-server.mjs --port 4000`
    const note = `Failed AC1: ${'the checkout page renders the wrong total '.repeat(4)}`
    const apply = vi.fn(async () => ({ status: 0, diagnostics: [], result: {} }))
    const begin = vi.fn(async () => ({ approval: { title: 'Give WO-1 fresh attempts', why: 'only a person grants them', details: [command], notes: [note] }, approve: apply }))
    await agentRuns(['work', 'retry', '--config', config, '--work-order', 'WO-1', '--note', 'a flaky fixture'], { beginOperatorWorkApplication: begin })
    const person = terminal(['d', 'y'])
    expect(await approve(config, person.io, { beginOperatorWorkApplication: begin })).toBe(0)
    const [screen, ...rest] = person.shown().split('Approve? [y/N, d = details]')
    expect(screen).toContain(`  ${command}\n`)
    expect(screen).toContain(`  ${note.slice(0, 89)}…\n`)
    expect(screen).not.toContain(note)
    expect(rest.join('')).toContain(`  ${note}\n`)
    expect(apply).toHaveBeenCalledOnce()
    person.close()
})

it('asks for the note a retry records when the agent gave none', async () => {
    const { config } = cockpitRoot()
    const { apply, begin } = retryStep()
    const agent = await agentRuns(['work', 'retry', '--config', config, '--work-order', 'WO-1'], { beginOperatorWorkApplication: begin })
    expect(agent.envelope.diagnostics[0].code).toBe('WORK_PERSON_REQUIRED')
    expect(begin).not.toHaveBeenCalled()
    const person = terminal(['the fixture clock drifted', 'y'])
    expect(await approve(config, person.io, { beginOperatorWorkApplication: begin })).toBe(0)
    expect(begin).toHaveBeenCalledExactlyOnceWith({ configPath: config, request: { operation: 'work-retry', workOrderId: 'WO-1', note: 'the fixture clock drifted' } })
    expect(apply).toHaveBeenCalledOnce()
    person.close()
})

it('finds a step recorded through a linked path to the cockpit root', async () => {
    const { root, config } = cockpitRoot()
    const link = `${root}-link`
    symlinkSync(root, link)
    roots.push(link)
    const { apply, begin } = retryStep()
    await agentRuns(['work', 'retry', '--config', join(link, 'cockpit.toml'), '--work-order', 'WO-1', '--note', 'a flaky fixture'], { beginOperatorWorkApplication: begin })
    const person = terminal(['y'])
    expect(await approve(config, person.io, { beginOperatorWorkApplication: begin })).toBe(0)
    expect(apply).toHaveBeenCalledOnce()
    person.close()
})

it('queues nothing for an agent\'s prune preview that only warns about other cockpits\' stacks', async () => {
    const { config, pending } = cockpitRoot()
    const preview = { status: 0, result: { dryRun: true }, diagnostics: [{ severity: 'warning' as const, code: 'STACKS_PRUNE_UNCONFIRMED', message: 'other cockpits' }] }
    const beginStacksPrune = async () => ({ preview, digest: 'b'.repeat(64), empty: false, deletesData: false, apply: async () => preview })
    expect((await agentRuns(['stacks', 'prune', '--config', config], { beginStacksPrune })).status).toBe(0)
    expect(pending()).toEqual([])
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
