import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough, Readable } from 'node:stream'
import * as fixCatalogue from './fix-catalogue.js'
import { runCli, type CliIo } from './cli.js'
import { runGuardCommand } from './cli-guard.js'
import { createInvocationRecord } from './invocation.js'
import { runSyncOperatorCommand } from './generated-environment/command.js'
import { loadCockpitConfig } from './config/load.js'
import { renderHumanDiagnostics } from './diagnostics.js'
import { RefusalError, type EnvironmentCommandOutcome, type ExecutionStep } from './environment/contract.js'
import type { SetupResult } from './environment/setup.js'
import { agentMayRun, commands, describePublicOption, internalCommands } from './command-table.js'
import type { OperatorPolicy, WideningPreview } from './environment/operator-application.js'
import { DEFAULT_SURFACE_TOOLS, GUARD_SURFACE_TARGETS, SURFACE_TARGETS } from './surfaces/harness-registry.js'
import { installedPackageMetadata } from './package-metadata.js'
import { cockpitPackageVersion } from './test-support/package-version.js'

// Human-mode runs publish no invocation record; it exists only in the --json envelope on stdout.
function humanStderr(stderr: string): string {
    expect(stderr).not.toContain('"invocation"')
    return stderr
}

function jsonInvocation(stdout: string, exitCode: number, verb: string, resolvedConfigPath: string | null) {
    const envelope = JSON.parse(stdout)
    expect(stdout.split('\n')).toHaveLength(2)
    expect(envelope.invocation).toEqual(createInvocationRecord(envelope.invocation))
    expect(envelope.invocation).toEqual({ verb, durationMs: expect.any(Number), exitCode, resolvedConfigPath })
    return envelope.invocation
}

describe('invocation publication', () => {
    it.each([
        [['--version'], 'version', 0],
        [[], 'unknown', 2], [['unknown'], 'unknown', 2],
        [['unsafe\u202e'], 'unknown', 2], [['check', '--unknown'], 'check', 2],
        [['guard-evaluate', '--harness', 'claudecode'], 'guard-evaluate', 0],
        [['guard-evaluate', '--harness', 'codexcli'], 'guard-evaluate', 0],
    ] as const)('publishes no invocation record on stderr for %j', (args, verb, exitCode) => {
        const result = run([...args])
        expect(result.status).toBe(exitCode)
        const diagnostics = humanStderr(result.stderr)
        if (verb === 'version') expect(result.stdout).toBe(`@b00dea/cockpit ${cockpitPackageVersion} (Node ^22.22.0 || ^24.0.0 || ^26.0.0; source development)\n`)
        else if (verb === 'guard-evaluate') {
            expect(diagnostics).toBe('')
            expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny',
                permissionDecisionReason: expect.stringContaining('Guard input, arguments or installed identity') })
        } else expect(diagnostics).toContain(args.length ? verb === 'check' ? 'CLI_USAGE_INVALID' : 'CLI_UNKNOWN_COMMAND' : 'CLI_COMMAND_REQUIRED')
    })

    it('retains artifact bytes and uses floored monotonic elapsed milliseconds', async () => {
        let stdout = '', stderr = ''
        const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) } }
        const resolver = async () => ({ status: 0, result: null, diagnostics: [], artifact: 'exact artifact bytes\n' })
        const args = ['check', '--config', 'cockpit.toml']
        const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(10.25).mockReturnValueOnce(19.99)
        try {
            const status = await runCli(args, io, { check: resolver })
            expect(status).toBe(0)
            expect(stdout).toBe('exact artifact bytes\n')
            expect(humanStderr(stderr)).toBe('')
            stdout = ''
            clock.mockReset().mockReturnValueOnce(10.25).mockReturnValueOnce(19.99)
            await runCli([...args, '--json'], io, { check: resolver })
            expect(JSON.parse(stdout).invocation.durationMs).toBe(9)
        } finally { clock.mockRestore() }
    })

    it.each([false, true])('refuses unsafe decoded config before handler side effects in JSON=%s', async json => {
        for (const control of ['\0', '\n', '\u0085', '\u202e']) {
            let stdout = '', stderr = ''
            const handler = vi.fn(async () => ({ status: 0, result: null, diagnostics: [] }))
            const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) } }
            const status = await runCli(['check', '--config', `unsafe${control}.toml`, ...(json ? ['--json'] : [])], io, { check: handler })
            expect(status).toBe(2)
            expect(handler).not.toHaveBeenCalled()
            if (json) {
                const envelope = JSON.parse(stdout)
                expect(envelope).toMatchObject({ result: null, diagnostics: [{ code: 'CLI_USAGE_INVALID' }],
                    invocation: { verb: 'check', exitCode: status, resolvedConfigPath: null } })
                expect(envelope.invocation).toEqual(createInvocationRecord(envelope.invocation))
                expect(stdout.split('\n')).toHaveLength(2)
                expect(stderr).toBe('')
            } else {
                expect(stdout).toBe('')
                expect(humanStderr(stderr)).toContain('CLI_USAGE_INVALID')
            }
        }
    })

    it.each([false, true])('closes successful, refused and thrown handler outcomes consistently in JSON=%s', async json => {
        for (const behavior of ['success', 'refusal', 'throw'] as const) {
            let stdout = '', stderr = ''
            const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) } }
            const handler = vi.fn(async () => {
                if (behavior === 'throw') throw new Error('synthetic handler failure')
                return { status: behavior === 'success' ? 0 : 2, diagnostics: behavior === 'refusal'
                    ? [{ severity: 'error' as const, code: 'SYNTHETIC_REFUSAL', message: 'retained diagnostic' }] : [], result: null }
            })
            const status = await runCli(['check', '--config', './nested/../cockpit.toml', ...(json ? ['--json'] : [])], io, { check: handler })
            expect(status).toBe(behavior === 'success' ? 0 : 2)
            expect(handler).toHaveBeenCalledWith({ configPath: './nested/../cockpit.toml' })
            const code = behavior === 'throw' ? 'CLI_INTERNAL_ERROR' : 'SYNTHETIC_REFUSAL'
            if (json) {
                const envelope = JSON.parse(stdout)
                expect(envelope.invocation).toEqual(createInvocationRecord(envelope.invocation))
                expect(envelope.invocation).toEqual({ verb: 'check', exitCode: status, durationMs: expect.any(Number), resolvedConfigPath: resolve('cockpit.toml') })
                expect(stdout.split('\n')).toHaveLength(2)
                expect(stderr).toBe('')
                expect(envelope.result).toBeNull()
                expect(envelope.diagnostics).toEqual(behavior === 'success' ? [] : [expect.objectContaining({ code })])
            } else {
                expect(stdout).toBe('')
                const diagnostics = humanStderr(stderr)
                if (behavior === 'success') expect(diagnostics).toBe('')
                else expect(diagnostics).toContain(code)
            }
        }
    })
})

describe('agent admission', () => {
    const authority = { grants: ['browser-preapproval', 'seeded-reset'] as const, profiles: ['jobs'],
        roots: ['/workspace/product', '/workspace/app'], cwd: '/workspace/product' }

    it('keeps the guard-only command out of the public table', () => {
        expect(internalCommands).toMatchObject([{ name: 'guard-evaluate', visibility: 'internal' }])
        expect(commands.some(row => String(row.name) === 'guard-evaluate')).toBe(false)
        expect(run(['--help']).stdout).not.toContain('guard-evaluate')
    })

    // The guard asks a person only for a cockpit command that changes what agents may do or waits for a
    // person; every other spelling, malformed ones included, is an ordinary program the CLI judges itself.
    it('holds exactly the commands that change what agents may do or wait for a person', () => {
        for (const args of [['check'], ['up', '--profile', 'jobs'], ['session', '--profile=jobs', '--', 'npm', 'test'], ['logs', '--service', 'undeclared'],
            ['stacks', 'prune', '--apply'], ['tool', 'add', 'opencode'], ['tool', '--dry-run', 'add', 'opencode'],
            ['use', 'app', '/workspace/app/.worktrees/feature'], ['use', 'app', 'app/feature'], ['use', 'app', '--clear'], ['exec', '--service', 'api', '--', 'psql'],
            ['init', '.', '--target', 'codexcli'], ['work', 'signoff', '--work-order', 'WO-1'], ['work'], ['unknown'], ['sync'], ['upgrade', '1.2.3'], ['reset', '--apply'],
            ['browser', 'drive'], ['setup', '--write-instruction-files']]) {
            expect(agentMayRun(args, authority), args.join(' ')).toBe(true)
        }
        for (const args of [['sibling', 'add', 'api'], ['sibling', 'remove', 'api'], ['tool', 'remove', 'codexcli'], ['guard-evaluate', '--harness', 'claudecode'],
            ['sync', '--interactive'], ['sync', '--interactive=false'], ['reset', '--interactive'], ['stacks', 'prune', '--interactive'],
            ...['accept', 'acknowledge', 'signoff', 'retry'].map(sub => ['work', sub, '--work-order', 'WO-1', '--interactive']),
            ...['--interactive', '--answers=a.toml', '--scaffold-compose=app', '--command=x', '--port=1', '--with=redis']
                .map(flag => ['init', '.', '--target', 'codexcli', flag]),
            // A profile that mounts an operator-gated sibling never starts without a person.
            ['up', '--profile', 'ops'], ['session', '--profile', 'jobs', '--profile', 'ops', '--', 'npm', 'test'],
            // The CLI runs a wrapper's positionals before `--` too, which the evaluator would not judge.
            ['session', 'cockpit', 'tool', 'remove', 'codexcli', '--', '--config', 'cockpit.toml'], ['session', 'rm', '--', '-rf', '/elsewhere'],
            ['exec', '--service', 'api', 'sh', '--', '-c', 'id'], ['session', 'npm', 'test'],
            // A checkout outside every allowed root would widen what agents can reach, so a person names it.
            ['use', 'app', '/elsewhere/app'], ['use', 'app', '../app/feature'], ['use', 'app', '../../elsewhere'], ['use', 'app', '/workspace/app/../../elsewhere']]) {
            expect(agentMayRun(args, authority), args.join(' ')).toBe(false)
        }
        // Browser commands run unprompted only where cockpit.toml preapproves them, and an applied reset only
        // where a declared seed refills the data it deletes. A writing sync, an upgrade (whose sync child
        // writes) and setup's writes into sibling repositories need no grant: sync itself refuses a widening.
        for (const [args, grant] of [[['browser', 'drive'], 'browser-preapproval'], [['reset', '--apply'], 'seeded-reset']] as const) {
            expect(agentMayRun(args, { ...authority, grants: authority.grants.filter(row => row !== grant) }), args.join(' ')).toBe(false)
        }
        const ungranted = { ...authority, grants: [] }
        for (const args of [['sync'], ['upgrade', '1.2.3'], ['setup', '--write-instruction-files'], ['setup', '--write-instruction-pointers'], ['sync', '--dry-run'], ['reset']]) {
            expect(agentMayRun(args, ungranted), args.join(' ')).toBe(true)
        }
    })
})

const root = resolve(import.meta.dirname, '../../..')
const cli = join(root, 'packages/cockpit/src/cli.ts')
const scratch: string[] = []

function renderSetupConfig({
    siblingsRoot = '.',
    siblingFields = [
        'slug = "assets"',
        'dir = "assets"',
        'mount = "none"',
        'acquire = "none"',
        'var = "ASSETS_DIR"',
        'toolchain = "none"',
        'purpose = "Synthetic local assets"',
    ],
    sections = [],
}: {
    readonly siblingsRoot?: string
    readonly siblingFields?: readonly string[]
    readonly sections?: readonly string[]
} = {}): string {
    return [
        '[cockpit]',
        'name = "synthetic-cockpit"',
        `siblings_root = ${JSON.stringify(siblingsRoot)}`,
        '',
        '[[sibling]]',
        ...siblingFields,
        '',
        '[ports]',
        'bases = { APP_PORT = 4100 }',
        '',
        ...sections,
    ].join('\n')
}

function run(args: string[], env: Readonly<Record<string, string>> = {}) {
    return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...env },
    })
}

describe('CLI help', () => {
    async function runInProcess(args: string[], overrides: Parameters<typeof runCli>[2] = {}) {
        let stdout = '', stderr = ''
        const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) } }
        const status = await runCli(args, io, overrides)
        return { status, stdout, stderr }
    }

    it.each([['--help'], ['-h']])('prints a command usage and its options for `check %s` and exits 0', async (flag) => {
        const result = await runInProcess(['check', flag])

        expect(result).toMatchObject({ status: 0, stderr: '' })
        expect(result.stdout).toContain('Usage: cockpit check [options]')
        expect(result.stdout).toContain('--config <value>')
        expect(result.stdout).toContain('Path to cockpit.toml')
        expect(result.stdout).toContain('--json')
        expect(result.stdout).toContain('Emit one machine-readable JSON response')
    })

    it.each([
        ['session', 'Usage: cockpit session [options] -- <command> [args...]'],
        ['init', 'Usage: cockpit init [<root>] [options]'],
        ['sibling', 'Usage: cockpit sibling add|remove <slug> [options]'],
    ])('prints the operands `%s` takes besides its options', async (verb, usage) => {
        const result = await runInProcess([verb, '--help'])

        expect(result).toMatchObject({ status: 0, stderr: '' })
        expect(result.stdout.split('\n')[0]).toBe(usage)
    })

    it('keeps a command-table description for every public flag', () => {
        for (const command of commands) {
            for (const name of Object.keys(command.options)) expect(describePublicOption(name)).not.toBe('')
        }
    })

    it('tells `down --help` and `reset --help` readers which Docker daemon they delete from', async () => {
        // Both now pin the active context themselves; help that still asked for DOCKER_CONTEXT sent
        // readers to a `$(docker context show)` prefix the guard refuses.
        for (const command of ['down', 'reset']) {
            const help = await runInProcess([command, '--help'])
            expect(help.status).toBe(0)
            expect(help.stdout).toContain('active local Docker context')
            expect(help.stdout).not.toContain('DOCKER_CONTEXT')
        }
    })

    it('lists every sibling flag in `sibling --help` and routes add and remove to their handlers', async () => {
        const help = await runInProcess(['sibling', '--help'])
        expect(help.status).toBe(0)
        for (const flag of ['--config', '--create', '--from', '--remote', '--dir', '--var', '--purpose', '--instruction-pointer', '--json']) expect(help.stdout).toContain(flag)

        const seen: unknown[] = []
        const sibling = async (request: unknown) => { seen.push(request); return { status: 0, result: null, diagnostics: [] } }
        await runInProcess(['sibling', 'add', 'api', '--config', 'cockpit.toml', '--remote', 'https://git.invalid/a.git', '--dir', 'svc', '--instruction-pointer'], { sibling } as never)
        await runInProcess(['sibling', 'remove', 'api', '--config', 'cockpit.toml'], { sibling } as never)
        expect(seen).toEqual([
            { operation: 'add', input: { configPath: 'cockpit.toml', slug: 'api', create: false, remote: 'https://git.invalid/a.git', dir: 'svc', instructionPointer: true } },
            { operation: 'remove', input: { configPath: 'cockpit.toml', slug: 'api' } },
        ])

        const stray = await runInProcess(['sibling', 'remove', 'api', '--config', 'cockpit.toml', '--create'], { sibling } as never)
        expect(stray.status).toBe(2)
        expect(stray.stderr).toContain('--create belongs to sibling add')

        const invalid = await runInProcess(['sibling', 'unknown', 'api'])
        expect(invalid.status).toBe(2)
        expect(invalid.stderr).toContain('[--instruction-pointer]')
    })

    it('lists the commands for a bare invocation and points usage errors at --help', async () => {
        const bare = await runInProcess([])
        expect(bare.status).toBe(2)
        expect(bare.stderr).toContain('Set up:')
        expect(bare.stderr).toContain('CLI_COMMAND_REQUIRED')

        const bad = await runInProcess(['check', '--unknown'])
        expect(bad.status).toBe(2)
        expect(bad.stderr).toContain("Run './node_modules/@b00dea/cockpit/bin/cockpit.mjs check --help' for usage.")

        const unknown = await runInProcess(['unknown'])
        expect(unknown.status).toBe(2)
        expect(unknown.stderr).toContain("Run './node_modules/@b00dea/cockpit/bin/cockpit.mjs --help' for the command list.")
    })

    it('names the TOML position and the failing schema paths when the configuration is rejected', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-config-cause-'))
        try {
            const malformed = join(directory, 'malformed.toml')
            writeFileSync(malformed, 'name = \n[cockpit\n')
            const parse = await runInProcess(['check', '--config', malformed, '--json'])
            expect(JSON.parse(parse.stdout).diagnostics[0]).toMatchObject({ code: 'CONFIG_PARSE_INVALID', message: expect.stringMatching(/line 1, column \d+/) })

            const unknown = join(directory, 'unknown.toml')
            writeFileSync(unknown, 'cockpit = 1\n')
            const schema = await runInProcess(['check', '--config', unknown, '--json'])
            expect(JSON.parse(schema.stdout).diagnostics[0]).toMatchObject({ code: 'CONFIG_SCHEMA_INVALID', message: expect.stringContaining('cockpit: ') })
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('reports a failing handler by its error class, and by its text only when cockpit worded it', async () => {
        const parsed = await runInProcess(['check', '--config', 'cockpit.toml'], {
            check: async () => JSON.parse('SECRET_CANARY=private-value'),
        })
        expect(parsed.status).toBe(2)
        expect(parsed.stderr).toContain('CLI_INTERNAL_ERROR')
        expect(parsed.stderr).toContain('failed unexpectedly (SyntaxError)')
        expect(parsed.stderr).not.toContain('SECRET_CANARY')

        const refused = await runInProcess(['check', '--config', 'cockpit.toml'], {
            check: async () => { throw new RefusalError('synthetic handler refusal') },
        })
        expect(refused.stderr).toContain('failed unexpectedly (synthetic handler refusal)')
    })

    it('prints the collected log records in human mode', async () => {
        const record = { timestamp: '2026-01-01T00:00:00Z', stream: 'stdout', message: 'synthetic log line' }
        const result = await runInProcess(['logs', '--config', 'cockpit.toml', '--service', 'app'], {
            logs: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: { json: false, records: [record] } }),
        })

        expect(result.status).toBe(0)
        expect(result.stdout).toBe('2026-01-01T00:00:00Z stdout synthetic log line\n')
    })

    it('renders root help by stage, with each command group as one entry', () => {
        const result = run(['--help'])

        expect(result.status).toBe(0)
        expect(result.stdout).toBe(
            'Usage: cockpit <command> [options]\n\n' +
            'Set up:\n' +
            '  init       Preview a first cockpit setup for one or more agent tools, then write it from answers\n' +
            '  setup      Clone or locate the declared sibling repositories and link them\n' +
            '  use        Serve a sibling from another of its checkouts, such as a worktree\n' +
            '  pull       Fast-forward the cockpit and its siblings to their upstreams\n' +
            '  sibling    Add or remove a repository in cockpit.toml (sibling add, sibling remove)\n' +
            '  tool       Add or remove an agent tool in cockpit.toml (tool add, tool remove)\n' +
            '  upgrade    Move the exact cockpit pin to a newer version and re-run sync\n\n' +
            'Generate and verify:\n' +
            '  sync       Write the Compose ownership override and agent files from cockpit.toml\n' +
            '  check      Report generated files that no longer match cockpit.toml\n\n' +
            'Run the stack:\n' +
            '  up         Start or resume the declared environment\n' +
            '  preflight  Check that the environment is healthy and ready for work\n' +
            '  session    Keep the environment available for one command, then release it\n' +
            '  logs       Show recent logs for one declared service\n' +
            '  ps         Show the state and health of each service in this checkout\'s stack\n' +
            '  restart    Restart one service of this checkout\'s stack and wait until it is healthy\n' +
            '  rebuild    Rebuild one service\'s image, replace its container and wait until it is healthy\n' +
            '  exec       Run a command inside one service\'s container of this checkout\'s stack\n' +
            '  sleep      Release this checkout and stop the stack if no other holder remains\n' +
            '  down       Stop and remove the stack (on the active local Docker context)\n' +
            '  reset      Preview a reset, then approve it interactively, or apply it where a seed is declared (on the active local Docker context)\n' +
            '  stacks     List every stack on this machine, or preview and remove those whose checkout is gone (stacks prune)\n\n' +
            'Diagnose:\n' +
            '  doctor     Report environment problems without changing anything\n' +
            '  env        Read what environment schemas declare with nothing resolved: variable names, or one schema\'s text\n\n' +
            'Test and grade:\n' +
            '  test-run   Run a declared product test gate and report which tests it selected\n' +
            '  work       Accept, check, grade and close work orders\n' +
            '  grade      Independently grade uncommitted work against a criteria file, with no work order\n' +
            '  browser    Drive, inspect and capture the declared application in a browser\n' +
            '  docs       Check living documents and decision records against the repositories\n\n' +
            "Run 'cockpit <command> --help' for its options, and 'cockpit work --help', 'cockpit browser --help', 'cockpit docs --help' or 'cockpit env --help' for its subcommands.\n",
        )
        expect(humanStderr(result.stderr)).toBe('')
    })

    it('lists a command group with its subcommands and refuses a group without one', async () => {
        const work = await runInProcess(['work', '--help'])
        expect(work.status).toBe(0)
        expect(work.stdout).toBe('Usage: cockpit work <subcommand> [options]\n\n' +
            'Accept, check, grade and close work orders\n\n' +
            'Subcommands:\n' +
            '  status       Report each work order, its state and how it closed\n' +
            '  accept       Accept a work order, or a change to an accepted one\n' +
            "  check        Run every criterion's check and the order's gates\n" +
            '  note         Record a note on an order, an open question with --ask, or a decision with --decision\n' +
            '  decide       Resolve a recorded decision: write or cite its decision record, or say it is not lasting\n' +
            '  answer       Answer an open question on an order\n' +
            '  acknowledge  Acknowledge that an order weakened tests\n' +
            '  grade        Grade an accepted order the way [work] grading says\n' +
            '  signoff      Close a graded order as done, or any open one as partial or abandoned\n' +
            '  retry        Grant an order at its attempt cap fresh attempts, as a person at a terminal\n' +
            "  recover      Inspect or remove a crashed command's work-order lock\n" +
            '  verify       Check every record against its order\n\n' +
            "Run 'cockpit work <subcommand> --help' for its options.\n")
        const browser = await runInProcess(['browser', '--help'])
        expect(browser.status).toBe(0)
        expect(browser.stdout).toContain('Subcommands:\n' +
            '  drive       Drive the declared application browser surfaces\n' +
            '  screenshot  Capture the declared application surfaces\n\n')
        expect((await runInProcess(['work', 'grade', '--help'])).stdout).toMatch(/^Usage: cockpit work grade \[options\]\n/)

        const envelope = async (args: string[]) => JSON.parse((await runInProcess([...args, '--json'])).stdout)
        expect(await envelope(['work'])).toMatchObject({ invocation: { verb: 'work', exitCode: 2 }, diagnostics: [{ code: 'CLI_COMMAND_REQUIRED',
            message: 'work requires a subcommand: status, accept, check, note, decide, answer, acknowledge, grade, signoff, retry, recover, verify' }] })
        expect(await envelope(['work', 'bogus'])).toMatchObject({ invocation: { verb: 'unknown' }, diagnostics: [{ code: 'CLI_UNKNOWN_COMMAND', message: 'unknown command "work bogus"' }] })
        // There are no hyphenated aliases; the refusal names the spelling that runs.
        const hyphenated = await runInProcess(['work-grade', '--config', 'cockpit.toml'])
        expect(hyphenated.status).toBe(2)
        expect(humanStderr(hyphenated.stderr)).toBe('ERROR CLI_UNKNOWN_COMMAND: unknown command "work-grade"; did you mean "work grade"?\n'
            + "Run './node_modules/@b00dea/cockpit/bin/cockpit.mjs work grade --help' for usage.\n")
        expect((await envelope(['browser-drive'])).diagnostics).toMatchObject([{ code: 'CLI_UNKNOWN_COMMAND', message: 'unknown command "browser-drive"; did you mean "browser drive"?' }])
    })
})

// What sync decides by, in place of a cockpit.toml on disk and this machine's guard record.
const quietPolicy = async (): Promise<OperatorPolicy> => ({ configSha256: 'a'.repeat(64), widened: [], unrecorded: false, seeded: false, approveMcp: async () => 'a'.repeat(64) })
const widenedPolicy = async (): Promise<OperatorPolicy> => ({ ...await quietPolicy(), widened: ['guards.allow'] })

describe('generated environment process contract', () => {
    function captureIo(
        confirmWidening?: (preview: WideningPreview) => Promise<boolean>,
    ) {
        let stdout = ''
        let stderr = ''
        const io = {
            stdout: { write: (text: string) => ((stdout += text), true) },
            stderr: { write: (text: string) => ((stderr += text), true) },
            ...(confirmWidening ? { confirmWidening } : {}),
        } as unknown as CliIo
        return { io, output: () => ({ stdout, stderr }) }
    }

    it('keeps the team metadata byte tree unchanged during a public sync preview', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-sync-preview-metadata-')))
        scratch.push(directory)
        const configPath = join(directory, 'cockpit.toml')
        mkdirSync(join(directory, 'app'))
        mkdirSync(join(directory, 'fixtures'))
        writeFileSync(join(directory, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
        writeFileSync(configPath, readFileSync(join(root, 'fixtures/registries/generated-environment.toml'), 'utf8')
            .replace('name = "generated-environment"', 'name = "preview-metadata"\nsiblings_root = "."'))
        writeFileSync(join(directory, 'package.json'), '{"private":true}\n')
        writeFileSync(join(directory, '.gitignore'), 'operator-owned\n')
        const snapshot = () => Object.freeze({
            package: readFileSync(join(directory, 'package.json'), 'utf8'),
            ignore: readFileSync(join(directory, '.gitignore'), 'utf8'),
        })
        const before = snapshot()
        const capture = captureIo()

        const status = await runCli(['sync', '--config', configPath, '--dry-run', '--json'], capture.io)
        expect(status, capture.output().stdout).toBe(0)

        expect(snapshot()).toEqual(before)
        expect(JSON.parse(capture.output().stdout).result.changes).toEqual(expect.arrayContaining([
            { operation: 'write', path: 'package.json' },
            { operation: 'write', path: '.gitignore' },
        ]))
    })

    it.each(['first sync', 'owned surface', 'adoption'] as const)(
        'preserves team metadata when public sync refuses %s', async reason => {
            const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-sync-refusal-metadata-')))
            scratch.push(directory)
            const configPath = join(directory, 'cockpit.toml')
            mkdirSync(join(directory, 'app'))
            mkdirSync(join(directory, 'fixtures'))
            writeFileSync(join(directory, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
            writeFileSync(configPath, readFileSync(join(root, 'fixtures/registries/generated-environment.toml'), 'utf8')
                .replace('name = "generated-environment"', 'name = "refusal-metadata"\nsiblings_root = "."'))
            if (reason === 'owned surface') {
                const initial = captureIo()
                expect(await runCli(['sync', '--config', configPath, '--json'], initial.io), initial.output().stdout).toBe(0)
            }
            const metadata = {
                'package.json': '{"private":true}\n',
                'package-lock.json': '{"lockfileVersion":3,"canary":"unchanged"}\n',
                '.gitignore': 'operator-owned\n',
            }
            for (const [path, bytes] of Object.entries(metadata)) writeFileSync(join(directory, path), bytes)
            const guard = join(directory, '.cockpit/guards/bash-guard.sh')
            if (reason !== 'adoption') {
                mkdirSync(dirname(guard), { recursive: true })
                writeFileSync(guard, '# operator change\n')
            } else {
                // A file under cockpit/adopted/ is merged on every sync; this one would switch the guard off.
                mkdirSync(join(directory, 'cockpit/adopted/.claude'), { recursive: true })
                writeFileSync(join(directory, 'cockpit/adopted/.claude/settings.json'), '{ "disableAllHooks": true }\n')
            }
            const capture = captureIo()
            expect(await runCli(['sync', '--config', configPath, '--json'], capture.io)).toBe(2)
            expect(JSON.parse(capture.output().stdout).diagnostics).toEqual([
                expect.objectContaining({ code: reason === 'adoption' ? 'SURFACE_ADOPTION_REFUSED' : 'SURFACE_STATE_CONFLICT' }),
            ])
            for (const [path, bytes] of Object.entries(metadata)) expect(readFileSync(join(directory, path), 'utf8'), path).toBe(bytes)
            if (reason !== 'adoption') expect(readFileSync(guard, 'utf8')).toBe('# operator change\n')
        },
    )

    it.each([
        ['a conflicting package pin', JSON.stringify({ devDependencies: { '@b00dea/cockpit': '9.9.9' } }), 'operator-owned\n'],
        ['a dependencies package slot', JSON.stringify({ dependencies: {
            [installedPackageMetadata.name]: installedPackageMetadata.version } }), 'operator-owned\n'],
        ['an optionalDependencies package slot', JSON.stringify({ optionalDependencies: {
            [installedPackageMetadata.name]: installedPackageMetadata.version } }), 'operator-owned\n'],
        ['a peerDependencies package slot', JSON.stringify({ peerDependencies: {
            [installedPackageMetadata.name]: installedPackageMetadata.version } }), 'operator-owned\n'],
        ['a conflicting cockpit script', JSON.stringify({ scripts: { 'cockpit:sync': 'custom sync' } }), 'operator-owned\n'],
        ['an edited owned ignore block', '{"private":true}\n', '# cockpit:ignore:start\n/human-edit/\n# cockpit:ignore:end\n'],
    ])('refuses %s before public sync changes team metadata', async (_name, packageBytes, ignoreBytes) => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-sync-conflicting-metadata-')))
        scratch.push(directory)
        const configPath = join(directory, 'cockpit.toml')
        writeFileSync(configPath, readFileSync(join(root, 'fixtures/registries/generated-environment.toml'), 'utf8')
            .replace('name = "generated-environment"', 'name = "conflicting-metadata"'))
        writeFileSync(join(directory, 'package.json'), packageBytes)
        writeFileSync(join(directory, 'package-lock.json'), '{"lockfileVersion":3,"canary":"unchanged"}\n')
        writeFileSync(join(directory, '.gitignore'), ignoreBytes)
        const capture = captureIo()

        expect(await runCli(['sync', '--config', configPath, '--json'], capture.io)).toBe(2)

        expect(JSON.parse(capture.output().stdout).diagnostics).toEqual([
            expect.objectContaining({ severity: 'error', code: 'TEAM_METADATA_UNAVAILABLE' }),
        ])
        expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(packageBytes)
        expect(readFileSync(join(directory, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3,"canary":"unchanged"}\n')
        expect(readFileSync(join(directory, '.gitignore'), 'utf8')).toBe(ignoreBytes)
    })

    it.each([[['--dry-run']], [[]]])('names the invalid configuration field when sync %j refuses before writing', async (flags) => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-sync-invalid-config-')))
        scratch.push(directory)
        const configPath = join(directory, 'cockpit.toml')
        writeFileSync(configPath, readFileSync(join(root, 'fixtures/registries/generated-environment.toml'), 'utf8')
            .replace('dir = "app"', 'dir = "../escape"'))
        const capture = captureIo()

        expect(await runCli(['sync', '--config', configPath, '--json', ...flags], capture.io)).toBe(2)

        expect(JSON.parse(capture.output().stdout).diagnostics).toEqual([expect.objectContaining({
            severity: 'error', code: 'CONFIG_SCHEMA_INVALID', target: configPath, message: expect.stringContaining('sibling.0.dir:'),
        })])
        expect(readdirSync(directory)).toEqual(['cockpit.toml'])
    })

    it('binds doctor freshness only after CI and NO_UPDATE_NOTIFIER transport admissions', async () => {
        const transport = vi.fn(async () => ({ status: 200, body: (async function* () {
            yield Buffer.from(JSON.stringify({ name: '@b00dea/cockpit', version: '1.2.3' }))
        })() }))
        const createReleaseMetadataTransport = vi.fn(() => transport)
        for (const env of [{ CI: '0' }, { NO_UPDATE_NOTIFIER: 'false' }]) {
            const capture = captureIo()
            await runCli(['doctor', '--config', '/synthetic/missing.toml', '--json'], capture.io, {}, { env, createReleaseMetadataTransport })
            expect(JSON.parse(capture.output().stdout).result.freshness.release).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/disabled/) })
        }
        expect(createReleaseMetadataTransport).not.toHaveBeenCalled()
        expect(transport).not.toHaveBeenCalled()
        for (const command of ['check', 'sync', 'up', 'sleep', 'down', 'reset', 'preflight', 'logs', 'setup']) {
            const capture = captureIo()
            await runCli([command, '--config', '/synthetic/missing.toml', '--json'], capture.io, {}, { env: {}, createReleaseMetadataTransport })
        }
        expect(createReleaseMetadataTransport).not.toHaveBeenCalled()
        for (let index = 0; index < 2; index++) {
            const capture = captureIo()
            await runCli(['doctor', '--config', '/synthetic/missing.toml', '--json'], capture.io, {}, { env: {}, createReleaseMetadataTransport })
            expect(JSON.parse(capture.output().stdout).result.freshness.release).toMatchObject({ kind: 'known', latestVersion: '1.2.3' })
        }
        expect(createReleaseMetadataTransport).toHaveBeenCalledTimes(1)
        expect(transport).toHaveBeenCalledTimes(1)
    })
    it('prints doctor as a short report with its findings and the commands that show the detail', async () => {
        const capture = captureIo()
        const surfaceOverrides = {
            kind: 'complete',
            activeOverrides: [{ name: 'review', feature: 'skills', originalSha256: 'a'.repeat(64), recordedSha256: 'a'.repeat(64), overlaySource: 'surfaces/review.json' }],
            changedOverrideOriginals: [],
        }
        const owned = Array.from({ length: 500 }, (_, index) => ({ path: `.claude/skills/s${index}/SKILL.md`, authority: 'generated' }))
        const freshness = {
            local: { kind: 'complete', status: 0, diagnostics: [], result: { paths: owned } },
            changes: [{ operation: 'write', path: 'compose.cockpit.yml' }],
            release: { kind: 'known', package: '@b00dea/cockpit', installedVersion: '1.0.0', latestVersion: '1.2.3', currency: 'different-version' },
        }
        expect(await runCli(['doctor', '--config', 'cockpit.toml'], capture.io, {
            doctor: async () => ({ status: 0,
                diagnostics: [{ severity: 'warning', code: 'GUARD_HOSTS_UNDECLARED', target: 'guards', message: 'synthetic warning' }],
                result: { verdict: 'pass', checks: [{ verdict: 'pass' }, { verdict: 'pass' }, { verdict: 'not-applicable' }], comparisons: [], surfaceOverrides, freshness,
                    declarations: [{ subject: 'runtime', state: 'declared' }, { subject: 'reset-volumes', state: 'not-declared' }, { subject: 'docs', state: 'declared' }] } }),
        })).toBe(0)
        const config = resolve('cockpit.toml')
        expect(capture.output().stdout).toBe([
            'Doctor: pass. Findings: 1 warning, listed below.',
            'Checks: 2 pass, 1 not applicable.',
            'Generated files: 1 change pending.',
            'Surface overrides: 1 active (review).',
            'Declared: runtime, docs; not declared: reset volumes.',
            `Documents: ./node_modules/@b00dea/cockpit/bin/cockpit.mjs docs check --config ${config} checks them; doctor does not.`,
            'Release: 1.2.3 is published; 1.0.0 is installed.',
            `Full report: ./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config ${config} --json`,
            `Generated file detail: ./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config ${config}`,
            '',
        ].join('\n'))
        expect(capture.output().stderr).toContain('WARNING GUARD_HOSTS_UNDECLARED')
    })

    it('reports a state lock a command took over from a dead holder, and nothing for a command that took none', async () => {
        const { hostname } = await import('node:os')
        const { randomUUID } = await import('node:crypto')
        const { mkdir, writeFile, readlink } = await import('node:fs/promises')
        const { selectStateRoot, transactState } = await import('./environment/state.js')
        const home = join(mkdtempSync(join(tmpdir(), 'cockpit-takeover-')), 'home')
        await mkdir(home)
        const selected = await selectStateRoot({ platform: 'linux', home, cockpitId: `cockpit:sample:${'a'.repeat(64)}` as never })
        if (selected.kind !== 'complete') throw new Error('expected a selected state root')
        const namespace = selected.value
        const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
        await mkdir(namespace.paths.stateLock, { recursive: true })
        await writeFile(join(namespace.paths.stateLock, 'owner.json'), `${JSON.stringify({
            format: 'cockpit-state/v1', kind: 'state-lock', ownerId: `holder:${'d'.repeat(64)}:session`, pid: Number(child.stdout),
            command: 'cockpit.mjs reset --config cockpit.toml', acquiredAt: '2000-01-01T00:00:00.000Z', token: randomUUID(),
            host: hostname(), ...(process.platform === 'linux' ? { pidNamespace: await readlink('/proc/self/ns/pid') } : {}),
        })}\n`)
        const stackId = `stack:${'b'.repeat(64)}` as never
        // A command that writes state takes the lock; stacks stands in for any such non-lifecycle command.
        const takesLock = async () => {
            const address = namespace.paths.lifecycle(stackId)
            const result = await transactState(namespace, address, { ownerId: `holder:${'e'.repeat(64)}:session` as never, contentionTimeoutMs: 5_000 },
                async () => ({ format: 'cockpit-state/v1', kind: address.kind, cockpitId: address.cockpitId, subjectId: address.subjectId,
                    revision: 0, updatedAt: '2026-09-07T12:00:00.000Z', value: {} }) as never)
            if (result.kind !== 'complete') throw new Error(JSON.stringify(result))
            return { artifact: null, destination: null, status: 0, diagnostics: [], result: null }
        }
        const takesNone = async () => ({ artifact: null, destination: null, status: 0, diagnostics: [], result: null })

        const first = captureIo()
        expect(await runCli(['stacks', '--config', 'cockpit.toml', '--json'], first.io, { stacks: takesLock })).toBe(0)
        expect(JSON.parse(first.output().stdout).diagnostics).toEqual([expect.objectContaining({
            severity: 'warning', code: 'STATE_LOCK_RECLAIMED', target: namespace.paths.stateLock,
            message: expect.stringContaining(`process ${child.stdout} (cockpit.mjs reset --config cockpit.toml)`),
        })])

        // Reported once: the next command, which takes no lock, says nothing.
        const second = captureIo()
        expect(await runCli(['stacks', '--config', 'cockpit.toml', '--json'], second.io, { stacks: takesNone })).toBe(0)
        expect(JSON.parse(second.output().stdout).diagnostics).toEqual([])
    })

    it.each(['sync', 'check'] as const)('routes %s in JSON and human modes', async (command) => {
        const calls: unknown[] = []
        const handler = async (input: unknown) => {
            calls.push(input)
            return {
                artifact: null, destination: null, status: 0,
                diagnostics: [{ severity: 'info' as const, code: 'GENERATED_CURRENT', message: 'generated files are current' }],
                result: { action: command, paths: ['compose.generated.yml'] },
            }
        }
        const json = captureIo()
        expect(await runCli([command, '--config', 'cockpit.toml', '--json'], json.io, { [command]: handler, loadPolicy: quietPolicy })).toBe(0)
        expect(JSON.parse(json.output().stdout)).toEqual({
            invocation: jsonInvocation(json.output().stdout, 0, command, resolve('cockpit.toml')),
            result: { action: command, paths: ['compose.generated.yml'] },
            diagnostics: [{ severity: 'info', code: 'GENERATED_CURRENT', message: 'generated files are current' }],
        })
        expect(json.output().stderr).toBe('')

        const human = captureIo()
        expect(await runCli([command, '--config=cockpit.toml'], human.io, { [command]: handler, loadPolicy: quietPolicy })).toBe(0)
        expect({ ...human.output(), stderr: humanStderr(human.output().stderr) })
            .toEqual({ stdout: '', stderr: 'INFO GENERATED_CURRENT: generated files are current\n' })
        expect(calls).toEqual([expect.objectContaining({ configPath: 'cockpit.toml' }), expect.objectContaining({ configPath: 'cockpit.toml' })])
    })

    it.each(['sync', 'check'] as const)('rejects malformed %s invocation before dispatch', async (command) => {
        let calls = 0
        const handler = async () => {
            calls += 1
            throw new Error('must not run')
        }
        for (const args of [
            [command],
            [command, '--config', 'one.toml', '--config=two.toml'],
            [command, '--config', 'one.toml', 'positional'],
        ]) {
            const capture = captureIo()
            expect(await runCli(args, capture.io, { [command]: handler, loadPolicy: quietPolicy })).toBe(2)
            expect(capture.output().stderr).toContain('CLI_USAGE_INVALID')
        }
        expect(calls).toBe(0)
    })

    it('routes sync dry-run as an explicit preview and rejects that option on check', async () => {
        const calls: unknown[] = []
        const capture = captureIo()
        expect(await runCli(['sync', '--config', 'cockpit.toml', '--dry-run', '--json'], capture.io, {
            sync: async (input) => {
                calls.push(input)
                return { status: 0, diagnostics: [], result: { action: 'sync', dryRun: true, changes: [{ operation: 'write', path: 'compose.generated.yml' }] } }
            },
        })).toBe(0)
        expect(calls).toEqual([{ configPath: 'cockpit.toml', dryRun: true }])
        expect(JSON.parse(capture.output().stdout).result.changes).toEqual([{ operation: 'write', path: 'compose.generated.yml' }])
        expect(await runCli(['check', '--config', 'cockpit.toml', '--dry-run'], captureIo().io)).toBe(2)

    })

    it('refuses interactive sync without a terminal before previewing, and applies nothing on a no', async () => {
        const calls: unknown[] = []
        const sync = async (input: { dryRun?: boolean }) => {
            calls.push(input)
            return { status: 0, diagnostics: [], result: { action: 'sync', dryRun: input.dryRun === true, sourceSha256: 'a'.repeat(64), changes: [] } }
        }

        expect(await runCli(['sync', '--config', 'cockpit.toml', '--interactive'], captureIo().io, { sync, loadPolicy: widenedPolicy }, { env: {} })).toBe(2)
        expect(calls).toEqual([])
        expect(await runCli(['sync', '--config', 'cockpit.toml', '--interactive'], captureIo(async () => false).io,
            { sync, loadPolicy: widenedPolicy }, { env: {} })).toBe(2)
        expect(calls).toEqual([{ configPath: 'cockpit.toml', dryRun: true, approveDeclaredMcp: true }])
    })

    it('refuses interactive sync in JSON and CI modes before previewing', async () => {
        let calls = 0
        const sync = async () => {
            calls += 1
            return { status: 0, diagnostics: [], result: { action: 'sync', dryRun: true, changes: [] } }
        }
        const confirmed = captureIo(async () => true)

        expect(await runCli(
            ['sync', '--config', 'cockpit.toml', '--interactive', '--json'],
            confirmed.io,
            { sync, loadPolicy: quietPolicy },
        )).toBe(2)
        expect(await runCli(
            ['sync', '--config', 'cockpit.toml', '--interactive'],
            confirmed.io,
            { sync, loadPolicy: quietPolicy },
            { env: { CI: '1' } },
        )).toBe(2)
        expect(calls).toBe(0)
    })

    it('applies interactive sync without prompting when nothing widens', async () => {
        const calls: unknown[] = []
        let confirmations = 0
        const capture = captureIo(async () => {
            confirmations += 1
            return false
        })

        expect(await runCli(['sync', '--config', 'cockpit.toml', '--interactive'], capture.io, {
            loadPolicy: quietPolicy,
            sync: async (input) => {
                calls.push(input)
                return { status: 0, diagnostics: [], result: { action: 'sync', dryRun: input.dryRun === true, sourceSha256: 'a'.repeat(64), changes: [] } }
            },
        }, { env: {} })).toBe(0)
        expect(calls).toEqual([{ configPath: 'cockpit.toml', dryRun: true, approveDeclaredMcp: true },
            expect.objectContaining({ configPath: 'cockpit.toml', guardWidening: { configSha256: 'a'.repeat(64) } })])
        expect(confirmations).toBe(0)
        // A person at a terminal had nothing to approve, and sync printed nothing at all: they could
        // not tell it ran, nor that it left files to commit.
        const applied = async (input: { dryRun?: boolean }) => ({ status: 0, diagnostics: [], result: input.dryRun === true
            ? { action: 'sync', dryRun: true, sourceSha256: 'a'.repeat(64), changes: [] }
            : { action: 'sync', dryRun: false, paths: ['AGENTS.md', 'CLAUDE.md'], changes: [{ operation: 'write', path: 'AGENTS.md' }] } })
        const first = captureIo(async () => false)
        expect(await runCli(['sync', '--config', 'cockpit.toml', '--interactive'], first.io, { loadPolicy: quietPolicy, sync: applied }, { env: {} })).toBe(0)
        expect(first.output().stdout).toBe('write "AGENTS.md"\n'
            + 'Sync wrote 1 file; 1 generated file was already current. Review them with git status --short and commit them so teammates get the same files.\n')
        const unchanged = captureIo(async () => false)
        expect(await runCli(['sync', '--config', 'cockpit.toml', '--interactive'], unchanged.io, { loadPolicy: quietPolicy,
            sync: async (input) => ({ status: 0, diagnostics: [], result: { action: 'sync', dryRun: input.dryRun === true, sourceSha256: 'a'.repeat(64), paths: ['AGENTS.md', 'CLAUDE.md'], changes: [] } }) }, { env: {} })).toBe(0)
        expect(unchanged.output().stdout).toBe('Nothing to sync: all 2 generated files were already current.\n')
    })

    // Agents are told to pass --json to every command but session.
    it('prints an upgrade outcome as JSON', async () => {
        const json = captureIo()
        expect(await runCli(['upgrade', '--config', 'cockpit.toml', '--dry-run', '--json'], json.io, {
            upgrade: async () => ({ status: 0, diagnostics: [], result: { dryRun: true } }),
        })).toBe(0)
        expect(JSON.parse(json.output().stdout)).toMatchObject({ result: { dryRun: true } })
    })

    it('shows preview changes in human mode', async () => {
        const preview = captureIo()
        expect(await runCli(['sync', '--config', 'cockpit.toml', '--dry-run'], preview.io, {
            sync: async () => ({ status: 0, diagnostics: [], result: {
                action: 'sync', dryRun: true, changes: [{ operation: 'write', path: '.agents/skills/cockpit-fix/SKILL.md' }],
            } }),
        })).toBe(0)
        expect(preview.output().stdout).toContain('write ".agents/skills/cockpit-fix/SKILL.md"')
    })
})

describe('setup process contract', () => {
    function captureIo() {
        let stdout = ''
        let stderr = ''
        const io = {
            stdout: { write: (text: string) => ((stdout += text), true) },
            stderr: { write: (text: string) => ((stderr += text), true) },
        } as unknown as CliIo
        return { io, output: () => ({ stdout, stderr }) }
    }

    async function withPlatform<T>(platform: NodeJS.Platform, action: () => Promise<T>): Promise<T> {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
        Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
        try { return await action() }
        finally { Object.defineProperty(process, 'platform', descriptor) }
    }

    function setupOutcome(step?: ExecutionStep): Exclude<EnvironmentCommandOutcome<{
        source: { path: string; byteLength: number; sha256: string }
        siblings: readonly SetupResult[]
    }>, { kind: 'refusal' }> {
        const result = {
            source: { path: '/tmp/synthetic-cockpit.toml', byteLength: 128, sha256: 'a'.repeat(64) },
            siblings: [{
                sibling: 'api', target: '/tmp/synthetic-api', observed: 'directory',
                action: step ? 'wire-remote' : 'report',
                changed: step !== undefined,
            } as const],
        }
        return step
            ? { kind: 'preview', status: 0, diagnostics: [], result, plan: { steps: [step] } }
            : { kind: 'complete', status: 0, diagnostics: [], result }
    }

    it('composes authenticated setup authorities for the default handler', () => {
        const testRoot = mkdtempSync(join(tmpdir(), 'cockpit-cli-setup-default-'))
        scratch.push(testRoot)
        const directory = join(testRoot, 'checkout')
        const home = join(testRoot, 'home')
        mkdirSync(directory)
        mkdirSync(home)
        execFileSync('git', ['init', '--quiet', directory])
        const configPath = join(directory, 'cockpit.toml')
        writeFileSync(configPath, renderSetupConfig())

        const irrelevantSecret = 'irrelevant-secret-canary'.repeat(4_096)
        const result = run(['setup', '--config', configPath, '--json'], {
            HOME: home,
            COCKPIT_TEST_IRRELEVANT_SECRET: irrelevantSecret,
        })
        const canonicalDirectory = realpathSync(directory)
        const canonicalConfigPath = realpathSync(configPath)

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({
            invocation: jsonInvocation(result.stdout, result.status!, 'setup', resolve(configPath)),
            result: {
                source: {
                    path: canonicalConfigPath,
                    byteLength: Buffer.byteLength(readFileSync(configPath)),
                    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                },
                siblings: [{
                    sibling: 'assets',
                    target: join(canonicalDirectory, 'assets'),
                    observed: 'absent',
                    action: 'report',
                    changed: false,
                }],
            },
            diagnostics: [{
                severity: 'info',
                code: 'SETUP_NONE_ABSENT',
                message: 'acquire = "none", so setup leaves this path alone: nothing exists there yet',
                target: join(canonicalDirectory, 'assets'),
            }],
        })
        expect(result.stderr).toBe('')
        expect(result.stdout).not.toContain(irrelevantSecret)
    })

    it('refuses every command on native Windows before dispatch, in human and JSON modes', async () => {
        const setup = vi.fn(async () => ({ status: 0, diagnostics: [], result: null }))
        const human = captureIo()
        expect(await withPlatform('win32', () => runCli(['setup', '--config', 'cockpit.toml'], human.io, { setup }))).toBe(2)
        expect(human.output().stdout).toBe('')
        expect(human.output().stderr).toContain('CLI_PLATFORM_UNSUPPORTED')
        expect(human.output().stderr).toContain('run cockpit on a macOS or Linux host')
        const json = captureIo()
        expect(await withPlatform('win32', () => runCli(['guard-evaluate', '--harness', 'claudecode', '--json'], json.io))).toBe(2)
        expect(JSON.parse(json.output().stdout)).toMatchObject({ result: null, diagnostics: [{ code: 'CLI_PLATFORM_UNSUPPORTED' }] })
        expect(setup).not.toHaveBeenCalled()
    })

    it.each([
        ['missing automatic checkout parent', '.', 'missing/api', false, 'SETUP_PARENT_MISSING', 'missing'],
        ['absent siblings root', 'missing-siblings', 'api', false, 'SETUP_PATH_TYPE_INVALID', 'missing-siblings/api'],
        ['symlinked checkout target', '.', 'api', true, 'SETUP_PATH_SYMLINK', 'api'],
    ] as const)('attributes a %s refusal to the canonical configuration source', (
        _label, siblingsRoot, siblingDir, symlinkTarget, code, originalRelativeTarget,
    ) => {
        const testRoot = mkdtempSync(join(tmpdir(), 'cockpit-cli-setup-refusal-'))
        scratch.push(testRoot)
        const directory = join(testRoot, 'checkout')
        const home = join(testRoot, 'home')
        mkdirSync(directory)
        mkdirSync(home)
        execFileSync('git', ['init', '--quiet', directory])
        const configPath = join(directory, 'cockpit.toml')
        writeFileSync(configPath, renderSetupConfig({
            siblingsRoot,
            siblingFields: [
                'slug = "api"', `dir = ${JSON.stringify(siblingDir)}`, 'remote = "ssh://example.invalid/api.git"',
                'mount = "always"', 'acquire = "auto"', 'var = "API_DIR"',
                'toolchain = "none"', 'purpose = "Synthetic API"',
            ],
        }))
        if (symlinkTarget) {
            mkdirSync(join(directory, 'target'))
            symlinkSync(join(directory, 'target'), join(directory, 'api'))
        }

        const result = run(['setup', '--config', configPath, '--json'], { HOME: home })
        const response = JSON.parse(result.stdout)
        const canonicalConfigPath = realpathSync(configPath)
        const originalTarget = join(realpathSync(directory), originalRelativeTarget)

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2)
        expect(response).toEqual({
            invocation: jsonInvocation(result.stdout, result.status!, 'setup', resolve(configPath)),
            result: null,
            diagnostics: [{
                severity: 'error', code,
                message: expect.stringContaining(`(${originalTarget})`),
                target: canonicalConfigPath,
            }],
            evidence: expect.any(Object),
        })
        expect(response.diagnostics[0].message.split(originalTarget)).toHaveLength(2)
        expect(result.stderr).toBe('')
    })

    it('does not read an irrelevant ambient environment getter', async () => {
        const testRoot = mkdtempSync(join(tmpdir(), 'cockpit-cli-setup-environment-'))
        scratch.push(testRoot)
        const directory = join(testRoot, 'checkout')
        const home = join(testRoot, 'home')
        mkdirSync(directory)
        mkdirSync(home)
        execFileSync('git', ['init', '--quiet', directory])
        const configPath = join(directory, 'cockpit.toml')
        writeFileSync(configPath, renderSetupConfig())
        const originalEnvironment = process.env
        const environment = { ...originalEnvironment, HOME: home, COCKPIT_TEST_UNREADABLE: 'present' }
        process.env = new Proxy(environment, {
            get(target, property, receiver) {
                if (property === 'COCKPIT_TEST_UNREADABLE') throw new Error('irrelevant-secret-canary')
                return Reflect.get(target, property, receiver)
            },
        })
        const capture = captureIo()
        try {
            const status = await runCli(['setup', '--config', configPath, '--json'], capture.io)

            expect(status, `${capture.output().stdout}\n${capture.output().stderr}`).toBe(0)
            expect(capture.output().stdout).not.toContain('irrelevant-secret-canary')
            expect(capture.output().stderr).toBe('')
        } finally {
            process.env = originalEnvironment
        }
    })

    it('refuses a malformed relevant ambient environment value', async () => {
        const originalEnvironment = process.env
        process.env = new Proxy({ ...originalEnvironment }, {
            get(target, property, receiver) {
                if (property === 'HOME') return 'malformed\0home'
                return Reflect.get(target, property, receiver)
            },
        })
        const capture = captureIo()
        try {
            const status = await runCli(['setup', '--config', 'unread.toml', '--json'], capture.io)

            expect(status).toBe(2)
            expect(JSON.parse(capture.output().stdout)).toEqual({
                invocation: jsonInvocation(capture.output().stdout, status, 'setup', resolve('unread.toml')),
                result: null,
                diagnostics: [{
                    severity: 'error',
                    code: 'SETUP_PATH_TYPE_INVALID',
                    message: 'setup environment is not valid bounded data',
                    target: 'setup-environment',
                }],
            })
            expect(capture.output().stderr).toBe('')
        } finally {
            process.env = originalEnvironment
        }
    })

    it('refuses a linked-worktree state root contained in the main checkout', () => {
        const testRoot = mkdtempSync(join(tmpdir(), 'cockpit-cli-setup-state-root-'))
        scratch.push(testRoot)
        const mainCheckout = join(testRoot, 'main')
        const linkedCheckout = join(mainCheckout, 'linked')
        mkdirSync(mainCheckout)
        execFileSync('git', ['init', '--quiet', mainCheckout])
        execFileSync('git', ['-C', mainCheckout, 'config', 'user.name', 'Synthetic'])
        execFileSync('git', ['-C', mainCheckout, 'config', 'user.email', 'synthetic@example.invalid'])
        writeFileSync(join(mainCheckout, 'tracked'), 'base\n')
        execFileSync('git', ['-C', mainCheckout, 'add', 'tracked'])
        execFileSync('git', ['-C', mainCheckout, 'commit', '--quiet', '-m', 'base'])
        execFileSync('git', ['-C', mainCheckout, 'worktree', 'add', '--quiet', '-b', 'linked', linkedCheckout])
        const configPath = join(linkedCheckout, 'cockpit.toml')
        writeFileSync(configPath, renderSetupConfig())

        const result = run(['setup', '--config', configPath, '--json'], { HOME: realpathSync(mainCheckout) })

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2)
        expect(JSON.parse(result.stdout)).toEqual({
            invocation: jsonInvocation(result.stdout, result.status!, 'setup', resolve(configPath)),
            result: null,
            diagnostics: [{
                severity: 'error',
                code: 'STATE_ROOT_UNAVAILABLE',
                message: expect.stringMatching(/^the state root .* lies inside the checkout /),
                target: expect.stringContaining(mainCheckout),
            }],
        })
        expect(result.stderr).toBe('')
    })

    it('composes seed and install-policy owners without exposing environment values', () => {
        const testRoot = mkdtempSync(join(tmpdir(), 'cockpit-cli-setup-seed-'))
        scratch.push(testRoot)
        const checkout = join(testRoot, 'checkout')
        const home = join(testRoot, 'home')
        const siblingRoot = join(checkout, 'repositories', 'api')
        mkdirSync(siblingRoot, { recursive: true })
        mkdirSync(home)
        execFileSync('git', ['init', '--quiet', checkout])
        execFileSync('git', ['init', '--quiet', siblingRoot])
        execFileSync('git', ['-C', siblingRoot, 'remote', 'add', 'origin', 'ssh://example.invalid/api.git'])
        const canary = 'seed-value-canary'
        writeFileSync(join(siblingRoot, '.gitignore'), '.env\n!.env.example\n')
        writeFileSync(join(siblingRoot, '.env.example'), `TOKEN=${canary}\n`)
        writeFileSync(join(siblingRoot, 'package-lock.json'), '{}\n')
        execFileSync('git', ['-C', siblingRoot, 'add', '.gitignore', '.env.example', 'package-lock.json'])
        const configPath = join(checkout, 'cockpit.toml')
        writeFileSync(configPath, renderSetupConfig({
            siblingsRoot: 'repositories',
            siblingFields: [
                'slug = "api"',
                'dir = "api"',
                'remote = "ssh://example.invalid/api.git"',
                'mount = "always"',
                'acquire = "manual"',
                'var = "API_DIR"',
                'toolchain = "node"',
                'purpose = "Synthetic API"',
                'environment_files = [{ template = ".env.example", instance = ".env" }]',
            ],
            sections: [
                '[environment]',
                'install_policies = [{ toolchain = "node", lockfile = "package-lock.json", build = ["npm", "run", "build"] }]',
                '',
            ],
        }))

        const result = run(['setup', '--config', configPath, '--json'], { HOME: home })

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
        expect(readFileSync(join(siblingRoot, '.env'), 'utf8')).toBe(`TOKEN=${canary}\n`)
        expect(result.stdout).not.toContain(canary)
        expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
            result: expect.objectContaining({
                siblings: [expect.objectContaining({ sibling: 'api', action: 'report', changed: false })],
                installPolicies: [expect.objectContaining({
                    siblingSlug: 'api',
                    policy: expect.objectContaining({ toolchain: 'node', lockfile: 'package-lock.json' }),
                })],
                execution: expect.objectContaining({ mutationMayHaveOccurred: true, completedStepIds: [] }),
            }),
            diagnostics: [],
        }))
        expect(result.stderr).toBe('')
    })

    it('does not execute a plan returned by a handler override', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-cli-setup-'))
        scratch.push(directory)
        const marker = join(directory, 'executed')
        const step: ExecutionStep = {
            id: 'setup:api:test', argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done')`], argv0: process.execPath,
            cwd: directory, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 2_000,
            stdoutLimitBytes: 1_024, stderrLimitBytes: 1_024, paths: [marker], ports: [], labels: {}, expected: [],
            consumedFiles: [], filesystemChecks: [], compensation: [],
        }
        const capture = captureIo()
        const status = await runCli(['setup', '--config', 'cockpit.toml'], capture.io, {
            setup: async () => setupOutcome(step),
        })
        expect(status).toBe(0)
        expect(existsSync(marker)).toBe(false)
        expect({ ...capture.output(), stderr: humanStderr(capture.output().stderr) })
            .toEqual({ stdout: '', stderr: '' })
    })

    it('emits one JSON document for a report-only setup result', async () => {
        const capture = captureIo()
        const status = await runCli(['setup', '--config', 'cockpit.toml', '--json'], capture.io, {
            setup: async () => setupOutcome(),
        })
        expect(status).toBe(0)
        expect(JSON.parse(capture.output().stdout)).toEqual({ invocation: jsonInvocation(capture.output().stdout, status, 'setup', resolve('cockpit.toml')), result: setupOutcome().result, diagnostics: [] })
        expect(capture.output().stderr).toBe('')
    })

    it('routes explicit instruction-pointer write authority to setup', async () => {
        const seen: unknown[] = []
        const capture = captureIo()
        expect(await runCli(['setup', '--config', 'cockpit.toml', '--write-instruction-pointers'], capture.io, {
            setup: async input => { seen.push(input); return setupOutcome() },
        })).toBe(0)
        expect(seen).toEqual([{ configPath: 'cockpit.toml', writeInstructionPointers: true }])
    })

    it('routes explicit sibling instruction file write authority to setup', async () => {
        const seen: unknown[] = []
        expect(await runCli(['setup', '--config', 'cockpit.toml', '--write-instruction-files'], captureIo().io, {
            setup: async input => { seen.push(input); return setupOutcome() },
        })).toBe(0)
        expect(seen).toEqual([{ configPath: 'cockpit.toml', writeInstructionFiles: true }])
    })

    it('keeps setup refusals off stdout for humans and null in JSON mode', async () => {
        const refusal = { kind: 'refusal', status: 2, diagnostics: [{ severity: 'error', code: 'SETUP_PATH_TYPE_INVALID', message: 'synthetic refusal' }], result: null } as const
        const human = captureIo()
        expect(await runCli(['setup', '--config', 'cockpit.toml'], human.io, { setup: async () => refusal })).toBe(2)
        expect({ ...human.output(), stderr: humanStderr(human.output().stderr) })
            .toEqual({ stdout: '', stderr: 'ERROR SETUP_PATH_TYPE_INVALID: synthetic refusal\n' })
        const json = captureIo()
        expect(await runCli(['setup', '--config', 'cockpit.toml', '--json'], json.io, { setup: async () => refusal })).toBe(2)
        expect(JSON.parse(json.output().stdout).result).toBeNull()
        expect(json.output().stderr).toBe('')
    })

    it('refuses duplicate setup options before invoking setup and names the duplicated option', async () => {
        const handler = async () => setupOutcome()
        const human = captureIo()
        expect(await runCli(['setup', '--config', 'one.toml', '--config=two.toml'], human.io, { setup: handler })).toBe(2)
        expect(human.output().stdout).toBe('')
        expect(human.output().stderr).toContain('SETUP_OPTION_DUPLICATE')

        const json = captureIo()
        expect(await runCli(['setup', '--config=one.toml', '--config', 'two.toml', '--json'], json.io, { setup: handler })).toBe(2)
        expect(JSON.parse(json.output().stdout)).toEqual({
            invocation: jsonInvocation(json.output().stdout, 2, 'setup', null),
            result: null,
            diagnostics: [expect.objectContaining({ code: 'SETUP_OPTION_DUPLICATE' })],
        })
        expect(json.output().stderr).toBe('')

        const pointer = captureIo()
        expect(await runCli(['setup', '--config', 'cockpit.toml', '--write-instruction-pointers',
            '--write-instruction-pointers', '--json'], pointer.io, { setup: handler })).toBe(2)
        expect(JSON.parse(pointer.output().stdout).diagnostics).toEqual([
            expect.objectContaining({ code: 'SETUP_OPTION_DUPLICATE', target: '--write-instruction-pointers' }),
        ])
    })

    it('renders partial execution and compensation evidence without replacing diagnostic targets', async () => {
        const capture = captureIo()
        const evidence = {
            execution: {
                mutationMayHaveOccurred: true,
                completedStepIds: ['setup:other:clone'],
                failedStep: { id: 'setup:api:clone', started: true },
                compensation: {
                    attemptedStepIds: ['undo:api'],
                    completedStepIds: [],
                    failed: [{ id: 'undo:api', code: 'EXECUTION_STEP_FAILED' as const }],
                },
            },
            source: {
                before: setupOutcome().result.source,
                after: { state: 'available' as const, ...setupOutcome().result.source },
            },
        }
        const diagnostics = [{
            severity: 'error' as const,
            code: 'EXECUTION_COMPENSATION_STEP_FAILED' as const,
            message: 'compensation failed',
            target: 'undo:api',
        }]

        const status = await runCli(['setup', '--config', 'cockpit.toml', '--json'], capture.io, {
            setup: async () => ({ kind: 'refusal', status: 2, result: null, evidence, diagnostics }),
        })

        expect(status).toBe(2)
        expect(JSON.parse(capture.output().stdout)).toEqual({ invocation: jsonInvocation(capture.output().stdout, status, 'setup', resolve('cockpit.toml')), result: null, diagnostics, evidence })
        expect(capture.output().stderr).toBe('')
    })

    it('does not serialize config bytes from a config-change refusal', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-cli-config-evidence-'))
        scratch.push(directory)
        const configPath = join(directory, 'cockpit.toml')
        // The configuration carries the canary, so a source projection that kept raw bytes would leak it.
        const canary = 'raw-config-secret-sentinel'
        writeFileSync(configPath, [
            '[cockpit]', 'name = "synthetic-cockpit"', `siblings_root = ${JSON.stringify(directory)}`, '',
            '[[sibling]]', 'slug = "api"', 'dir = "api"',
            'remote = "ssh://example.invalid/api.git"', 'acquire = "auto"',
            'mount = "always"', 'var = "API_DIR"', `purpose = "Synthetic API ${canary}"`, '',
            '[ports]', 'bases = { APP_PORT = 4100 }', '',
        ].join('\n'))
        const loaded = await loadCockpitConfig(configPath)
        if (loaded.kind === 'refusal') throw new Error('fixture configuration did not load')
        const outcome = {
            kind: 'refusal' as const,
            status: 2 as const,
            diagnostics: [{
                severity: 'error' as const,
                code: 'CONFIG_CHANGED_DURING_EXECUTION' as const,
                message: 'cockpit configuration changed during setup execution',
                target: loaded.result.source.path,
            }],
            result: null,
            evidence: {
                execution: {
                    mutationMayHaveOccurred: true,
                    completedStepIds: ['setup:api:clone'],
                    compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] },
                },
                source: {
                    before: loaded.result.source,
                    after: { state: 'available' as const, ...loaded.result.source },
                },
            },
        }
        const capture = captureIo()

        const status = await runCli(['setup', '--config', configPath, '--json'], capture.io, {
            setup: async () => outcome,
        })

        expect(status).toBe(2)
        expect(JSON.parse(capture.output().stdout)).toEqual(expect.objectContaining({
            result: null,
            diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: 'CONFIG_CHANGED_DURING_EXECUTION' }),
            ]),
            evidence: expect.any(Object),
        }))
        expect(capture.output().stdout).not.toContain(canary)
        expect(capture.output().stderr).toBe('')
    })

    it('renders manual absence and every none posture as stable human diagnostics', async () => {
        const result = setupOutcome().result
        const diagnostics = [
            { severity: 'warning', code: 'SETUP_MANUAL_MISSING', message: 'manual checkout is absent', target: '/tmp/manual' },
            { severity: 'info', code: 'SETUP_NONE_ABSENT', message: 'acquire = "none", so setup leaves this path alone: nothing exists there yet', target: '/tmp/absent' },
            { severity: 'info', code: 'SETUP_NONE_DIRECTORY', message: 'acquire = "none", so setup leaves this path alone: it is a plain directory, not a Git checkout', target: '/tmp/directory' },
            { severity: 'info', code: 'SETUP_NONE_REPOSITORY', message: 'acquire = "none", so setup leaves this path alone: it is an existing Git checkout', target: '/tmp/repository' },
        ] as const
        const capture = captureIo()

        const status = await runCli(['setup', '--config', 'cockpit.toml'], capture.io, {
            setup: async () => ({ kind: 'complete', status: 0, result, diagnostics }),
        })

        expect(status).toBe(0)
        expect(capture.output().stdout).toBe('')
        expect(capture.output().stderr).toContain('WARNING SETUP_MANUAL_MISSING')
        expect(capture.output().stderr).toContain('INFO SETUP_NONE_ABSENT')
        expect(capture.output().stderr).toContain('INFO SETUP_NONE_DIRECTORY')
        expect(capture.output().stderr).toContain('INFO SETUP_NONE_REPOSITORY')
    })

    it('does not execute or expose a subprocess plan returned by a handler override', async () => {
        const canary = 'cli-subprocess-secret-canary'
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-cli-secret-'))
        scratch.push(directory)
        const step: ExecutionStep = {
            id: 'setup:api:secret-output',
            argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(canary)}); process.stderr.write(${JSON.stringify(canary)}); process.exit(7)`],
            argv0: process.execPath,
            cwd: directory,
            env: { PATH: process.env.PATH ?? '' },
            timeoutMs: 2_000,
            stdoutLimitBytes: 1_024,
            stderrLimitBytes: 1_024,
            paths: [],
            ports: [],
            labels: {},
            expected: [],
            consumedFiles: [], filesystemChecks: [],
            compensation: [],
        }
        const capture = captureIo()

        const status = await runCli(['setup', '--config', 'cockpit.toml', '--json'], capture.io, {
            setup: async () => setupOutcome(step),
        })

        expect(status).toBe(0)
        expect(capture.output().stdout).not.toContain(canary)
        expect(capture.output().stderr).not.toContain(canary)
        expect(JSON.stringify(JSON.parse(capture.output().stdout))).not.toContain(canary)
    })
})

describe('terminal-safe diagnostics', () => {
    it.each([false, true])('projects arbitrary guidance and admitted fixes once per human/JSON publication (%s)', async json => {
        const admission = fixCatalogue.admitDiagnosticFix
        const calls = new Set<unknown>()
        const projector = vi.spyOn(fixCatalogue, 'admitDiagnosticFix').mockImplementation((diagnostic, context) => {
            if (calls.has(diagnostic)) throw new Error('diagnostic projected twice')
            calls.add(diagnostic)
            return admission(diagnostic, context)
        })
        let stdout = '', stderr = ''
        const io: CliIo = { stdout: { write: text => { stdout += text; return true } },
            stderr: { write: text => { stderr += text; return true } } }
        try {
            const status = await runCli(['check', '--config', '/synthetic/cockpit.toml', ...(json ? ['--json'] : [])], io, {
                check: async () => ({ status: 2, result: null, diagnostics: [
                    { severity: 'error', code: 'ARBITRARY', message: 'Review required', fix: 'run something unsafe' },
                    { severity: 'error', code: 'GENERATED_ARTIFACT_DRIFT', target: '.codex/hooks.json', message: 'Generated bytes changed', fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>' },
                ], fixContext: { resolvedConfigPath: '/synthetic/cockpit.toml', generatedTargets: ['.codex/hooks.json'] } }),
            })
            expect(status).toBe(2)
            expect(projector).toHaveBeenCalledTimes(2)
            if (json) {
                const output = JSON.parse(stdout)
                expect(output.diagnostics[0]).not.toHaveProperty('fix')
                expect(output.guidance).toEqual([{ code: 'ARBITRARY', text: 'run something unsafe' }])
                expect(output.diagnostics[1].fix).toBe('./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config /synthetic/cockpit.toml')
                expect(stderr).toBe('')
            } else {
                expect(stderr).toContain('Guidance: run something unsafe')
                expect(stderr).not.toContain('Fix: run something unsafe')
                expect(stderr).toContain('Fix: ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config /synthetic/cockpit.toml')
                expect(stdout).toBe('')
            }
        } finally { projector.mockRestore() }
    })

    it('binds the configuration placeholder in a sibling refusal, whose arguments sit under the operation', async () => {
        let stdout = ''
        const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: () => true } }
        const status = await runCli(['sibling', 'remove', 'web', '--config', '/synthetic/cockpit.toml', '--json'], io, {
            sibling: async () => ({ status: 2, result: null, diagnostics: [{ severity: 'error', code: 'SYNTHETIC_REFUSAL', message: 'refused',
                fix: 'make the change by hand, then run npx --no cockpit sync --config <your cockpit.toml> --dry-run' }] }),
        })
        expect(status).toBe(2)
        const envelope = JSON.parse(stdout)
        expect(envelope.guidance).toEqual([{ code: 'SYNTHETIC_REFUSAL', text: 'make the change by hand, then run npx --no cockpit sync --config /synthetic/cockpit.toml --dry-run' }])
        expect(envelope.invocation.resolvedConfigPath).toBe('/synthetic/cockpit.toml')
    })

    it('reads bounded fatal UTF-8 private input once and publishes one projected closed refusal', async () => {
        for (const input of [Buffer.from('{'), Buffer.from([0xc3, 0x28]), Buffer.alloc(65_537, 32)]) {
            const projector = vi.spyOn(fixCatalogue, 'admitDiagnosticFix').mockImplementationOnce(() => undefined)
                .mockImplementation(() => { throw new Error('diagnostic projected twice') })
            let stdout = '', stderr = ''
            const io = { stdin: Readable.from([input]), stdout: { write: (text: string) => { stdout += text; return true } },
                stderr: { write: (text: string) => { stderr += text; return true } } } as unknown as CliIo
            try {
                expect(await runCli(['guard-evaluate', '--harness', 'claudecode'], io, {}, { env: {} })).toBe(0)
                expect(stderr).toBe('')
                expect(stdout).toMatch(/^[^\n]+\n$/)
                expect(JSON.parse(stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/^Guard input/) })
                expect(projector).toHaveBeenCalledTimes(1)
            } finally { projector.mockRestore() }
        }
    })

    // The hook registrations give a guard call 30 seconds, and what a harness does when that fires is
    // unmeasured, so the guard refuses on its own before then.
    it('refuses a guard call still undecided at its deadline, and stops reading its input', async () => {
        const stdin = new PassThrough()
        let stdout = '', stderr = ''
        const io = { stdin, stdout: { write: (text: string) => { stdout += text; return true } },
            stderr: { write: (text: string) => { stderr += text; return true } } } as unknown as CliIo
        expect(await runGuardCommand(['--harness', 'claudecode'], io, {}, performance.now() + 50)).toBe(0)
        expect(stderr).toBe('')
        expect(JSON.parse(stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/^The guard ran out of time/) })
        expect(stdin.destroyed).toBe(true)
    })

    it('visibly escapes C1 and Unicode bidi controls in every human diagnostic field', () => {
        const rendered = renderHumanDiagnostics([
            {
                severity: 'error',
                code: 'UNSAFE_TEXT',
                message: 'message\u0085\u202e\u061c\u2028',
                target: 'target\u009f\u2066\u200e',
                fix: 'fix\u202a\u2069\u200f\u2029',
            },
        ])

        expect(rendered).toBe(
            'ERROR UNSAFE_TEXT [target\\u009f\\u2066\\u200e]: message\\u0085\\u202e\\u061c\\u2028 Guidance: fix\\u202a\\u2069\\u200f\\u2029\n',
        )
    })
})

afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('generated sync operator admission', () => {
    it('shows the interactive widening preview as human-readable text', async () => {
        const stdin = Readable.from(['yes\n']) as NodeJS.ReadStream
        Object.defineProperty(stdin, 'isTTY', { value: true })
        const stderr = Object.assign(new PassThrough(), { isTTY: true })
        let shown = ''
        stderr.on('data', chunk => { shown += chunk.toString() })

        const outcome = await runSyncOperatorCommand({ configPath: 'cockpit.toml' }, {
            interactive: true, json: false, ci: undefined,
        }, { stderr, stdin, env: {} }, async (input) => input.dryRun
            ? { status: 0, diagnostics: [], result: { dryRun: true, sourceSha256: 'a'.repeat(64) } }
            : { status: 0, diagnostics: [], result: { dryRun: false } }, widenedPolicy)

        expect(outcome.status).toBe(0)
        expect(shown).toContain('widens:')
        expect(shown).toContain('guards.allow')
        expect(shown).not.toContain('{')
    })
})


describe('work command routing', () => {
    // Cases name the handler; a person types the command's words, such as `work accept`.
    const spelling = (handler: string) => commands.find(command => command.handler === handler)!.name
    it('completes a person gate only with the digest typed at a terminal, and passes an agent gate through', async () => {
        const digest = 'a'.repeat(64), prompt = `Accept WO-1 (digest ${digest})`
        const decide = vi.fn(async (answer: string) => ({ status: answer === digest ? 0 : 2, result: { accepted: answer === digest }, diagnostics: [] }))
        const begin = vi.fn(async () => ({ digest, prompt, decide }))
        const confirm = vi.fn(async (candidate: Readonly<{ digest: string; prompt: string }>) => candidate.digest)
        let stdout = '', stderr = ''
        const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) }, confirmWorkOrder: confirm }
        expect(await runCli(['work', 'accept', '--config', 'cockpit.toml', '--work-order', 'WO-1', '--interactive'], io, { beginOperatorWorkApplication: begin }, { env: {} })).toBe(0)
        expect(begin).toHaveBeenCalledExactlyOnceWith({ configPath: 'cockpit.toml', request: { operation: 'work-accept', workOrderId: 'WO-1' } })
        expect(confirm).toHaveBeenCalledExactlyOnceWith({ digest, prompt })
        expect(decide).toHaveBeenCalledExactlyOnceWith(digest)
        // The person who accepted sees what was recorded, not silence.
        expect(stdout).toBe('accepted: true\n')
        expect(humanStderr(stderr)).toBe('')
        for (const [args, request] of [
            [['work', 'signoff', '--work-order', 'WO-1', '--partial', '--note', 'AC3 is left'], { operation: 'work-signoff', workOrderId: 'WO-1', close: 'partial', note: 'AC3 is left' }],
        ] as const) {
            begin.mockClear(); decide.mockClear(); confirm.mockClear()
            expect(await runCli([...args, '--config', 'cockpit.toml', '--interactive'], io, { beginOperatorWorkApplication: begin }, { env: {} })).toBe(0)
            expect(begin).toHaveBeenCalledExactlyOnceWith({ configPath: 'cockpit.toml', request })
            expect(decide).toHaveBeenCalledExactlyOnceWith(digest)
        }
        // CI, a run without --interactive, and one without a terminal on both standard streams have nobody to read the prompt.
        const piped = { stdin: Readable.from([`accept ${digest}\n`]), stdout: { write: () => true }, stderr: { write: () => true } } as unknown as CliIo
        for (const [runIo, args, env] of [[io, ['--interactive'], { CI: '1' }], [io, [], {}], [piped, ['--interactive'], {}]] as const) {
            decide.mockClear(); confirm.mockClear()
            let output = ''
            const captured = runIo === io ? { ...io, stdout: { write: (text: string) => ((output += text), true) } } : runIo
            expect(await runCli(['work', 'accept', '--config', 'cockpit.toml', '--work-order', 'WO-1', '--json', ...args], captured, { beginOperatorWorkApplication: begin }, { env })).toBe(2)
            expect(decide).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled()
            if (runIo === io) expect(JSON.parse(output).diagnostics[0].code).toBe('WORK_PERSON_REQUIRED')
        }
        // Under an agent gate the application records the step itself, and no terminal is asked for.
        const recorded = vi.fn(async () => ({ status: 0, result: { by: 'agent' }, diagnostics: [] }))
        expect(await runCli(['work', 'accept', '--config', 'cockpit.toml', '--work-order', 'WO-1'], io, { beginOperatorWorkApplication: recorded }, { env: {} })).toBe(0)
        expect(recorded).toHaveBeenCalledOnce()
    })

    it('routes closed work browser and testing selectors through one configured application input', async () => {
        const cases: readonly (readonly [string, readonly string[], unknown, string?])[] = [
            ['work-status', [], { operation: 'work-status' }],
            ['work-status', ['--work-order', 'WO-1'], { operation: 'work-status', workOrderId: 'WO-1' }],
            ['work-check', ['--work-order', 'WO-1'], { operation: 'work-check', workOrderId: 'WO-1' }],
            ['work-note', ['--work-order', 'WO-1', '--text', 'tried the cache first'], { operation: 'work-note', workOrderId: 'WO-1', text: 'tried the cache first', kind: 'note' }],
            ['work-note', ['--work-order', 'WO-1', '--ask', '--text', 'Which origin?'], { operation: 'work-note', workOrderId: 'WO-1', text: 'Which origin?', kind: 'question' }],
            ['work-note', ['--work-order', 'WO-1', '--decision', '--text', 'Cache by tenant'], { operation: 'work-note', workOrderId: 'WO-1', text: 'Cache by tenant', kind: 'decision' }],
            ['work-decide', ['--work-order', 'WO-1', '--decision', '2', '--record', '--supersedes', '0007'], { operation: 'work-decide', workOrderId: 'WO-1', decision: 2, resolution: { kind: 'record', supersedes: '0007' } }],
            ['work-decide', ['--work-order', 'WO-1', '--decision', '2', '--record-file', 'app:docs/adr/0008-cache.md'], { operation: 'work-decide', workOrderId: 'WO-1', decision: 2, resolution: { kind: 'record', path: 'app:docs/adr/0008-cache.md' } }],
            ['work-decide', ['--work-order', 'WO-1', '--decision', '2', '--none', '--reason', 'reverted later'], { operation: 'work-decide', workOrderId: 'WO-1', decision: 2, resolution: { kind: 'none', reason: 'reverted later' } }],
            ['work-grade', ['--work-order', 'WO-1'], { operation: 'work-grade', workOrderId: 'WO-1' }],
            ['work-grade', ['--work-order', 'WO-1', '--evaluator', 'codexcli'], { operation: 'work-grade', workOrderId: 'WO-1' }, 'codexcli'],
            ['grade-criteria', ['--criteria', 'criteria.md', '--evaluator', 'opencode'], { operation: 'grade-criteria', criteriaFile: 'criteria.md' }, 'opencode'],
            ['work-grade', ['--work-order', 'WO-1', '--verdict', 'unmet', '--note', 'AC2 fails'], { operation: 'work-grade', workOrderId: 'WO-1', verdict: 'unmet', note: 'AC2 fails' }],
            ['work-recover', ['--work-order', 'WO-1'], { operation: 'work-recover', workOrderId: 'WO-1', apply: false }],
            ['work-recover', ['--work-order', 'WO-1', '--apply'], { operation: 'work-recover', workOrderId: 'WO-1', apply: true }],
            ['work-verify', [], { operation: 'work-verify' }],
            ['grade-criteria', ['--criteria', 'criteria.md'], { operation: 'grade-criteria', criteriaFile: 'criteria.md' }],
            ['browser-drive', ['--role', 'qa_user'], { operation: 'browser-drive', role: 'qa_user' }],
            ['browser-drive', ['--route', 'settings'], { operation: 'browser-drive', route: 'settings' }],
            ['browser-drive', ['--route', '/settings?tab=billing'], { operation: 'browser-drive', route: '/settings?tab=billing' }],
            ['browser-drive', ['--route', 'settings', '--fail-on-findings'], { operation: 'browser-drive', route: 'settings', failOnFindings: true }],
            ['browser-screenshot', ['--role', '1worker'], { operation: 'browser-screenshot', role: '1worker' }],
            ['browser-screenshot', [], { operation: 'browser-screenshot' }],
            ['test-run', ['--gate', 'unit', '--mode', 'canonical', '--select', 'file:src/example.ts'], { operation: 'test-run', gate: 'unit', mode: 'canonical', select: { kind: 'file', value: 'src/example.ts' } }],
            ['test-run', ['--gate', 'unit', '--mode', 'canonical', '--select', 'test:' + 'é'.repeat(2048)], { operation: 'test-run', gate: 'unit', mode: 'canonical', select: { kind: 'test', value: 'é'.repeat(2048) } }],
        ]
        for (const [operation, args, request, evaluator] of cases) {
            let stdout = '', stderr = ''
            const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) } }
            const handler = vi.fn(async () => ({ status: 0, result: { operation }, diagnostics: [] }))
            const verb = spelling(operation)
            const status = await runCli([...verb.split(' '), '--config', 'cockpit.toml', ...args, '--json'], io, { [operation]: handler })
            expect(status, operation).toBe(0)
            expect(handler, operation).toHaveBeenCalledExactlyOnceWith({ configPath: 'cockpit.toml', request, ...(evaluator ? { evaluator } : {}) })
            expect(JSON.parse(stdout)).toMatchObject({ result: { operation }, invocation: { verb, exitCode: 0 } })
            expect(stdout.split('\n')).toHaveLength(2)
            expect(stderr).toBe('')
        }
    })

    it('exits 2 with the route-findings diagnostic when a clean browser route is asked for and the application finds problems', async () => {
        // The application is the boundary: its outcome is faked, the mapping to exit status and diagnostic is the CLI's own.
        vi.resetModules()
        vi.doMock('./work-orders/composition.js', () => ({ createConfiguredWorkApplicationComposition: async () => ({ kind: 'complete', composition: {} }) }))
        vi.doMock('./work-orders/application.js', async importOriginal => ({ ...await importOriginal<typeof import('./work-orders/application.js')>(),
            runWorkApplication: async () => ({ kind: 'unsatisfied', operation: 'browser-drive',
                value: { receipt: { verdict: 'findings' } }, reason: 'settings: 1 console error' }) }))
        try {
            const { runCli: isolatedRunCli } = await import('./cli.js')
            let stdout = ''
            const status = await isolatedRunCli(['browser', 'drive', '--config', 'cockpit.toml', '--route', 'settings', '--fail-on-findings', '--json'],
                { stdout: { write: text => ((stdout += text), true) }, stderr: { write: () => true } }, {}, { env: {} })
            expect(status).toBe(2)
            expect(JSON.parse(stdout)).toMatchObject({ result: { receipt: { verdict: 'findings' } },
                diagnostics: [{ code: 'BROWSER_ROUTE_FINDINGS', message: 'settings: 1 console error' }] })
        } finally {
            vi.doUnmock('./work-orders/composition.js')
            vi.doUnmock('./work-orders/application.js')
            vi.resetModules()
        }
    })

    it('refuses malformed selectors before dispatch', async () => {
        const cases = [
            ['work-check'], ['work-check', '--work-order', '../WO-1'], ['work-note', '--work-order', 'WO-1'], ['work-note', '--work-order', 'WO-1', '--ask', '--decision', '--text', 'x'],
            ['work-decide', '--work-order', 'WO-1', '--decision', '1'], ['work-decide', '--work-order', 'WO-1', '--decision', '1', '--record', '--none', '--reason', 'x'],
            ['work-decide', '--work-order', 'WO-1', '--decision', '1', '--none'], ['work-decide', '--work-order', 'WO-1', '--decision', '1', '--record', '--record-file', 'docs/adr/0001-x.md'],
            ['work-answer', '--work-order', 'WO-1', '--text', 'yes'], ['work-answer', '--work-order', 'WO-1', '--question', 'first', '--text', 'yes'],
            ['work-grade', '--work-order', 'WO-1', '--verdict', 'maybe'], ['work-grade', '--work-order', 'WO-1', '--evaluator', 'gemini'], ['work-grade', '--work-order', 'WO-1', '--work-order', 'WO-2'],
            ['work-signoff', '--work-order', 'WO-1', '--partial', '--abandon'], ['work-recover'],
            ['grade-criteria'], ['grade-criteria', '--criteria', '../outside.md'], ['grade-criteria', '--criteria', '/absolute.md'],
            ['test-run', '--gate', 'unit', '--select', 'unknown:value'],
            ['test-run', '--gate', 'unit', '--mode', 'arbitrary'],
            ['test-run', '--gate', 'unit', '--mode', 'canonical', '--select', 'test:' + 'é'.repeat(2049)],
            ['browser-drive', '--role', 'bad\nrole'], ['browser-drive', '--route', 'Not A Route'], ['browser-drive', '--route', '//outside.test/'],
            ...['Bad', 'bad role', '../outside', 'x'.repeat(65)].flatMap(value => [
                ['browser-drive', '--role', value],
                ['test-run', '--gate', value, '--mode', 'canonical'],
            ]),
        ]
        for (const args of cases) {
            let stdout = '', stderr = ''
            const handler = vi.fn(async () => ({ status: 0, result: null, diagnostics: [] }))
            const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) } }
            expect(await runCli([...spelling(args[0]!).split(' '), '--config', 'cockpit.toml', ...args.slice(1), '--json'], io, { [args[0]!]: handler }), args.join(' ')).toBe(2)
            expect(handler).not.toHaveBeenCalled()
            expect(JSON.parse(stdout).diagnostics[0].code).not.toBe('CLI_UNKNOWN_COMMAND')
            expect(stderr).toBe('')
        }
    })
})


it('does not expose comparison validation as a public CLI command', async () => {
    let stdout = ''
    expect(await runCli(['compare', 'validate', '--fixture', 'comparison.json', '--json'], {
        stdout: { write: text => ((stdout += text), true) }, stderr: { write: () => true },
    })).toBe(2)
    expect(JSON.parse(stdout).diagnostics[0].code).toBe('CLI_UNKNOWN_COMMAND')
})


describe('init command admission', () => {
    it('renders the cockpit-root question as human text in interactive mode', async () => {
        const previewSha256 = 'a'.repeat(64)
        const application = vi.fn(async (input: import('./environment/init-application.js').InitApplicationInput) => ({
            kind: input.accepted ? 'complete' as const : 'pending' as const,
            status: 0 as const,
            artifact: null,
            destination: null,
            diagnostics: [],
            result: {
                stage: input.accepted ? 'environment-verified' as const : 'surface-previewed' as const,
                root: input.root,
                target: input.target,
                previewSha256,
                files: [],
                ...(input.cockpitRoot === undefined ? { cockpitRoot: {
                    field: 'cockpit.root' as const,
                    why: 'the product repository must stay separate from cockpit control files',
                    recommended: 'in-repo' as const,
                    options: [{ answer: 'in-repo' as const, root: input.root, creates: [], siblingsRoot: '..',
                        firstSibling: input.root, tradeOff: 'keeps one repository' }],
                } } : {}),
            },
        }))
        const stdin = Readable.from(['in-repo\n']) as NodeJS.ReadStream
        Object.defineProperty(stdin, 'isTTY', { value: true })
        const stderr = new PassThrough()
        let shown = ''
        stderr.on('data', chunk => { shown += chunk.toString() })
        expect(await runCli(['init', process.cwd(), '--target', 'codexcli', '--interactive'], {
            stdin,
            stdout: Object.assign(new PassThrough(), { isTTY: true }),
            stderr,
        }, { init: application })).toBe(0)

        expect(shown).toContain('field: cockpit.root')
        expect(shown).toContain('why: the product repository must stay separate from cockpit control files')
        expect(shown).not.toContain('"field":"cockpit.root"')
    })

    it('initialises a dedicated cockpit root as a Git repository before continuing init', async () => {
        const product = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-init-product-')))
        const dedicated = `${product}-cockpit`
        const answers = join(product, 'answers.toml')
        const previewSha256 = 'a'.repeat(64)
        writeFileSync(answers, '[cockpit]\nroot = "dedicated"\n')
        const application = vi.fn(async (input: import('./environment/init-application.js').InitApplicationInput) => ({
            kind: input.accepted ? 'complete' as const : 'pending' as const,
            status: 0 as const,
            artifact: null,
            destination: null,
            diagnostics: [],
            result: {
                stage: input.accepted ? 'environment-verified' as const : 'surface-previewed' as const,
                root: input.root,
                target: input.target,
                previewSha256,
                files: [],
                ...(input.cockpitRoot === undefined ? { cockpitRoot: {
                    field: 'cockpit.root' as const,
                    why: 'the product repository must stay separate from cockpit control files',
                    recommended: 'dedicated' as const,
                    options: [{ answer: 'dedicated' as const, root: dedicated, creates: [dedicated],
                        siblingsRoot: '..', firstSibling: product, tradeOff: 'keeps control files separate' }],
                } } : {}),
            },
        }))
        try {
            const status = await runCli(['init', product, '--target', 'codexcli', '--json',
                '--answers', answers], {
                stdout: { write: () => true }, stderr: { write: () => true },
            }, { init: application }, { env: { PATH: process.env.PATH } })

            expect(status).toBe(0)
            expect(application).toHaveBeenCalledTimes(3)
            expect(statSync(join(dedicated, '.git')).isDirectory()).toBe(true)
        } finally {
            rmSync(dedicated, { recursive: true, force: true })
            rmSync(product, { recursive: true, force: true })
        }
    })

    it('binds one explicit root and one or more tools, the first as the target, and keeps JSON preview read-only', async () => {
        for (const [args, target, tools] of [
            ...GUARD_SURFACE_TARGETS.map(tool => [['--target', tool], tool, [tool]] as const),
            [['--target', 'claudecode,cursor'], 'claudecode', ['claudecode', 'cursor']],
            [['--target', 'cursor,opencode'], 'cursor', ['cursor', 'opencode']],
            [[], DEFAULT_SURFACE_TOOLS[0], DEFAULT_SURFACE_TOOLS],
        ] as const) {
            let stdout = ''
            const application = vi.fn(async (input: import('./environment/init-application.js').InitApplicationInput) => ({
                kind: 'pending' as const, status: 0 as const, artifact: null, destination: null, diagnostics: [],
                result: { stage: 'surface-previewed' as const, root: input.root, target: input.target,
                    previewSha256: 'a'.repeat(64), files: [] },
            }))
            const answerInitQuestion = vi.fn(async () => undefined)
            const io: CliIo = { stdout: { write: value => ((stdout += value), true) }, stderr: { write: () => true }, answerInitQuestion }
            expect(await runCli(['init', process.cwd(), ...args, '--interactive', '--json'], io, { init: application })).toBe(0)
            expect(application).toHaveBeenCalledOnce()
            expect(application.mock.calls[0]![0]).toMatchObject({ root: process.cwd(), target, tools, accepted: false })
            expect(answerInitQuestion).not.toHaveBeenCalled()
            expect(JSON.parse(stdout).result).toMatchObject({ root: process.cwd(), target })
            expect(stdout.split('\n')).toHaveLength(2)
        }
        // A bare `cockpit init` sets up the current directory for the default tools.
        const bare = vi.fn(async (input: import('./environment/init-application.js').InitApplicationInput) => ({
            kind: 'pending' as const, status: 0 as const, artifact: null, destination: null, diagnostics: [],
            result: { stage: 'surface-previewed' as const, root: input.root, target: input.target, previewSha256: 'a'.repeat(64), files: [] },
        }))
        expect(await runCli(['init', '--json'], { stdout: { write: () => true }, stderr: { write: () => true } }, { init: bare })).toBe(0)
        expect(bare.mock.calls[0]![0]).toMatchObject({ root: realpathSync(process.cwd()), target: DEFAULT_SURFACE_TOOLS[0], tools: [...DEFAULT_SURFACE_TOOLS] })
    })

    it('routes a structured configuration question through the interactive CLI hook', async () => {
        const id = `question:${'c'.repeat(64)}` as const
        const application = vi.fn(async (input: import('./environment/init-application.js').InitApplicationInput) =>
            input.greenfieldAnswer ? {
                kind: 'complete' as const, status: 0 as const, artifact: null, destination: null, diagnostics: [],
                result: { stage: 'environment-verified' as const, root: input.root, target: input.target,
                    previewSha256: 'a'.repeat(64), files: [] },
            } : {
                kind: 'pending' as const, status: 0 as const, artifact: null, destination: null, diagnostics: [],
                result: { stage: 'surface-published' as const, root: input.root, target: input.target,
                    previewSha256: 'a'.repeat(64), files: [],
                    question: { id, field: 'ports.bases', source: `configuration:${'b'.repeat(64)}`,
                        why: 'no source establishes product ports' } },
            })
        const answerInitQuestion = vi.fn(async () => '{}')
        const status = await runCli(['init', process.cwd(), '--target', 'codexcli', '--interactive'], {
            stdout: { write: () => true }, stderr: { write: () => true }, answerInitQuestion,
        }, { init: application })
        expect(status).toBe(0)
        expect(answerInitQuestion).toHaveBeenCalledOnce()
        expect(application).toHaveBeenCalledTimes(2)
        expect(application.mock.calls[1]![0]).toMatchObject({ accepted: true,
            greenfieldAnswer: { questionId: id, bytes: '{}', provenance: 'operator-confirmed' } })
    })

    it('reads the answers file and writes from it when no terminal is attached', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-init-answers-'))
        try {
            const answers = join(directory, 'answers.toml')
            writeFileSync(answers, '[ports]\nbases = { API_PORT = 4100 }\n')
            const question = { id: `question:${'c'.repeat(64)}` as const, field: 'ports.bases', source: `configuration:${'b'.repeat(64)}`, why: 'no source' }
            const result = (extra: object = {}) => ({ stage: 'surface-published' as const, root: process.cwd(), target: 'codexcli' as const,
                previewSha256: 'a'.repeat(64), files: [], ...extra })
            const application = vi.fn(async (input: import('./environment/init-application.js').InitApplicationInput) => input.greenfieldAnswer
                ? { kind: 'complete' as const, status: 0 as const, artifact: null, destination: null, diagnostics: [], result: result() }
                : { kind: 'pending' as const, status: 0 as const, artifact: null, destination: null, diagnostics: [], result: result({ question }) })
            let stdout = ''
            const io: CliIo = { stdout: { write: value => ((stdout += value), true) }, stderr: { write: () => true } }
            const base = ['init', process.cwd(), '--target', 'codexcli', '--json']

            expect(await runCli([...base, '--answers', answers], io, { init: application })).toBe(0)
            expect(application.mock.calls.at(-1)![0]).toMatchObject({ accepted: true,
                greenfieldAnswer: { questionId: question.id, bytes: '{"API_PORT":4100}' } })
            expect(JSON.parse(stdout).result.stage).toBe('surface-published')

            for (const refused of [
                [...base, '--answers', answers, '--interactive'],
                [...base, '--answers', join(directory, 'missing.toml')],
            ]) {
                application.mockClear()
                expect(await runCli(refused, io, { init: application })).toBe(2)
                expect(application).not.toHaveBeenCalled()
            }
            // The parser's own message quotes the bytes it stopped at; the refusal names only the position.
            writeFileSync(answers, 'ports = [SECRET_CANARY')
            stdout = ''
            expect(await runCli([...base, '--answers', answers], io, { init: application })).toBe(2)
            expect(application).not.toHaveBeenCalled()
            expect(stdout).toMatch(/invalid TOML at line 1, column \d+/)
            expect(stdout).not.toContain('SECRET_CANARY')
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('refuses a FIFO answers file without waiting for a writer', () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-init-answers-fifo-'))
        scratch.push(directory)
        const canonical = realpathSync(directory)
        const answers = join(canonical, 'answers.toml')
        execFileSync('mkfifo', [answers])

        const result = spawnSync(process.execPath, ['--import', 'tsx', cli,
            'init', canonical, '--target', 'codexcli', '--json',
            '--answers', answers], {
            cwd: root,
            encoding: 'utf8',
            env: process.env,
            timeout: 2_000,
        })

        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()
        expect(result.status).toBe(2)
        expect(JSON.parse(result.stdout)).toMatchObject({ diagnostics: [{
            code: 'CLI_USAGE_INVALID',
            message: expect.stringContaining('replace it with a plain TOML file and retry'),
            target: '--answers',
        }] })
    })

    it('refuses an answers file that is not valid UTF-8', () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-init-answers-encoding-'))
        scratch.push(directory)
        const canonical = realpathSync(directory)
        const answers = join(canonical, 'answers.toml')
        writeFileSync(answers, Buffer.concat([Buffer.from('label = "'), Buffer.from([0xc3, 0x28]), Buffer.from('"\n')]))

        const result = spawnSync(process.execPath, ['--import', 'tsx', cli,
            'init', canonical, '--target', 'codexcli', '--json',
            '--answers', answers], {
            cwd: root,
            encoding: 'utf8',
            env: process.env,
        })

        expect(result.status).toBe(2)
        expect(JSON.parse(result.stdout)).toMatchObject({ diagnostics: [{
            code: 'CLI_USAGE_INVALID',
            message: expect.stringContaining('is not valid UTF-8'),
            target: '--answers',
        }] })
    })

    it.each(['ports.bases', 'environment.install_policies', 'environment.test_data'])('routes a recorded-answer reset preview and only its exact explicit acceptance for %s', async field => {
        const digest = 'd'.repeat(64)
        const application = vi.fn(async (input: import('./environment/init-application.js').InitApplicationInput) => ({
            kind: 'pending' as const, status: 0 as const, artifact: null, destination: null, diagnostics: [],
            result: { stage: 'surface-published' as const, root: input.root, target: input.target,
                previewSha256: 'a'.repeat(64), files: [], nextCommand: 'answer configuration', resetAnswer: {
                    field: input.resetAnswer!.field, revision: 7, invalidatedFields: ['ports.bases', 'guards'],
                    previewSha256: digest,
                } },
        }))
        let stdout = ''
        const io: CliIo = { stdout: { write: value => ((stdout += value), true) }, stderr: { write: () => true } }
        const base = ['init', process.cwd(), '--target', 'codexcli', '--reset-answer', field, '--json']

        expect(await runCli(base, io, { init: application })).toBe(0)
        expect(application).toHaveBeenLastCalledWith(expect.objectContaining({ accepted: false,
            resetAnswer: { field } }))
        expect(JSON.parse(stdout).result.resetAnswer).toMatchObject({ revision: 7, previewSha256: digest })
        stdout = ''; application.mockClear()
        expect(await runCli([...base, '--accept-reset', digest], io, { init: application })).toBe(0)
        expect(application).toHaveBeenLastCalledWith(expect.objectContaining({ accepted: false,
            resetAnswer: { field, acceptedPreviewSha256: digest } }))

        for (const refused of [
            ...['environment..test_data', 'environment/_test', '_environment', 'environment.'].map(invalid =>
                ['init', process.cwd(), '--target', 'codexcli', '--reset-answer', invalid, '--json']),
            [...base, '--accept-reset', 'not-a-digest'],
            [...base, '--accept-reset', digest, '--answers', 'answers.toml'],
            ['init', process.cwd(), '--target', 'codexcli', '--accept-reset', digest, '--json'],
        ]) {
            application.mockClear()
            expect(await runCli(refused, io, { init: application })).toBe(2)
            expect(application).not.toHaveBeenCalled()
        }
    })

    it('refuses extra or duplicate roots and targets before dispatch', async () => {
        for (const args of [
            ['.', '.', '--target', 'codexcli'], ['.', '.'],
            ['.', '--target', 'unknown'], ['.', '--target', 'codexcli', '--target', 'opencode'], ['.', '--target', 'codexcli,codexcli'], ['.', '--target', 'codexcli,unknown'],
            ['.', '--target', 'cursor,grokcli'],
        ]) {
            const application = vi.fn()
            expect(await runCli(['init', ...args, '--json'], { stdout: { write: () => true }, stderr: { write: () => true } }, { init: application })).toBe(2)
            expect(application).not.toHaveBeenCalled()
        }
    })
})


it('shows a human init preview without accepting or writing it', async () => {
    let stdout = ''
    const application = vi.fn(async (input: import('./environment/init-application.js').InitApplicationInput) => ({
        kind: 'pending' as const, status: 0 as const, artifact: null, destination: null, diagnostics: [],
        result: { stage: 'surface-previewed' as const, root: input.root, target: input.target,
            previewSha256: 'a'.repeat(64), files: [{ path: '.agents/skills/cockpit-setup/SKILL.md', sha256: 'b'.repeat(64) }] },
    }))
    const status = await runCli(['init', process.cwd(), '--target', 'codexcli'], {
        stdout: { write: value => ((stdout += value), true) }, stderr: { write: () => true },
    }, { init: application })
    expect(status).toBe(0)
    expect(stdout).toContain('stage: surface-previewed')
    expect(stdout).toContain(`previewSha256: ${'a'.repeat(64)}`)
    expect(stdout).toContain('path: .agents/skills/cockpit-setup/SKILL.md')
    expect(stdout).not.toContain('{')
    expect(application).toHaveBeenCalledOnce()
    expect(application.mock.calls[0]![0].accepted).toBe(false)
})
