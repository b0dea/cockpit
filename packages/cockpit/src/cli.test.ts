import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough, Readable } from 'node:stream'
import * as fixCatalogue from './fix-catalogue.js'
import { runCli, type CliIo } from './cli.js'
import { createInvocationRecord } from './invocation.js'
import { runSyncOperatorCommand } from './generated-environment/command.js'
import { loadCockpitConfig } from './config/load.js'
import { renderHumanDiagnostics } from './diagnostics.js'
import type { RegistryResolveCommandInput, RegistryResolveOutcome } from './registry-resolve/command.js'
import { RefusalError, type EnvironmentCommandOutcome, type ExecutionStep } from './environment/contract.js'
import type { SetupResult } from './environment/setup.js'
import type { SurfaceSelftestDraftInput, SurfaceSelftestHandlerInput } from './environment/selftest-application.js'
import { commands, describePublicOption, internalCommands, resolveOrdinaryInvocation } from './command-table.js'
import { SURFACE_TARGETS } from './surfaces/harness-registry.js'
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
        [['guard-evaluate', '--harness', 'codexcli'], 'guard-evaluate', 2],
    ] as const)('publishes no invocation record on stderr for %j', (args, verb, exitCode) => {
        const native = args[2] === 'codexcli'
        const result = run([...args], native ? { COCKPIT_GUARD_TRANSPORT: '1' } : {})
        expect(result.status).toBe(exitCode)
        const diagnostics = humanStderr(result.stderr)
        if (verb === 'version') expect(result.stdout).toBe(`@b00dea/cockpit ${cockpitPackageVersion} (Node ^22.22.0 || ^24.0.0 || ^26.0.0; source development)\n`)
        else if (verb === 'guard-evaluate') {
            if (native) {
                expect(result.stdout).toBe('')
                expect(diagnostics).toContain('Guard input, arguments or installed identity')
            } else {
                expect(JSON.parse(result.stdout)).toEqual({ decision: 'unavailable', reason: expect.any(String) })
                expect(diagnostics).toBe('')
            }
        } else expect(diagnostics).toContain(args.length ? verb === 'check' ? 'CLI_USAGE_INVALID' : 'CLI_UNKNOWN_COMMAND' : 'CLI_COMMAND_REQUIRED')
    })

    it('retains artifact bytes and uses floored monotonic elapsed milliseconds', async () => {
        let stdout = '', stderr = ''
        const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) } }
        const document = async () => ({ status: 0, result: null, diagnostics: [], artifact: 'exact artifact bytes\n' })
        const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(10.25).mockReturnValueOnce(19.99)
        try {
            const status = await runCli(['document', '--registry', 'synthetic.sh'], io, { document })
            expect(status).toBe(0)
            expect(stdout).toBe('exact artifact bytes\n')
            expect(humanStderr(stderr)).toBe('')
            stdout = ''
            clock.mockReset().mockReturnValueOnce(10.25).mockReturnValueOnce(19.99)
            await runCli(['document', '--registry', 'synthetic.sh', '--json'], io, { document })
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

describe('closed ordinary invocation metadata', () => {
    const authority = { executable: '/workspace/bin/cockpit', canonicalRoot: '/workspace/product',
        allowedRoots: ['/workspace/product', '/workspace/app'], configPath: '/workspace/product/cockpit.toml', services: ['app'], gates: ['quick'], browserPreapproved: true }
    const ordinary = (argv: string[], patch = {}) => resolveOrdinaryInvocation({ executable: authority.executable, cwd: authority.canonicalRoot, argv, ...patch }, authority, () => true)
    // The words each available config-bearing row needs besides --config.
    const requiredWords: Readonly<Record<string, readonly string[]>> = {
        selftest: ['--probe-specifications', 'probes.json'], logs: ['--service', 'app'], runtime: ['measure', '--image', 'node:22-alpine'], sync: ['--dry-run'],
        'test-run': ['--gate', 'quick'], 'work intake': ['--intent', 'intents/task.json'], 'work recover': ['--lock', 'WO-001'],
        'work execute': ['--work-order', 'WO-001', '--approach', 'first-try'], 'work record': ['--work-order', 'WO-001', '--event-file', 'workorders/events/progress.json'],
        'work review': ['--work-order', 'WO-001'], 'work grade': ['--work-order', 'WO-001'], 'work programme-mint': ['--programme', 'release'],
    }
    it('keeps public rows compatible and internal transport separately typed and closed', async () => {
        expect(commands.every(row => row.visibility === 'public' && row.ordinary !== undefined)).toBe(true)
        expect(internalCommands).toMatchObject([{ name: 'guard-evaluate', visibility: 'internal', ordinary: { availability: 'unavailable' } }])
        expect(commands.some(row => String(row.name) === 'guard-evaluate')).toBe(false)
        const help = run(['--help'])
        expect(help.stdout).not.toContain('guard-evaluate')
        // Each row declares its options twice, once for parseArgs and once for the guard: an option the
        // guard admits must be one the CLI parses with the same arity, or the admitted run is refused.
        for (const row of commands) {
            if (row.ordinary.availability !== 'available') continue
            const { options, forbidden } = row.ordinary
            for (const [name, option] of Object.entries(options)) {
                const parsed = row.options[name]
                expect(parsed && { type: parsed.type, multiple: parsed.multiple === true }, `${row.name} --${name}`)
                    .toEqual({ type: option.kind === 'flag' ? 'boolean' : 'string', multiple: false })
            }
            for (const name of [...forbidden.presence, ...forbidden.values.map(({ option }) => option)]) {
                expect(Object.keys(row.options), `${row.name} forbidden --${name}`).toContain(name)
            }
        }
    })

    it('admits exactly the public ordinary profiles with bounded roles', () => {
        const cases = [
            ['document', '.'], ['document', '--registry', 'registry.sh', '--json'],
            ['registry-resolve', '--registry', 'registry.sh', '--siblings-root', '/workspace/app', '--adoption', 'adoption.toml'],
            ['setup'], ['sync', '--dry-run'], ['check'],
            ['selftest', '--probe-specifications', 'probes.json'], ['upgrade'],
            ['upgrade', '--release-evidence', 'release.json', '--release-evidence-sha256', 'a'.repeat(64)],
            ['up'], ['sleep'], ['down'], ['preflight'], ['doctor'],
            ['logs', '--service', 'app'], ['logs', '--service', 'app', '--tail', '1', '--since', '15m', '--follow'],
            ['logs', '--service=app', '--tail=10000', '--since=2026-10-22T10:00:00Z', '--json'],
            ['runtime', 'measure', '--image', 'node:22-alpine'], ['runtime', 'measure', '--image', `sha256:${'c'.repeat(64)}`, '--json'],
            // The documented agent steps of the test, work-order and browser loops.
            ['test-run', '--gate', 'quick', '--json'], ['test-run', '--gate=quick', '--mode', 'staged', '--select', 'file:src/cache.test.ts'],
            ['work', 'status', '--json'], ['work', 'status', '--work-order', 'WO-001'], ['work', 'resume'], ['work', 'metrics', '--json'],
            ['work', 'intake', '--intent', 'intents/task.json'], ['work', 'intake', '--intent', 'intents/task.json', '--candidate', 'drafts/task.md', '--json'],
            ['work', 'intake', '--work-order', 'WO-001'], ['work', 'execute', '--work-order', 'WO-001', '--approach', 'cache refresh, first try'],
            ['work', 'record', '--work-order', 'WO-001', '--event-file', 'workorders/events/progress.json'],
            ['work', 'review', '--work-order', 'WO-001', '--json'], ['work', 'grade', '--work-order', 'WO-001'],
            ['work', 'recover', '--lock', 'WO-001'], ['work', 'recover', '--lock', '.admission-capacity'], ['work', 'sweep'],
            ['work', 'programme-mint', '--programme', 'release', '--item', 'first-item'],
            ['browser', 'drive', '--json'], ['browser', 'accessibility', '--role', 'admin'], ['browser', 'screenshot', '--role', 'admin', '--json'],
        ]
        for (const args of cases) {
            const argv = ['document', 'registry-resolve'].includes(args[0]!) ? args : [...args, '--config', authority.configPath]
            const { reads: _reads, ...profile } = ordinary(argv) ?? {}
            expect(profile, argv.join(' ')).toEqual({ executable: authority.executable, cwd: authority.canonicalRoot, argv })
        }
        // The files a command parses are carried for the evaluator to check as reads.
        expect(ordinary(['work', 'intake', '--config', authority.configPath, '--intent', 'intents/task.json', '--candidate', 'drafts/task.md'])?.reads)
            .toEqual(['/workspace/product/intents/task.json', '/workspace/product/drafts/task.md'])
        expect(ordinary(['work', 'status', '--config', authority.configPath])).not.toHaveProperty('reads')
        for (const field of ['environment.install_policies', 'environment.test_data']) {
            const argv = ['init', '.', '--target', 'codexcli', '--reset-answer', field, '--json']
            expect(ordinary(argv), field).toEqual({ executable: authority.executable, cwd: authority.canonicalRoot, argv })
        }
    })

    it('requires the exact resolved config for every available config-bearing row', () => {
        const rows = commands.filter(row => row.ordinary.availability === 'available' && row.ordinary.configuration !== 'none')
        expect(rows.map(row => row.name)).toEqual(['setup', 'upgrade', 'sync', 'check', 'selftest', 'runtime', 'up', 'preflight', 'logs', 'sleep', 'down', 'doctor',
            'test-run', 'work intake', 'work status', 'work resume', 'work recover', 'work execute', 'work record', 'work review', 'work sweep',
            'work programme-mint', 'work metrics', 'work grade', 'browser drive', 'browser accessibility', 'browser screenshot'])
        for (const row of rows) {
            const argv = [...row.name.split(' '), ...(requiredWords[row.name] ?? [])]
            expect(ordinary(argv), `${row.name} missing config`).toBeUndefined()
            expect(ordinary([...argv, '--config', authority.configPath]), row.name).toBeDefined()
            expect(ordinary([...argv, '--config', 'other.toml']), `${row.name} wrong config`).toBeUndefined()
        }
    })

    // Writes into a product repository change what every agent session there loads, so a person runs them.
    it('leaves setup writes into sibling repositories to a person', () => {
        for (const flag of ['--write-instruction-pointers', '--write-instruction-files']) {
            expect(ordinary(['setup', flag, '--config', authority.configPath]), flag).toBeUndefined()
        }
    })

    it('refuses all ambiguous, repeated, escaping, unavailable or differently spelled forms', () => {
        const cases = [
            ['document'], ['document', '.', '--registry', 'registry.sh'], ['document', '.', '--output', 'out.toml'], ['document', '.', 'other'],
            ['document', '../escape'], ['document', '--registry', '/outside/registry'],
            ['registry-resolve', '--registry', 'registry.sh'], ['registry-resolve', '.', '--registry', 'registry.sh', '--siblings-root', '.', '--adoption', 'adoption'],
            ['sync', '--interactive'], ['sync', '--interactive=false'], ['sync', '--adopt', '.claude/settings.json'], ['selftest'], ['selftest', '--probe-specifications', 'probe', '--interactive'],
            ['selftest', '--probe-specifications', 'probe', '--write-probe-specifications', 'draft'],
            ['upgrade', '--release-evidence', 'release'], ['upgrade', '--release-evidence-sha256', 'a'.repeat(64)],
            ['upgrade', '--release-evidence', 'release', '--release-evidence-sha256', 'A'.repeat(64)],
            ['upgrade', '--release-evidence', 'release', '--release-evidence-sha256', 'a'.repeat(63)],
            ['logs'], ['logs', '--service', 'other'], ['logs', '--service', 'app', '--tail', '0'], ['logs', '--service', 'app', '--tail', '10001'],
            ['logs', '--service', 'app', '--tail', '1.5'], ['logs', '--service', 'app', '--since', '1m;id'], ['logs', '--service', 'app', '--since', 'x'.repeat(65)],
            ['sync'], ['reset'], ['baseline-record'], ['guard-evaluate', '--harness', 'claudecode'],
            ['runtime', '--image', 'node:22-alpine'], ['runtime', 'other', '--image', 'node:22-alpine'], ['runtime', 'measure'],
            ['runtime', 'measure', 'extra', '--image', 'node:22-alpine'], ['runtime', 'measure', '--image', 'node 22'],
            ['runtime', 'measure', '--image', 'node:22-alpine', '--write'],
            ['check', 'extra'], ['check', '--unknown'], ['check', '--config', '/outside/cockpit.toml'], ['check', '--config', 'other.toml'],
            ['check', '--json=false'], ['check', '--'], ['check', '--config'], ['check', '-c', 'cockpit.toml'],
            // A person answers the displayed digest, applies or reverses a sweep, takes a lock, binds a programme item or opens the debugger.
            ['work', 'accept', '--work-order', 'WO-001'], ['work', 'accept', '--work-order', 'WO-001', '--interactive'], ['work', 'renew', '--work-order', 'WO-001'],
            ['work', 'answer', '--work-order', 'WO-001', '--event-file', 'workorders/events/answer.json', '--interactive'],
            ['work', 'reverse', '--work-order', 'WO-001'], ['work', 'sweep', '--apply'], ['work', 'recover', '--lock', 'WO-001', '--apply'],
            ['work', 'programme-mint', '--programme', 'release', '--candidate', 'drafts/task.md'], ['browser', 'debugger'],
            ['test-run'], ['test-run', '--gate', 'undeclared'], ['test-run', '--gate', 'quick', '--mode', 'all'],
            ['test-run', '--gate', 'quick', '--select', 'file:--config=evil.ts'], ['test-run', '--gate', 'quick', '--select', 'src/cache.test.ts'],
            ['work', 'intake'], ['work', 'intake', '--candidate', 'drafts/task.md', '--work-order', 'WO-001'],
            ['work', 'intake', '--intent', 'intents/task.json', '--work-order', 'WO-001'], ['work', 'intake', '--intent', '../outside.json'],
            ['work', 'execute', '--work-order', 'WO-001'], ['work', 'execute', '--approach', 'first'], ['work', 'grade', '--work-order', '../WO-001'],
            ['work', 'status', 'WO-001'], ['work', '--json'], ['work', 'unknown'], ['browser', 'drive', '--role', 'a/b'],
        ]
        for (const args of cases) {
            const argv = ['document', 'registry-resolve'].includes(args[0]!) || args.some(arg => arg === '--config') ? args : [...args, '--config', authority.configPath]
            expect(ordinary(argv), argv.join(' ')).toBeUndefined()
        }
        for (const row of commands) {
            if (row.ordinary.availability !== 'available') continue
            const required = row.name === 'init' ? ['.', '--target', 'codexcli'] : row.name === 'document' ? ['.'] : row.name === 'registry-resolve' ? ['--registry', 'r', '--siblings-root', '.', '--adoption', 'a'] : ['--config', authority.configPath, ...(requiredWords[row.name] ?? [])]
            for (const [name, option] of Object.entries(row.ordinary.options)) {
                const value = option.kind === 'flag' ? [] : [name === 'target' ? 'codexcli' : name === 'config' ? authority.configPath : name === 'service' ? 'app' : name === 'tail' ? '1' : name === 'since' ? '1m'
                    : name === 'gate' ? 'quick' : name === 'mode' ? 'full' : name === 'select' ? 'test:refresh' : name.endsWith('sha256') || name === 'accept-reset' ? 'a'.repeat(64) : 'path']
                let baseline = required.filter((arg, i) => arg !== `--${name}` && required[i - 1] !== `--${name}`)
                if (row.name === 'document' && name === 'registry' || row.name === 'work intake' && name === 'work-order') baseline = baseline.filter(arg => !['.', '--intent', 'intents/task.json'].includes(arg))
                if (name === 'release-evidence') baseline.push('--release-evidence-sha256', 'a'.repeat(64))
                if (name === 'release-evidence-sha256') baseline.push('--release-evidence', 'path')
                expect(ordinary([...row.name.split(' '), ...baseline, `--${name}`, ...value]), `${row.name} single ${name}`).toBeDefined()
                expect(ordinary([...row.name.split(' '), ...baseline, `--${name}`, ...value, `--${name}`, ...value]), `${row.name} repeated ${name}`).toBeUndefined()
            }
        }
        // Browser commands run unprompted only where cockpit.toml preapproves them.
        expect(resolveOrdinaryInvocation({ executable: authority.executable, cwd: authority.canonicalRoot, argv: ['browser', 'drive', '--config', authority.configPath] },
            { ...authority, browserPreapproved: false }, () => true)).toBeUndefined()
        for (const executable of ['cockpit', '/other/cockpit', 'bash']) expect(ordinary(['check', '--config', authority.configPath], { executable })).toBeUndefined()
        expect(ordinary(['check', '--config', authority.configPath], { cwd: '/workspace/app' })).toBeUndefined()
        expect(ordinary(['sh', '-c', 'cockpit check', '--config', authority.configPath])).toBeUndefined()
    })
})

const root = resolve(import.meta.dirname, '../../..')
const cli = join(root, 'packages/cockpit/src/cli.ts')
const laneFixture = readFileSync(join(root, 'fixtures/registries/lane-dialect.sh'), 'utf8')
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
        ['init', 'Usage: cockpit init <root> [options]'],
        ['document', 'Usage: cockpit document [<root>] [options]'],
        ['runtime', 'Usage: cockpit runtime measure [options]'],
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

    it('labels experimental command-specific help without labeling stable commands', async () => {
        const experimental = await runInProcess(['upgrade', '--help'])
        expect(experimental.stdout).toContain('Status: experimental. This interface may change before a stable release.')
        for (const args of [['check'], ['work', 'grade'], ['browser', 'drive']]) {
            expect((await runInProcess([...args, '--help'])).stdout, args.join(' ')).not.toContain('Status: experimental.')
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
        expect(bad.stderr).toContain("Run 'npx --no cockpit check --help' for usage.")
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

    it('refuses document --output with --json instead of exiting 0 without writing', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-document-output-'))
        try {
            const destination = join(directory, 'out.toml')
            const result = await runInProcess(['document', '--registry', 'synthetic.sh', '--output', destination, '--json'], {
                document: async () => ({ status: 0, result: null, diagnostics: [], artifact: 'document bytes\n', destination }),
            })

            expect(result.status).toBe(2)
            expect(JSON.parse(result.stdout).diagnostics[0]).toMatchObject({ code: 'DOCUMENT_OUTPUT_JSON_UNSUPPORTED', target: '--output' })
            expect(existsSync(destination)).toBe(false)
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('prints the collected log records in human mode', async () => {
        const record = { timestamp: '2026-01-01T00:00:00Z', stream: 'stdout', message: 'synthetic log line' }
        const result = await runInProcess(['logs', '--config', 'cockpit.toml', '--service', 'app'], {
            logs: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: { json: false, records: [record] } }),
        })

        expect(result.status).toBe(0)
        expect(result.stdout).toBe('2026-01-01T00:00:00Z stdout synthetic log line\n')
    })

    it.each(['registry', 'output'])('refuses duplicate document --%s options before accessing files', (option) => {
        const result = run(['document', `--${option}=first`, `--${option}`, 'second', '--json'])

        expect(result.status).toBe(2)
        expect(JSON.parse(result.stdout)).toMatchObject({
            result: null,
            diagnostics: [expect.objectContaining({ code: 'DOCUMENT_OPTION_DUPLICATE', target: `--${option}` })],
        })
        expect(result.stderr).toBe('')
    })

    it('renders root help by stage, with each command group as one entry', () => {
        const result = run(['--help'])

        expect(result.status).toBe(0)
        expect(result.stdout).toBe(
            'Usage: cockpit <command> [options]\n\n' +
            'Set up:\n' +
            '  init              Preview, then accept, a first cockpit setup for one agent tool\n' +
            '  document          Draft cockpit.toml from an existing cockpit, marking every inferred value\n' +
            '  setup             Clone or locate the declared sibling repositories and link them\n' +
            '  sibling           Add or remove a repository in cockpit.toml (sibling add, sibling remove)\n' +
            '  registry-resolve  Turn a validated shell registry into data shell scripts can source\n' +
            '  upgrade           Show the steps to upgrade cockpit without applying them (experimental)\n\n' +
            'Generate and verify:\n' +
            '  sync              Write the generated stack and agent files from cockpit.toml\n' +
            '  check             Report generated files that no longer match cockpit.toml\n' +
            '  selftest          Test whether agent tools enforce the generated controls\n\n' +
            'Run the stack:\n' +
            '  runtime           Measure the local container runtime (runtime measure) and record the result for this machine\n' +
            '  up                Start or resume the declared environment\n' +
            '  preflight         Check that the environment is healthy and ready for work\n' +
            '  session           Keep the environment available for one command, then release it\n' +
            '  logs              Show recent logs for one declared service\n' +
            '  sleep             Release this checkout and stop the stack if no other holder remains\n' +
            '  down              Stop and remove the stack (on the active local Docker context)\n' +
            '  reset             Preview a reset, or approve that exact preview interactively (on the active local Docker context)\n\n' +
            'Diagnose:\n' +
            '  doctor            Report environment problems without changing anything\n' +
            '  baseline-record   Record an explicitly confirmed environment baseline (experimental)\n\n' +
            'Test and grade:\n' +
            '  test-run          Run a declared product test gate and report which tests it selected\n' +
            '  work              Prepare, accept, execute, review and grade work orders\n' +
            '  browser           Drive, inspect and capture the declared application in a browser\n\n' +
            "Run 'cockpit <command> --help' for its options, and 'cockpit work --help' or 'cockpit browser --help' for its subcommands.\n",
        )
        expect(humanStderr(result.stderr)).toBe('')

        // The README's "Commands at a glance" table is the same map in prose; each row names the
        // entries of its stage, in help order, by their first word.
        const readme = readFileSync(resolve(import.meta.dirname, '../../../README.md'), 'utf8')
        const table = readme.slice(readme.indexOf('## Commands at a glance'), readme.indexOf('## How cockpit compares'))
        const documented = [...table.matchAll(/^\| ([A-Z][a-z ]+) \| (.+) \|$/gm)].filter(([, stage]) => stage !== 'Stage')
            .map(([, stage, cells]) => `${stage}:\n${[...new Set([...cells!.matchAll(/`([a-z][a-z-]*)[^`]*`/g)].map(match => match[1]))].join('\n')}`)
        const helped = result.stdout.split('\n\n').slice(1, -1)
            .map(section => section.split('\n').map((line, index) => index === 0 ? line : line.trim().split(' ', 1)[0]).join('\n'))
        expect(documented).toEqual(helped)
    })

    it('lists a command group with its subcommands and refuses a group without one', async () => {
        const work = await runInProcess(['work', '--help'])
        expect(work.status).toBe(0)
        expect(work.stdout).toBe('Usage: cockpit work <subcommand> [options]\n\n' +
            'Prepare, accept, execute, review and grade work orders\n\n' +
            'Subcommands:\n' +
            '  intake          Prepare a work order from its source document\n' +
            '  status          Report current work-order state\n' +
            '  accept          Interactively accept the exact current work order\n' +
            '  renew           Interactively renew a changed work-order contract\n' +
            '  resume          Resume the next executable step of the single active work order\n' +
            '  recover         Inspect or explicitly recover one interrupted work lock\n' +
            '  execute         Execute one accepted work-order step\n' +
            '  record          Persist current work-order progress\n' +
            "  answer          Interactively record a person's answer to an open gap, or their decision\n" +
            '  review          Review the current accepted work order\n' +
            '  sweep           Inspect or apply a reversible work-order sweep\n' +
            '  reverse         Reverse a recorded work-order sweep\n' +
            '  programme-mint  Mint the next declared programme work order\n' +
            '  metrics         Report work-order metrics\n' +
            '  grade           Independently grade the current accepted work order\n\n' +
            "Run 'cockpit work <subcommand> --help' for its options.\n")
        const browser = await runInProcess(['browser', '--help'])
        expect(browser.status).toBe(0)
        expect(browser.stdout).toContain('Subcommands:\n' +
            '  drive          Drive the declared application browser surfaces\n' +
            '  accessibility  Collect accessibility observations from the application\n' +
            '  screenshot     Capture the declared application surfaces\n' +
            '  debugger       Prepare an explicitly requested browser debugger\n\n')
        expect((await runInProcess(['work', 'grade', '--help'])).stdout).toMatch(/^Usage: cockpit work grade \[options\]\n/)

        const envelope = async (args: string[]) => JSON.parse((await runInProcess([...args, '--json'])).stdout)
        expect(await envelope(['work'])).toMatchObject({ invocation: { verb: 'work', exitCode: 2 }, diagnostics: [{ code: 'CLI_COMMAND_REQUIRED',
            message: 'work requires a subcommand: intake, status, accept, renew, resume, recover, execute, record, answer, review, sweep, reverse, programme-mint, metrics, grade' }] })
        expect(await envelope(['work', 'bogus'])).toMatchObject({ invocation: { verb: 'unknown' }, diagnostics: [{ code: 'CLI_UNKNOWN_COMMAND', message: 'unknown command "work bogus"' }] })
        // There are no hyphenated aliases; the refusal names the spelling that runs.
        const hyphenated = await runInProcess(['work-grade', '--config', 'cockpit.toml'])
        expect(hyphenated.status).toBe(2)
        expect(humanStderr(hyphenated.stderr)).toBe('ERROR CLI_UNKNOWN_COMMAND: unknown command "work-grade"; did you mean "work grade"?\n'
            + "Run 'npx --no cockpit work grade --help' for usage.\n")
        expect((await envelope(['browser-drive'])).diagnostics).toMatchObject([{ code: 'CLI_UNKNOWN_COMMAND', message: 'unknown command "browser-drive"; did you mean "browser drive"?' }])
    })
})

describe('generated environment process contract', () => {
    function captureIo(
        confirmSelftestExecutable?: CliIo['confirmSelftestExecutable'],
        confirmStaleRemoval?: (request: unknown) => Promise<string | undefined>,
        confirmSelftestProbeSpecifications?: CliIo['confirmSelftestProbeSpecifications'],
    ) {
        let stdout = ''
        let stderr = ''
        const io = {
            stdout: { write: (text: string) => ((stdout += text), true) },
            stderr: { write: (text: string) => ((stderr += text), true) },
            ...(confirmSelftestExecutable ? { confirmSelftestExecutable } : {}),
            ...(confirmStaleRemoval ? { confirmStaleRemoval } : {}),
            ...(confirmSelftestProbeSpecifications ? { confirmSelftestProbeSpecifications } : {}),
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
            }
            const capture = captureIo()
            expect(await runCli(['sync', '--config', configPath, '--json',
                ...(reason === 'adoption' ? ['--adopt', '.claude/settings.json'] : [])], capture.io)).toBe(2)
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
        for (const command of ['check', 'sync', 'selftest', 'upgrade', 'up', 'sleep', 'down', 'reset', 'preflight', 'logs', 'setup']) {
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
            changes: [{ operation: 'write', path: 'compose.generated.yml' }],
            release: { kind: 'known', package: '@b00dea/cockpit', installedVersion: '1.0.0', latestVersion: '1.2.3', currency: 'different-version' },
        }
        expect(await runCli(['doctor', '--config', 'cockpit.toml'], capture.io, {
            doctor: async () => ({ status: 0,
                diagnostics: [{ severity: 'warning', code: 'GUARD_HOSTS_UNDECLARED', target: 'guards', message: 'synthetic warning' }],
                result: { verdict: 'pass', checks: [{ verdict: 'pass' }, { verdict: 'pass' }, { verdict: 'not-applicable' }], comparisons: [], surfaceOverrides, freshness,
                    declarations: [{ subject: 'runtime', state: 'declared' }, { subject: 'data-modes', state: 'not-declared' }] } }),
        })).toBe(0)
        const config = resolve('cockpit.toml')
        expect(capture.output().stdout).toBe([
            'Doctor: pass. Findings: 1 warning, listed below.',
            'Checks: 2 pass, 1 not applicable.',
            'Generated files: 1 change pending.',
            'Surface overrides: 1 active (review).',
            'Declared: runtime; not declared: data modes.',
            'Release: 1.2.3 is published; 1.0.0 is installed.',
            `Full report: npx --no cockpit doctor --config ${config} --json`,
            `Generated file detail: npx --no cockpit check --config ${config}`,
            '',
        ].join('\n'))
        expect(capture.output().stderr).toContain('WARNING GUARD_HOSTS_UNDECLARED')
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
        expect(await runCli([command, '--config', 'cockpit.toml', '--json'], json.io, { [command]: handler })).toBe(0)
        expect(JSON.parse(json.output().stdout)).toEqual({
            invocation: jsonInvocation(json.output().stdout, 0, command, resolve('cockpit.toml')),
            result: { action: command, paths: ['compose.generated.yml'] },
            diagnostics: [{ severity: 'info', code: 'GENERATED_CURRENT', message: 'generated files are current' }],
        })
        expect(json.output().stderr).toBe('')

        const human = captureIo()
        expect(await runCli([command, '--config=cockpit.toml'], human.io, { [command]: handler })).toBe(0)
        expect({ ...human.output(), stderr: humanStderr(human.output().stderr) })
            .toEqual({ stdout: '', stderr: 'INFO GENERATED_CURRENT: generated files are current\n' })
        expect(calls).toEqual([{ configPath: 'cockpit.toml' }, { configPath: 'cockpit.toml' }])
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
            expect(await runCli(args, capture.io, { [command]: handler })).toBe(2)
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

        // A stale removal is approved only by typing its digest, so the human preview must show it.
        const human = captureIo()
        const digest = 'c'.repeat(64)
        expect(await runCli(['sync', '--config', 'cockpit.toml', '--dry-run'], human.io, {
            sync: async () => ({ status: 0, diagnostics: [], result: { action: 'sync', dryRun: true,
                changes: [{ operation: 'remove', path: 'compose.generated.yml' }], staleRemoval: { digest } } }),
        })).toBe(0)
        expect(human.output().stdout).toBe('remove "compose.generated.yml"\n'
            + `Stale-removal digest ${digest}: to approve these removals, a person runs npx --no cockpit sync --config ${resolve('cockpit.toml')} --interactive in a terminal and types it.\n`)
    })

    it('previews interactive sync and applies only after the exact stale-removal digest is typed', async () => {
        const staleRemoval = {
            format: 'cockpit-stale-removal-request/v1' as const,
            cockpitId: 'synthetic',
            generation: 'generation-1',
            sourceSha256: 'a'.repeat(64),
            entries: [{
                path: '.agents/skills/old/SKILL.md',
                operation: 'remove-file' as const,
                current: { kind: 'file' as const, sha256: 'b'.repeat(64), dev: 1, ino: 2 },
            }],
            digest: 'c'.repeat(64),
        }
        const calls: unknown[] = []
        const approvals: unknown[] = []
        const capture = captureIo(undefined, async (request) => {
            approvals.push(request)
            return staleRemoval.digest
        })

        expect(await runCli(['sync', '--config', 'cockpit.toml', '--interactive'], capture.io, {
            sync: async (input) => {
                calls.push(input)
                if (input.dryRun) return { status: 0, diagnostics: [], result: { action: 'sync', dryRun: true, changes: [], staleRemoval } }
                const authorize = (input as typeof input & { authorizeStaleRemoval?: (request: typeof staleRemoval) => Promise<unknown> }).authorizeStaleRemoval
                expect(await authorize?.(staleRemoval)).toEqual({ format: 'cockpit-stale-removal-approval/v1', digest: staleRemoval.digest })
                return { status: 0, diagnostics: [], result: { action: 'sync', dryRun: false, changes: [] } }
            },
        }, { env: {} })).toBe(0)
        expect(approvals).toEqual([staleRemoval])
        expect(calls).toHaveLength(2)
    })

    it('refuses interactive stale removal before apply for non-terminal and wrong-digest input', async () => {
        const staleRemoval = {
            format: 'cockpit-stale-removal-request/v1' as const,
            cockpitId: 'synthetic', generation: 'generation-1', sourceSha256: 'a'.repeat(64),
            entries: [{ path: 'old', operation: 'remove-file' as const, current: { kind: 'file' as const, sha256: 'b'.repeat(64), dev: 1, ino: 2 } }],
            digest: 'c'.repeat(64),
        }
        let calls = 0
        const sync = async () => {
            calls += 1
            return { status: 0, diagnostics: [], result: { action: 'sync', dryRun: true, changes: [], staleRemoval } }
        }

        expect(await runCli(['sync', '--config', 'cockpit.toml', '--interactive'], captureIo().io, { sync }, { env: {} })).toBe(2)
        expect(calls).toBe(0)
        expect(await runCli(
            ['sync', '--config', 'cockpit.toml', '--interactive'],
            captureIo(undefined, async () => 'd'.repeat(64)).io,
            { sync },
            { env: {} },
        )).toBe(2)
        expect(calls).toBe(1)
    })

    it('refuses interactive sync in JSON and CI modes before previewing', async () => {
        let calls = 0
        const sync = async () => {
            calls += 1
            return { status: 0, diagnostics: [], result: { action: 'sync', dryRun: true, changes: [] } }
        }
        const confirmed = captureIo(undefined, async () => 'a'.repeat(64))

        expect(await runCli(
            ['sync', '--config', 'cockpit.toml', '--interactive', '--json'],
            confirmed.io,
            { sync },
        )).toBe(2)
        expect(await runCli(
            ['sync', '--config', 'cockpit.toml', '--interactive'],
            confirmed.io,
            { sync },
            { env: { CI: '1' } },
        )).toBe(2)
        expect(calls).toBe(0)
    })

    it('applies interactive sync without prompting when its preview has no stale removal', async () => {
        const calls: unknown[] = []
        let confirmations = 0
        const capture = captureIo(undefined, async () => {
            confirmations += 1
            return undefined
        })

        expect(await runCli(['sync', '--config', 'cockpit.toml', '--interactive'], capture.io, {
            sync: async (input) => {
                calls.push(input)
                return { status: 0, diagnostics: [], result: { action: 'sync', dryRun: input.dryRun === true, changes: [] } }
            },
        }, { env: {} })).toBe(0)
        expect(calls).toEqual([{ configPath: 'cockpit.toml', dryRun: true }, { configPath: 'cockpit.toml' }])
        expect(confirmations).toBe(0)
    })

    it('binds interactive approval to the previewed digest when apply re-prepares stale entries', async () => {
        const preview = {
            format: 'cockpit-stale-removal-request/v1' as const,
            cockpitId: 'synthetic', generation: 'generation-1', sourceSha256: 'a'.repeat(64),
            entries: [{ path: 'old', operation: 'remove-file' as const, current: { kind: 'file' as const, sha256: 'b'.repeat(64), dev: 1, ino: 2 } }],
            digest: 'c'.repeat(64),
        }
        const changed = { ...preview, generation: 'generation-2', digest: 'd'.repeat(64) }
        let calls = 0
        const capture = captureIo(undefined, async () => preview.digest)

        expect(await runCli(['sync', '--config', 'cockpit.toml', '--interactive'], capture.io, {
            sync: async (input) => {
                calls += 1
                if (input.dryRun) return { status: 0, diagnostics: [], result: { action: 'sync', dryRun: true, changes: [], staleRemoval: preview } }
                const authorize = (input as typeof input & { authorizeStaleRemoval?: (request: typeof changed) => Promise<unknown> }).authorizeStaleRemoval
                expect(await authorize?.(changed)).toBeUndefined()
                return { status: 2, diagnostics: [{ severity: 'error', code: 'GENERATED_STALE_APPROVAL_REQUIRED', message: 'changed' }], result: null }
            },
        }, { env: {} })).toBe(2)
        expect(calls).toBe(2)
    })

    it('requires a measured selftest artifact and routes upgrade without implicit mutation', async () => {
        const selftestCalls: unknown[] = []
        const upgradeCalls: unknown[] = []
        const selftest = captureIo()
        expect(await runCli(['selftest', '--config', 'cockpit.toml', '--probe-specifications', 'probe.json', '--json'], selftest.io, {
            selftest: async (input) => {
                selftestCalls.push(input)
                return { status: 0, diagnostics: [], result: { pending: ['native'] } }
            },
        }, { env: { PATH: '/synthetic/bin' } })).toBe(0)
        expect(selftestCalls).toEqual([{ configPath: 'cockpit.toml', probeSpecificationsPath: 'probe.json', env: { PATH: '/synthetic/bin' } }])
        const missing = captureIo()
        expect(await runCli(['selftest', '--config', 'cockpit.toml'], missing.io)).toBe(2)
        expect(missing.output().stderr).toContain('write one with --write-probe-specifications <new file> first')
        selftestCalls.length = 0
        expect(await runCli(['selftest', '--config', 'cockpit.toml', '--write-probe-specifications', 'probe.json'], captureIo().io, {
            selftest: async (input) => {
                selftestCalls.push(input)
                return { status: 0, diagnostics: [], result: null }
            },
        })).toBe(0)
        for (const conflict of [['--interactive'], ['--json'], ['--probe-specifications=']]) {
            expect(await runCli(['selftest', '--config', 'cockpit.toml', '--write-probe-specifications', 'probe.json', ...conflict],
                captureIo().io, { selftest: async (input) => { selftestCalls.push(input); return { status: 0, diagnostics: [], result: null } } }),
            conflict.join(' ')).toBe(2)
        }
        expect(await runCli(['selftest', '--config', 'cockpit.toml', '--write-probe-specifications', 'probe.json', '--probe-specifications', 'earlier.json'],
            captureIo().io, { selftest: async (input) => { selftestCalls.push(input); return { status: 0, diagnostics: [], result: null } } })).toBe(0)
        expect(selftestCalls).toEqual([
            { configPath: 'cockpit.toml', writeProbeSpecificationsPath: 'probe.json' },
            { configPath: 'cockpit.toml', writeProbeSpecificationsPath: 'probe.json', previousProbeSpecificationsPath: 'earlier.json' },
        ])
        const upgrade = captureIo()
        expect(await runCli(['upgrade', '--config', 'cockpit.toml', '--json'], upgrade.io, {
            upgrade: async (input) => {
                upgradeCalls.push(input)
                return { status: 0, diagnostics: [], result: { commands: ['cockpit sync --dry-run', 'cockpit sync', 'cockpit preflight'] } }
            },
        })).toBe(0)
        expect(upgradeCalls).toEqual([{ configPath: 'cockpit.toml' }])
    })

    it('preserves only the selftest search path, the non-secret tool variables and undefined own values for injected handlers', async () => {
        const unrelated = vi.fn(() => { throw new Error('unrelated environment value must not be read') })
        const env = Object.defineProperty({
            PATH: undefined, Path: '/synthetic/harnesses', HOME: '/synthetic/home', UNRELATED_DATA: 'synthetic-unrelated-canary',
            ANTHROPIC_API_KEY: 'synthetic-key-canary',
        }, 'UNRELATED_ACCESSOR', { enumerable: true, get: unrelated })
        const selftest = vi.fn(async (_input: SurfaceSelftestHandlerInput | SurfaceSelftestDraftInput) => ({
            status: 0, diagnostics: [], result: { pending: ['native'] },
        }))
        const capture = captureIo()

        expect(await runCli([
            'selftest', '--config', 'cockpit.toml', '--probe-specifications', 'probe.json', '--json',
        ], capture.io, { selftest }, { env })).toBe(0)

        expect(selftest).toHaveBeenCalledExactlyOnceWith({
            configPath: 'cockpit.toml', probeSpecificationsPath: 'probe.json',
            env: { PATH: undefined, HOME: '/synthetic/home' },
        })
        const dispatched = selftest.mock.calls[0]?.[0]
        expect(dispatched && 'env' in dispatched ? dispatched.env : null).toStrictEqual({ PATH: undefined, HOME: '/synthetic/home' })
        expect(unrelated).not.toHaveBeenCalled()
        expect(capture.output().stdout + capture.output().stderr).not.toMatch(/synthetic-unrelated-canary|synthetic-key-canary/)
    })

    it('refuses a selftest PATH accessor before reading or dispatching it', async () => {
        const selected = vi.fn(() => { throw new Error('selected search accessor must not be read') })
        const env = Object.defineProperty({}, 'PATH', { enumerable: true, get: selected })
        const selftest = vi.fn(async () => ({ status: 0, diagnostics: [], result: null }))
        const capture = captureIo()

        expect(await runCli([
            'selftest', '--config', 'cockpit.toml', '--probe-specifications', 'probe.json', '--json',
        ], capture.io, { selftest }, { env })).toBe(2)

        expect(capture.output().stdout).toContain('CLI_USAGE_INVALID')
        expect(selected).not.toHaveBeenCalled()
        expect(selftest).not.toHaveBeenCalled()
    })

    it('requires paired authenticated release-evidence inputs before upgrade dispatch', async () => {
        let calls = 0
        const upgrade = async () => {
            calls += 1
            return { status: 0, diagnostics: [], result: null }
        }
        for (const args of [
            ['upgrade', '--config', 'cockpit.toml', '--release-evidence', 'release.json'],
            ['upgrade', '--config', 'cockpit.toml', '--release-evidence-sha256', 'a'.repeat(64)],
            ['upgrade', '--config', 'cockpit.toml', '--release-evidence', 'release.json', '--release-evidence-sha256', 'not-a-digest'],
        ]) {
            const capture = captureIo()
            expect(await runCli(args, capture.io, { upgrade })).toBe(2)
            expect(capture.output().stderr).toContain('CLI_USAGE_INVALID')
        }
        expect(calls).toBe(0)
    })

    it('forwards exact authenticated release-evidence inputs to upgrade without applying sync', async () => {
        const calls: unknown[] = []
        const capture = captureIo()
        expect(await runCli([
            'upgrade', '--config', 'cockpit.toml', '--release-evidence', 'release.json',
            '--release-evidence-sha256', 'a'.repeat(64), '--json',
        ], capture.io, {
            upgrade: async (input) => {
                calls.push(input)
                return { status: 0, diagnostics: [], result: { commands: [] } }
            },
            sync: async () => {
                throw new Error('upgrade handler overrides must not invoke sync')
            },
        })).toBe(0)
        expect(calls).toEqual([{
            configPath: 'cockpit.toml',
            releaseEvidencePath: 'release.json',
            releaseEvidenceSha256: 'a'.repeat(64),
        }])
    })

    it('authenticates explicit release evidence against a read-only generated projection', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-upgrade-cli-')))
        scratch.push(directory)
        const configPath = join(directory, 'cockpit.toml')
        const declaration = readFileSync(join(root, 'fixtures/registries/generated-environment.toml'), 'utf8')
            .replace('name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."')
        writeFileSync(configPath, declaration)
        mkdirSync(join(directory, 'app'))
        mkdirSync(join(directory, 'fixtures'))
        writeFileSync(join(directory, 'fixtures/personas.json'), '[{"id":"first"}]\n')
        const evidencePath = join(directory, 'release-evidence.json')
        const installedVersion = JSON.parse(readFileSync(join(root, 'packages/cockpit/package.json'), 'utf8')).version as string
        const evidenceBytes = JSON.stringify({
            schema: 'cockpit-upgrade-release-evidence/v1',
            current: {
                package: '@b00dea/cockpit', version: installedVersion, integrity: `sha256-${createHash('sha256').update('a').digest('base64')}`, originals: [],
            },
            candidate: {
                package: '@b00dea/cockpit', version: '1.1.0', integrity: `sha256-${createHash('sha256').update('b').digest('base64')}`, originals: [],
            },
        })
        writeFileSync(evidencePath, evidenceBytes)
        const evidenceSha256 = createHash('sha256').update(evidenceBytes).digest('hex')
        const capture = captureIo()

        const status = await runCli([
            'upgrade', '--config', configPath, '--release-evidence', evidencePath,
            '--release-evidence-sha256', evidenceSha256, '--json',
        ], capture.io)
        expect(status, JSON.stringify(capture.output())).toBe(0)
        expect(JSON.parse(capture.output().stdout)).toMatchObject({
            result: { current: { version: installedVersion }, candidate: { version: '1.1.0' } },
        })
        expect(existsSync(join(directory, 'compose.generated.yml'))).toBe(false)
        expect(existsSync(join(directory, '.cockpit'))).toBe(false)

        const forged = captureIo()
        expect(await runCli([
            'upgrade', '--config', configPath, '--release-evidence', evidencePath,
            '--release-evidence-sha256', '0'.repeat(64), '--json',
        ], forged.io)).toBe(2)
        expect(JSON.parse(forged.output().stdout)).toMatchObject({
            diagnostics: [{ code: 'UPGRADE_AUTH_FAILED' }], result: null,
        })
        expect(existsSync(join(directory, 'compose.generated.yml'))).toBe(false)
        expect(existsSync(join(directory, '.cockpit'))).toBe(false)
    })

    it('adds probe and executable authority only through interactive exact-digest operator decisions', async () => {
        const candidate = {
            harness: 'Codex' as const,
            canonicalPath: '/synthetic/bin/codex',
            sha256: 'a'.repeat(64),
        }
        const decisions: unknown[] = []
        const specificationCandidate = {
            canonicalPath: '/synthetic/probe.json',
            sha256: 'b'.repeat(64),
            sourceSha256: 'c'.repeat(64),
            generatedManifestSha256: 'd'.repeat(64),
            commandVectors: [{
                harness: 'Codex', capability: 'instruction-loading', skill: null,
                invocation: ['{executable}', '--probe', '{control}'] as const,
                versionCommand: ['{executable}', '--version'] as const,
                helpCommand: ['{executable}', '--help'] as const,
            }],
        }
        const specificationDecisions: unknown[] = []
        const capture = captureIo(async (shown) => {
            decisions.push(shown)
            return shown.sha256
        }, undefined, async (shown) => {
            specificationDecisions.push(shown)
            return shown.sha256
        })
        expect(await runCli([
            'selftest', '--config', 'cockpit.toml', '--probe-specifications', 'probe.json', '--interactive',
        ], capture.io, {
            selftest: async (input) => {
                if ('writeProbeSpecificationsPath' in input) throw new Error('an interactive run must not reach the file writer')
                expect(await input.requestProbeSpecificationsApproval?.(specificationCandidate)).toBe(specificationCandidate.sha256)
                expect(await input.requestExecutableApproval?.(candidate)).toBe(candidate.sha256)
                return { status: 0, diagnostics: [], result: { pending: [] } }
            },
        }, { env: { PATH: '/synthetic/bin' } })).toBe(0)
        expect(decisions).toEqual([candidate])
        expect(specificationDecisions).toEqual([specificationCandidate])

        let calls = 0
        const handler = async () => {
            calls += 1
            return { status: 0, diagnostics: [], result: null }
        }
        expect(await runCli([
            'selftest', '--config', 'cockpit.toml', '--probe-specifications', 'probe.json', '--interactive', '--json',
        ], captureIo(async () => candidate.sha256, undefined, async () => specificationCandidate.sha256).io, { selftest: handler })).toBe(2)
        expect(await runCli([
            'selftest', '--config', 'cockpit.toml', '--probe-specifications', 'probe.json', '--interactive',
        ], captureIo().io, { selftest: handler })).toBe(2)
        expect(calls).toBe(0)
    })

    it('exposes the unavailable release source as a named upgrade refusal', async () => {
        const capture = captureIo()
        expect(await runCli(['upgrade', '--config', 'cockpit.toml', '--json'], capture.io)).toBe(2)
        expect(JSON.parse(capture.output().stdout)).toEqual({
            invocation: jsonInvocation(capture.output().stdout, 2, 'upgrade', resolve('cockpit.toml')),
            result: null,
            diagnostics: [expect.objectContaining({ code: 'UPGRADE_VERSION_AMBIGUOUS', severity: 'error' })],
        })
        expect(capture.output().stderr).toBe('')
    })

    it('shows preview changes and review evidence in human mode', async () => {
        const preview = captureIo()
        expect(await runCli(['sync', '--config', 'cockpit.toml', '--dry-run'], preview.io, {
            sync: async () => ({ status: 0, diagnostics: [], result: {
                action: 'sync', dryRun: true, changes: [{ operation: 'write', path: '.agents/skills/cockpit-fix/SKILL.md' }],
            } }),
        })).toBe(0)
        expect(preview.output().stdout).toContain('write ".agents/skills/cockpit-fix/SKILL.md"')

        const upgrade = captureIo()
        expect(await runCli(['upgrade', '--config', 'cockpit.toml'], upgrade.io, {
            upgrade: async () => ({ status: 0, diagnostics: [], result: { commands: ['cockpit sync --dry-run'] } }),
        })).toBe(0)
        expect(upgrade.output().stdout).toContain('cockpit sync --dry-run')
        expect(upgrade.output().stdout).not.toContain('{')

        const selftest = captureIo()
        expect(await runCli(['selftest', '--config', 'cockpit.toml', '--probe-specifications', 'probe.json'], selftest.io, {
            selftest: async () => ({ status: 0, diagnostics: [], result: { evidence: { human_needed: ['native'] } } }),
        })).toBe(0)
        expect(selftest.output().stdout).toContain('human_needed')
        expect(selftest.output().stdout).not.toContain('{')
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
                'install_policies = [{ toolchain = "node", volume = "node-modules", lockfile = "package-lock.json", install = ["npm", "ci"], load_probe = ["npm", "test"] }]',
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

describe('registry-resolve process contract', () => {
    function completeRegistryOutcome(): RegistryResolveOutcome {
        return {
            kind: 'complete',
            artifact: "COCKPIT_REGISTRY_FORMAT='1'\n",
            destination: null,
            diagnostics: [],
            result: {
                registry: {
                    format: '1',
                    cockpitSourceRevision: '0123456789abcdef0123456789abcdef01234567',
                    registrySha256: 'a'.repeat(64),
                    dialect: 'tier',
                    siblingCount: 1,
                    adoption: [
                        { layer: 'registry', state: 'migrated' },
                        { layer: 'environment', state: 'documented-only' },
                        { layer: 'surfaces', state: 'documented-only' },
                        { layer: 'guards', state: 'documented-only' },
                        { layer: 'grading', state: 'documented-only' },
                    ],
                },
            },
            status: 0,
        }
    }

    function captureIo() {
        let stdout = ''
        let stderr = ''
        const io = {
            stdout: { write: (text: string) => ((stdout += text), true) },
            stderr: { write: (text: string) => ((stderr += text), true) },
        } as unknown as CliIo
        return { io, output: () => ({ stdout, stderr }) }
    }

    it('decodes required named inputs and writes only artifact bytes to stdout', async () => {
        const capture = captureIo()
        let received: RegistryResolveCommandInput | undefined

        const status = await runCli(
            ['registry-resolve', '--registry', 'registry.sh', '--siblings-root', '../siblings', '--adoption', 'adoption.state'],
            capture.io,
            {
                'registry-resolve': async (input) => {
                    received = input
                    return completeRegistryOutcome()
                },
            },
        )

        expect(status).toBe(0)
        expect(received).toEqual({ registry: 'registry.sh', siblingsRoot: '../siblings', adoption: 'adoption.state' })
        expect({ ...capture.output(), stderr: humanStderr(capture.output().stderr) })
            .toEqual({ stdout: "COCKPIT_REGISTRY_FORMAT='1'\n", stderr: '' })
    })

    it('emits one JSON result and no artifact bytes or stderr', async () => {
        const capture = captureIo()

        const status = await runCli(
            ['registry-resolve', '--registry', 'registry.sh', '--siblings-root', '../siblings', '--adoption', 'adoption.state', '--json'],
            capture.io,
            { 'registry-resolve': async () => completeRegistryOutcome() },
        )
        const output = capture.output()
        const response = JSON.parse(output.stdout) as { result: unknown; diagnostics: unknown[] }

        expect(status).toBe(0)
        expect(response.result).toEqual(completeRegistryOutcome().result)
        expect(response.diagnostics).toEqual([])
        expect(output.stdout).not.toContain('COCKPIT_REGISTRY_FORMAT')
        expect(output.stderr).toBe('')
    })

    it.each([
        [['registry-resolve'], 'REGISTRY_SOURCE_REQUIRED'],
        [['registry-resolve', '--registry', 'registry.sh'], 'REGISTRY_SIBLINGS_ROOT_REQUIRED'],
        [['registry-resolve', '--registry', 'registry.sh', '--siblings-root', '../siblings'], 'REGISTRY_ADOPTION_REQUIRED'],
        [['registry-resolve', 'positional', '--registry', 'registry.sh', '--siblings-root', '../siblings', '--adoption', 'adoption.state'], 'REGISTRY_POSITIONAL_UNSUPPORTED'],
        [['registry-resolve', '--registry', 'registry.sh', '--siblings-root', '../siblings', '--adoption', 'adoption.state', '--output', 'artifact.sh'], 'REGISTRY_OUTPUT_UNSUPPORTED'],
        [['registry-resolve', '--registry', 'one.sh', '--registry', 'two.sh', '--siblings-root', '../siblings', '--adoption', 'adoption.state'], 'REGISTRY_OPTION_DUPLICATE'],
        [['registry-resolve', '--registry', 'one.sh', '--siblings-root', '../siblings', '--adoption', 'adoption.state', '--', '--output', 'artifact.sh'], 'REGISTRY_POSITIONAL_UNSUPPORTED'],
        [['registry-resolve', '--registry', 'one.sh', '--siblings-root', '../siblings', '--adoption', 'adoption.state', '--', '--registry', 'two.sh'], 'REGISTRY_POSITIONAL_UNSUPPORTED'],
    ])('refuses resolver misuse with its own code and no document diagnostic', (args, code) => {
        const result = run(args)

        expect(result.status).not.toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain(code)
        expect(result.stderr).not.toContain('DOCUMENT_')
    })

    it('keeps a resolver refusal as one null JSON result', () => {
        const result = run(['registry-resolve', '--json'])
        const response = JSON.parse(result.stdout) as { result: unknown; diagnostics: { code: string }[] }

        expect(result.status).not.toBe(0)
        expect(response.result).toBeNull()
        expect(response.diagnostics.map(({ code }) => code)).toEqual(['REGISTRY_SOURCE_REQUIRED'])
        expect(result.stderr).toBe('')
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
                    { severity: 'error', code: 'GENERATED_ARTIFACT_DRIFT', target: '.codex/hooks.json', message: 'Generated bytes changed', fix: 'run npx --no cockpit sync --config <your cockpit.toml>' },
                ], fixContext: { resolvedConfigPath: '/synthetic/cockpit.toml', generatedTargets: ['.codex/hooks.json'] } }),
            })
            expect(status).toBe(2)
            expect(projector).toHaveBeenCalledTimes(2)
            if (json) {
                const output = JSON.parse(stdout)
                expect(output.diagnostics[0]).not.toHaveProperty('fix')
                expect(output.guidance).toEqual([{ code: 'ARBITRARY', text: 'run something unsafe' }])
                expect(output.diagnostics[1].fix).toBe('npx --no cockpit sync --config /synthetic/cockpit.toml')
                expect(stderr).toBe('')
            } else {
                expect(stderr).toContain('Guidance: run something unsafe')
                expect(stderr).not.toContain('Fix: run something unsafe')
                expect(stderr).toContain('Fix: npx --no cockpit sync --config /synthetic/cockpit.toml')
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
                expect(JSON.parse(stdout)).toEqual({ decision: 'unavailable', reason: expect.any(String) })
                expect(stdout.split('\n')).toHaveLength(2)
                expect(humanStderr(stderr)).toBe('')
                expect(projector).toHaveBeenCalledTimes(1)
            } finally { projector.mockRestore() }
        }
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

function makeCockpit() {
    const parent = mkdtempSync(join(tmpdir(), 'cockpit-document-'))
    const cockpitRoot = join(parent, 'sample-cockpit')
    const registry = join(cockpitRoot, 'env/lib/instance.sh')
    mkdirSync(dirname(registry), { recursive: true })
    writeFileSync(registry, laneFixture)
    scratch.push(parent)
    return { cockpitRoot, registry }
}

function makeRegistry(source: string) {
    const directory = mkdtempSync(join(tmpdir(), 'cockpit-registry-'))
    const registry = join(directory, 'instance.sh')
    writeFileSync(registry, source)
    scratch.push(directory)
    return { directory, registry }
}

afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('document process contract', () => {
    it('reports an unexpected command failure as an internal operation error', async () => {
        let stdout = ''
        let stderr = ''
        const io = {
            stdout: { write: (text: string) => ((stdout += text), true) },
            stderr: { write: (text: string) => ((stderr += text), true) },
        } as unknown as CliIo

        const status = await runCli(['document', '--registry', 'unused', '--json'], io, {
            document: async () => {
                throw new Error('synthetic handler defect')
            },
        })
        const response = JSON.parse(stdout) as {
            diagnostics: { code: string; target?: string }[]
        }

        expect(status).not.toBe(0)
        expect(response.diagnostics).toEqual([
            expect.objectContaining({ code: 'CLI_INTERNAL_ERROR', target: 'document' }),
        ])
        expect(response.diagnostics).not.toEqual([
            expect.objectContaining({ code: 'CLI_USAGE_INVALID' }),
        ])
        expect(stderr).toBe('')
    })

    it('escapes terminal controls from a rejected registry row in the spawned process', () => {
        const { registry } = makeRegistry('X_SIBLINGS=(\n  "bad|bad|bad|profile:web\u202e|BAD_DIR|purpose"\n)\n')
        const result = run(['document', '--registry', registry])

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('profile:web\\u202e')
        expect(result.stderr).not.toContain('\u202e')
    })

    it('resolves a cockpit root and emits an attributed incomplete draft', () => {
        const { cockpitRoot } = makeCockpit()
        const result = run(['document', cockpitRoot])

        expect(result.status).not.toBe(0)
        expect(result.stdout).toMatch(/^#:schema \.\/node_modules\/@b00dea\/cockpit\/cockpit\.schema\.json\n/)
        expect(result.stdout).toContain('# COCKPIT DOCUMENT: INCOMPLETE DRAFT')
        expect(result.stdout).toContain('[inferred] cockpit.name')
        expect(result.stdout).toContain('sample-cockpit')
        expect(result.stderr).toContain('DOCUMENT_GAP')
        expect(result.stderr).not.toMatch(/\?\s*$/m)
    })

    it('accepts an explicit registry without inventing a cockpit root', () => {
        const { registry } = makeCockpit()
        const result = run(['document', '--registry', registry])

        expect(result.status).not.toBe(0)
        expect(result.stdout).toContain('# COCKPIT DOCUMENT: INCOMPLETE DRAFT')
        expect(result.stdout).toContain('[REQUIRED] cockpit.name')
        expect(result.stdout).not.toContain('[inferred] cockpit.name')
        expect(result.stderr).toContain('DOCUMENT_GAP')
    })

    it('materialises every sibling guide default with separate attribution', () => {
        const { cockpitRoot } = makeCockpit()
        const result = run(['document', cockpitRoot])

        const guideNotices = result.stdout.match(/\[default\] sibling\.[a-z0-9-]+\.guides/g) ?? []
        expect(guideNotices).toHaveLength(5)
        expect(result.stdout).toContain('registry dialect does not record guide filenames')
        expect(result.stdout).toContain('guides = [ "CLAUDE.md", "AGENTS.md" ]')
    })

    it.each([
        [['document'], 'DOCUMENT_SOURCE_REQUIRED'],
        [['document', 'one', 'two'], 'DOCUMENT_ROOT_COUNT'],
    ])('refuses invalid positional source forms with a stable code', (args, code) => {
        const result = run(args)

        expect(result.status).not.toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain(code)
        expect(result.stderr).not.toMatch(/\?\s*$/m)
    })

    it('refuses a root and registry together', () => {
        const { cockpitRoot, registry } = makeCockpit()
        const result = run(['document', cockpitRoot, '--registry', registry])

        expect(result.status).not.toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('DOCUMENT_SOURCE_CONFLICT')
    })

    it('reports an invalid positional basename from its actual source', () => {
        const parent = mkdtempSync(join(tmpdir(), 'cockpit-document-'))
        const cockpitRoot = join(parent, 'Invalid_Name')
        const registry = join(cockpitRoot, 'env/lib/instance.sh')
        mkdirSync(dirname(registry), { recursive: true })
        writeFileSync(registry, laneFixture)
        scratch.push(parent)

        const result = run(['document', cockpitRoot])

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('positional cockpit root basename')
        expect(result.stderr).toContain('rename the cockpit root')
        expect(result.stderr).not.toContain('an explicit registry cannot establish the cockpit name')
    })

    it('emits exactly one JSON value carrying the incomplete draft and no stderr prose', () => {
        const { cockpitRoot } = makeCockpit()
        const result = run(['document', cockpitRoot, '--json'])
        const response = JSON.parse(result.stdout) as {
            result: { document: string } | null
            diagnostics: { code: string }[]
        }

        expect(result.status).not.toBe(0)
        expect(response.result?.document).toBe(run(['document', cockpitRoot]).stdout)
        expect(response.result?.document).toContain('INCOMPLETE DRAFT')
        expect(response.diagnostics.some((diagnostic) => diagnostic.code === 'DOCUMENT_GAP')).toBe(true)
        expect(result.stdout.trimEnd().split('\n')).toHaveLength(1)
        expect(result.stderr).toBe('')
    })

    it('keeps usage refusals machine-readable when --json is present', () => {
        const { cockpitRoot } = makeCockpit()
        const result = run(['document', cockpitRoot, '--json', '--unknown'])
        const response = JSON.parse(result.stdout) as {
            result: unknown
            diagnostics: { code: string }[]
        }

        expect(result.status).not.toBe(0)
        expect(response.result).toBeNull()
        expect(response.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['CLI_USAGE_INVALID'])
        expect(result.stderr).toBe('')
    })

    it('treats --json after the option terminator as a positional cockpit root', () => {
        const result = run(['document', '--', '--json'])

        expect(result.status).not.toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('REGISTRY_NOT_FOUND')
        expect(result.stderr).toContain(`${sep}--json${sep}env${sep}lib${sep}instance.sh`)
    })

    it('states that stdout bytes target the canonical cockpit.toml location', () => {
        const { cockpitRoot } = makeCockpit()
        const result = run(['document', cockpitRoot])

        expect(result.stderr).toContain('DOCUMENT_STDOUT_TARGET')
        expect(result.stderr).toContain('<cockpit-root>/cockpit.toml')
        expect(result.stderr).not.toContain(cockpitRoot)
    })
})

describe('document output execution', () => {
    it('refuses an empty output path without emitting artifact bytes', () => {
        const { cockpitRoot } = makeCockpit()

        const result = run(['document', cockpitRoot, '--output='])

        expect(result.status).not.toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('CLI_USAGE_INVALID')
        expect(result.stderr).toContain('--output requires a non-empty path')
        expect(result.stderr).not.toContain('DOCUMENT_STDOUT_TARGET')
    })

    it('exclusively creates a marked gap draft and keeps stdout empty', () => {
        const { cockpitRoot } = makeCockpit()
        const output = join(dirname(cockpitRoot), 'generated', 'cockpit.toml')
        mkdirSync(dirname(output))
        const result = run(['document', cockpitRoot, '--output', output])

        expect(result.status).not.toBe(0)
        expect(result.stdout).toBe('')
        // The file is committed, so the directive names the cockpit's own install, never this machine's package path.
        expect(readFileSync(output, 'utf8')).toMatch(/^#:schema \.\/node_modules\/@b00dea\/cockpit\/cockpit\.schema\.json\n/)
        expect(readFileSync(output, 'utf8')).toContain('INCOMPLETE DRAFT')
    })

    it('leaves an existing output byte-identical', () => {
        const { cockpitRoot } = makeCockpit()
        const output = join(dirname(cockpitRoot), 'existing.toml')
        const original = 'operator-owned bytes\n'
        writeFileSync(output, original)

        const result = run(['document', cockpitRoot, '--output', output])

        expect(result.status).not.toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('OUTPUT_EXISTS')
        expect(readFileSync(output, 'utf8')).toBe(original)
    })

    it('suppresses stdout and destination artifacts when any row is skipped', () => {
        const source = [
            'X_SIBLINGS=(',
            '  "ok|ok|ok|host|OK_DIR|make local — host lane"',
            '  "broken|too|few"',
            ')',
            '',
        ].join('\n')
        const { directory, registry } = makeRegistry(source)
        const output = join(directory, 'cockpit.toml')

        const result = run(['document', '--registry', registry, '--output', output])

        expect(result.status).not.toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('REGISTRY_ROW_SKIPPED')
        expect(result.stderr).toContain('DOCUMENT_GAP')
        expect(() => readFileSync(output, 'utf8')).toThrow()
    })

    it('does not write a draft in JSON mode even when --output is supplied', () => {
        const { cockpitRoot } = makeCockpit()
        const output = join(dirname(cockpitRoot), 'json-output.toml')

        const result = run(['document', cockpitRoot, '--json', '--output', output])
        const response = JSON.parse(result.stdout) as { result: unknown }

        expect(result.status).not.toBe(0)
        expect(response.result).toBeNull()
        expect(() => readFileSync(output, 'utf8')).toThrow()
        expect(result.stderr).toBe('')
    })
})

describe('generated sync operator admission', () => {
    it('shows the interactive stale-removal preview as human-readable text', async () => {
        const preview = {
            format: 'cockpit-stale-removal-request/v1' as const,
            cockpitId: 'synthetic', generation: 'generation-1', sourceSha256: 'a'.repeat(64),
            entries: [{ path: 'old', operation: 'remove-file' as const, current: {
                kind: 'file' as const, sha256: 'b'.repeat(64), dev: 1, ino: 2,
            } }],
            digest: 'c'.repeat(64),
        }
        const stdin = Readable.from([`${preview.digest}\n`]) as NodeJS.ReadStream
        Object.defineProperty(stdin, 'isTTY', { value: true })
        const stderr = new PassThrough()
        let shown = ''
        stderr.on('data', chunk => { shown += chunk.toString() })

        const outcome = await runSyncOperatorCommand({ configPath: 'cockpit.toml' }, {
            interactive: true, json: false, ci: undefined,
        }, { stderr, stdin }, async (input) => input.dryRun
            ? { status: 0, diagnostics: [], result: { dryRun: true, staleRemoval: preview } }
            : { status: 0, diagnostics: [], result: { dryRun: false } })

        expect(outcome.status).toBe(0)
        expect(shown).toContain('digest:')
        expect(shown).toContain('path: old')
        expect(shown).not.toContain('{')
    })

    it('withholds stale-removal authority when entries change while the supplied digest remains equal', async () => {
        const preview = {
            format: 'cockpit-stale-removal-request/v1' as const,
            cockpitId: 'synthetic', generation: 'generation-1', sourceSha256: 'a'.repeat(64),
            entries: [{ path: 'old', operation: 'remove-file' as const, current: {
                kind: 'file' as const, sha256: 'b'.repeat(64), dev: 1, ino: 2,
            } }],
            digest: 'c'.repeat(64),
        }
        const changed = { ...preview, entries: [{ ...preview.entries[0]!, path: 'other' }] }
        let calls = 0
        const outcome = await runSyncOperatorCommand({ configPath: 'cockpit.toml' }, {
            interactive: true, json: false, ci: undefined,
        }, {
            stderr: { write: () => true },
            confirmStaleRemoval: async () => preview.digest,
        }, async (input) => {
            calls += 1
            if (input.dryRun) return { status: 0, diagnostics: [], result: { dryRun: true, staleRemoval: preview } }
            expect(await input.authorizeStaleRemoval?.(changed)).toBeUndefined()
            expect(await input.authorizeStaleRemoval?.(preview)).toEqual({
                format: 'cockpit-stale-removal-approval/v1', digest: preview.digest,
            })
            return { status: 2, diagnostics: [{ severity: 'error', code: 'GENERATED_STALE_APPROVAL_REQUIRED', message: 'changed' }], result: null }
        })
        expect(outcome.status).toBe(2)
        expect(calls).toBe(2)
    })
})


describe('work command routing', () => {
    // Cases name the handler; a person types the command's words, such as `work intake`.
    const spelling = (handler: string) => commands.find(command => command.handler === handler)!.name
    it('binds acceptance to one same-process human continuation after terminal admission', async () => {
        const digest = 'a'.repeat(64), prompt = `Accept exact contract ${digest}`
        const decide = vi.fn(async (answer: string) => ({ status: answer === digest ? 0 : 2, result: { accepted: answer === digest }, diagnostics: [] }))
        const begin = vi.fn(async () => ({ digest, prompt, decide }))
        const confirm = vi.fn(async (candidate: Readonly<{ digest: string; prompt: string }>) => candidate.digest)
        let stdout = '', stderr = ''
        const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) }, confirmWorkOrder: confirm }
        expect(await runCli(['work', 'accept', '--config', 'cockpit.toml', '--work-order', 'WO-001', '--interactive'], io, { beginOperatorWorkApplication: begin }, { env: {} })).toBe(0)
        expect(begin).toHaveBeenCalledExactlyOnceWith({ configPath: 'cockpit.toml', request: { operation: 'work-accept', workOrderId: 'WO-001' } })
        expect(confirm).toHaveBeenCalledExactlyOnceWith({ digest, prompt })
        expect(decide).toHaveBeenCalledExactlyOnceWith(digest)
        // The person who accepted sees what was recorded, not silence.
        expect(stdout).toBe('accepted: true\n')
        expect(humanStderr(stderr)).toBe('')
        begin.mockClear(); decide.mockClear(); confirm.mockClear(); stdout = ''
        // A person's answer to an open gap, or their decision, takes the same terminal continuation.
        expect(await runCli(['work', 'answer', '--config', 'cockpit.toml', '--work-order', 'WO-001', '--event-file', 'workorders/events/answer.json', '--interactive'],
            io, { beginOperatorWorkApplication: begin }, { env: {} })).toBe(0)
        expect(begin).toHaveBeenCalledExactlyOnceWith({ configPath: 'cockpit.toml', request: { operation: 'work-answer', workOrderId: 'WO-001', eventFile: 'workorders/events/answer.json' } })
        expect(confirm).toHaveBeenCalledExactlyOnceWith({ digest, prompt })
        expect(decide).toHaveBeenCalledExactlyOnceWith(digest)
        begin.mockClear(); decide.mockClear(); confirm.mockClear()
        expect(await runCli(['work', 'accept', '--config', 'cockpit.toml', '--work-order', 'WO-001', '--interactive'], io, { beginOperatorWorkApplication: begin }, { env: { CI: '1' } })).toBe(2)
        expect(await runCli(['work', 'accept', '--config', 'cockpit.toml', '--work-order', 'WO-001'], io, { beginOperatorWorkApplication: begin }, { env: {} })).toBe(2)
        // Without a terminal on both standard input and standard output, nobody is there to read the contract.
        const piped = { stdin: Readable.from([`accept ${digest}\n`]), stdout: { write: () => true }, stderr: { write: () => true } } as unknown as CliIo
        expect(await runCli(['work', 'accept', '--config', 'cockpit.toml', '--work-order', 'WO-001', '--interactive'], piped, { beginOperatorWorkApplication: begin }, { env: {} })).toBe(2)
        expect(begin).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled()
    })

    it('routes closed work browser and testing selectors through one configured application input', async () => {
        const cases: readonly (readonly [string, readonly string[], unknown])[] = [
            ['work-intake', ['--work-order', 'WO-001'], { operation: 'work-intake', workOrderId: 'WO-001' }],
            ['work-intake', ['--intent', 'intents/task.json'], { operation: 'work-intake', intent: 'intents/task.json' }],
            ['work-intake', ['--intent', 'intents/task.json', '--candidate', 'drafts/task.md'], { operation: 'work-intake', intent: 'intents/task.json', candidate: 'drafts/task.md' }],
            ['work-record', ['--work-order', 'WO-001', '--event-file', 'events/heartbeat.json'], { operation: 'work-record', workOrderId: 'WO-001', eventFile: 'events/heartbeat.json' }],
            ['work-review', ['--work-order', 'WO-001'], { operation: 'work-review', workOrderId: 'WO-001' }],
            ['work-status', [], { operation: 'work-status' }],
            ['work-resume', [], { operation: 'work-resume' }],
            ['work-recover', ['--lock', 'WO-001'], { operation: 'work-recover', lockId: 'WO-001', apply: false }],
            ['work-recover', ['--lock', '.admission-capacity', '--apply'], { operation: 'work-recover', lockId: '.admission-capacity', apply: true }],
            ['work-execute', ['--work-order', 'WO-001', '--approach', 'bounded correction'], { operation: 'work-execute', workOrderId: 'WO-001', approach: 'bounded correction' }],
            ['work-sweep', [], { operation: 'work-sweep', apply: false }],
            ['work-reverse', ['--work-order', 'WO-001'], { operation: 'work-reverse', workOrderId: 'WO-001' }],
            ['work-programme-mint', ['--programme', 'synthetic', '--item', 'first'], { operation: 'work-programme-mint', programmeId: 'synthetic', itemKey: 'first' }],
            ['work-programme-mint', ['--programme', 'synthetic'], { operation: 'work-programme-mint', programmeId: 'synthetic' }],
            ['work-programme-mint', ['--programme', 'synthetic', '--candidate', 'drafts/next.md'], { operation: 'work-programme-mint', programmeId: 'synthetic', candidate: 'drafts/next.md' }],
            ['work-metrics', [], { operation: 'work-metrics' }],
            ['work-grade', ['--work-order', 'WO-001'], { operation: 'work-grade', workOrderId: 'WO-001' }],
            ['browser-drive', ['--role', 'qa_user'], { operation: 'browser-drive', role: 'qa_user' }],
            ['browser-accessibility', ['--role', '1worker'], { operation: 'browser-accessibility', role: '1worker' }],
            ['browser-screenshot', [], { operation: 'browser-screenshot' }],
            ['browser-debugger', [], { operation: 'browser-debugger' }],
            ['test-run', ['--gate', 'unit', '--mode', 'canonical', '--select', 'file:src/example.ts'], { operation: 'test-run', gate: 'unit', mode: 'canonical', select: { kind: 'file', value: 'src/example.ts' } }],
            ['test-run', ['--gate', 'unit', '--mode', 'canonical', '--select', 'test:' + 'é'.repeat(2048)], { operation: 'test-run', gate: 'unit', mode: 'canonical', select: { kind: 'test', value: 'é'.repeat(2048) } }],
        ]
        for (const [operation, args, request] of cases) {
            let stdout = '', stderr = ''
            const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) } }
            const handler = vi.fn(async () => ({ status: 0, result: { operation }, diagnostics: [] }))
            const verb = spelling(operation)
            const status = await runCli([...verb.split(' '), '--config', 'cockpit.toml', ...args, '--json'], io, { [operation]: handler })
            expect(status, operation).toBe(0)
            expect(handler, operation).toHaveBeenCalledExactlyOnceWith({ configPath: 'cockpit.toml', request })
            expect(JSON.parse(stdout)).toMatchObject({ result: { operation }, invocation: { verb, exitCode: 0 } })
            expect(stdout.split('\n')).toHaveLength(2)
            expect(stderr).toBe('')
        }
    })

    it('refuses noninteractive acceptance and malformed selectors before dispatch', async () => {
        const cases = [
            ['work-accept', '--work-order', 'WO-001', '--interactive'],
            ['work-renew', '--work-order', 'WO-001', '--interactive'],
            ['work-answer', '--work-order', 'WO-001', '--event-file', 'workorders/events/answer.json', '--interactive'],
            ['work-intake'],
            ['work-intake', '--intent', '../outside.json'],
            ['work-intake', '--intent', 'intents/task.json', '--work-order', 'WO-001'],
            ['work-intake', '--work-order', 'WO-001', '--candidate', 'drafts/task.md'],
            ['work-intake', '--intent', 'intents/task.json', '--candidate', '/absolute.md'],
            ['work-record', '--work-order', 'WO-001'],
            ['work-record', '--work-order', 'WO-001', '--event-file', 'events/../outside.json'],
            ['work-review'],
            ['work-recover'],
            ['work-recover', '--lock', '../outside'],
            ['work-recover', '--lock', '.'],
            ['work-recover', '--lock', 'WO-001', '--lock', 'WO-002'],
            ['work-programme-mint', '--programme', 'synthetic', '--candidate', './draft.md'],
            ['work-programme-mint', '--programme', 'synthetic', '--item', 'bad/key'],
            ['work-execute', '--work-order', 'WO-001'],
            ['work-grade', '--work-order', 'WO-001', '--work-order', 'WO-002'],
            ['work-sweep', '--apply', 'unexpected'],
            ['test-run', '--gate', 'unit', '--select', 'unknown:value'],
            ['test-run', '--gate', 'unit', '--mode', 'arbitrary'],
            ['test-run', '--gate', 'unit', '--mode', 'canonical', '--select', 'test:' + 'é'.repeat(2049)],
            ['browser-drive', '--role', 'bad\nrole'],
            ...['Bad', 'bad role', '../outside', 'x'.repeat(65)].flatMap(value => [
                ['browser-drive', '--role', value],
                ['test-run', '--gate', value, '--mode', 'canonical'],
            ]),
        ]
        for (const args of cases) {
            let stdout = '', stderr = ''
            const handler = vi.fn(async () => ({ status: 0, result: null, diagnostics: [] }))
            const io: CliIo = { stdout: { write: text => ((stdout += text), true) }, stderr: { write: text => ((stderr += text), true) } }
            expect(await runCli([...spelling(args[0]!).split(' '), '--config', 'cockpit.toml', ...args.slice(1), '--json'], io, { [args[0]!]: handler })).toBe(2)
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
            stdout: { write: () => true },
            stderr,
            confirmInit: async () => previewSha256,
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
                '--accept-preview', previewSha256, '--answers', answers], {
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

    it('binds one explicit root and target and keeps JSON preview read-only', async () => {
        for (const target of SURFACE_TARGETS) {
            let stdout = ''
            const application = vi.fn(async (input: import('./environment/init-application.js').InitApplicationInput) => ({
                kind: 'pending' as const, status: 0 as const, artifact: null, destination: null, diagnostics: [],
                result: { stage: 'surface-previewed' as const, root: input.root, target: input.target,
                    previewSha256: 'a'.repeat(64), files: [] },
            }))
            const confirmInit = vi.fn(async () => 'a'.repeat(64))
            const io: CliIo = { stdout: { write: value => ((stdout += value), true) }, stderr: { write: () => true }, confirmInit }
            expect(await runCli(['init', process.cwd(), '--target', target, '--interactive', '--json'], io, { init: application })).toBe(0)
            expect(application).toHaveBeenCalledOnce()
            expect(application.mock.calls[0]![0]).toMatchObject({ root: process.cwd(), target, accepted: false })
            expect(confirmInit).not.toHaveBeenCalled()
            expect(JSON.parse(stdout).result).toMatchObject({ root: process.cwd(), target })
            expect(stdout.split('\n')).toHaveLength(2)
        }
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

    it('reads the answers file and accepts only the printed digest when no terminal is attached', async () => {
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

            expect(await runCli([...base, '--accept-preview', 'a'.repeat(64), '--answers', answers], io, { init: application })).toBe(0)
            expect(application.mock.calls.at(-1)![0]).toMatchObject({ accepted: true,
                greenfieldAnswer: { questionId: question.id, bytes: '{"API_PORT":4100}' } })
            expect(JSON.parse(stdout).result.stage).toBe('surface-published')

            application.mockClear()
            expect(await runCli([...base, '--accept-preview', 'b'.repeat(64), '--answers', answers], io, { init: application })).toBe(2)
            expect(application.mock.calls.every(([input]) => !input.accepted)).toBe(true)

            for (const refused of [
                [...base, '--answers', answers],
                [...base, '--accept-defaults', 'a'.repeat(64)],
                [...base, '--accept-preview', 'not-a-digest'],
                [...base, '--accept-preview', 'a'.repeat(64), '--interactive'],
                [...base, '--accept-preview', 'a'.repeat(64), '--answers', join(directory, 'missing.toml')],
            ]) {
                application.mockClear()
                expect(await runCli(refused, io, { init: application })).toBe(2)
                expect(application).not.toHaveBeenCalled()
            }
            // The parser's own message quotes the bytes it stopped at; the refusal names only the position.
            writeFileSync(answers, 'ports = [SECRET_CANARY')
            stdout = ''
            expect(await runCli([...base, '--accept-preview', 'a'.repeat(64), '--answers', answers], io, { init: application })).toBe(2)
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
            '--accept-preview', 'a'.repeat(64), '--answers', answers], {
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
            '--accept-preview', 'a'.repeat(64), '--answers', answers], {
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
            [...base, '--accept-reset', digest, '--accept-preview', 'a'.repeat(64)],
            [...base, '--accept-reset', digest, '--answers', 'answers.toml'],
            ['init', process.cwd(), '--target', 'codexcli', '--accept-reset', digest, '--json'],
        ]) {
            application.mockClear()
            expect(await runCli(refused, io, { init: application })).toBe(2)
            expect(application).not.toHaveBeenCalled()
        }
    })

    it('refuses missing, extra or duplicate root and target before dispatch', async () => {
        for (const args of [
            [], ['--target', 'codexcli'], ['.'], ['.', '.', '--target', 'codexcli'],
            ['.', '--target', 'unknown'], ['.', '--target', 'codexcli', '--target', 'opencode'],
            ['.', '--target', 'codexcli', '--registry', 'a', '--registry', 'b'],
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
