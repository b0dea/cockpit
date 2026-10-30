import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from './cli.js'
import { renderHumanDiagnostics } from './diagnostics.js'
import { admitDiagnosticFix, formatShellCommand } from './fix-catalogue.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './generated-environment/command.js'

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('executable remedy catalogue', () => {
    const diagnostic = { severity: 'error' as const, code: 'GENERATED_ARTIFACT_DRIFT', message: 'Owned artifact differs',
        target: 'fixtures/personas.generated.ts', fix: 'run npx --no cockpit sync --config <your cockpit.toml>' }
    const context = { resolvedConfigPath: '/workspace/cockpit.toml', generatedTargets: [diagnostic.target] }

    it('refuses unregistered guidance and unbound or unsafe command inputs', () => {
        expect(admitDiagnosticFix({ ...diagnostic, code: 'UNKNOWN' }, context)).toBeUndefined()
        expect(admitDiagnosticFix({ ...diagnostic, fix: 'run arbitrary-command' }, context)).toBeUndefined()
        expect(admitDiagnosticFix({ ...diagnostic, fix: undefined }, context)).toBeUndefined()
        expect(admitDiagnosticFix(diagnostic)).toBeUndefined()
        expect(admitDiagnosticFix(diagnostic, { ...context, resolvedConfigPath: null })).toBeUndefined()
        expect(admitDiagnosticFix(diagnostic, { ...context, generatedTargets: [] })).toBeUndefined()
        for (const path of ['cockpit.toml', '', '/workspace/../cockpit.toml', '/workspace/./cockpit.toml']) {
            expect(admitDiagnosticFix(diagnostic, { ...context, resolvedConfigPath: path })).toBeUndefined()
        }
        for (const target of ['', '../outside', '/outside', 'a/../outside', 'a\\outside', 'a//b', 'a/./b']) {
            expect(admitDiagnosticFix({ ...diagnostic, target }, { ...context, generatedTargets: [target] })).toBeUndefined()
        }
        for (const control of ['\n', '\r', '\0', '\u001b', '\u007f', '\u0085', '\u009b', '\u061c', '\u200e', '\u200f', '\u2028', '\u2029', '\u202e', '\u2066', '\u2069']) {
            expect(admitDiagnosticFix(diagnostic, { ...context, resolvedConfigPath: `/workspace/config${control}.toml` })).toBeUndefined()
            const target = `${diagnostic.target}${control}`
            expect(admitDiagnosticFix({ ...diagnostic, target }, { ...context, generatedTargets: [target] })).toBeUndefined()
            expect(admitDiagnosticFix({ ...diagnostic, code: `${diagnostic.code}${control}` }, context)).toBeUndefined()
            expect(admitDiagnosticFix({ ...diagnostic, fix: `${diagnostic.fix}${control}` }, context)).toBeUndefined()
        }
    })

    it('keeps shell metacharacters as one quoted token and freezes the admitted argv', () => {
        const admitted = admitDiagnosticFix(diagnostic, { ...context,
            resolvedConfigPath: "/workspace/a'$(echo injected);`id` config.toml" })
        expect(admitted).toEqual({
            argv: ['npx', '--no', 'cockpit', 'sync', '--config', "/workspace/a'$(echo injected);`id` config.toml"],
            command: "npx --no cockpit sync --config '/workspace/a'\"'\"'$(echo injected);`id` config.toml'",
        })
        expect(Object.isFrozen(admitted)).toBe(true)
        expect(Object.isFrozen(admitted?.argv)).toBe(true)
    })

    it('formats suggested commands so a POSIX shell receives the exact argv', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-suggested-command-')))
        roots.push(root)
        const bin = join(root, 'bin')
        const capture = join(root, 'argv')
        const configPath = join(root, "config $HOME `touch escaped` ' review.toml")
        await mkdir(bin)
        await writeFile(join(bin, 'cockpit'), '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$CAPTURE"\n', { mode: 0o700 })

        const command = formatShellCommand(['cockpit', 'up', '--config', configPath])
        const executed = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8',
            env: { ...process.env, CAPTURE: capture, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })

        expect(executed.status, executed.stderr).toBe(0)
        expect((await readFile(capture)).toString('utf8').split('\0').filter(Boolean))
            .toEqual(['up', '--config', configPath])
        expect(existsSync(join(root, 'escaped'))).toBe(false)
    })

    it('clears real generated drift by executing exactly the admitted argv without a shell', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-remedy-')))
        roots.push(root)
        const configPath = join(root, "demo'$(false); config.toml")
        const declaration = (await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8'))
            .replace('name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."')
        await mkdir(join(root, 'app'))
        await mkdir(join(root, 'fixtures'))
        await writeFile(configPath, declaration)
        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
        const synced = await syncGeneratedEnvironment({ configPath })
        expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete', status: 0 })
        if (synced.kind !== 'complete') throw new Error('Synthetic remedy setup failed')
        await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"changed"}]\n')
        const before = await checkGeneratedEnvironment({ configPath })
        expect(before).toMatchObject({ kind: 'refusal', status: 2,
            diagnostics: [expect.objectContaining({ code: 'GENERATED_ARTIFACT_DRIFT', target: diagnostic.target })] })
        const failure = before.diagnostics.find(row => row.code === 'GENERATED_ARTIFACT_DRIFT')
        if (!failure) throw new Error('Synthetic fixture did not produce generated drift')
        const admitted = admitDiagnosticFix(failure, { resolvedConfigPath: configPath, generatedTargets: synced.result.paths })
        expect(admitted?.argv).toEqual(['npx', '--no', 'cockpit', 'sync', '--config', configPath])
        if (!admitted) throw new Error('Catalogue did not admit the generated drift remedy')

        const bin = join(root, 'bin')
        await mkdir(bin)
        const launcher = join(bin, 'cockpit')
        const cliUrl = pathToFileURL(resolve('packages/cockpit/src/cli.ts')).href
        // Bind the installed executable name to the current source CLI, never to a user's installation.
        await writeFile(launcher, `#!/usr/bin/env -S node --import tsx\nimport { runCli } from ${JSON.stringify(cliUrl)};\nprocess.exitCode = await runCli(process.argv.slice(2));\n`)
        await chmod(launcher, 0o755)
        // The remedy runs through npx; this stand-in resolves only the cockpit bin, as npx does for a
        // project that installs cockpit, without consulting the npm registry.
        const npx = join(bin, 'npx')
        await writeFile(npx, `#!/bin/sh\ntest "$1" = --no && test "$2" = cockpit || exit 64\nshift 2\nexec ${JSON.stringify(launcher)} "$@"\n`)
        await chmod(npx, 0o755)
        const [executable, ...args] = admitted.argv
        const executed = spawnSync(executable, args, { shell: false, cwd: resolve('.'), encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })
        expect(executed.error).toBeUndefined()
        expect(executed.status, executed.stderr).toBe(0)
        // Human mode prints only the warning; the invocation record belongs to the --json envelope.
        const lines = executed.stderr.match(/[^\n]*\n/g) ?? []
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatch(/^WARNING SURFACE_GENERATOR_TRUST_WARNING \[claudecode:\.claude\/settings\.json\]: [^\n]+\n$/)
        expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete', status: 0,
            diagnostics: [expect.objectContaining({ severity: 'warning', code: 'SURFACE_GENERATOR_TRUST_WARNING' })] })
        expect(await readFile(join(root, diagnostic.target), 'utf8')).toContain('"changed"')
    })
})

// Every one of these used to fail as printed: a bare `cockpit` is not on PATH for a dev-dependency
// install, every configured command refuses without --config, and down and reset refuse until the
// Docker daemon is named.
describe('printed cockpit commands', () => {
    const VERBS = 'sibling add|sibling remove|runtime measure|baseline-record|setup|sync|check|selftest|upgrade|up|sleep|session|down|reset|preflight|doctor|logs'
    const runnable = new RegExp(`(?:npx --no |\\./node_modules/\\.bin/)cockpit (${VERBS})(?![\\w-])`, 'g')
    const bare = new RegExp(`\\b(?:run|rerun|re-run)\\s+\`?cockpit (?:${VERBS})(?![\\w-])`, 'gi')
    // A command ends at its closing quote or the prose around it.
    const commandEnd = /[`'";,)|\\]| then | to | and | or /

    it('name the configuration everywhere a diagnostic, instruction or skill spells one, and the daemon for down and reset', () => {
        const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard',
            'packages/cockpit/src', 'packages/cockpit/surfaces'], { encoding: 'utf8' }).split('\0')
            .filter(path => /\.(?:ts|md|sh|json|cjs|mjs)$/.test(path) && !path.endsWith('.test.ts'))
        expect(paths).toContain('packages/cockpit/src/diagnostics.ts')
        const unrunnable: string[] = []
        for (const path of paths) {
            readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
                if (path.endsWith('.ts') && /^\s*(?:\/\/|\*|\/\*)/.test(line)) return
                const at = `${path}:${index + 1}`
                for (const match of line.matchAll(runnable)) {
                    const rest = line.slice(match.index + match[0].length)
                    if (rest.startsWith(' --help')) continue
                    if (!/--config (?!<file>|<cockpit\.toml>)/.test(rest.split(commandEnd)[0]!)) unrunnable.push(`${at}: ${match[0]} without --config`)
                    if ((match[1] === 'down' || match[1] === 'reset')
                        && !line.slice(0, match.index).endsWith('DOCKER_CONTEXT="$(docker context show)" ')) unrunnable.push(`${at}: ${match[0]} without DOCKER_CONTEXT`)
                }
                for (const match of line.matchAll(bare)) unrunnable.push(`${at}: bare ${match[0]}`)
            })
        }
        expect(unrunnable).toEqual([])
    })

    it('bind the resolved configuration path and parse when run exactly as printed', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-printed-command-')))
        roots.push(root)
        const configPath = join(root, "the team's cockpit.toml")
        await mkdir(join(root, 'docs'))
        await mkdir(join(root, 'home'))
        execFileSync('git', ['init', '--quiet', root])
        await writeFile(configPath, readFileSync(resolve('examples/docs-only/cockpit.toml'), 'utf8'))
        const { DOCKER_HOST: _host, DOCKER_CONTEXT: _context, ...inherited } = process.env
        const env = { ...inherited, CI: '1', HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'home', 'state') }
        const quoted = formatShellCommand([configPath])

        // A real refusal: `up` on a cockpit that declares no runtime names sync as its remedy.
        let stderr = ''
        let stdout = ''
        const io = { stdout: { write: (chunk: string) => { stdout += chunk; return true } },
            stderr: { write: (chunk: string) => { stderr += chunk; return true } } }
        expect(await runCli(['up', '--config', configPath], io, {}, { env }), stderr).toBe(2)
        const sync = `npx --no cockpit sync --config ${quoted}`
        expect(stderr).toContain(sync)
        expect(await runCli(['up', '--config', configPath, '--json'], io, {}, { env })).toBe(2)
        expect(JSON.parse(stdout).guidance).toEqual([expect.objectContaining({ code: 'ENVIRONMENT_NOT_DECLARED', text: expect.stringContaining(sync) })])
        const down = `DOCKER_CONTEXT="$(docker context show)" npx --no cockpit down --config ${quoted}`
        expect(renderHumanDiagnostics([{ severity: 'error', code: 'CLAIM_CO_TENANT', message: 'another holder owns the stack' }],
            undefined, { resolvedConfigPath: configPath, generatedTargets: [] })).toContain(down)

        const bin = join(root, 'bin')
        await mkdir(bin)
        const launcher = join(bin, 'cockpit')
        const cliUrl = pathToFileURL(resolve('packages/cockpit/src/cli.ts')).href
        await writeFile(launcher, `#!/usr/bin/env -S node --import tsx\nimport { runCli } from ${JSON.stringify(cliUrl)};\nprocess.exitCode = await runCli(process.argv.slice(2));\n`)
        await chmod(launcher, 0o755)
        await writeFile(join(bin, 'npx'), `#!/bin/sh\ntest "$1" = --no && test "$2" = cockpit || exit 64\nshift 2\nexec ${JSON.stringify(launcher)} "$@"\n`)
        await chmod(join(bin, 'npx'), 0o755)
        // Answers the context query the printed down command makes; any other Docker call fails.
        await writeFile(join(bin, 'docker'), '#!/bin/sh\ntest "$1 $2" = "context show" && echo stand-in && exit 0\nexit 1\n')
        await chmod(join(bin, 'docker'), 0o755)
        const run = (command: string) => spawnSync('/bin/sh', ['-c', command], { cwd: resolve('.'), encoding: 'utf8',
            env: { ...env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })

        const synced = run(sync)
        expect(synced.status, synced.stderr).toBe(0)
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
        // down gets past argument parsing and the daemon-selection refusal to the cockpit's own answer.
        const downed = run(down)
        expect(downed.stderr).not.toContain('CLI_USAGE_INVALID')
        expect(downed.stderr).toContain('ENVIRONMENT_NOT_DECLARED')
    }, 120_000)
})
