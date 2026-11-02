import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveDockerExecutable } from './environment/executable.js'
import { inventory } from '../test-support/example-inventory.js'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const launcher = join(repositoryRoot, 'packages/cockpit/bin/cockpit.mjs')
const scratch = mkdtempSync(join(tmpdir(), 'cockpit-example-'))

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function copyExample(name: string) {
    const root = join(scratch, name)
    cpSync(join(repositoryRoot, 'examples/synthetic'), root, { recursive: true })
    mkdirSync(join(root, 'repositories/app'), { recursive: true })
    mkdirSync(join(root, 'repositories/web'), { recursive: true })
    execFileSync('git', ['init', '--quiet', '--bare', join(root, 'repositories/synthetic-web.git')])
    mkdirSync(join(root, 'fixtures'), { recursive: true })
    writeFileSync(join(root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
    writeFileSync(join(root, 'repositories/app/.gitignore'), '.env\n')
    writeFileSync(join(root, 'repositories/app/package.json'), '{"name":"synthetic-app","version":"0.0.0","scripts":{"build":"node --check probe.mjs","test":"node --check probe.mjs"}}\n')
    writeFileSync(join(root, 'repositories/app/package-lock.json'), '{"name":"synthetic-app","version":"0.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"synthetic-app","version":"0.0.0"}}}\n')
    writeFileSync(join(root, 'repositories/app/probe.mjs'), 'process.exitCode = 0\n')
    for (const directory of [root, join(root, 'repositories/app'), join(root, 'repositories/web')]) {
        execFileSync('git', ['init', '--quiet', directory])
    }
    execFileSync('git', ['-C', join(root, 'repositories/web'), 'remote', 'add', 'origin', 'synthetic-web.git'])
    execFileSync('git', ['-C', join(root, 'repositories/app'), 'add', '.gitignore', 'package.json', 'package-lock.json', 'probe.mjs'])
    execFileSync('git', ['-C', join(root, 'repositories/app'), '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'synthetic fixture'])
    return root
}

// Everything an agent session can load from a synced cockpit: the shared guides and every
// generated skill, agent and settings directory.
function loadableFiles(root: string): Map<string, string> {
    const files = new Map<string, string>()
    const visit = (relative: string) => {
        for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
            const path = join(relative, entry.name)
            if (entry.isDirectory()) visit(path)
            else if (entry.isFile()) files.set(path, readFileSync(join(root, path), 'utf8'))
        }
    }
    for (const directory of ['.claude', '.agents', '.opencode', '.codex']) if (existsSync(join(root, directory))) visit(directory)
    for (const guide of ['AGENTS.md', 'CLAUDE.md']) files.set(guide, readFileSync(join(root, guide), 'utf8'))
    return files
}

// Cockpit's own maintenance markers must never reach a consumer: they cost context in every
// session and describe cockpit's docs, not the consumer's product.
function expectNoDevelopmentMarkers(root: string) {
    for (const [path, text] of loadableFiles(root)) {
        expect(text, path).not.toMatch(/cockpit:verified|SHIPPED SURFACE/)
    }
}

function stackCommands(text: string) {
    return text.match(/cockpit (?:up|down|session|doctor|preflight)\b/g) ?? []
}

function run(root: string, argv: string[]) {
    const environment = join(scratch, '.environment', basename(root))
    mkdirSync(join(environment, 'home'), { recursive: true, mode: 0o700 })
    mkdirSync(join(environment, 'state'), { recursive: true, mode: 0o700 })
    const result = spawnSync(process.execPath, [launcher, ...argv.slice(1)], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', HOME: join(environment, 'home'), CODEX_HOME: undefined, XDG_STATE_HOME: join(environment, 'state') },
    })
    return { ...result, response: result.stdout ? JSON.parse(result.stdout) : undefined }
}

describe('the public synthetic cockpit', () => {
    it('executes every classified non-destructive command in the synthetic example README', () => {
        const root = copyExample('complete')
        const readme = readFileSync(join(root, 'README.md'), 'utf8')
        const { executable, humanOnly } = inventory(readme)

        expect(executable.map(argv => argv.slice(0, 2))).toEqual([
            ['./node_modules/.bin/cockpit', 'sync'], ['./node_modules/.bin/cockpit', 'sync'],
            ['./node_modules/.bin/cockpit', 'setup'], ['./node_modules/.bin/cockpit', 'check'],
        ])
        expect(humanOnly.map(argv => argv.slice(0, 2))).toEqual([
            ['npm', 'init'], ['npm', 'install'],
            ['mkdir', '-p'], ['printf', '\'[{"id":"synthetic"}]\\n\''],
            ['printf', '\'.env\\n\''],
            ['printf', '\'%s\\n\''], ['printf', '\'%s\\n\''], ['printf', '\'process.exitCode'],
            ['git', 'init'], ['git', 'init'], ['git', 'init'], ['git', 'init'],
            ['git', '-C'],
            ['git', '-C'], ['git', '-C'],
            ['git', '-C'], ['git', '-C'],
        ])
        for (const argv of executable) {
            if (argv[1] === 'setup') {
                const app = join(root, 'repositories/app')
                execFileSync('git', ['-C', app, 'add', '.env.example'])
                execFileSync('git', ['-C', app, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
                    'commit', '--quiet', '-m', 'generated synthetic template'])
                // sync needs the web checkout to exist, but a fresh machine has none: setup must clone it
                // from the relative remote and accept the absolute origin Git records for it.
                rmSync(join(root, 'repositories/web'), { recursive: true })
            }
            const result = run(root, argv)
            expect(result.status, `${argv.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0)
            expect(result.stderr).toBe('')
            expect(result.response.invocation.exitCode).toBe(0)
        }
        const rerun = run(root, ['cockpit', 'setup', '--config', 'cockpit.toml', '--json'])
        expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0)
        expect(rerun.response.result.siblings.map((row: { changed: boolean }) => row.changed)).toEqual([false, false])
        expect(existsSync(join(root, 'repositories/web/.git'))).toBe(true)
        expect(existsSync(join(root, '.cockpit/generated-environment-ownership.json'))).toBe(true)
        expect(existsSync(join(root, 'compose.generated.yml'))).toBe(true)
        expect(existsSync(join(root, 'repositories/app/.env'))).toBe(true)
        expect(existsSync(join(root, 'app/.env.example'))).toBe(false)
    })

    it('fails for a missing sibling and stale generated output', () => {
        const missing = copyExample('missing-sibling')
        expect(run(missing, ['cockpit', 'sync', '--config', 'cockpit.toml', '--json']).status).toBe(0)
        execFileSync('git', ['-C', join(missing, 'repositories/app'), 'add', '.env.example'])
        execFileSync('git', ['-C', join(missing, 'repositories/app'), '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
            'commit', '--quiet', '-m', 'generated synthetic template'])
        rmSync(join(missing, 'repositories/web'), { recursive: true })
        rmSync(join(missing, 'repositories/synthetic-web.git'), { recursive: true })
        const missingResult = run(missing, ['cockpit', 'setup', '--config', 'cockpit.toml', '--json'])
        expect(missingResult.status).toBe(2)
        const missingCodes = missingResult.response.diagnostics.map((row: { code: string }) => row.code)
        expect(missingCodes, JSON.stringify(missingCodes)).toContain('SETUP_CLONE_FAILED')
        const cloneFailure = missingResult.response.diagnostics.find((row: { code: string }) => row.code === 'SETUP_CLONE_FAILED')
        expect(cloneFailure.message).toContain('synthetic-web.git')

        const stale = copyExample('stale')
        expect(run(stale, ['cockpit', 'sync', '--config', 'cockpit.toml', '--json']).status).toBe(0)
        const generated = join(stale, '.agents/skills/cockpit-setup/SKILL.md')
        expect(existsSync(generated)).toBe(true)
        writeFileSync(generated, `${readFileSync(generated, 'utf8')}\nstale\n`)
        const staleResult = run(stale, ['cockpit', 'check', '--config', 'cockpit.toml', '--json'])
        expect(staleResult.status).toBe(2)
        expect(staleResult.response.diagnostics.map((row: { code: string }) => row.code)).toContain('SURFACE_STATE_CONFLICT')
    })

    it('renders a valid Compose file from the minimal example and reports its undecided subjects', () => {
        const root = join(scratch, 'minimal')
        cpSync(join(repositoryRoot, 'examples/minimal'), root, { recursive: true })
        execFileSync('git', ['init', '--quiet', root])
        const { executable } = inventory(readFileSync(join(root, 'README.md'), 'utf8'))
        expect(executable.map(argv => argv.slice(1, 2))).toEqual([['sync'], ['sync'], ['check']])
        const results = executable.map(argv => {
            const result = run(root, argv)
            expect(result.status, `${argv.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0)
            return result
        })
        expect(results[0]!.response.result.changes).toContainEqual({ operation: 'write', path: 'compose.generated.yml' })
        const compose = readFileSync(join(root, 'compose.generated.yml'), 'utf8')
        expect(compose).toContain('    build:\n      context: api\n')
        const native = spawnSync('docker', ['compose', '-f', join(root, 'compose.generated.yml'), 'config', '-q'], {
            cwd: root, encoding: 'utf8', env: { ...process.env, COCKPIT_OWNER_ID: 'synthetic-owner', COCKPIT_STACK_ID: 'synthetic-stack' },
        })
        if (native.error) {
            expect({ kind: 'unavailable', reason: (native.error as NodeJS.ErrnoException).code ?? 'native Compose did not return' }).toMatchObject({ kind: 'unavailable' })
        } else expect(native.status, native.stderr).toBe(0)
        expect(readFileSync(join(root, 'docs/cockpit/environment-decisions.md'), 'utf8')).toContain('## service:api\n\n- Status: **undecided**')
        const check = results[2]!.response
        expect(check.result.currentness.decisions).toEqual({
            path: 'docs/cockpit/environment-decisions.md', undecided: 2, subjects: ['port:api:http', 'service:api'],
        })
        expect(check.diagnostics).toContainEqual(expect.objectContaining({ severity: 'info', code: 'GENERATED_DECISIONS_UNDECIDED' }))
    })

    it('validates the browser variant of the minimal example up to the port lease that up creates', () => {
        const root = join(scratch, 'minimal-browser')
        cpSync(join(repositoryRoot, 'examples/minimal'), root, { recursive: true })
        execFileSync('git', ['init', '--quiet', root])
        // Every declared digest, pin and runner field is checked before the lease, so the only
        // refusal left for a correct example is the one its README answers by running up first.
        const result = run(root, ['cockpit', 'sync', '--config', 'cockpit.browser.toml', '--json'])
        expect(result.status, result.stdout).toBe(2)
        expect(result.response.diagnostics.filter((row: { severity: string }) => row.severity === 'error'))
            .toEqual([expect.objectContaining({ code: 'GENERATED_INPUT_INVALID', target: 'browser' })])
        expect(result.response.guidance).toContainEqual({ code: 'GENERATED_INPUT_INVALID', target: 'browser',
            text: `run npx --no cockpit up --config ${join(realpathSync(root), 'cockpit.browser.toml')}, which leases the ports and publishes the runner; sync works while that lease is held` })
    })

    it('opens the generated guide with what the cockpit is, how to work in it and the rules with their reasons', () => {
        const root = join(scratch, 'minimal-guide')
        cpSync(join(repositoryRoot, 'examples/minimal'), root, { recursive: true })
        execFileSync('git', ['init', '--quiet', root])
        const sync = run(root, ['cockpit', 'sync', '--config', 'cockpit.toml', '--json'])
        expect(sync.status, `${sync.stdout}\n${sync.stderr}`).toBe(0)
        const guide = readFileSync(join(root, 'AGENTS.md'), 'utf8')
        expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md')
        const headings = [...guide.matchAll(/^# (.+)$/gm)].map(match => match[1])
        expect(headings).toEqual(['What this is', 'How to work here', 'Rules and why', 'Skills', 'Testing tiers'])
        // Facts come from cockpit.toml: the cockpit name and each sibling's directory, purpose and acquire mode.
        expect(guide).toContain('`tinya` cockpit')
        expect(guide).toContain('| `api` | Tiny api | none: already on disk |')
        expect(guide).toContain('npx --no cockpit session --config cockpit.toml -- <command>')
        expect(guide).toContain('npx --no cockpit sync --config cockpit.toml --dry-run')
        // The minimal example declares no [testing], so agents are told no gate exists rather than to run one.
        expect(guide).toContain('This cockpit declares no product test gate, so no change can be graded PASS.')
        expect(guide).not.toContain('npx --no cockpit test-run')
        expect(guide).toContain('database hosts: not declared')
        expect(guide).toMatch(/A local mistake is cheap; a production one is not/)
        // Sync refuses a hand edit rather than replacing it, so the guide must not promise an overwrite.
        expect(guide).toContain('sync refuses to overwrite it; to recover, undo the edit')
        for (const skill of ['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work']) expect(guide).toMatch(new RegExp(`- \`${skill}\`: Use when `))
        expect(guide.split('\n').length).toBeLessThanOrEqual(60)
        expectNoDevelopmentMarkers(root)
    })
})

// Docker is not a prerequisite of this suite, and hosted macOS runners have none. Where no docker
// executable is on PATH, check must refuse a Compose-first cockpit rather than pass it unread; any
// other Compose failure still fails these tests.
const DOCKER_ABSENT = 'Executable was not found in the supplied search path: docker'
const docker = await resolveDockerExecutable(process.env)
const dockerAbsent = docker.state !== 'available' && docker.reason === DOCKER_ABSENT

describe('cockpits without a generated environment', () => {
    function readsTopology(check: ReturnType<typeof run>): boolean {
        if (!dockerAbsent) return true
        expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(2)
        expect(check.response.diagnostics.filter((row: { severity: string }) => row.severity === 'error')).toEqual([
            expect.objectContaining({ code: 'COMPOSE_TOPOLOGY_UNAVAILABLE', message: expect.stringContaining(DOCKER_ABSENT) })])
        return false
    }

    function copyPlainExample(example: string, name: string) {
        const root = join(scratch, name)
        cpSync(join(repositoryRoot, 'examples', example), root, { recursive: true })
        execFileSync('git', ['init', '--quiet', root])
        return root
    }

    function syncedComposeFirst(name: string) {
        const root = copyPlainExample('compose-first', name)
        const sync = run(root, ['cockpit', 'sync', '--config', 'cockpit.toml', '--json'])
        expect(sync.status, `${sync.stdout}\n${sync.stderr}`).toBe(0)
        return root
    }

    it('publishes and checks only the surfaces of a docs-only cockpit and refuses to run it', () => {
        const root = copyPlainExample('docs-only', 'docs-only')
        const { executable } = inventory(readFileSync(join(root, 'README.md'), 'utf8'))
        expect(executable.map(argv => argv[1])).toEqual(['sync', 'check', 'up'])
        const [sync, check, up] = executable.map(argv => run(root, argv))
        for (const result of [sync!, check!]) {
            expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
            expect(result.stderr).toBe('')
        }
        expect(existsSync(join(root, '.claude/skills/cockpit-setup/SKILL.md'))).toBe(true)
        expect(existsSync(join(root, '.claude/skills/cockpit-work/SKILL.md'))).toBe(true)
        for (const reference of ['test-data-and-personas.md']) {
            expect(readFileSync(join(root, '.claude/skills/cockpit-setup/references', reference), 'utf8')).not.toContain('cockpit:verified')
        }
        expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
        expect(existsSync(join(root, 'env'))).toBe(false)
        const guide = readFileSync(join(root, 'AGENTS.md'), 'utf8')
        expect(guide).toContain('`handbook` cockpit')
        expect(guide).toContain('| `docs` | Design notes and decision records |')
        expect(stackCommands(guide)).toEqual([])
        expectNoDevelopmentMarkers(root)
        expect(sync!.response.result.changes.map((change: { path: string }) => change.path)).not.toContain('compose.generated.yml')
        expect(up!.status).toBe(2)
        expect(up!.response.diagnostics).toEqual([expect.objectContaining({ code: 'ENVIRONMENT_NOT_DECLARED' })])
        const doctor = run(root, ['cockpit', 'doctor', '--config', 'cockpit.toml', '--json'])
        // A docs-only cockpit still depends on its Git working tree, and this copy has no commit yet.
        expect(doctor.response.result.verdict).toBe('fail')
        // The surfaces publish a Codex hook that no person has trusted in this fresh home, and the
        // copied example has no cockpit installed in it.
        expect(doctor.response.diagnostics).toEqual([expect.objectContaining({ code: 'ENVIRONMENT_NOT_DECLARED' }),
            expect.objectContaining({ code: 'GIT_STATE_UNHEALTHY', message: expect.stringContaining('no commits yet') }),
            expect.objectContaining({ code: 'CODEX_HOOK_UNTRUSTED', severity: 'warning' }),
            expect.objectContaining({ code: 'COCKPIT_NOT_INSTALLED', severity: 'warning' })])
        expect(doctor.response.result.readiness.gaps.map((gap: { id: string }) => gap.id))
            .toEqual(['cockpit-committed', 'cockpit-installed', 'codex-hook-trusted'])
        expect(doctor.response.result.declarations).toContainEqual(expect.objectContaining({ subject: 'runtime', state: 'not-declared' }))
    })

    it('owns the surfaces of a compose-first cockpit, leaves its Compose file alone and passes check', () => {
        const root = copyPlainExample('compose-first', 'compose-first')
        const compose = readFileSync(join(root, 'compose.yml'), 'utf8')
        const { executable } = inventory(readFileSync(join(root, 'README.md'), 'utf8'))
        expect(executable.map(argv => argv[1])).toEqual(['sync', 'check'])
        const [sync, check] = executable.map(argv => run(root, argv))
        expect(sync!.status, `${sync!.stdout}\n${sync!.stderr}`).toBe(0)
        if (readsTopology(check!)) {
            expect(check!.status, `${check!.stdout}\n${check!.stderr}`).toBe(0)
            expect(check!.response.diagnostics.filter((row: { code: string }) => row.code.startsWith('COMPOSE_'))).toEqual([])
        }
        const ownership = JSON.parse(readFileSync(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8'))
        const owned = ownership.entries.map((entry: { path: string }) => entry.path)
        expect(owned).toContain('.claude/skills/cockpit-setup/SKILL.md')
        expect(owned).toContain('.claude/skills/cockpit-setup/references/test-data-and-personas.md')
        expect(owned).toContain('.cockpit/guards/bash-guard.sh')
        // Beside the surfaces, cockpit owns only the override that labels the Compose services.
        expect(owned.filter((path: string) => !path.startsWith('.') && !/^(?:AGENTS|CLAUDE)\.md$|^opencode\.jsonc$/.test(path))).toEqual(['compose.cockpit.yml'])
        const override = readFileSync(join(root, 'compose.cockpit.yml'), 'utf8')
        expect(override).toContain('  api:\n    labels:\n      dev.b0dea.cockpit.config-sha256:')
        expect(override).toContain('  web:\n    labels:\n      dev.b0dea.cockpit.config-sha256:')
        expect(readFileSync(join(root, 'compose.yml'), 'utf8')).toBe(compose)
        // cockpit does not rewrite published interfaces, so the example itself binds loopback.
        expect([...compose.matchAll(/^ {4}ports: \["([^"]+)"\]$/gm)].map(match => match[1]))
            .toEqual(['127.0.0.1:${API_HOST_PORT:-4200}:3000', '127.0.0.1:${WEB_HOST_PORT:-4300}:3000'])
    })

    it('preserves build-beside extensions when sync upgrades producer ownership', () => {
        const root = copyPlainExample('extended', 'extended')
        const owned = ['Makefile', 'scripts/verify.mjs', 'compose.yml', 'api/server.mjs'].map(path => [path, readFileSync(join(root, path), 'utf8')] as const)
        const first = run(root, ['cockpit', 'sync', '--config', 'cockpit.toml', '--json'])
        expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0)
        const ownershipPath = join(root, '.cockpit/generated-environment-ownership.json')
        const prior = JSON.parse(readFileSync(ownershipPath, 'utf8'))
        delete prior.integrity
        prior.producer.version = '0.0.0-prior'
        writeFileSync(ownershipPath, `${JSON.stringify({ ...prior, integrity: createHash('sha256').update(JSON.stringify(prior)).digest('hex') }, null, 2)}\n`)
        const upgraded = run(root, ['cockpit', 'sync', '--config', 'cockpit.toml', '--json'])
        expect(upgraded.status, `${upgraded.stdout}\n${upgraded.stderr}`).toBe(0)
        for (const [path, bytes] of owned) expect(readFileSync(join(root, path), 'utf8')).toBe(bytes)
        const manifest = JSON.parse(readFileSync(ownershipPath, 'utf8'))
        for (const [path] of owned) expect(manifest.entries.map((entry: { path: string }) => entry.path)).not.toContain(path)
        expect(existsSync(join(root, '.agents/skills/verify-workflow/SKILL.md'))).toBe(true)
        expect(existsSync(join(root, '.codex/hooks.json'))).toBe(true)
        expect(spawnSync('make', ['verify'], { cwd: root }).status).toBe(0)
    })

    it('fails check on a published host port that no ports.bases variable leases', () => {
        const root = syncedComposeFirst('compose-first-port')
        const path = join(root, 'compose.yml')
        writeFileSync(path, readFileSync(path, 'utf8').replace('"127.0.0.1:${WEB_HOST_PORT:-4300}:3000"', '"127.0.0.1:4300:3000"'))
        const check = run(root, ['cockpit', 'check', '--config', 'cockpit.toml', '--json'])
        if (!readsTopology(check)) return
        expect(check.status).toBe(2)
        expect(check.response.diagnostics).toContainEqual(expect.objectContaining({
            severity: 'error', code: 'COMPOSE_PORT_NOT_LEASED', target: 'compose:web:3000' }))
    })

    it('warns in check on a published port with no host interface and stays quiet for a loopback one', () => {
        const root = syncedComposeFirst('compose-first-interface')
        const path = join(root, 'compose.yml')
        const loopback = readFileSync(path, 'utf8')
        const quiet = run(root, ['cockpit', 'check', '--config', 'cockpit.toml', '--json'])
        if (!readsTopology(quiet)) return
        expect(quiet.response.diagnostics.map((row: { code: string }) => row.code)).not.toContain('COMPOSE_PORT_ALL_INTERFACES')
        writeFileSync(path, loopback.replace('"127.0.0.1:${WEB_HOST_PORT:-4300}:3000"', '"${WEB_HOST_PORT:-4300}:3000"'))
        const open = run(root, ['cockpit', 'check', '--config', 'cockpit.toml', '--json'])
        expect(open.response.diagnostics).toContainEqual(expect.objectContaining({
            severity: 'warning', code: 'COMPOSE_PORT_ALL_INTERFACES', target: 'compose:web:3000' }))
        writeFileSync(path, loopback.replace('"127.0.0.1:${WEB_HOST_PORT:-4300}:3000"', '{ target: 3000, published: "${WEB_HOST_PORT:-4300}", host_ip: "127.0.0.1" }'))
        const longForm = run(root, ['cockpit', 'check', '--config', 'cockpit.toml', '--json'])
        expect(longForm.response.diagnostics.map((row: { code: string }) => row.code)).not.toContain('COMPOSE_PORT_ALL_INTERFACES')
    })

    it('fails check on a mount = "always" sibling that no Compose service bind-mounts', () => {
        const root = copyPlainExample('compose-first', 'compose-first-mount')
        mkdirSync(join(root, 'worker'))
        const config = join(root, 'cockpit.toml')
        writeFileSync(config, readFileSync(config, 'utf8').replace('# The bases are', [
            '[[sibling]]', 'slug = "worker"', 'dir = "worker"', 'mount = "always"', 'acquire = "none"',
            'var = "WORKER_DIR"', 'purpose = "Background worker"', '', '# The bases are'].join('\n')))
        const checked = () => {
            const sync = run(root, ['cockpit', 'sync', '--config', 'cockpit.toml', '--json'])
            expect(sync.status, `${sync.stdout}\n${sync.stderr}`).toBe(0)
            return run(root, ['cockpit', 'check', '--config', 'cockpit.toml', '--json'])
        }

        const unmounted = checked()
        if (!readsTopology(unmounted)) return
        expect(unmounted.status).toBe(2)
        expect(unmounted.response.diagnostics).toContainEqual(expect.objectContaining({
            severity: 'error', code: 'COMPOSE_SIBLING_NOT_MOUNTED', target: 'sibling:worker' }))
        expect(unmounted.response.guidance).toContainEqual({ code: 'COMPOSE_SIBLING_NOT_MOUNTED', target: 'sibling:worker',
            text: expect.stringMatching(/bind-mount it .*\$\{WORKER_DIR\}.*set mount = "none" on sibling worker/) })
        expect(unmounted.response.diagnostics.filter((row: { code: string }) => row.code === 'COMPOSE_SIBLING_NOT_MOUNTED')).toHaveLength(1)

        // Compose reports a variable source uninterpolated; the sibling's own variable is its mount.
        const compose = join(root, 'compose.yml')
        writeFileSync(compose, readFileSync(compose, 'utf8').replace('volumes: ["./web:/app"]', 'volumes: ["./web:/app", "${WORKER_DIR}:/worker"]'))
        const mounted = checked()
        expect(mounted.status, `${mounted.stdout}\n${mounted.stderr}`).toBe(0)
    })

    // A product repository's own Compose file names its paths relative to itself. Resolved against
    // the cockpit root instead, `./` bound the root and `build: .` built it, so check refused the
    // binds and up would have started the wrong tree.
    it('resolves a sibling Compose file\'s relative paths against its own directory, as Compose does', () => {
        const root = copyPlainExample('compose-first', 'compose-first-sibling-file')
        rmSync(join(root, 'compose.yml'))
        writeFileSync(join(root, 'api/compose.yml'), [
            'services:',
            '  api:',
            '    build: .',
            '    ports: ["127.0.0.1:${API_HOST_PORT:-4200}:3000"]',
            '    volumes:',
            '      - ".:/app"',
            '      - "../web:/web"',
            // Compose prefixes an uninterpolated variable source with the project directory.
            '      - type: bind',
            '        source: "${WEB_DIR:?run through cockpit}"',
            '        target: /web-again',
            '    healthcheck:',
            '      test: ["CMD", "true"]',
            '',
        ].join('\n'))
        const config = join(root, 'cockpit.toml')
        writeFileSync(config, readFileSync(config, 'utf8')
            .replace('compose_files = ["compose.yml"]', 'compose_files = ["api/compose.yml"]')
            .replace('WEB_HOST_PORT = 4300\n', ''))
        const sync = run(root, ['cockpit', 'sync', '--config', 'cockpit.toml', '--json'])
        expect(sync.status, `${sync.stdout}\n${sync.stderr}`).toBe(0)
        const check = run(root, ['cockpit', 'check', '--config', 'cockpit.toml', '--json'])
        if (!readsTopology(check)) return
        expect(check.response.diagnostics.filter((row: { code: string }) => row.code.startsWith('COMPOSE_'))).toEqual([])
        expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0)
    })

    it('warns, without failing check, that a service with no healthcheck is ready once running', () => {
        const root = syncedComposeFirst('compose-first-health')
        const path = join(root, 'compose.yml')
        const [api, web] = readFileSync(path, 'utf8').split('  web:\n')
        writeFileSync(path, `${api}  web:\n${web!.slice(0, web!.indexOf('    healthcheck:'))}`)
        const check = run(root, ['cockpit', 'check', '--config', 'cockpit.toml', '--json'])
        if (!readsTopology(check)) return
        expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0)
        expect(check.response.diagnostics).toContainEqual(expect.objectContaining({
            severity: 'warning', code: 'COMPOSE_HEALTHCHECK_MISSING', target: 'compose:web' }))
    })
})
