import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, renameSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'smol-toml'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as generatedCurrentnessOwner from './generated-application/sync.js'
import { executeProbe } from '../environment-exec/execute.js'
import { fileFingerprint } from '../environment-exec/verified-digest.js'
import { GUARD_EXECUTABLE_SEARCH_PATH, resolveDockerExecutable } from './executable.js'
import { evaluateGuard, GUARD_ROOT_PROTECTIONS, guardIdentity } from '../guards/evaluator.js'
import { parseGuardInput } from '../guards/invocation-parser.js'
import { encodeGuardLocalIdentity, GUARD_LOCAL_PATHS, parseGuardLocalIdentity, type GuardHandlerIdentity } from '../guards/local-identity.js'
import { shellPayload } from '../guards/fixtures/invocation-corpus.js'
import { parseOwnershipManifest } from '../surfaces/ownership.js'
import type { ExecutionStep } from './contract.js'
import { loadCockpitConfig } from '../config/load.js'
import { prepareGuardEvaluationPolicy, runGuardEvaluationApplication, type GuardEvaluationApplicationInput } from './application/guard.js'
import { observeSetupCheckout } from './setup-observation.js'
import { CockpitConfig } from '../schema.js'
import { GuardCommandArgv } from '../schema.js'
import { renderGuardProjectCommand } from './install-policy.js'
import { createApplicationFixtureSupport } from '../../test-support/application-fixture.js'

const scratch: string[] = []
const gitDirectory = mkdtempSync(join(tmpdir(), 'cockpit-application-git-'))
const gitCanonicalPath = join(gitDirectory, 'git-executable')
const gitInvocationPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
writeFileSync(gitCanonicalPath, `#!/bin/sh\nexec ${JSON.stringify(gitInvocationPath)} "$@"\n`, { mode: 0o700 })
const gitExecutable = {
    canonicalPath: gitCanonicalPath,
    invocationPath: gitInvocationPath,
    sha256: createHash('sha256').update(readFileSync(gitCanonicalPath)).digest('hex'),
    executionMode: 'verified-path' as const,
}

const installedGuardMutablePaths = [
    'cockpit.toml',
    '.cockpit/guards/bash-guard.sh',
    '.cockpit/generated-environment-ownership.json',
    '.cockpit/local/guard-identity',
    '.claude/settings.json',
    '.codex/hooks.json',
] as const
type InstalledGuardFixture = Readonly<{
    root: string
    configPath: string
    identity: GuardEvaluationApplicationInput['identity']
    snapshots: ReadonlyArray<Readonly<{ path: string; bytes: Buffer; mode: number }>>
}>
let sharedInstalledGuardRoot: string | undefined
let sharedInstalledGuard: InstalledGuardFixture | undefined
let installedGuardAttempt: Promise<InstalledGuardFixture> | undefined

function restoreInstalledGuardFixture(fixture: InstalledGuardFixture) {
    for (const snapshot of fixture.snapshots) {
        let current: Stats | undefined
        try {
            current = lstatSync(snapshot.path)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (!current?.isFile()) {
            rmSync(snapshot.path, { recursive: true, force: true })
            writeFileSync(snapshot.path, snapshot.bytes, { mode: snapshot.mode })
            continue
        }
        if (!readFileSync(snapshot.path).equals(snapshot.bytes)) writeFileSync(snapshot.path, snapshot.bytes)
        if ((current.mode & 0o7777) !== snapshot.mode) chmodSync(snapshot.path, snapshot.mode)
    }
    rmSync(join(fixture.root, 'registration.json'), { recursive: true, force: true })
}

describe('guard policy construction', () => {
    it('refuses missing installed guard identity through the application boundary', async () => {
        expect(await runGuardEvaluationApplication({ identity: null, guardRoot: '/workspace/product', payload: {}, harness: 'claudecode', cwd: '/workspace/product' }, {
            loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout, resolveGit: async () => ({ state: 'unavailable', reason: 'synthetic missing Git' }),
        })).toMatchObject({ decision: { decision: 'unavailable', reason: expect.any(String) }, diagnostics: [expect.objectContaining({ severity: 'error' })] })
    })

    it('keeps a literal configuration path as one argument in application recovery guidance', async () => {
        const base = mkdtempSync(join(tmpdir(), 'cockpit-guard-guidance-'))
        scratch.push(base)
        const createdRoot = join(base, "cock'pit$(printf injected); root")
        mkdirSync(createdRoot)
        const root = realpathSync(createdRoot)
        const configPath = join(root, 'cockpit.toml')
        writeFileSync(configPath, '')
        const launcher = join(root, 'node_modules/@b00dea/cockpit/bin/cockpit.mjs')
        mkdirSync(dirname(launcher), { recursive: true })
        mkdirSync(join(root, 'node_modules/@b00dea/cockpit/dist'))
        writeFileSync(join(root, 'node_modules/@b00dea/cockpit/dist/cli.js'), '')
        writeFileSync(launcher, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 })
        const digest = '0'.repeat(64)
        const identity = {
            root, rootInode: '0', configPath, configSha256: digest,
            configInode: '0', node: process.execPath, nodeSha256: digest,
            nodeFingerprint: 'synthetic', module: join(base, 'other-cli.js'), moduleSha256: digest,
        }
        const result = await runGuardEvaluationApplication({ identity, guardRoot: root, payload: {}, harness: 'claudecode', cwd: root }, {
            loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'unavailable', reason: 'not reached' }),
        })
        const command = /run `([^`]+)` in a terminal/.exec(result.decision.reason)?.[1]
        expect(command, result.decision.reason).toBeDefined()
        const captured = spawnSync('/bin/bash', ['-c', command!], { encoding: 'utf8' })
        expect(captured).toMatchObject({ status: 0, stderr: '', stdout: `<sync>\n<--config>\n<${configPath}>\n` })
    })

    it('names a missing dash-prefixed configuration without claiming it can be restored from Git', async () => {
        const base = mkdtempSync(join(tmpdir(), 'cockpit-guard-restore-'))
        scratch.push(base)
        const createdRoot = join(base, "cock'pit root")
        mkdirSync(createdRoot)
        const root = realpathSync(createdRoot)
        const rootStatus = lstatSync(root)
        const configFile = "-cock'pit.toml"
        const configPath = join(root, configFile)
        const digest = '0'.repeat(64)
        const identity = {
            root, rootInode: String(rootStatus.ino), configPath, configSha256: digest,
            configInode: '0', node: process.execPath, nodeSha256: digest,
            nodeFingerprint: 'synthetic', module: realpathSync(fileURLToPath(new URL('../../dist/cli.js', import.meta.url))), moduleSha256: digest,
        }
        const result = await runGuardEvaluationApplication({ identity, guardRoot: root, payload: {}, harness: 'claudecode', cwd: root }, {
            loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'unavailable', reason: 'not reached' }),
        })
        expect(result.decision).toMatchObject({ decision: 'unavailable', reason: expect.stringContaining(`${configPath} is missing`) })
        expect(result.decision.reason).toContain('return to the intended configured checkout/worktree and branch')
        expect(result.decision.reason).toContain('preserve native guards')
        expect(result.decision.reason).not.toContain('git ')
        expect(result.decision.reason).not.toContain('sync --config')
    })
    async function observedPolicy(declared = true, tuple?: string[]) {
        const { configPath } = fixture()
        const root = realpathSync(dirname(configPath))
        const source = CockpitConfig.parse(parse(readFileSync(new URL('../../../../fixtures/registries/generated-environment.toml', import.meta.url), 'utf8')))
        source.cockpit.name = 'synthetic-cockpit'
        source.cockpit.siblings_root = root
        if (tuple) {
            source.environment.install_policies[0]!.build = tuple
            source.environment.install_policies[0]!.test = tuple
        }
        if (!source.sibling[0].environment_files) throw new Error('guard fixture has no declared instance files')
        source.sibling[0].environment_files.push({ template: 'config/template.example', instance: 'config/runtime.env' })
        mkdirSync(join(root, 'app/config'), { recursive: true })
        writeFileSync(join(root, 'app/package-lock.json'), '{}')
        writeFileSync(configPath, stringify({ ...source, guards: { hosted_db_hosts: ['db.example.test'],
            allow: [{ argv: ['make', 'verify'], reason: 'Repository verification is safe.', cwd: '.' }],
            deny: [{ contains: ['--environment', 'shared'], reason: 'Shared environments are human-operated.', fix: 'Use a local environment.' }],
            ...(declared ? { vendor_endpoint_hosts: ['api.vendor.example.test'] } : {}) } }))
        const loaded = await loadCockpitConfig(configPath)
        if (loaded.kind !== 'complete') throw new Error('guard fixture did not load')
        const checkout = await observeSetupCheckout({ source: loaded.result.source, cockpitName: loaded.result.config.cockpit.name,
            observedAt: new Date().toISOString(), env: { VENDOR_API_URL: 'https://environment.example.test' }, gitExecutable })
        expect(checkout.state).toBe('available')
        return { input: { configuration: loaded.result, checkout }, root, configPath }
    }

    async function createInstalledGuardFixture(): Promise<InstalledGuardFixture> {
        const { root, configPath } = await observedPolicy()
        const scratchIndex = scratch.findIndex(path => realpathSync(path) === root)
        if (scratchIndex < 0) throw new Error('installed guard fixture root was not registered for cleanup')
        scratch.splice(scratchIndex, 1)
        sharedInstalledGuardRoot = root
        mkdirSync(join(root, 'node_modules/@b00dea'), { recursive: true })
        symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), join(root, 'node_modules/@b00dea/cockpit'))
        mkdirSync(join(root, 'fixtures'), { recursive: true })
        writeFileSync(join(root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
        expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        const identity = parseGuardLocalIdentity(readFileSync(join(root, '.cockpit/local/guard-identity'), 'utf8'))!
        const fixture = Object.freeze({
            root,
            configPath: realpathSync(configPath),
            identity,
            snapshots: installedGuardMutablePaths.map(relativePath => {
                const path = join(root, relativePath)
                const stat = lstatSync(path)
                if (!stat.isFile()) throw new Error(`installed guard fixture path is not a file: ${relativePath}`)
                return Object.freeze({ path, bytes: readFileSync(path), mode: stat.mode & 0o7777 })
            }),
        })
        sharedInstalledGuard = fixture
        return fixture
    }

    async function installedGuardRequest() {
        installedGuardAttempt ??= createInstalledGuardFixture()
        const { root, configPath, identity: installedIdentity } = await installedGuardAttempt
        if (!sharedInstalledGuard) throw new Error('installed guard fixture initialization did not complete')
        restoreInstalledGuardFixture(sharedInstalledGuard)
        const identity = JSON.parse(JSON.stringify(installedIdentity)) as GuardEvaluationApplicationInput['identity']
        const request: GuardEvaluationApplicationInput = { identity, guardRoot: root, harness: 'claudecode', cwd: root,
            payload: { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: 'app/.env.example' } } }
        const adapters = { loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'available' as const, value: gitExecutable }) }
        return { root, configPath, request, adapters }
    }

    it.each(['claudecode', 'codexcli', 'opencode'] as const)('keeps reviewed external reads bounded through the %s application', async harness => {
        const { root, configPath } = await observedPolicy()
        const external = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-selected-input-')))
        scratch.push(external)
        const input = join(external, 'notes.md')
        writeFileSync(input, 'synthetic notes\n')
        execFileSync('git', ['init', '--quiet', external])
        const config = CockpitConfig.parse(parse(readFileSync(configPath, 'utf8')))
        config.surfaces.tools = ['claudecode', 'codexcli', 'opencode']
        const commands = [['cat', input], ['git', '-C', external, 'status', '--short'],
            ['rg', '-n', 'synthetic', input], ['cat', join(external, 'missing.md')], ['cat', join(external, 'alias.md')],
            ['cat', join(external, '.env')], ['node', '--test', '--test-concurrency=1', 'verify.mjs'], ['rg', '-n', 'synthetic', external]]
        config.guards.allow.push(...commands.map(argv => ({ argv, cwd: '.', reason: 'Read the selected input or run the reviewed verifier.' })))
        writeFileSync(configPath, stringify(config))
        expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        const identity = parseGuardLocalIdentity(readFileSync(join(root, '.cockpit/local/guard-identity'), 'utf8'))!
        const adapters = { loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'available' as const, value: gitExecutable }) }
        const decide = async (command: string) => (await runGuardEvaluationApplication({ identity, guardRoot: root, harness, cwd: root,
            payload: shellPayload(command, root), searchPath: '/usr/bin:/bin' }, adapters)).decision
        const spell = (argv: string[]) => argv.map(word => `'${word}'`).join(' ')
        for (const argv of commands.slice(0, 3)) expect(await decide(spell(argv))).toMatchObject({ decision: 'allow' })
        // The status grant admits that command only; changing the related checkout's branch stays refused.
        expect(await decide(`git -C '${external}' checkout -b other`)).toEqual({ decision: 'unavailable', reason: expect.stringContaining('A working directory in this command is outside every root') })
        // Outside the roots the guard recognises only .env and .secrets names, so a granted search must name a file.
        expect(await decide(spell(commands[7]!))).toEqual({ decision: 'ask', reason: expect.stringContaining('outside the configured roots must name a regular file') })
        expect(await decide(spell(commands[6]!))).toMatchObject({ decision: 'allow' })
        expect(await decide(`cat '${input}' '${join(external, 'other.md')}'`)).not.toMatchObject({ decision: 'allow' })
        expect(await decide(`cat '${input}' > copied.md`)).not.toMatchObject({ decision: 'allow' })
        expect(await decide(`cat '${input}' > '${join(external, 'copy.md')}'`)).not.toMatchObject({ decision: 'allow' })
        expect(await decide(spell(commands[3]!))).not.toMatchObject({ decision: 'allow' })
        symlinkSync(input, join(external, 'alias.md'))
        expect(await decide(spell(commands[4]!))).not.toMatchObject({ decision: 'allow' })
        const secretDecision = await decide(spell(commands[5]!))
        expect(secretDecision, secretDecision.reason).toMatchObject({ decision: 'deny' })
        expect(await decide('git push origin HEAD:main')).toMatchObject({ decision: 'deny' })
        expect(await decide('curl https://db.example.test')).toMatchObject({ decision: 'deny' })
        // A repository edit cannot activate another grant: it is not in force until a person syncs it.
        const other = join(external, 'other.md')
        writeFileSync(other, 'other synthetic notes\n')
        config.guards.allow.push({ argv: ['cat', other], cwd: '.', reason: 'Another selected file.' })
        writeFileSync(configPath, stringify(config))
        const held = await decide(`cat '${other}'`)
        expect(held.decision).not.toBe('allow')
        expect(held.reason).toContain('has an unapproved edit that widens what agents may do (guards.allow)')
        expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        const reloaded = parseGuardLocalIdentity(readFileSync(join(root, '.cockpit/local/guard-identity'), 'utf8'))!
        const decideSynced = async (command: string) => (await runGuardEvaluationApplication({ identity: reloaded, guardRoot: root, harness, cwd: root,
            payload: shellPayload(command, root), searchPath: '/usr/bin:/bin' }, adapters)).decision
        expect(await decideSynced(`cat '${other}'`)).toMatchObject({ decision: 'allow' })
        // Removing every grant puts the read outside the roots at once, before sync as after it.
        config.guards.allow = []
        writeFileSync(configPath, stringify(config))
        expect(await decideSynced(`cat '${input}'`)).toEqual({ decision: 'ask', reason: expect.stringContaining('is outside the configured roots') })
        expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        const narrowed = parseGuardLocalIdentity(readFileSync(join(root, '.cockpit/local/guard-identity'), 'utf8'))!
        expect((await runGuardEvaluationApplication({ identity: narrowed, guardRoot: root, harness, cwd: root,
            payload: shellPayload(`cat '${input}'`, root), searchPath: '/usr/bin:/bin' }, adapters)).decision)
            .toEqual({ decision: 'ask', reason: expect.stringContaining('is outside the configured roots') })
    }, 120_000)

    it('reads a person\'s declared folder, or defers to native permissions, without writes or recursive searches there', async () => {
        const { root, configPath } = await observedPolicy()
        const inputs = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-read-path-')))
        scratch.push(inputs)
        writeFileSync(join(inputs, 'photo.jpg'), 'synthetic image bytes\n')
        writeFileSync(join(inputs, '.env'), 'SYNTHETIC_KEY=synthetic\n')
        mkdirSync(join(inputs, 'album'))
        symlinkSync(join(inputs, 'photo.jpg'), join(inputs, 'alias.jpg'))
        const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-unlisted-')))
        scratch.push(elsewhere)
        writeFileSync(join(elsewhere, 'notes.md'), 'synthetic notes\n')
        const config = CockpitConfig.parse(parse(readFileSync(configPath, 'utf8')))
        const adapters = { loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'available' as const, value: gitExecutable }) }
        const decide = async (command: string) => {
            const identity = parseGuardLocalIdentity(readFileSync(join(root, '.cockpit/local/guard-identity'), 'utf8'))!
            return (await runGuardEvaluationApplication({ identity, guardRoot: root, harness: 'codexcli', cwd: root,
                payload: shellPayload(command, root), searchPath: '/usr/bin:/bin' }, adapters)).decision
        }
        const sync = async () => expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        await sync()
        expect(await decide(`cat '${inputs}/photo.jpg'`)).toMatchObject({ decision: 'ask' })
        config.guards.read_paths = [{ path: inputs, reason: 'Inputs a person drops in.' }]
        writeFileSync(configPath, stringify(config))
        // Adding a read path widens what agents may read, so it is not in force until a person's sync.
        expect(await decide(`cat '${inputs}/photo.jpg'`)).toEqual({ decision: 'ask', reason: expect.stringContaining('has an unapproved edit that widens what agents may do') })
        await sync()
        for (const command of [`cat '${inputs}/photo.jpg'`, `ls '${inputs}'`, `rg -n synthetic '${inputs}/photo.jpg'`]) {
            expect(await decide(command), command).toMatchObject({ decision: 'allow' })
        }
        expect(await decide(`cat '${inputs}/.env'`)).toMatchObject({ decision: 'deny' })
        expect(await decide(`ls '${inputs}/album'`)).toMatchObject({ decision: 'allow' })
        // Outside its work tree git diff compares two directories file by file, reading every file below them.
        mkdirSync(join(inputs, 'empty'))
        for (const command of [`git diff '${inputs}/empty' '${inputs}/album'`, `git diff '${inputs}/empty' '${root}/app'`, `cat '${inputs}/album'`,
            `rg -n synthetic '${inputs}'`, `rg -n synthetic '${inputs}/album'`, `cat '${inputs}/alias.jpg'`,
            `cat '${elsewhere}/notes.md'`, `cp README.md '${inputs}/copy.md'`]) {
            expect((await decide(command)).decision, command).not.toBe('allow')
        }
        // Native external reads hand every named read outside the roots to the agent tool's own permission.
        config.guards.read_paths = []
        config.guards.external_reads = 'native'
        writeFileSync(configPath, stringify(config))
        await sync()
        expect(await decide(`cat '${elsewhere}/notes.md'`)).toMatchObject({ decision: 'allow' })
        expect(await decide(`rg -n synthetic '${elsewhere}'`)).toEqual({ decision: 'ask', reason: expect.stringContaining('outside the configured roots must name a regular file') })
        expect(await decide(`cat '${inputs}/.env'`)).toMatchObject({ decision: 'deny' })
        config.guards.external_reads = 'grant'
        writeFileSync(configPath, stringify(config))
        await sync()
        expect(await decide(`cat '${elsewhere}/notes.md'`)).toEqual({ decision: 'ask', reason: expect.stringContaining('is outside the configured roots') })
    }, 120_000)

    it('allows development by default, resolves where a bare push goes, and asks again in strict mode', async () => {
        const { root, configPath } = await observedPolicy()
        const remote = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-push-remote-')))
        scratch.push(remote)
        const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args], { stdio: 'pipe' })
        execFileSync('git', ['init', '-q', '--bare', remote])
        git('commit', '-q', '--allow-empty', '-m', 'Synthetic history')
        // Git's default first branch differs by install (some ship `main`, others `master`); a bare push
        // resolves only when the local name matches the upstream it tracks.
        git('branch', '-M', 'main')
        git('remote', 'add', 'origin', remote)
        git('push', '-q', '-u', 'origin', 'HEAD:refs/heads/main')
        const config = CockpitConfig.parse(parse(readFileSync(configPath, 'utf8')))
        const adapters = { loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'available' as const, value: gitExecutable }) }
        const decide = async (command: string, environment: { home?: string; xdgConfigHome?: string } = {}) => {
            const identity = parseGuardLocalIdentity(readFileSync(join(root, '.cockpit/local/guard-identity'), 'utf8'))!
            return (await runGuardEvaluationApplication({ identity, guardRoot: root, harness: 'codexcli', cwd: root,
                payload: shellPayload(command, root), searchPath: '/usr/bin:/bin', ...environment }, adapters)).decision
        }
        const configure = async (mode: 'allow' | 'ask') => {
            config.guards.default = mode
            writeFileSync(configPath, stringify(config))
            expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        }
        await configure('allow')
        for (const command of ['git commit -m done', 'npm run build', 'git switch -c topic', 'git commit -m "$(cat <<\'EOF\'\nFix the parser\nEOF\n)"',
            'NODE_ENV=test npm test', 'rg --files app -g package-lock.json']) {
            expect(await decide(command), command).toMatchObject({ decision: 'allow' })
        }
        // The checkout's branch pushes to the protected main, so a bare push is refused.
        expect(await decide('git push')).toMatchObject({ decision: 'deny' })
        git('switch', '-q', '-c', 'topic')
        git('push', '-q', '-u', 'origin', 'topic')
        expect(await decide('git push')).toMatchObject({ decision: 'allow' })
        expect(await decide('git push --force')).toMatchObject({ decision: 'deny' })
        // Git reads the person's global configuration below HOME and XDG_CONFIG_HOME, and so does the guard:
        // a matching push sends main too, and a pull that rebases rewrites main.
        const home = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-global-home-')))
        scratch.push(home)
        mkdirSync(join(home, '.config/git'), { recursive: true })
        writeFileSync(join(home, '.config/git/config'), '[push]\n\tdefault = matching\n')
        mkdirSync(join(home, 'xdg/git'), { recursive: true })
        writeFileSync(join(home, 'xdg/git/config'), '[pull]\n\trebase = true\n')
        expect(await decide('git push', { home })).toMatchObject({ decision: 'deny', reason: expect.stringContaining('push.default=matching') })
        git('switch', '-q', 'main')
        // ACK: the cockpit root's work tree holds the guard, and a pull brings content the guard cannot inspect
        // before it is fetched, so a plain pull there asks; a fast-forward to what was last fetched is judged.
        expect(await decide('git pull')).toMatchObject({ decision: 'ask' })
        expect(await decide('git pull --ff-only')).toMatchObject({ decision: 'allow' })
        expect(await decide('git pull', { home, xdgConfigHome: join(home, 'xdg') })).toMatchObject({ decision: 'deny', reason: expect.stringContaining('protected branch') })
        git('switch', '-q', 'topic')
        // A commit that replaces the guard, made without touching this work tree, is refused when merged in.
        const index = join(home, 'evil.index')
        const plumbing = (args: string[], input?: string) => execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args],
            { env: { ...process.env, GIT_INDEX_FILE: index }, input, encoding: 'utf8' }).trim()
        plumbing(['read-tree', 'HEAD'])
        const blob = plumbing(['hash-object', '-w', '--stdin'], 'exit 0\n')
        plumbing(['update-index', '--add', '--cacheinfo', `100755,${blob},.cockpit/guards/bash-guard.sh`])
        git('branch', 'evil', plumbing(['commit-tree', plumbing(['write-tree']), '-p', 'HEAD', '-m', 'Replace the guard']))
        for (const command of ['git merge evil', 'git checkout evil', 'git reset --hard evil', 'git cherry-pick evil']) {
            expect(await decide(command), command).toMatchObject({ decision: 'deny', reason: expect.stringContaining('.cockpit/guards/bash-guard.sh') })
        }
        expect(await decide('git merge main')).toMatchObject({ decision: 'allow' })
        await configure('ask')
        expect((await decide('git commit -m done')).decision).toBe('ask')
    }, 120_000)

    it('binds the guard only to the cockpit installed under the root, never to a copy that runs sync', async () => {
        const { root, configPath } = await observedPolicy()
        // The installed package is a copy holding its own cli.js, so the running cockpit is not it.
        mkdirSync(join(root, 'node_modules/@b00dea/cockpit/dist'), { recursive: true })
        writeFileSync(join(root, 'node_modules/@b00dea/cockpit/dist/cli.js'), '')
        expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_EXECUTABLE_UNAVAILABLE', message: expect.stringContaining('not the installed cockpit') })] })
        expect(existsSync(join(root, GUARD_LOCAL_PATHS.identity))).toBe(false)
        rmSync(join(root, 'node_modules/@b00dea/cockpit'), { recursive: true })
        symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), join(root, 'node_modules/@b00dea/cockpit'))
        expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
    })

    it('leaves read-only Git in another repository to native permissions, never its writes, helpers or secrets', async () => {
        const { root, configPath } = await observedPolicy()
        const repository = (name: string, files: Record<string, string>) => {
            const path = realpathSync(mkdtempSync(join(tmpdir(), name)))
            scratch.push(path)
            const run = (...args: string[]) => execFileSync('git', ['-C', path, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args])
            run('init', '-q', '-b', 'main')
            for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text)
            run('add', '.')
            run('commit', '-q', '-m', 'Synthetic history')
            return path
        }
        const product = repository('cockpit-related-checkout-', { 'notes.md': 'synthetic notes\n' })
        const leaky = repository('cockpit-related-secrets-', { 'notes.md': 'synthetic notes\n', '.env': 'SYNTHETIC_KEY=synthetic\n' })
        const plain = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-not-a-repository-')))
        scratch.push(plain)
        const config = CockpitConfig.parse(parse(readFileSync(configPath, 'utf8')))
        const adapters = { loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'available' as const, value: gitExecutable }) }
        const decide = async (command: string) => {
            const identity = parseGuardLocalIdentity(readFileSync(join(root, '.cockpit/local/guard-identity'), 'utf8'))!
            return (await runGuardEvaluationApplication({ identity, guardRoot: root, harness: 'codexcli', cwd: root,
                payload: shellPayload(command, root), searchPath: '/usr/bin:/bin' }, adapters)).decision
        }
        const configure = async (externalReads: 'grant' | 'native', allow: string[][] = []) => {
            config.guards.external_reads = externalReads
            config.guards.allow = allow.map(argv => ({ argv, cwd: '.', reason: 'Inspect the related checkout.' }))
            writeFileSync(configPath, stringify(config))
            expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        }
        const inventory = `git -C ${product} worktree list --porcelain`
        await configure('grant')
        expect((await decide(inventory)).decision).not.toBe('allow')
        await configure('grant', [inventory.split(' ')])
        expect(await decide(inventory)).toMatchObject({ decision: 'allow' })
        await configure('native')
        for (const command of [inventory, `git -C ${product} status --short`, `git -C ${product} log --oneline -5`, `git -C ${product} show HEAD`,
            `git -C ${product} diff main --stat`, `git -C ${product} branch -l`, `git -C ${product} ls-files -z`, `git -C ${product} cat-file -p HEAD`]) {
            const decision = await decide(command)
            expect(decision, `${command}: ${decision.reason}`).toMatchObject({ decision: 'allow' })
        }
        for (const command of [
            // Writes and network access.
            `git -C ${product} worktree add ../copy`, `git -C ${product} branch copy`, `git -C ${product} commit --allow-empty -m x`, `git -C ${product} fetch`,
            // Ways to run a program the command line chooses.
            `git -C ${product} -c core.pager=cat log`, `git -C ${product} diff --ext-diff`, `git -C ${product} lg`, `GIT_PAGER=cat git -C ${product} log`,
            // Only the whole call: another command could read evidence a repository helper changed.
            `${inventory} | head -n 1`,
            // Content the guard cannot prove holds no secret, and a directory that is not a repository.
            `git -C ${leaky} show HEAD`, `git -C ${leaky} cat-file -p HEAD:.env`, `git -C ${leaky} diff main`, `git -C ${leaky} log -p`, `git -C ${plain} status`,
            // A path outside the work tree turns diff into a `--no-index` comparison that prints whole trees.
            `git -C ${product} diff ${root}/app ${plain}`]) {
            expect((await decide(command)).decision, command).not.toBe('allow')
        }
        // Inventories that print no file content stay readable beside a tracked secret.
        expect(await decide(`git -C ${leaky} log --oneline`)).toMatchObject({ decision: 'allow' })
    }, 120_000)

    it('reads a named package document, and searches a package directory, through a confined package symlink', async () => {
        const { root, request, adapters } = await installedGuardRequest()
        const store = join(root, 'packages/docs-fixture')
        mkdirSync(store, { recursive: true })
        writeFileSync(join(store, 'guide.md'), 'synthetic guide\n')
        const alias = join(root, 'package-docs')
        symlinkSync(store, alias)
        const decide = async (file: string) => (await runGuardEvaluationApplication({ ...request, searchPath: '/usr/bin:/bin',
            payload: shellPayload(`rg -n 'roots|read path|allow' ${file}`, root) }, adapters)).decision
        try {
            const result = await decide('package-docs/guide.md')
            expect(result, JSON.stringify(result)).toMatchObject({ decision: 'allow' })
            // A search through the link reads where it leads, judged by the same secret walk as any search.
            const search = async (command: string) => (await runGuardEvaluationApplication({ ...request, searchPath: '/usr/bin:/bin',
                payload: shellPayload(command, root) }, adapters)).decision
            for (const command of ['rg -n needle package-docs', 'grep -rn needle package-docs']) expect(await search(command), command).toMatchObject({ decision: 'allow' })
            writeFileSync(join(store, '.env'), 'SYNTHETIC_KEY=synthetic\n')
            for (const command of ['rg -n needle package-docs', 'grep -rn needle package-docs']) {
                expect(await search(command), command).toMatchObject({ decision: 'ask', reason: expect.stringContaining('.env') })
            }
            symlinkSync(join(store, '.env'), join(store, 'secret-alias.md'))
            expect(await decide('package-docs/secret-alias.md')).toMatchObject({ decision: 'deny' })
            writeFileSync(join(store, '.envrc'), 'synthetic environment script\n')
            symlinkSync(join(store, '.envrc'), join(store, 'script-alias.md'))
            const scriptRead = await runGuardEvaluationApplication({ ...request, searchPath: '/usr/bin:/bin',
                payload: shellPayload('cat package-docs/script-alias.md', root) }, adapters)
            expect(scriptRead.decision).toMatchObject({ decision: 'ask' })
            const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-unapproved-input-')))
            scratch.push(outside)
            writeFileSync(join(outside, 'guide.md'), 'synthetic external guide\n')
            symlinkSync(join(outside, 'guide.md'), join(store, 'outside-alias.md'))
            expect(await decide('package-docs/outside-alias.md')).not.toMatchObject({ decision: 'allow' })
            symlinkSync(outside, join(root, 'outside-docs'))
            expect(await search('grep -rn needle outside-docs')).not.toMatchObject({ decision: 'allow' })
        } finally {
            rmSync(join(root, 'outside-docs'), { force: true })
            rmSync(alias)
            rmSync(store, { recursive: true })
        }
    }, 120_000)

    it('keeps guarding after a reboot renumbers the volume, and holds for a replaced checkout', async () => {
        const { root, request, adapters } = await installedGuardRequest()
        const recorded = request.identity as GuardHandlerIdentity
        const decide = async (changes: Partial<GuardHandlerIdentity>) => {
            const identity = { ...recorded, ...changes }
            writeFileSync(join(root, GUARD_LOCAL_PATHS.identity), encodeGuardLocalIdentity(identity))
            return (await runGuardEvaluationApplication({ ...request, identity }, adapters)).decision
        }
        // A macOS reboot reassigns the APFS Data volume's device number while the path and inode stay, so
        // nothing recorded across boots may carry one: not the identity, nor the Node fingerprint in it.
        expect(Object.keys(recorded).filter(key => /device/i.test(key))).toEqual([])
        const node = lstatSync(recorded.node)
        expect(fileFingerprint(recorded.node, { ...node, dev: node.dev + 1 } as Stats)).toBe(fileFingerprint(recorded.node, node))
        expect(await decide({})).toMatchObject({ decision: 'allow' })
        expect(await decide({ rootInode: String(Number(recorded.rootInode) + 1) }))
            .toEqual({ decision: 'unavailable', reason: expect.stringContaining('was moved or replaced') })
    }, 120_000)

    it('guards native notebook edits against the same authenticated control paths as text edits', async () => {
        const { root, request, adapters } = await installedGuardRequest()
        for (const [file, decision] of [['app/analysis.ipynb', 'allow'], ['.cockpit/local/analysis.ipynb', 'deny']] as const) {
            const payload = { hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', cwd: root,
                tool_input: { notebook_path: join(root, file), new_source: 'print(1)' } }
            expect(await runGuardEvaluationApplication({ ...request, payload }, adapters))
                .toMatchObject({ decision: { decision } })
        }
    }, 120_000)

    it('protects harness search path directories and hard links to secrets files through the installed guard', async () => {
        const { root, request, adapters } = await installedGuardRequest()
        // A recursive search is proven only by walking its tree for environment files and secrets directories.
        const search = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command: 'grep -rn needle fixtures' } }
        expect(await runGuardEvaluationApplication({ ...request, payload: search, searchPath: '/usr/bin:/bin' }, adapters)).toMatchObject({ decision: { decision: 'allow' } })
        writeFileSync(join(root, 'fixtures/.env.local'), 'SYNTHETIC_KEY=synthetic\n')
        try {
            expect(await runGuardEvaluationApplication({ ...request, payload: search, searchPath: '/usr/bin:/bin' }, adapters))
                .toMatchObject({ decision: { decision: 'ask', reason: expect.stringContaining('would read fixtures/.env.local') } })
        } finally { rmSync(join(root, 'fixtures/.env.local'), { force: true }) }
        const secret = join(root, 'env/.secrets/token')
        mkdirSync(dirname(secret), { recursive: true })
        writeFileSync(secret, 'synthetic\n')
        linkSync(secret, join(root, 'notes.txt'))
        try {
            const read = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command: 'cat notes.txt' } }
            expect(await runGuardEvaluationApplication({ ...request, payload: read }, adapters))
                .toMatchObject({ decision: { decision: 'deny', reason: expect.stringContaining('Refusing to read') } })
            const plant = { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: join(root, 'tools/bin/ls'), content: '#!/bin/sh\n' } }
            expect(await runGuardEvaluationApplication({ ...request, payload: plant }, adapters)).toMatchObject({ decision: { decision: 'allow' } })
            const searchPath = `/usr/bin:${join(root, 'tools/bin')}/:relative/bin`
            expect(await runGuardEvaluationApplication({ ...request, payload: plant, searchPath }, adapters))
                .toMatchObject({ decision: { decision: 'deny', reason: expect.stringContaining('command search path directory') } })
            // A relative entry makes any file the agent wrote a candidate for a bare command name.
            const listing = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command: 'ls fixtures' } }
            expect(await runGuardEvaluationApplication({ ...request, payload: listing, searchPath: '/usr/bin:/bin' }, adapters)).toMatchObject({ decision: { decision: 'allow' } })
            expect(await runGuardEvaluationApplication({ ...request, payload: listing, searchPath }, adapters))
                .toMatchObject({ decision: { decision: 'ask', reason: expect.stringContaining('relative entry "relative/bin"') } })
        } finally {
            rmSync(join(root, 'env'), { recursive: true, force: true })
            rmSync(join(root, 'notes.txt'), { force: true })
        }
    }, 120_000)

    it('asks Git which protected files a default ripgrep search reads and a Git command prints, through the installed guard', async () => {
        const { root, request, adapters } = await installedGuardRequest()
        const decide = async (command: string) => (await runGuardEvaluationApplication({ ...request, searchPath: '/usr/bin:/bin',
            payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command } } }, adapters)).decision
        writeFileSync(join(root, 'fixtures/.gitignore'), '.env\n')
        writeFileSync(join(root, 'fixtures/.env'), 'SYNTHETIC_KEY=synthetic\n')
        try {
            // ripgrep skips the ignored file, so only searches that would read it ask.
            expect(await decide('rg needle fixtures')).toMatchObject({ decision: 'allow' })
            expect(await decide('grep -rn needle fixtures')).toMatchObject({ decision: 'ask', reason: expect.stringContaining('would read fixtures/.env,') })
            expect(await decide('rg --no-ignore needle fixtures')).toMatchObject({ decision: 'ask' })
            writeFileSync(join(root, 'fixtures/.env.local'), 'SYNTHETIC_KEY=synthetic\n')
            expect(await decide('rg needle fixtures')).toMatchObject({ decision: 'ask', reason: expect.stringContaining('would read fixtures/.env.local,') })
            expect(await decide('git diff')).toMatchObject({ decision: 'allow' })
            execFileSync('git', ['-C', root, 'add', '--force', 'fixtures/.env'])
            expect(await decide('git diff --cached')).toMatchObject({ decision: 'ask', reason: expect.stringContaining('can print fixtures/.env,') })
            expect(await decide('git log -p -- app')).toMatchObject({ decision: 'allow' })
        } finally {
            execFileSync('git', ['-C', root, 'rm', '--cached', '--quiet', '--ignore-unmatch', 'fixtures/.env'])
            for (const file of ['.gitignore', '.env', '.env.local']) rmSync(join(root, 'fixtures', file), { force: true })
        }
    }, 120_000)

    it.each([
        ['app/.env.example', 'allow'],
        ['app/config/runtime.env', 'deny'],
    ] as const)('batches authenticated guard publication at both freshness checkpoints for %s', async (file, decision) => {
        const { root, request, adapters } = await installedGuardRequest()
        const steps: Array<{ checkpoint: number; step: ExecutionStep }> = []
        let checkpoint = 0
        const result = await runGuardEvaluationApplication({ ...request,
            payload: { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: file } },
        }, {
            ...adapters,
            loadConfig: async path => { checkpoint += 1; return loadCockpitConfig(path) },
            execute: async step => {
                steps.push({ checkpoint, step })
                return executeProbe(step)
            },
        })
        expect(result).toMatchObject({ decision: { decision } })
        const publication = steps.filter(({ step }) => step.cwd === root)
        expect(publication.map(({ checkpoint, step }) => ({ checkpoint, labels: step.labels }))).toEqual([
            { checkpoint: 1, labels: { action: 'read-batch', parent: '.' } },
            { checkpoint: 2, labels: { action: 'read-batch', parent: '.' } },
        ])
        for (const { step } of publication) {
            expect(JSON.parse(step.argv[3]!)).toMatchObject({ action: 'read-batch', entries: [
                { action: 'read-file', segments: ['.cockpit'], name: 'generated-environment-ownership.json', maxBytes: 1_048_576 },
                { action: 'read-file', segments: ['.cockpit', 'guards'], name: 'bash-guard.sh', maxBytes: 65_536 },
                { action: 'read-file', segments: ['.claude'], name: 'settings.json', maxBytes: 65_536 },
                { action: 'read-file', segments: ['.cockpit', 'local'], name: 'guard-identity', maxBytes: 65_536 },
                { action: 'read-file', segments: [], name: 'cockpit.toml', maxBytes: 1_048_576 },
            ] })
        }
        // The first module read starts together with the configuration load, so both count as checkpoint 1.
        const module = steps.filter(({ step }) => step.cwd !== root)
        const moduleRoot = realpathSync(new URL('../../dist', import.meta.url))
        expect(module.map(({ checkpoint, step }) => ({ checkpoint, cwd: step.cwd, action: step.labels.action }))).toEqual([
            { checkpoint: 1, cwd: moduleRoot, action: 'read-file' },
            { checkpoint: 2, cwd: moduleRoot, action: 'read-file' },
        ])
        for (const { step } of module) expect(JSON.parse(step.argv[3]!)).toMatchObject({ action: 'read-file', name: 'cli.js', maxBytes: 16_777_216 })
    }, 120_000)

    it('refuses spellings and hard links that resolve to a protected file through the installed route', async () => {
        const { root, request, adapters } = await installedGuardRequest()
        const instance = join(root, 'app/config/runtime.env')
        const created = [instance, join(root, 'app/config/linked'), join(root, 'app/config/notes.md'), join(root, 'app/link'), join(root, 'app/config/sub')]
        try {
            writeFileSync(instance, 'synthetic instance\n')
            linkSync(instance, join(root, 'app/config/linked'))
            writeFileSync(join(root, 'app/config/notes.md'), 'synthetic notes\n')
            mkdirSync(join(root, 'app/config/sub'))
            symlinkSync(join(root, 'app/config/sub'), join(root, 'app/link'))
            const decide = async (file: string) => (await runGuardEvaluationApplication({ ...request,
                payload: { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: file } } }, adapters)).decision.decision
            expect(await decide('app/config/linked')).toBe('deny')
            expect(await decide('app/config/RUNTIME.ENV')).toBe('deny')
            expect(await decide('.claude/\u017Fettings.json')).toBe('deny')
            expect(await decide('app/config/NOTES.md')).toBe('allow')
            // The system resolves `..` from where a link leads, so `app/link/..` is app/config, not app.
            const read = async (command: string) => (await runGuardEvaluationApplication({ ...request, searchPath: '/usr/bin:/bin',
                payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command } } }, adapters)).decision.decision
            expect(await read('cat app/link/../runtime.env')).toBe('ask')
            expect(await read('cat app/config/sub/../notes.md')).toBe('allow')
            // A word longer than any file name the volume allows names nothing, so probing it is no failure.
            const long = 'x'.repeat(300)
            expect(await read(`echo '${long}'`)).toBe('allow')
            expect(await read(`cat app/${long} app/${long}/../config/notes.md`)).toBe('allow')
            expect(await read(`rg needle app/${long}`)).toBe(await read('rg needle app/missing'))
            // A word the guard cannot inspect holds the call by naming that word, not the guard's own authority.
            mkdirSync(join(root, 'app/locked'), { mode: 0o000 })
            const locked = await runGuardEvaluationApplication({ ...request, payload: shellPayload('echo app/locked/entry', root) }, adapters)
            expect(locked.decision).toEqual({ decision: 'unavailable', reason: expect.stringMatching(/^Guard could not inspect \S+\/app\/locked\/entry, which this call names/) })
        } finally {
            if (existsSync(join(root, 'app/locked'))) { chmodSync(join(root, 'app/locked'), 0o700); rmSync(join(root, 'app/locked'), { recursive: true }) }
            for (const path of created) rmSync(path, { recursive: true, force: true })
        }
    }, 120_000)

    it.each(['missing', 'symlink', 'changed'] as const)('refuses %s guard publication through authenticated reads', async change => {
        const { root, request, adapters } = await installedGuardRequest()
        const observeCheckout = vi.fn(adapters.observeCheckout)
        const path = join(root, change === 'missing' ? '.cockpit/guards/bash-guard.sh'
            : change === 'symlink' ? '.claude/settings.json' : '.cockpit/generated-environment-ownership.json')
        let loads = 0
        const result = await runGuardEvaluationApplication(request, {
            ...adapters, observeCheckout,
            loadConfig: async configPath => {
                loads += 1
                if (loads === 1 && change === 'missing') rmSync(path)
                if (loads === 1 && change === 'symlink') {
                    const target = join(root, 'registration.json')
                    writeFileSync(target, readFileSync(path))
                    rmSync(path)
                    symlinkSync(target, path)
                }
                if (loads === 2 && change === 'changed') writeFileSync(path, readFileSync(path, 'utf8') + '\n')
                return loadCockpitConfig(configPath)
            },
            execute: executeProbe,
        })
        expect(result).toMatchObject({ decision: { decision: 'unavailable', reason: expect.stringContaining(
            change === 'changed' ? 'publication changed during evaluation'
                : change === 'missing' ? `.cockpit/guards/bash-guard.sh is missing; it authenticates the guard and the hook that launches it, so shell commands, file edits and writes, and restricted MCP tools under Claude Code are held, including a sync run through this agent, while file reads and unrestricted MCP tools continue. Fix: a human must run \`${root}/node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ${root}/cockpit.toml\``
                    : 'could not be read or revalidated',
        ) } })
        expect(observeCheckout).toHaveBeenCalledTimes(change === 'changed' ? 1 : 0)
        expect(loads).toBe(change === 'changed' ? 2 : 1)
    }, 120_000)

    it.each([
        ['cockpit.toml', 'guard policy comes from it'],
        ['.cockpit/generated-environment-ownership.json', 'it authenticates the guard and the hook that launches it'],
        ['.claude/settings.json', 'it authenticates the guard and the hook that launches it'],
        ['.cockpit/local/guard-identity', 'it records the Node executable and cockpit handler on this machine, which committed files cannot carry'],
    ] as const)('names a deleted %s, why every call is held, and the fix', async (file, why) => {
        const { root, configPath, request, adapters } = await installedGuardRequest()
        // A rename keeps the file's identity, so the shared fixture stays authenticated afterwards.
        renameSync(join(root, file), join(root, `${file}.away`))
        try {
            const { decision } = await runGuardEvaluationApplication(request, adapters)
            expect(decision.decision).toBe('unavailable')
            expect(decision.reason).toContain(`${file === 'cockpit.toml' ? configPath : file} is missing; ${why}, so shell commands, file edits and writes, and restricted MCP tools under Claude Code are held`)
            expect(decision.reason).toContain(file === 'cockpit.toml'
                ? 'Fix: a human must return to the intended configured checkout/worktree and branch'
                : `Fix: a human must run \`${root}/node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ${configPath}\` in a terminal, outside the agent`)
            expect(decision.reason).not.toContain('git ')
            expect(decision.reason).not.toContain('npx ')
        } finally { renameSync(join(root, `${file}.away`), join(root, file)) }
    }, 120_000)

    it('holds missing guard authority while explaining an absent local package before regeneration', async () => {
        const { root, request, adapters } = await installedGuardRequest()
        const installed = join(root, 'node_modules/@b00dea/cockpit')
        const registration = join(root, '.claude/settings.json')
        renameSync(installed, `${installed}.away`)
        renameSync(registration, `${registration}.away`)
        try {
            const result = await runGuardEvaluationApplication(request, adapters)
            expect(result.decision).toMatchObject({ decision: 'unavailable', reason: expect.stringContaining('@b00dea/cockpit is not installed or is incomplete') })
            expect(result.decision.reason).toContain("repository's documented dependency-install command")
            expect(result.decision.reason).not.toContain('sync --config')
            expect(result.decision.reason).not.toContain('git restore')
        } finally {
            renameSync(`${installed}.away`, installed)
            renameSync(`${registration}.away`, registration)
        }
    }, 120_000)

    it.each([1, 2])('refuses forged guard publication batch evidence at checkpoint %s', async checkpoint => {
        const { root, request, adapters } = await installedGuardRequest()
        const observeCheckout = vi.fn(adapters.observeCheckout)
        let loads = 0
        let forged = false
        const result = await runGuardEvaluationApplication(request, {
            ...adapters, observeCheckout,
            loadConfig: async path => { loads += 1; return loadCockpitConfig(path) },
            execute: async step => {
                const outcome = await executeProbe(step)
                if (step.cwd === root && step.labels.action === 'read-batch' && loads === checkpoint) {
                    expect(outcome.kind).toBe('complete')
                    forged = true
                    return { ...outcome }
                }
                return outcome
            },
        })
        expect(forged).toBe(true)
        expect(result).toMatchObject({ decision: { decision: 'unavailable', reason: expect.stringContaining('could not be read or revalidated') } })
        expect(observeCheckout).toHaveBeenCalledTimes(checkpoint - 1)
        expect(loads).toBe(checkpoint)
    }, 120_000)

    it.each(['package', 'version', 'sourceRevision'] as const)(
        'refuses structurally valid prior producer authority: %s', async change => {
            const { root, configPath, request, adapters } = await installedGuardRequest()
            const path = join(root, '.cockpit/generated-environment-ownership.json')
            const { integrity: _integrity, ...payload } = JSON.parse(readFileSync(path, 'utf8'))
            payload.producer[change] = change === 'package' ? 'prior-cockpit' : change === 'version' ? '0.0.0-prior' : 'prior-revision'
            const bytes = JSON.stringify({ ...payload, integrity: createHash('sha256').update(JSON.stringify(payload)).digest('hex') })
            expect(parseOwnershipManifest(bytes, { root, configPath, cockpitId: payload.cockpitId }).kind).toBe('complete')
            writeFileSync(path, bytes)
            const observeCheckout = vi.fn(adapters.observeCheckout)
            expect(await runGuardEvaluationApplication(request, { ...adapters, observeCheckout }))
                .toMatchObject({ decision: { decision: 'unavailable', reason: expect.stringContaining('the installed cockpit version changed') } })
            expect(observeCheckout).not.toHaveBeenCalled()
        }, 120_000,
    )

    it.each(['v1', 'v2'] as const)('refuses obsolete ownership format %s before checkout observation', async format => {
        const { root, configPath, request, adapters } = await installedGuardRequest()
        const path = join(root, '.cockpit/generated-environment-ownership.json')
        const { integrity: _integrity, producer: _producer, ...current } = JSON.parse(readFileSync(path, 'utf8'))
        const payload = format === 'v1'
            ? { ...current, format: `cockpit-generated-ownership/${format}`, files: current.entries
                .filter((entry: { kind: string }) => entry.kind === 'file')
                .map(({ path: ownedPath, ownership, sha256 }: { path: string; ownership: string; sha256: string }) => ({ path: ownedPath, ownership, sha256 })) }
            : { ...current, format: `cockpit-generated-ownership/${format}` }
        if (format === 'v1') delete payload.entries
        const bytes = JSON.stringify({ ...payload, integrity: createHash('sha256').update(JSON.stringify(payload)).digest('hex') })
        expect(parseOwnershipManifest(bytes, { root, configPath, cockpitId: payload.cockpitId })).toEqual({ kind: 'invalid' })
        writeFileSync(path, bytes)
        const observeCheckout = vi.fn(adapters.observeCheckout)
        expect(await runGuardEvaluationApplication(request, { ...adapters, observeCheckout }))
            .toMatchObject({ decision: { decision: 'unavailable', reason: expect.stringContaining('stale or unauthenticated') } })
        expect(observeCheckout).not.toHaveBeenCalled()
    }, 120_000)

    it('keeps the captured harness authoritative across an awaited adapter mutation', async () => {
        const { root, request: captured, adapters } = await installedGuardRequest()
        const request = { ...captured }
        rmSync(join(root, '.codex/hooks.json'))
        const result = await runGuardEvaluationApplication(request, {
            ...adapters,
            loadConfig: async path => {
                const loaded = await loadCockpitConfig(path)
                request.harness = 'codexcli'
                return loaded
            },
        })
        expect(request.harness).toBe('codexcli')
        // The claudecode registration was authenticated; honouring the mutated harness would have needed the removed codex hooks file.
        expect(result, JSON.stringify(result)).toMatchObject({ decision: { decision: 'allow' } })
    }, 120_000)

    it('authenticates the installed application route and refuses copied, unresolved, ambiguous and changed authority', async () => {
        const { root, configPath } = await observedPolicy()
        mkdirSync(join(root, 'node_modules/@b00dea'), { recursive: true })
        symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), join(root, 'node_modules/@b00dea/cockpit'))
        mkdirSync(join(root, 'fixtures'), { recursive: true })
        writeFileSync(join(root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
        expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        const identity = parseGuardLocalIdentity(readFileSync(join(root, '.cockpit/local/guard-identity'), 'utf8'))!
        const payload = { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, tool_input: { file_path: 'app/.env.example' } }
        const request = { identity, guardRoot: root, payload, harness: 'claudecode' as const, cwd: root }
        const adapters = { loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'available' as const, value: gitExecutable }) }
        expect(await runGuardEvaluationApplication(request, adapters)).toMatchObject({ decision: { decision: 'allow' } })
        expect(await runGuardEvaluationApplication({ ...request, identity: { ...identity, extra: true } }, adapters))
            .toMatchObject({ decision: { decision: 'unavailable', reason: expect.stringContaining('malformed') } })
        expect(await runGuardEvaluationApplication({ ...request, identity: { ...identity, rootInode: '0' } }, adapters))
            .toMatchObject({ decision: { decision: 'unavailable', reason: expect.stringContaining(`the cockpit checkout ${root} was moved or replaced since the guards were generated`) } })
        // A guard in another checkout must not evaluate under this checkout's identity and policy.
        expect(await runGuardEvaluationApplication({ ...request, guardRoot: join(root, 'app') }, adapters))
            .toMatchObject({ decision: { decision: 'unavailable', reason: expect.stringContaining('location') } })
        const localPath = join(root, '.cockpit/local/guard-identity')
        const localBytes = readFileSync(localPath, 'utf8')
        writeFileSync(localPath, encodeGuardLocalIdentity({ ...identity, moduleSha256: 'f'.repeat(64) }))
        expect(await runGuardEvaluationApplication(request, adapters))
            .toMatchObject({ decision: { decision: 'unavailable', reason: expect.stringContaining('machine-local record') } })
        writeFileSync(localPath, localBytes)
        expect(await runGuardEvaluationApplication(request, { ...adapters, resolveGit: async () => ({ state: 'unavailable', reason: 'missing' }) }))
            .toMatchObject({ decision: { decision: 'unavailable', reason: expect.stringContaining('Git executable') } })
        expect(await runGuardEvaluationApplication({ ...request, payload: { ...payload, cwd: join(root, 'app') } }, adapters))
            .toMatchObject({ decision: { decision: 'unavailable', reason: expect.stringContaining('cwd') } })
        let loads = 0
        expect(await runGuardEvaluationApplication(request, { ...adapters, loadConfig: async path => {
            loads += 1
            if (loads === 2) writeFileSync(configPath, readFileSync(configPath, 'utf8') + '\n# changed during evaluation\n')
            return loadCockpitConfig(path)
        } })).toMatchObject({ decision: { decision: 'unavailable', reason: expect.stringContaining('changed during') } })
        expect(loads).toBe(2)
        // An edit that does not widen the guard grants nothing the last sync did not, so calls are judged
        // under it at once, the sync that applies it included, and a restriction it adds is in force.
        const canonicalConfig = realpathSync(configPath)
        const sync = { ...request, searchPath: '/usr/bin:/bin', payload: shellPayload(`${resolve(dirname(identity.module), '../bin/cockpit.mjs')} sync --config ${canonicalConfig}`, root) }
        const forced = { ...request, searchPath: '/usr/bin:/bin', payload: shellPayload('ls --force', root) }
        expect(await runGuardEvaluationApplication(request, adapters)).toMatchObject({ decision: { decision: 'allow' }, diagnostics: [] })
        expect(await runGuardEvaluationApplication(sync, adapters)).toMatchObject({ decision: { decision: 'allow' } })
        // Node named by its absolute path is proven as bare `node` is, by the search path the agent runs
        // with: it must be the `node` of one of its absolute entries, and the script the installed launcher.
        const script = './node_modules/@b00dea/cockpit/bin/cockpit.mjs'
        const homebrew = '/opt/homebrew/bin:/usr/bin:/bin'
        const preview = async (node: string, searchPath = homebrew, launched = script) => (await runGuardEvaluationApplication({ ...request, searchPath,
            payload: shellPayload(`${node} ${launched} sync --config cockpit.toml --dry-run`, root) }, adapters)).decision.decision
        expect(await preview('node')).toBe('allow')
        expect(await preview('/opt/homebrew/bin/node')).toBe('allow')
        expect(await preview('/usr/bin/node')).toBe('allow')
        for (const [node, searchPath, launched] of [['/opt/homebrew/bin/node', '/usr/bin:/bin', script], [`${root}/node`, `${homebrew}:${root}/tools/bin`, script],
            [`${tmpdir()}/node`, homebrew, script], ['/opt/homebrew/bin/../bin/node', homebrew, script], ['/opt/homebrew/bin/node', homebrew, `--require ./app/other.cjs ${script}`],
            ['/opt/homebrew/bin/node', homebrew, './node_modules/@b00dea/cockpit/dist/cli.js'], ['/opt/homebrew/bin/node', homebrew, './node_modules/@b00dea/missing/bin/cockpit.mjs']]) {
            expect(await preview(node!, searchPath, launched), `${node} ${launched} with ${searchPath}`).not.toBe('allow')
        }
        expect((await runGuardEvaluationApplication(forced, adapters)).decision.reason ?? '').not.toContain('Forced writes require review.')
        const restricted = parse(readFileSync(configPath, 'utf8')) as { guards: { deny: unknown[] } }
        restricted.guards.deny.push({ contains: ['--force'], reason: 'Forced writes require review.' })
        writeFileSync(configPath, stringify(restricted))
        expect(await runGuardEvaluationApplication(sync, adapters)).toMatchObject({ decision: { decision: 'allow' } })
        expect(await runGuardEvaluationApplication(request, adapters)).toMatchObject({ decision: { decision: 'allow' }, diagnostics: [] })
        expect(await runGuardEvaluationApplication(forced, adapters)).toMatchObject({ decision: { decision: 'deny', reason: expect.stringContaining('Forced writes require review.') } })
        // An edit that widens it leaves every call judged under the configuration last synced: what that
        // admits still runs, the widened rule is not yet in force, the agent cannot sync it in, and each
        // refusal says a person must.
        // Under the allow default a grant matters for what still asks, such as a named read outside the cockpit.
        const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-widened-input-')))
        scratch.push(outside)
        writeFileSync(join(outside, 'notes.md'), 'synthetic notes\n')
        const widened = parse(readFileSync(configPath, 'utf8')) as { guards: { allow: unknown[] } }
        widened.guards.allow.push({ argv: ['cat', join(outside, 'notes.md')], cwd: '.', reason: 'Read the selected input.' })
        writeFileSync(configPath, stringify(widened))
        const notice = ` ${canonicalConfig} has an unapproved edit that widens what agents may do (guards.allow); calls are judged under the configuration last synced until a person runs \`${root}/node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ${canonicalConfig} --interactive\` in a terminal, outside the agent, and confirms it.`
        expect(await runGuardEvaluationApplication(request, adapters)).toMatchObject({ decision: { decision: 'allow' }, diagnostics: [] })
        const release = await runGuardEvaluationApplication({ ...request, searchPath: '/usr/bin:/bin', payload: shellPayload(`cat ${join(outside, 'notes.md')}`, root) }, adapters)
        expect(release.decision.decision).not.toBe('allow')
        expect(release.decision.reason.endsWith(notice)).toBe(true)
        const launcher = resolve(dirname(identity.module), '../bin/cockpit.mjs')
        // A spelling the guard cannot prove starts the installed cockpit is held as surely: `/./`, another case, or a path from inside the package's scope.
        const scope = dirname(dirname(dirname(launcher)))
        for (const command of [`${launcher} upgrade`, `${launcher} session --config ${canonicalConfig} -- ${launcher} sync --config ${canonicalConfig}`,
            `node ${scope}/./cockpit/dist/cli.js sync --config ${canonicalConfig} --interactive`, `node ${scope.toUpperCase()}/COCKPIT/dist/cli.js upgrade`,
            `cd ${scope} && node cockpit/dist/cli.js sync --config ${canonicalConfig}`]) {
            expect((await runGuardEvaluationApplication({ ...sync, payload: shellPayload(command, root) }, adapters)).decision.reason, command).toMatch(/^Refusing to run cockpit (sync|upgrade)/)
        }
        expect((await runGuardEvaluationApplication({ ...sync, searchPath: homebrew, payload: shellPayload(`/opt/homebrew/bin/node ${script} sync --config cockpit.toml --dry-run`, root) }, adapters))
            .decision.reason).toMatch(/^Refusing to run cockpit sync/)
        expect(await runGuardEvaluationApplication(sync, adapters)).toMatchObject({ decision: { decision: 'deny',
            reason: `Refusing to run cockpit sync while ${canonicalConfig} has an unapproved edit that widens what agents may do: a person reviews it and syncs.${notice}` } })
    }, 120_000)

    it('admits only the exact restoration of the recorded configuration out of an edit sync cannot apply', async () => {
        const { root, configPath, request, adapters } = await installedGuardRequest()
        const recorded = readFileSync(configPath, 'utf8')
        const call = (tool_name: string, tool_input: unknown): GuardEvaluationApplicationInput => ({ ...request, payload: { hook_event_name: 'PreToolUse', tool_name, cwd: root, tool_input } })
        const write = (content: string, file_path = configPath) => call('Write', { file_path, content })
        const decision = async (input: GuardEvaluationApplicationInput, using = adapters) => (await runGuardEvaluationApplication(input, using)).decision
        const table = '[mcp.allowed_tools]\n'
        const addition = 'nosuchserver = []\n'
        const edited = recorded.replace(table, `${table}${addition}`)

        // The edit reduces, so the guard admits it, and only then does sync find it cannot publish it.
        expect(await decision(write(edited))).toMatchObject({ decision: 'allow' })
        writeFileSync(configPath, edited)
        expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'MCP_DECLARATION_INVALID' }] })

        const patch = (path: string) => `*** Begin Patch\n*** Update File: ${path}\n@@\n [mcp.allowed_tools]\n-nosuchserver = []\n*** End Patch\n`
        // Each hands the file back byte for byte, whichever tool spells it, though removing a restriction is otherwise pinned.
        for (const restore of [write(recorded), write(recorded, 'cockpit.toml'), call('Edit', { file_path: configPath, old_string: addition, new_string: '' }),
            call('apply_patch', { command: patch('cockpit.toml') })]) {
            expect(await decision(restore)).toMatchObject({ decision: 'allow' })
        }
        // Calls are judged under the edit, so the pin keeps the restriction it added against every other
        // change of cockpit.toml, nearly identical or not provably exact.
        for (const other of [
            write(`${recorded}\n`), write(''),
            call('Edit', { file_path: configPath, old_string: 'nosuchserver = []', new_string: '' }),
            call('Edit', { file_path: configPath, old_string: addition, new_string: addition.replace('[]', '["read"]') }),
            // Applied more than once, or not at all, the result is not proven.
            call('Edit', { file_path: configPath, old_string: '\n', new_string: '' }),
            call('Edit', { file_path: configPath, old_string: 'not in the file', new_string: '' }),
            // Another spelling of the file restores nothing, and a call doing more than this is more than a restoration.
            write(recorded, 'app/../cockpit.toml'),
            call('apply_patch', { command: `${patch('cockpit.toml').replace('*** End Patch\n', '')}*** Add File: app/notes.txt\n+added\n*** End Patch\n` }),
            { ...request, payload: shellPayload(`git -C ${root} restore -- cockpit.toml`, root) },
        ]) expect(await decision(other)).toMatchObject({ decision: 'deny' })
        // The same bytes anywhere else are an ordinary write, which the edit leaves as it was.
        expect(await decision(write(recorded, join(root, 'app/cockpit.toml')))).toMatchObject({ decision: 'allow' })

        // A hold whose policy cannot be built has the same way out, because restoring needs no policy.
        const unobserved = { ...adapters, observeCheckout: (async () => ({ state: 'unavailable', reason: 'synthetic' })) as unknown as typeof adapters.observeCheckout }
        expect(await decision(write(`${recorded}\n`), unobserved)).toMatchObject({ decision: 'unavailable', reason: expect.stringContaining('cannot build its policy') })
        expect(await decision(write(recorded), unobserved)).toMatchObject({ decision: 'allow' })

        // A configuration that does not load has the same way out, however it fails to.
        const declared = '[ports.bases]'
        const undeclared = '[ports.not_bases]'
        const invalid = recorded.replace(declared, undeclared)
        for (const broken of [invalid, `${recorded}\n[[[ not toml\n`, `${recorded}\n${'#'.repeat(1_100_000)}\n`]) {
            writeFileSync(configPath, broken)
            const unloaded = await decision(write(`${recorded}\n`))
            expect(unloaded).toMatchObject({ decision: 'unavailable', reason: expect.stringContaining('does not load') })
            expect(unloaded.reason).toContain('.cockpit/local/guard-config')
            expect(await decision({ ...request, payload: shellPayload('ls', root) })).toMatchObject({ decision: 'unavailable' })
            expect(await decision(write(recorded))).toMatchObject({ decision: 'allow' })
        }
        writeFileSync(configPath, invalid)
        expect(await decision(call('Edit', { file_path: configPath, old_string: undeclared, new_string: declared }))).toMatchObject({ decision: 'allow' })
        expect(await decision(call('Edit', { file_path: configPath, old_string: undeclared, new_string: `${declared}\n` }))).toMatchObject({ decision: 'unavailable' })
        // Admitting it still rests on the publication sync wrote for this machine.
        const localIdentity = join(root, GUARD_LOCAL_PATHS.identity)
        const localBytes = readFileSync(localIdentity)
        writeFileSync(localIdentity, encodeGuardLocalIdentity({ ...parseGuardLocalIdentity(localBytes.toString('utf8'))!, moduleSha256: 'f'.repeat(64) }))
        expect(await decision(write(recorded))).toMatchObject({ decision: 'unavailable', reason: expect.stringContaining('machine-local record') })
        writeFileSync(localIdentity, localBytes)

        // Out of a widening edit, calls are judged under the recorded configuration, so restoring it is admitted too.
        const widened = parse(recorded) as { guards: { allow: unknown[] } }
        widened.guards.allow.push({ argv: ['make', 'release'], reason: 'Releases are routine.' })
        writeFileSync(configPath, stringify(widened))
        expect(await decision(write(recorded))).toMatchObject({ decision: 'allow' })
    }, 120_000)

    it.each([
        ['no repository', 'Git could not authenticate', (root: string) => { renameSync(join(root, '.git'), join(root, '.git-aside')) }],
        ['a rejected .git entry', 'Git could not authenticate', (root: string) => { renameSync(join(root, '.git'), join(root, '.git-aside')); mkdirSync(join(root, '.git')) }],
        ['a repository-local include', 'Git configuration origins are unsupported', (root: string) => { execFileSync('git', ['-C', root, 'config', 'include.path', 'included-config']) }],
    ] as const)('holds guarded calls with %s, saying generated files stay valid and why', async (_name, stated, arrange) => {
        const { root, request, adapters } = await installedGuardRequest()
        const config = readFileSync(join(root, '.git/config'))
        arrange(root)
        try {
            const held = await runGuardEvaluationApplication({ ...request, payload: shellPayload('ls', root) }, adapters)
            expect(held).toMatchObject({ decision: { decision: 'unavailable' }, diagnostics: [{ code: 'GUARD_AUTHORITY_UNAVAILABLE' }] })
            expect(held.decision.reason).toContain('Generated files stay valid, but the guard needs a Git repository it can read and holds')
            expect(held.decision.reason).toContain(stated)
            expect(held.decision.reason).toContain(`git -C ${root} init`)
        } finally {
            if (existsSync(join(root, '.git-aside'))) {
                rmSync(join(root, '.git'), { recursive: true, force: true })
                renameSync(join(root, '.git-aside'), join(root, '.git'))
            }
            writeFileSync(join(root, '.git/config'), config)
        }
    }, 120_000)

    it('removes credentials and control characters from a checkout failure it forwards', async () => {
        const { root, request, adapters } = await installedGuardRequest()
        const failed = async () => ({ state: 'failed', reason: 'Git failed: https://someone:hunter2@git.example.test/repo.git\ntoken=hunter3' }) as unknown as ReturnType<typeof adapters.observeCheckout>
        const { decision } = await runGuardEvaluationApplication({ ...request, payload: shellPayload('ls', root) }, { ...adapters, observeCheckout: failed })
        expect(decision.reason).toContain('Git failed: https://[redacted]@git.example.test/repo.git')
        expect(decision.reason).not.toMatch(/hunter[23]/)
    }, 120_000)

    it('carries distinct declared vendor and database authority with authenticated roots and exact instance paths', async () => {
        const { input, root } = await observedPolicy()
        const result = await prepareGuardEvaluationPolicy(input)
        expect(result.kind, JSON.stringify(result)).toBe('complete')
        if (result.kind !== 'complete') throw new Error(JSON.stringify(result))
        const policy = result.result.policy
        expect(policy).toEqual({
            canonicalRoot: root, configPath: join(root, 'cockpit.toml'), allowedRoots: [root, join(root, 'app')],
            instances: ['.env', 'config/runtime.env'].map(path => ({ name: `app-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`, path: join(root, 'app', path) })),
            templates: [join(root, 'app/.env.example'), join(root, 'app/config/template.example')],
            protectedIdentities: expect.any(Array),
            protectedBranches: ['main', 'master'], hostedDatabaseHosts: ['db.example.test'], vendorHosts: ['api.vendor.example.test'],
            declaredAllows: [{ argv: ['make', 'verify'], reason: 'Repository verification is safe.', cwd: root }],
            declaredDenies: [{ match: 'contains', argv: ['--environment', 'shared'], reason: 'Shared environments are human-operated.', fix: 'Use a local environment.' }],
            ripgrepConfigActive: false, externalReads: 'grant', readPaths: [], defaultDecision: 'allow', homeDirectory: realpathSync(homedir()),
            // The running package lives outside this checkout, so no installed directory is in reach; the
            // package itself is carried wherever it is, since a path into it runs cockpit.
            executionDirectories: [], cockpitPackageDirectories: [realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))], searchDirectories: [], searchPathRelativeEntry: null, secretFileIdentities: [], protectedFilesLinked: false,
            cockpitLaunchers: [],
            cockpitInvocations: [], projectCommands: [
                { executable: 'npm', checkoutRoot: join(root, 'app'), kind: 'build', argv: ['run', 'build'] },
                { executable: 'npm', checkoutRoot: join(root, 'app'), kind: 'test', argv: ['test', '--', 'unit.test.ts'] },
            ],
        })
        expect(policy.protectedIdentities.map(item => item.path)).toEqual([...policy.instances.map(item => item.path),
            ...GUARD_ROOT_PROTECTIONS.map(item => join(root, item.path)), join(root, 'cockpit.toml')])
        expect(policy.protectedIdentities[1]).toEqual({ path: join(root, 'app/config/runtime.env'), identity: null,
            ancestors: ['app', 'app/config'].map(path => guardIdentity(lstatSync(join(root, path)))) })
        expect((await prepareGuardEvaluationPolicy(input)).kind).toBe('refusal')
    })

    it('admits the checkout use recorded as another root, with its own instances and project commands, while it exists', async () => {
        const { root, configPath } = await observedPolicy()
        const worktree = join(root, 'app-feature')
        mkdirSync(join(worktree, 'config'), { recursive: true })
        writeFileSync(join(worktree, 'package-lock.json'), '{}')
        mkdirSync(join(root, '.cockpit/local'), { recursive: true })
        writeFileSync(join(root, '.cockpit/local/sibling-checkouts'), JSON.stringify({ format: 'cockpit-sibling-checkouts/v1', checkouts: { app: worktree } }))
        const policy = async () => {
            const loaded = await loadCockpitConfig(configPath)
            if (loaded.kind !== 'complete') throw new Error('guard fixture did not load')
            const checkout = await observeSetupCheckout({ source: loaded.result.source, cockpitName: loaded.result.config.cockpit.name,
                observedAt: new Date().toISOString(), env: {}, gitExecutable })
            const result = await prepareGuardEvaluationPolicy({ configuration: loaded.result, checkout })
            if (result.kind !== 'complete') throw new Error(JSON.stringify(result))
            return result.result.policy
        }
        const served = await policy()
        expect(served.allowedRoots).toEqual([root, join(root, 'app'), worktree])
        expect(served.instances.map(item => item.path)).toEqual(expect.arrayContaining([join(worktree, '.env'), join(worktree, 'config/runtime.env')]))
        expect(served.projectCommands.filter(row => row.checkoutRoot === worktree).map(row => row.kind)).toEqual(['build', 'test'])
        // A recorded checkout that is gone grants nothing.
        rmSync(worktree, { recursive: true })
        expect((await policy()).allowedRoots).toEqual([root, join(root, 'app')])
    })

    it('keeps absent vendor declarations empty despite local sinks and environment values', async () => {
        const { input } = await observedPolicy(false)
        expect(await prepareGuardEvaluationPolicy(input)).toMatchObject({ kind: 'complete', result: { policy: { vendorHosts: [], hostedDatabaseHosts: ['db.example.test'] } } })
    })

    it('binds guard controls to the configuration directory inside a repository', async () => {
        const { root, configPath } = await observedPolicy()
        const cockpitRoot = join(root, 'control')
        mkdirSync(cockpitRoot)
        const nestedConfig = join(cockpitRoot, 'cockpit.toml')
        renameSync(configPath, nestedConfig)
        const declaration = CockpitConfig.parse(parse(readFileSync(nestedConfig, 'utf8')))
        declaration.cockpit.siblings_root = '..'
        writeFileSync(nestedConfig, stringify(declaration))
        const loaded = await loadCockpitConfig(nestedConfig)
        if (loaded.kind !== 'complete') throw new Error('nested configuration did not load')
        const checkout = await observeSetupCheckout({ source: loaded.result.source, cockpitName: loaded.result.config.cockpit.name,
            observedAt: new Date().toISOString(), env: {}, gitExecutable })
        const result = await prepareGuardEvaluationPolicy({ configuration: loaded.result, checkout })
        expect(result.kind, JSON.stringify(result)).toBe('complete')
        if (result.kind !== 'complete') throw new Error(JSON.stringify(result))
        const policy = result.result.policy
        expect(policy.canonicalRoot).toBe(cockpitRoot)
        expect(policy.configPath).toBe(nestedConfig)
        expect(policy.allowedRoots).toEqual([cockpitRoot, join(root, 'app')])
        expect(policy.protectedIdentities.map(row => row.path)).toEqual(expect.arrayContaining([
            nestedConfig, ...GUARD_ROOT_PROTECTIONS.map(row => join(cockpitRoot, row.path)),
        ]))
        const inspect = ({ path, cwd }: { path: string; cwd: string }) => ({ status: 'resolved', path: resolve(cwd, path), symlink: false, identity: null, ancestors: [] })
        expect(evaluateGuard(parseGuardInput(shellPayload(`rm ${nestedConfig}`, root)), policy, inspect).decision).toBe('deny')
        expect(evaluateGuard(parseGuardInput({ hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', cwd: cockpitRoot,
            tool_input: { notebook_path: join(cockpitRoot, '.cockpit/local/analysis.ipynb'), new_source: 'print(1)' } }), policy, inspect).decision).toBe('deny')
    })

    it('issues literal project tuples through authenticated policy', async () => {
        for (const executable of ['npm', 'build tool', 'tool*?[];literal']) {
            const tuple = [executable, '*', '**', '?', '[', ']', 'file[1]?.txt']
            expect(GuardCommandArgv.safeParse(tuple).success).toBe(true)
            const { input, root } = await observedPolicy(true, tuple)
            const result = await prepareGuardEvaluationPolicy(input)
            expect(result.kind, JSON.stringify(result)).toBe('complete')
            if (result.kind !== 'complete') throw new Error(JSON.stringify(result))
            // The strict mode, where only the exact tuple is admitted and every other spelling asks.
            const policy = { ...result.result.policy, defaultDecision: 'ask' as const }
            expect(policy.projectCommands.map(command => [command.executable, ...command.argv])).toEqual([tuple, tuple])
            const rendered = renderGuardProjectCommand(tuple)
            if (rendered.kind !== 'complete') throw new Error(JSON.stringify(rendered))
            const inspect = ({ path, cwd }: { path: string; cwd: string }) => ({ status: 'resolved', path: resolve(cwd, path), symlink: false, identity: null, ancestors: [] })
            const decide = (command: string, cwd = join(root, 'app')) => evaluateGuard(parseGuardInput(shellPayload(command, cwd)), policy, inspect)
            expect(decide(rendered.command).decision).toBe('allow')
            expect(decide(`${rendered.command} extra`).decision).toBe('ask')
            expect(decide(`'${executable}x' '*' '**' '?' '[' ']' 'file[1]?.txt'`).decision).toBe('ask')
            expect(decide(rendered.command, root).decision).toBe('ask')
            expect(decide(`${rendered.command}; curl https://api.vendor.example.test`)).toMatchObject({ decision: 'deny', reason: 'Refusing executable use of a declared vendor host.' })
            tuple[1] = 'changed'
            expect(policy.projectCommands[0]?.argv[0]).toBe('*')
        }
    })

    it('admits logs only for services the declared Compose files resolve to', async () => {
        const { configPath } = fixture()
        const root = realpathSync(dirname(configPath))
        const source = CockpitConfig.parse(parse(readFileSync(new URL('../../../../fixtures/registries/generated-environment.toml', import.meta.url), 'utf8')))
        const environment = source.environment
        mkdirSync(join(root, 'app'), { recursive: true })
        writeFileSync(join(root, 'app/package-lock.json'), '{}')
        writeFileSync(join(root, 'compose.yml'), 'services:\n  api:\n    image: busybox\n  worker:\n    image: busybox\n')
        writeFileSync(configPath, stringify({ ...source, cockpit: { ...source.cockpit, name: 'synthetic-cockpit', siblings_root: root },
            environment: { ...environment, compose_files: ['compose.yml'] } }))
        expect(await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        const identity = parseGuardLocalIdentity(readFileSync(join(root, '.cockpit/local/guard-identity'), 'utf8'))!
        const launcher = resolve(dirname(identity.module), '../bin/cockpit.mjs')
        const adapters = { loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'available' as const, value: gitExecutable }),
            resolveDocker: () => resolveDockerExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH }) }
        const decide = async (service: string) => (await runGuardEvaluationApplication({ identity, guardRoot: root, harness: 'claudecode', cwd: root, searchPath: '/usr/bin:/bin',
            payload: shellPayload(`${launcher} logs --config ${realpathSync(configPath)} --service ${service}`, root) }, adapters)).decision.decision
        // Docker is not a prerequisite of this suite; without it no service name can be admitted.
        const docker = await adapters.resolveDocker()
        if (docker.state !== 'available' && docker.reason === 'Executable was not found in the supplied search path: docker') {
            expect([await decide('worker'), await decide('app')]).toEqual(['unavailable', 'unavailable'])
            return
        }
        expect(await decide('worker')).toBe('allow')
        expect(await decide('app')).toBe('ask')
    }, 120_000)

    it('admits --profile only for a declared default profile that mounts no operator-gated sibling', async () => {
        const { configPath } = fixture()
        const root = realpathSync(dirname(configPath))
        const source = CockpitConfig.parse(parse(readFileSync(new URL('../../../../fixtures/registries/generated-environment.toml', import.meta.url), 'utf8')))
        for (const directory of ['app', 'ops']) mkdirSync(join(root, directory), { recursive: true })
        writeFileSync(join(root, 'app/package-lock.json'), '{}')
        writeFileSync(join(root, 'compose.yml'), ['services:', ...['jobs', 'ops', 'mail'].flatMap(profile => [`  ${profile}:`, '    image: busybox', `    profiles: [${profile}]`])].join('\n') + '\n')
        writeFileSync(configPath, stringify({ ...source, cockpit: { ...source.cockpit, name: 'synthetic-cockpit', siblings_root: root },
            sibling: [...source.sibling, { slug: 'ops', dir: 'ops', mount: 'profile:ops', acquire: 'none', var: 'OPS_DIR', purpose: 'Synthetic live-data lane', gate: 'operator' }],
            environment: { ...source.environment, compose_files: ['compose.yml'], profiles: ['jobs', 'ops'] } }))
        const synced = await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })
        expect(synced, JSON.stringify(synced)).toMatchObject({ kind: 'complete' })
        const identity = parseGuardLocalIdentity(readFileSync(join(root, '.cockpit/local/guard-identity'), 'utf8'))!
        const launcher = resolve(dirname(identity.module), '../bin/cockpit.mjs')
        const config = realpathSync(configPath)
        const adapters = { loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'available' as const, value: gitExecutable }),
            resolveDocker: () => resolveDockerExecutable({ PATH: GUARD_EXECUTABLE_SEARCH_PATH }) }
        const decide = async (command: string) => (await runGuardEvaluationApplication({ identity, guardRoot: root, harness: 'claudecode', cwd: root,
            searchPath: '/usr/bin:/bin', payload: shellPayload(command, root) }, adapters)).decision.decision
        // Docker is not a prerequisite of this suite; without it the guard cannot list services and admits no cockpit command.
        const docker = await adapters.resolveDocker()
        if (docker.state !== 'available' && docker.reason === 'Executable was not found in the supplied search path: docker') {
            expect(await decide(`${launcher} up --config ${config} --profile jobs`)).toBe('unavailable')
            return
        }
        expect(await decide(`${launcher} up --config ${config} --profile jobs`)).toBe('allow')
        expect(await decide(`${launcher} session --config ${config} --profile jobs -- ${launcher} check --config ${config}`)).toBe('allow')
        // An operator gate keeps a live-data lane a person's, and an undeclared profile was never theirs to give.
        for (const profile of ['ops', 'mail']) {
            expect(await decide(`${launcher} up --config ${config} --profile ${profile}`), profile).toBe('ask')
            expect(await decide(`${launcher} session --config ${config} --profile ${profile} -- ${launcher} check --config ${config}`), profile).toBe('ask')
        }
    }, 120_000)

    it('does not infer absent project declarations and refuses missing, ambiguous or symlinked lockfiles', async () => {
        for (const change of ['absent', 'missing', 'ambiguous', 'symlink'] as const) {
            const { root, configPath } = await observedPolicy()
            const config = CockpitConfig.parse(parse(readFileSync(configPath, 'utf8')))
            if (change === 'absent') delete config.environment.install_policies[0]!.build
            if (change === 'missing') rmSync(join(root, 'app/package-lock.json'))
            if (change === 'symlink') { rmSync(join(root, 'app/package-lock.json')); symlinkSync(configPath, join(root, 'app/package-lock.json')) }
            if (change === 'ambiguous') {
                config.environment.install_policies.push({ ...config.environment.install_policies[0]!, lockfile: 'other.lock' })
                writeFileSync(join(root, 'app/other.lock'), '{}')
            }
            writeFileSync(configPath, stringify(config))
            const loaded = await loadCockpitConfig(configPath)
            if (loaded.kind !== 'complete') throw new Error('project command fixture did not load')
            const checkout = await observeSetupCheckout({ source: loaded.result.source, cockpitName: config.cockpit.name, observedAt: new Date().toISOString(), env: {}, gitExecutable })
            const result = await prepareGuardEvaluationPolicy({ configuration: loaded.result, checkout })
            // Only the declared test command becomes a project command; the undeclared build is not inferred.
            if (change === 'absent') expect(result).toMatchObject({ kind: 'complete', result: { policy: { projectCommands: [expect.objectContaining({ kind: 'test', executable: 'npm' })] } } })
            else expect(result, change).toMatchObject({ kind: 'refusal', status: 2, result: null })
        }
    })

    it('refuses copied, modified and cross-config authority', async () => {
        for (const change of ['config-copy', 'checkout-copy', 'config-change', 'source-change', 'cross-config'] as const) {
            const { input } = await observedPolicy()
            if (change === 'config-copy') input.configuration = { ...input.configuration }
            if (change === 'checkout-copy') input.checkout = { ...input.checkout }
            if (change === 'config-change') input.configuration.config.guards.vendor_endpoint_hosts.push('changed.example.test')
            if (change === 'source-change') input.configuration.source.sha256 = '0'.repeat(64)
            if (change === 'cross-config') input.configuration = (await observedPolicy()).input.configuration
            expect(await prepareGuardEvaluationPolicy(input), change).toMatchObject({ kind: 'refusal', status: 2, result: null })
        }
    })

    it('refuses changed source bytes, roots and symlinked instance parents without reading instance contents', async () => {
        for (const change of ['source', 'root', 'instance-parent', 'instance-leaf'] as const) {
            const { input, root, configPath } = await observedPolicy()
            if (change === 'source') writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}\n# changed authority\n`)
            if (change === 'root') {
                rmSync(join(root, 'app'), { recursive: true })
                symlinkSync(root, join(root, 'app'))
            }
            if (change === 'instance-parent') {
                rmSync(join(root, 'app/config'), { recursive: true })
                symlinkSync(root, join(root, 'app/config'))
            }
            if (change === 'instance-leaf') symlinkSync(configPath, join(root, 'app/config/runtime.env'))
            expect(await prepareGuardEvaluationPolicy(input), change).toMatchObject({ kind: 'refusal', status: 2, result: null })
        }
    })

    it('refuses expired observations and accessors without invoking them', async () => {
        const { input } = await observedPolicy()
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
        try { expect((await prepareGuardEvaluationPolicy(input)).kind).toBe('refusal') }
        finally { clock.mockRestore() }
        const fresh = await observedPolicy()
        let reads = 0
        const hostile = Object.defineProperty({ ...fresh.input }, 'configuration', { enumerable: true, get() { reads += 1; return fresh.input.configuration } })
        expect((await prepareGuardEvaluationPolicy(hostile)).kind).toBe('refusal')
        expect(reads).toBe(0)
    })
})

afterEach(() => {
    vi.restoreAllMocks()
    if (sharedInstalledGuard) restoreInstalledGuardFixture(sharedInstalledGuard)
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})
afterAll(() => {
    if (sharedInstalledGuardRoot) rmSync(sharedInstalledGuardRoot, { recursive: true, force: true })
    rmSync(gitDirectory, { recursive: true, force: true })
})

const { fixture } = createApplicationFixtureSupport(scratch, gitExecutable)
