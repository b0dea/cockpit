import { execFileSync } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { loadCockpitConfig } from '../config/load.js'
import { inspectServedSiblings, runPull, runUse } from './application/siblings.js'
import { createGitRunner, loadServedSiblings } from './sibling-checkouts.js'
import { forgetStackInputs, recordStackInputs, staleStackDiagnostics } from './stack-inputs.js'

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const env = { PATH: process.env.PATH, HOME: tmpdir() }
const deps = { execute: executeProbe }

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', '-c', 'init.defaultBranch=main',
        '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1' } }).trim()
}

async function commit(cwd: string, file: string, text: string, message: string) {
    await mkdir(join(cwd, file, '..'), { recursive: true })
    await writeFile(join(cwd, file), text)
    git(cwd, 'add', file)
    git(cwd, 'commit', '--quiet', '-m', message)
}

const sibling = (slug: string, extra: readonly string[] = []) => ['[[sibling]]', `slug = "${slug}"`, `dir = "${slug}"`, 'mount = "always"',
    'acquire = "none"', `var = "${slug.toUpperCase()}_DIR"`, `purpose = "Synthetic ${slug}"`, ...extra, '']

// A dedicated cockpit beside its sibling checkouts, each pushed to a bare repository of its own.
async function estate(siblings: readonly (readonly [string, readonly string[]])[] = [['app', []]], environment: readonly string[] = []) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-served-')))
    roots.push(root)
    const cockpit = join(root, 'cockpit')
    await mkdir(join(cockpit, '.cockpit'), { recursive: true })
    const configPath = join(cockpit, 'cockpit.toml')
    await writeFile(configPath, ['[cockpit]', 'name = "served-siblings"', 'siblings_root = ".."', '',
        ...siblings.flatMap(([slug, extra]) => sibling(slug, extra)),
        '[ports.bases]', 'APP_HOST_PORT = 4100', '', '[environment]', 'compose_files = ["compose.yml"]', ...environment, ''].join('\n'))
    for (const [slug] of siblings) {
        git(root, 'init', '--quiet', '--bare', `${slug}.git`)
        git(root, 'init', '--quiet', slug)
        await commit(join(root, slug), 'README.md', `${slug}\n`, 'Start')
        git(join(root, slug), 'remote', 'add', 'origin', join(root, `${slug}.git`))
        git(join(root, slug), 'push', '--quiet', '-u', 'origin', 'main')
    }
    return { root, cockpit, configPath }
}

async function exists(path: string): Promise<boolean> {
    return access(path).then(() => true, () => false)
}

async function servedBy(cockpit: string, configPath: string) {
    const loaded = await loadCockpitConfig(configPath)
    if (loaded.kind !== 'complete') throw new Error('fixture configuration is invalid')
    const served = await loadServedSiblings(cockpit, loaded.result.config)
    if (served.kind !== 'complete') throw new Error(served.diagnostic.message)
    return { config: loaded.result.config, siblings: served.siblings }
}

describe('serving a sibling from another checkout', () => {
    it('serves a sibling from its worktree, reports what the worktree lacks without copying it, and clears back', async () => {
        const { root, cockpit, configPath } = await estate([['app', ['environment_files = [{ template = ".env.example", instance = ".env" }]']]])
        const app = join(root, 'app')
        await commit(app, '.env.example', 'PORT=\n', 'Template')
        await writeFile(join(app, '.env'), 'PORT=3000\n')
        const worktree = join(app, '.worktrees', 'feature')
        git(app, 'worktree', 'add', '--quiet', '-b', 'feature', worktree)

        const used = await runUse({ configPath, slug: 'app', checkout: worktree, clear: false, env }, deps)
        expect(used, JSON.stringify(used)).toMatchObject({ status: 0, result: { slug: 'app', declared: app, served: worktree, evidence: 'object-store' },
            diagnostics: [{ code: 'SIBLING_ENVIRONMENT_FILE_MISSING', target: join(worktree, '.env') }] })
        expect(await exists(join(worktree, '.env'))).toBe(false)
        expect([...(await servedBy(cockpit, configPath)).siblings.values()]).toEqual([{ slug: 'app', declared: app, served: worktree, overridden: true }])
        expect((await inspectServedSiblings({ configPath, env }, deps)).map(({ code, severity }) => [code, severity])).toEqual([
            ['SIBLING_CHECKOUT_OVERRIDDEN', 'info'], ['SIBLING_ENVIRONMENT_FILE_MISSING', 'warning']])

        const cleared = await runUse({ configPath, slug: 'app', clear: true, env }, deps)
        expect(cleared).toMatchObject({ status: 0, result: { served: app, overridden: false, previous: worktree } })
        expect(await inspectServedSiblings({ configPath, env }, deps)).toEqual([])

        // A sibling removed from cockpit.toml after use can still be forgotten.
        await runUse({ configPath, slug: 'app', checkout: worktree, clear: false, env }, deps)
        await writeFile(configPath, (await readFile(configPath, 'utf8')).replaceAll('"app"', '"web"').replace('APP_DIR', 'WEB_DIR'))
        expect((await inspectServedSiblings({ configPath, env }, deps)).map(({ code }) => code)).toEqual(['SIBLING_CHECKOUT_UNKNOWN'])
        expect(await runUse({ configPath, slug: 'app', clear: true, env }, deps)).toMatchObject({ status: 0, result: { previous: worktree } })
        expect(await inspectServedSiblings({ configPath, env }, deps)).toEqual([])
    })

    it('grants the agent tools a worktree outside the declared checkout through machine-local settings, and takes back only what it added', async () => {
        const { root, cockpit, configPath } = await estate()
        const app = join(root, 'app')
        const worktree = join(root, 'app-feature')
        git(app, 'worktree', 'add', '--quiet', '-b', 'feature', worktree)
        const settingsPath = join(cockpit, '.claude/settings.local.json')
        const grantPath = join(cockpit, '.cockpit/local/opencode-grant-app')
        await mkdir(join(cockpit, '.claude'))
        // Claude Code drops a settings file it cannot load, so one cockpit cannot read is left alone and nothing is recorded.
        await writeFile(settingsPath, '{"permissions": ')
        expect(await runUse({ configPath, slug: 'app', checkout: worktree, clear: false, env }, deps)).toMatchObject({ status: 2,
            diagnostics: [{ code: 'SIBLING_CHECKOUT_RECORD_INVALID', target: '.claude/settings.local.json' }] })
        expect(await exists(join(cockpit, '.cockpit/local/sibling-checkouts'))).toBe(false)

        const person = { model: 'synthetic', permissions: { allow: ['Bash(ls)'], additionalDirectories: ['/synthetic/own'] } }
        const personBytes = `${JSON.stringify(person)}\n`
        await writeFile(settingsPath, personBytes)
        const used = await runUse({ configPath, slug: 'app', checkout: worktree, clear: false, env }, deps)
        expect(used, JSON.stringify(used)).toMatchObject({ status: 0, result: { served: worktree, insideDeclared: false,
            agentGrants: { granted: ['claudecode', 'opencode'], ungranted: ['codexcli'] } } })
        expect(used.artifact).toContain(`start Codex with --add-dir ${worktree}`)
        expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ ...person,
            permissions: { ...person.permissions, additionalDirectories: ['/synthetic/own', worktree] } })
        expect(await readFile(grantPath, 'utf8')).toBe(worktree)

        expect(await runUse({ configPath, slug: 'app', clear: true, env }, deps)).toMatchObject({ status: 0 })
        expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(person)
        expect(await readFile(grantPath, 'utf8')).toBe(app)

        // A file cockpit created for its grant alone is removed with it.
        await rm(settingsPath)
        await runUse({ configPath, slug: 'app', checkout: worktree, clear: false, env }, deps)
        expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ permissions: { additionalDirectories: [worktree] } })
        await runUse({ configPath, slug: 'app', clear: true, env }, deps)
        expect(await exists(settingsPath)).toBe(false)
    })

    it('refuses a declared checkout it cannot resolve rather than guessing its path', async () => {
        const { root, configPath } = await estate()
        await rm(join(root, 'app'), { recursive: true, force: true })
        await symlink(join(root, 'app'), join(root, 'app'))
        expect(await runUse({ configPath, slug: 'app', clear: true, env }, deps)).toMatchObject({ status: 2,
            diagnostics: [{ code: 'EVIDENCE_UNAVAILABLE', target: join(root, 'app'), message: expect.stringContaining('could not be resolved') }] })
    })

    it('refuses a checkout of another repository or part of a checkout, and accepts a clone with the same origin', async () => {
        const { root, cockpit, configPath } = await estate()
        const app = join(root, 'app')
        git(root, 'init', '--quiet', 'unrelated')
        await commit(join(root, 'unrelated'), 'README.md', 'other\n', 'Start')
        const foreign = await runUse({ configPath, slug: 'app', checkout: join(root, 'unrelated'), clear: false, env }, deps)
        expect(foreign).toMatchObject({ status: 2, diagnostics: [{ code: 'SIBLING_CHECKOUT_FOREIGN' }] })
        await mkdir(join(app, 'src'))
        const inside = await runUse({ configPath, slug: 'app', checkout: join(app, 'src'), clear: false, env }, deps)
        expect(inside).toMatchObject({ status: 2, diagnostics: [{ code: 'SIBLING_CHECKOUT_UNAVAILABLE' }] })
        // The guard admits the path as written, so one that reaches elsewhere through a link is refused.
        await symlink(join(root, 'unrelated'), join(app, 'link'))
        const linked = await runUse({ configPath, slug: 'app', checkout: join(app, 'link'), clear: false, env }, deps)
        expect(linked).toMatchObject({ status: 2, diagnostics: [{ code: 'SIBLING_CHECKOUT_UNAVAILABLE', message: expect.stringContaining('symbolic link') }] })
        expect(await exists(join(cockpit, '.cockpit/local/sibling-checkouts'))).toBe(false)

        // Two independent clones share no object store; the same origin is what makes them one repository.
        git(root, 'clone', '--quiet', join(root, 'app.git'), 'app-clone')
        for (const directory of [app, join(root, 'app-clone')]) git(directory, 'remote', 'set-url', 'origin', 'https://example.test/my-org/my-app.git')
        const clone = await runUse({ configPath, slug: 'app', checkout: join(root, 'app-clone'), clear: false, env }, deps)
        expect(clone).toMatchObject({ status: 0, result: { served: join(root, 'app-clone'), evidence: 'remote' } })
    })
})

describe('pull', () => {
    it('fast-forwards clean checkouts without running hooks, and leaves dirty, diverged and filtered ones exactly as they were', async () => {
        const { root, configPath } = await estate([['api', []], ['web', []], ['docs', []], ['assets', []], ['proxied', []]])
        for (const slug of ['api', 'web', 'docs', 'assets', 'proxied']) {
            git(root, 'clone', '--quiet', join(root, `${slug}.git`), `${slug}-upstream`)
            // A filter driver defined only outside the repository, as `git lfs install` leaves it.
            if (slug === 'assets') await commit(join(root, 'assets-upstream'), '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'Track binaries')
            await commit(join(root, `${slug}-upstream`), 'CHANGES.md', 'upstream\n', 'Upstream change')
            git(join(root, `${slug}-upstream`), 'push', '--quiet')
        }
        const hook = join(root, 'api', '.git', 'hooks', 'post-merge')
        await writeFile(hook, `#!/bin/sh\ntouch ${join(root, 'hook-ran')}\n`)
        await chmod(hook, 0o755)
        await writeFile(join(root, 'web', 'README.md'), 'local edit\n')
        await commit(join(root, 'docs'), 'LOCAL.md', 'local\n', 'Local change')
        // A command the checkout's own configuration names would run during the fetch.
        git(join(root, 'proxied'), 'config', 'core.sshCommand', 'false')
        const head = (slug: string) => git(join(root, slug), 'rev-parse', 'HEAD')
        const before = { web: head('web'), docs: head('docs'), proxied: head('proxied') }

        const pulled = await runPull({ configPath, env }, deps)

        const rows = (pulled.result as { repositories: { label: string; state: string; reason?: string }[] }).repositories
        expect(Object.fromEntries(rows.map(row => [row.label, row.state]))).toEqual({ cockpit: 'skipped', api: 'advanced', web: 'skipped', docs: 'skipped', assets: 'skipped', proxied: 'skipped' })
        expect(head('api')).toBe(git(join(root, 'api-upstream'), 'rev-parse', 'HEAD'))
        expect(await exists(join(root, 'hook-ran'))).toBe(false)
        expect(rows.find(row => row.label === 'assets')?.reason).toContain('Git filter lfs')
        expect(rows.find(row => row.label === 'proxied')?.reason).toContain('core.sshcommand')
        expect({ web: head('web'), docs: head('docs'), proxied: head('proxied') }).toEqual(before)
        expect(await readFile(join(root, 'web', 'README.md'), 'utf8')).toBe('local edit\n')
        expect(rows.find(row => row.label === 'docs')?.reason).toContain('diverged')
        expect(pulled.diagnostics.map(({ code, target }) => [code, target])).toEqual([['PULL_SKIPPED', join(root, 'web')], ['PULL_SKIPPED', join(root, 'docs')],
            ['PULL_SKIPPED', join(root, 'assets')], ['PULL_SKIPPED', join(root, 'proxied')]])
    })
})

describe('git runner', () => {
    it('does not run an fsmonitor command or hook the repository configuration names', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-runner-')))
        roots.push(root)
        git(root, 'init', '--quiet')
        await commit(root, 'a.txt', 'a\n', 'Initial')
        const marker = join(root, 'monitor-ran')
        const monitor = join(root, 'monitor.sh')
        await writeFile(monitor, `#!/bin/sh\ntouch ${marker}\n`)
        await chmod(monitor, 0o755)
        git(root, 'config', 'core.fsmonitor', monitor)
        const runner = await createGitRunner(env, executeProbe)
        if ('unavailable' in runner) throw new Error(runner.unavailable)

        const status = await runner.run(root, 'test:status', ['status', '--porcelain'])

        expect(status.kind).toBe('complete')
        expect(await exists(marker)).toBe(false)
    })

    it('reports a checkout whose repository cannot be resolved under its label instead of dropping it', async () => {
        const { root, configPath } = await estate([['api', []]])
        const loop = join(root, 'loop')
        await symlink(loop, loop)
        // Git names a toplevel the filesystem cannot resolve, which a real repository does not produce on demand.
        const bin = join(root, 'bin')
        await mkdir(bin)
        const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
        await writeFile(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" -C ${join(root, 'api')} "*" rev-parse "*) echo "${loop}"; exit 0 ;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 })

        const pulled = await runPull({ configPath, env: { ...env, PATH: `${bin}:${process.env.PATH}` } }, deps)

        const rows = (pulled.result as { repositories: { label: string; state: string; reason?: string }[] }).repositories
        expect(rows.find(row => row.label === 'api')).toMatchObject({ state: 'skipped', reason: expect.stringContaining(`${loop} could not be resolved`) })
        expect(pulled.diagnostics).toEqual([expect.objectContaining({ code: 'PULL_SKIPPED', target: join(root, 'api'), message: expect.stringMatching(/^api at /) })])
    })
})

describe('stale stack inputs', () => {
    it('warns when a lockfile, a declared rebuild input or the served checkout changes behind a running stack', async () => {
        const { root, cockpit, configPath } = await estate([['app', ['toolchain = "node"', 'rebuild_inputs = ["db/migrations"]']]])
        const app = join(root, 'app')
        await writeFile(join(app, 'package-lock.json'), '{"lockfileVersion":3}\n')
        await mkdir(join(app, 'db', 'migrations'), { recursive: true })
        await writeFile(join(app, 'db', 'migrations', '001.sql'), 'create table t (id int);\n')
        const { config } = await servedBy(cockpit, configPath)
        const served = async () => (await servedBy(cockpit, configPath)).siblings

        expect(await recordStackInputs(cockpit, config, await served(), { keepExisting: false })).toEqual([])
        expect(await staleStackDiagnostics(cockpit, await served())).toEqual([])

        await writeFile(join(app, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n')
        await writeFile(join(app, 'db', 'migrations', '002.sql'), 'alter table t add column name text;\n')
        // A resumed stack restarted nothing, so the record of its start stays.
        await recordStackInputs(cockpit, config, await served(), { keepExisting: true })
        const [stale] = await staleStackDiagnostics(cockpit, await served())
        expect(stale).toMatchObject({ code: 'STACK_INPUTS_CHANGED', severity: 'warning', target: 'sibling:app' })
        expect(stale!.message).toContain('package-lock.json (common lockfile names) changed')
        expect(stale!.message).toContain('db/migrations (rebuild_inputs) changed')
        expect(stale!.fix).toContain('./node_modules/@b00dea/cockpit/bin/cockpit.mjs down')

        await recordStackInputs(cockpit, config, await served(), { keepExisting: false })
        expect(await staleStackDiagnostics(cockpit, await served())).toEqual([])
        const worktree = join(app, '.worktrees', 'feature')
        git(app, 'worktree', 'add', '--quiet', '-b', 'feature', worktree)
        expect(await runUse({ configPath, slug: 'app', checkout: worktree, clear: false, env }, deps)).toMatchObject({ status: 0,
            diagnostics: [{ code: 'STACK_INPUTS_CHANGED', message: expect.stringContaining(`it is now served from ${worktree}`) }] })

        expect(await forgetStackInputs(cockpit)).toEqual([])
        expect(await staleStackDiagnostics(cockpit, await served())).toEqual([])
    })
})
