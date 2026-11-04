import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli, type CliHandlerOverrides } from './cli.js'
import { commandGroups, commands as cliCommands } from './command-table.js'
import { renderHumanDiagnostics } from './diagnostics.js'
import { admitDiagnosticFix, cockpitCommand, formatShellCommand, type ConfiguredCommand } from './fix-catalogue.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './generated-environment/command.js'
import { stubComposeTopology } from '../test-support/compose-topology-docker.js'

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('executable remedy catalogue', () => {
    const diagnostic = { severity: 'error' as const, code: 'GENERATED_ARTIFACT_DRIFT', message: 'Owned artifact differs',
        target: 'compose.cockpit.yml', fix: 'run npx --no cockpit sync --config <your cockpit.toml>' }
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
        // The compose-first example under a configuration name a shell would misread.
        cpSync(resolve('examples/compose-first'), root, { recursive: true })
        // The example's compose.yml as Compose reports it, in the fields check reads: both services build,
        // have a healthcheck, publish a leased loopback port and bind their sibling.
        const service = (sibling: string, port: string) => ({ build: { context: join(root, sibling) }, healthcheck: { test: ['CMD', 'true'] },
            ports: [port], volumes: [{ type: 'bind', source: join(root, sibling), target: '/app' }] })
        await stubComposeTopology({ api: service('api', '127.0.0.1:${API_HOST_PORT:-4200}:3000'), web: service('web', '127.0.0.1:${WEB_HOST_PORT:-4300}:3000') })
        const configPath = join(root, "demo'$(false); config.toml")
        await writeFile(configPath, await readFile(join(root, 'cockpit.toml'), 'utf8'))
        await rm(join(root, 'cockpit.toml'))
        const synced = await syncGeneratedEnvironment({ configPath })
        expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete', status: 0 })
        if (synced.kind !== 'complete') throw new Error('Synthetic remedy setup failed')
        const canonical = await readFile(join(root, diagnostic.target), 'utf8')
        await writeFile(join(root, diagnostic.target), `${canonical}# edited by hand\n`)
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
        // Human mode prints nothing: the invocation record belongs to the --json envelope, and the
        // Claude settings trust warning belongs to a run that writes those settings, which this one does not.
        expect(executed.stderr).toBe('')
        expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete', status: 0, diagnostics: [] })
        expect(await readFile(join(root, diagnostic.target), 'utf8')).toBe(canonical)
    })
})

// Every one of these used to fail as printed: a bare `cockpit` is not on PATH for a dev-dependency
// install, every configured command refuses without --config, and down and reset refuse until the
// Docker daemon is named.
describe('printed cockpit commands', () => {
    const VERBS = 'sibling add|sibling remove|runtime measure|setup|sync|check|selftest|up|sleep|session|down|reset|preflight|doctor|logs'
    // Every work, browser and test command reads --config too; they are spelled through their own owners, not cockpitCommand.
    const SCANNED = `${VERBS}|test-run|${commandGroups.map(group => `${group.name} [a-z][a-z-]*`).join('|')}`
    const runnable = new RegExp(`(?:npx --no |\\./node_modules/\\.bin/)cockpit (${SCANNED})(?![\\w-])`, 'g')
    const bare = new RegExp(`\\b(?:run|rerun|re-run)\\s+\`?cockpit (?:${SCANNED})(?![\\w-])`, 'gi')
    // A command ends at its closing quote or the prose around it.
    const commandEnd = /[`'";,)|\\]| then | to | and | or /
    // init takes no --config: it refuses without its root operand and --target, and a bare
    // `cockpit init <root>` is not on PATH for a dev-dependency install.
    const runnableInit = /(?:npx --no |\.\/node_modules\/\.bin\/)cockpit init(?![\w-])/g
    const bareInit = /(?<!npx --no |\.bin\/)\bcockpit init (?=[./<$])/g
    // npx reads a flag that directly follows the package name as its own, so `npx --no cockpit
    // --help` prints npm's help and `--version` npm's version.
    const npxOwnFlag = /npx --no cockpit --(?:help|version)\b/g

    // The guard refuses a command substitution, so a printed `VAR="$(…)" npx --no cockpit …` line is
    // one an agent can never run as printed; down and reset once printed their daemon that way. It
    // asks before any wrapped command, such as `env -u NAME …`, and Codex and OpenCode treat an ask
    // as a denial; runtime measure once printed its daemon that way.
    const unrunnablePrefix = (before: string): string | undefined => {
        const assignments = /(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*) +)*$/.exec(before)!
        if (/\$\(|`/.test(assignments[0])) return 'a substituted environment prefix'
        return /(?:^|[\s;&|(`'"])(?:env|timeout|nice|nohup|setsid|command|exec)(?: +(?:-\S+|[A-Z_][A-Z0-9_]*|[A-Za-z_]\w*=\S*|\d+[smhd]?))* +$/
            .test(before.slice(0, assignments.index)) ? 'a wrapper prefix' : undefined
    }

    it('spell every configured command from npx itself, with no wrapper or environment prefix', () => {
        for (const verb of VERBS.split('|') as ConfiguredCommand[]) {
            expect(cockpitCommand(verb, { config: '/synthetic/cockpit.toml' })).toMatch(new RegExp(`^npx --no cockpit ${verb} --config `))
        }
        for (const [before, reason] of [['env -u DOCKER_CONTEXT ', 'a wrapper prefix'], ['run `env FOO=1 ', 'a wrapper prefix'],
            ['nohup ', 'a wrapper prefix'], ['DOCKER_CONTEXT="$(docker context show)" ', 'a substituted environment prefix'],
            ['run ', undefined], ['DEBUG=1 ', undefined], ['set the env to X, then run ', undefined]] as const) {
            expect(unrunnablePrefix(before), before).toBe(reason)
        }
    })

    it('name the configuration everywhere a diagnostic, instruction or skill spells one, carry no substituted or wrapper prefix, and name the root and target for init', () => {
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
                    const prefixed = unrunnablePrefix(line.slice(0, match.index))
                    if (prefixed) unrunnable.push(`${at}: ${match[0]} behind ${prefixed}`)
                }
                for (const match of line.matchAll(bare)) unrunnable.push(`${at}: bare ${match[0]}`)
                for (const match of line.matchAll(runnableInit)) {
                    const rest = line.slice(match.index + match[0].length).replace(/"[^"]*"|'[^']*'/g, 'quoted')
                    // The one-time Compose scaffold is the other init mode: it names its app directory instead of a tool.
                    if (!/^ (?!--)\S+ (?:.* )?--(?:target|scaffold-compose) \S/.test(rest.split(commandEnd)[0]!)) {
                        unrunnable.push(`${at}: ${match[0]} without its root and --target`)
                    }
                }
                for (const match of line.matchAll(bareInit)) unrunnable.push(`${at}: bare ${match[0]}`)
                for (const match of line.matchAll(npxOwnFlag)) unrunnable.push(`${at}: ${match[0]} reaches npx, not cockpit`)
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
        const down = `npx --no cockpit down --config ${quoted}`
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
        // Answers the context reads down makes to pin the active daemon; any other Docker call fails.
        await writeFile(join(bin, 'docker'), '#!/bin/sh\ntest "$1 $2" = "context show" && echo stand-in && exit 0\n'
            + 'test "$1 $2" = "context inspect" && echo unix:///synthetic/docker.sock && exit 0\nexit 1\n')
        await chmod(join(bin, 'docker'), 0o755)
        const run = (command: string) => spawnSync('/bin/sh', ['-c', command], { cwd: resolve('.'), encoding: 'utf8',
            env: { ...env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } })

        const synced = run(sync)
        expect(synced.status, synced.stderr).toBe(0)
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
        // down, printed without a daemon prefix, gets past argument parsing and daemon selection to the cockpit's own answer.
        const downed = run(down)
        expect(downed.stderr).not.toContain('CLI_USAGE_INVALID')
        expect(downed.stderr).toContain('ENVIRONMENT_NOT_DECLARED')
    }, 120_000)

    // Shipped skills once printed `logs` without its required --service, work commands without
    // --config, and a bare `cockpit work intake` that exits 127 for a dev-dependency install. A text
    // rule cannot know each command's required options, so every printed command goes through the
    // real argument parser and decoder, stopping at a stub handler before any work happens.
    it('reach a command handler when copied from any shipped surface, rendered guide or hand-written document', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-printed-surface-')))
        roots.push(root)
        const example = join(root, 'example')
        cpSync(resolve('examples/compose-first'), example, { recursive: true })
        execFileSync('git', ['init', '--quiet', example])
        const synced = await syncGeneratedEnvironment({ configPath: join(example, 'cockpit.toml') })
        expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete', status: 0 })

        // Generated reference pages are rendered from the command table and owned by their generator.
        const generated = /^<!-- Generated by `npm run references`/m
        const documents = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard',
            'packages/cockpit/surfaces/skills', 'packages/cockpit/surfaces/references', 'packages/cockpit/surfaces/agents',
            'scripts/adopt-cockpit.skill.md', 'docs', 'examples', 'README.md', 'CONTRIBUTING.md'], { encoding: 'utf8' })
            .split('\0').filter(path => path.endsWith('.md'))
            .map(path => [path, readFileSync(path, 'utf8')] as const)
            .filter(([, text]) => !generated.test(text.split('\n').slice(0, 5).join('\n')))
        expect(documents.map(([path]) => path)).toEqual(expect.arrayContaining([
            'packages/cockpit/surfaces/skills/cockpit-fix.skill.md', 'packages/cockpit/surfaces/skills/procedures/setup.md',
            'packages/cockpit/surfaces/references/testing-tiers.md', 'docs/getting-started.md']))
        const sources = [...documents, ['examples/compose-first AGENTS.md as synced', await readFile(join(example, 'AGENTS.md'), 'utf8')] as const]

        const prefix = /(?:npx --no |\.\/node_modules\/\.bin\/)cockpit(?![\w-])/g
        const printed: { at: string; command: string }[] = []
        const bare: string[] = []
        const unrunnable: string[] = []
        for (const [path, raw] of sources) {
            const text = raw.replace(/<!-- cockpit:diagnostic-index:begin -->[\s\S]*?<!-- cockpit:diagnostic-index:end -->/g, '')
                .replace(/\{\{![\s\S]*?\}\}/g, '').replace(/<!--[\s\S]*?-->/g, '')
            const fenced: string[] = [], prose: string[] = []
            let inFence = false
            for (const line of text.split('\n')) {
                if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
                ;(inFence ? fenced : prose).push(line)
            }
            const collect = (snippet: string, kind: string) => {
                // A command ends where the shell would start the next one.
                for (const match of snippet.matchAll(prefix)) {
                    // A redirect is the shell's, not an argument: `> resolved.sh` would swallow the argv capture.
                    const command = snippet.slice(match.index).split(/\s(?:&&|\|\||\||;|#|>>?)\s|;\s/)[0]!.trim()
                    printed.push({ at: `${path} (${kind})`, command })
                    const prefixed = unrunnablePrefix(snippet.slice(0, match.index))
                    if (prefixed) unrunnable.push(`${path}: ${command} behind ${prefixed}`)
                }
            }
            for (const line of fenced.join('\n').replace(/\\\n/g, ' ').split('\n')) {
                collect(line, 'fenced')
                if (/^\s*(?:[A-Z_]+=\S+\s+)*cockpit\s/.test(line)) bare.push(`${path}: ${line.trim()}`)
            }
            for (const [, span] of prose.join('\n').matchAll(/`([^`]+)`/g)) {
                const snippet = span!.replace(/\s+/g, ' ')
                collect(snippet, 'inline')
                // Prose may name a command (`cockpit sync`); a surface an agent loads must spell it runnably.
                if (!path.startsWith('docs/') && !/^(?:README|CONTRIBUTING)\.md$/.test(path) && /^cockpit [a-z]/.test(snippet)) bare.push(`${path}: ${snippet}`)
            }
        }
        // These name the installed executable or the command line's shape, not a command to run.
        const shapes = new Set(['./node_modules/.bin/cockpit', './node_modules/.bin/cockpit <command>', './node_modules/.bin/cockpit <command> --help', 'npx --no cockpit <command>'])
        const commands = [...new Map(printed.filter(row => !shapes.has(row.command)).map(row => [row.command, row])).values()]
        expect(commands.length).toBeGreaterThan(60)
        for (const name of shapes) expect(printed.map(row => row.command)).toContain(name)

        // Placeholders become synthetic values of the kind the parser accepts; the rest stay generic.
        const placeholder: Readonly<Record<string, string>> = { kind: 'spec', target: 'codexcli', tool: 'codexcli', root: '.', command: 'true', 'agent command': 'true', port: '3000', 'cockpit root': '.' }
        const substitute = (command: string) => command.replace(/<([^<>]+)>/g, (_, name: string) => placeholder[name]
            ?? (/sha256$/i.test(name) ? 'a'.repeat(64) : `synthetic-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`))
        // The file a reader has written by the time they run the command: the init answers it reads.
        await writeFile(join(root, 'answers.toml'), '')
        const env = { PATH: process.env.PATH ?? '', HOME: root }
        const io = { confirmInit: async () => undefined, answerInitQuestion: async () => undefined, confirmReset: async () => false,
            confirmWorkOrder: async () => undefined, confirmSelftestExecutable: async () => undefined,
            confirmSelftestProbeSpecifications: async () => undefined, confirmStaleRemoval: async () => undefined }

        let reached = false
        const stop = () => { reached = true; throw new Error('stopped before work') }
        const stubs = Object.fromEntries([...new Set(cliCommands.map(command => command.handler)),
            'beginOperatorWorkApplication', 'beginOperatorReset', 'loadPolicy', 'scaffoldCompose'].map(name => [name, stop])) as CliHandlerOverrides
        // Relative paths in a printed command resolve against the reader's cockpit root.
        const cwd = process.cwd()
        process.chdir(root)
        try {
            for (const { at, command } of commands) {
                // The shell does the quoting and command substitution exactly as a reader's would.
                const words = spawnSync('/bin/sh', ['-c', `cockpit() { printf '%s\\0' "$@"; }\n${substitute(command).replace(prefix, 'cockpit')}`],
                    { cwd: root, encoding: 'utf8', env })
                if (words.status !== 0) { unrunnable.push(`${at}: ${command} -> shell: ${words.stderr.trim()}`); continue }
                const argv = words.stdout.split('\0').slice(0, -1)
                reached = false
                let output = ''
                const sink = { write: (chunk: string) => { output += chunk; return true } }
                const status = await runCli(argv, { stdout: sink, stderr: sink, ...io }, stubs, { env })
                if (!reached && !(argv.includes('--help') && status === 0)) unrunnable.push(`${at}: ${command} -> ${output.trim().split('\n')[0]}`)
            }
        } finally { process.chdir(cwd) }
        expect({ bare, unrunnable }).toEqual({ bare: [], unrunnable: [] })
    }, 120_000)
})
