import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, renameSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'smol-toml'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as generatedCurrentnessOwner from './generated-application.js'
import { executeProbe } from '../environment-exec/execute.js'
import { GUARD_EXECUTABLE_SEARCH_PATH, resolveDockerExecutable } from './executable.js'
import { evaluateGuard, GUARD_ROOT_PROTECTIONS, guardIdentity } from '../guards/evaluator.js'
import { parseGuardInput } from '../guards/invocation-parser.js'
import { encodeGuardLocalIdentity, parseGuardLocalIdentity } from '../guards/local-identity.js'
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
        const digest = '0'.repeat(64)
        const identity = {
            root, rootDevice: '0', rootInode: '0', configPath, configSha256: digest,
            configDevice: '0', configInode: '0', node: process.execPath, nodeSha256: digest,
            nodeFingerprint: 'synthetic', module: join(base, 'other-cli.js'), moduleSha256: digest,
        }
        const result = await runGuardEvaluationApplication({ identity, guardRoot: root, payload: {}, harness: 'claudecode', cwd: root }, {
            loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'unavailable', reason: 'not reached' }),
        })
        const command = /run `([^`]+)` in a terminal/.exec(result.decision.reason)?.[1]
        expect(command, result.decision.reason).toBeDefined()
        const captured = spawnSync('/bin/bash', ['-c', `npx() { printf '<%s>\\n' "$@"; }; ${command}`], { encoding: 'utf8' })
        expect(captured).toMatchObject({ status: 0, stderr: '', stdout: `<--no>\n<cockpit>\n<sync>\n<--config>\n<${configPath}>\n` })
    })

    it('delimits a dash-prefixed configuration filename in application restore guidance', async () => {
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
            root, rootDevice: String(rootStatus.dev), rootInode: String(rootStatus.ino), configPath, configSha256: digest,
            configDevice: '0', configInode: '0', node: process.execPath, nodeSha256: digest,
            nodeFingerprint: 'synthetic', module: realpathSync(fileURLToPath(new URL('../../dist/cli.js', import.meta.url))), moduleSha256: digest,
        }
        const result = await runGuardEvaluationApplication({ identity, guardRoot: root, payload: {}, harness: 'claudecode', cwd: root }, {
            loadConfig: loadCockpitConfig, observeCheckout: observeSetupCheckout,
            resolveGit: async () => ({ state: 'unavailable', reason: 'not reached' }),
        })
        const command = /restore it with `([^`]+)`/.exec(result.decision.reason)?.[1]
        expect(command, result.decision.reason).toBeDefined()
        const captured = spawnSync('/bin/bash', ['-c', `git() { printf '<%s>\\n' "$@"; }; ${command}`], { encoding: 'utf8' })
        expect(captured).toMatchObject({ status: 0, stderr: '', stdout: `<-C>\n<${root}>\n<restore>\n<-->\n<${configFile}>\n` })
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
        const module = steps.filter(({ step }) => step.cwd !== root)
        const moduleRoot = realpathSync(new URL('../../dist', import.meta.url))
        expect(module.map(({ checkpoint, step }) => ({ checkpoint, cwd: step.cwd, action: step.labels.action }))).toEqual([
            { checkpoint: 0, cwd: moduleRoot, action: 'read-file' },
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
        } finally { for (const path of created) rmSync(path, { recursive: true, force: true }) }
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
                : change === 'missing' ? `.cockpit/guards/bash-guard.sh is missing; it authenticates the guard and the hook that launches it, so every tool call is held, including a sync run through this agent. Fix: a human must restore it with \`git -C ${root} restore -- .cockpit/guards/bash-guard.sh\``
                    : 'could not be read or revalidated',
        ) } })
        expect(observeCheckout).toHaveBeenCalledTimes(change === 'changed' ? 1 : 0)
        expect(loads).toBe(change === 'changed' ? 2 : 1)
    }, 120_000)

    it.each([
        // Restoring committed bytes clears the hold by itself: the guard authenticates their content.
        ['cockpit.toml', 'guard policy comes from it', true],
        ['.cockpit/generated-environment-ownership.json', 'it authenticates the guard and the hook that launches it', true],
        ['.claude/settings.json', 'it authenticates the guard and the hook that launches it', true],
        ['.cockpit/local/guard-identity', 'it records the Node executable and cockpit handler on this machine, which committed files cannot carry', false],
    ] as const)('names a deleted %s, why every call is held, and the fix', async (file, why, restorable) => {
        const { root, configPath, request, adapters } = await installedGuardRequest()
        // A rename keeps the file's identity, so the shared fixture stays authenticated afterwards.
        renameSync(join(root, file), join(root, `${file}.away`))
        try {
            const { decision } = await runGuardEvaluationApplication(request, adapters)
            expect(decision.decision).toBe('unavailable')
            expect(decision.reason).toContain(`${file === 'cockpit.toml' ? configPath : file} is missing; ${why}, so every tool call is held`)
            expect(decision.reason).toContain(restorable
                ? `Fix: a human must restore it with \`git -C ${root} restore -- ${file}\` (it is committed), or run \`npx --no cockpit sync --config ${configPath}\``
                : `Fix: a human must run \`npx --no cockpit sync --config ${configPath}\` in a terminal, outside the agent`)
        } finally { renameSync(join(root, `${file}.away`), join(root, file)) }
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
        // An edited configuration holds every call until a human regenerates, and the reason says which file and how.
        const canonicalConfig = realpathSync(configPath)
        expect(await runGuardEvaluationApplication(request, adapters)).toMatchObject({ decision: { decision: 'unavailable', reason:
            `${canonicalConfig} changed since the guards were generated; guard policy comes from it and an edit takes effect only once a human approves it, so every tool call is held, including a sync run through this agent. Fix: a human must run \`npx --no cockpit sync --config ${canonicalConfig}\` in a terminal, outside the agent, then commit any regenerated files.` } })
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
            ripgrepConfigActive: false,
            // The running package lives outside this checkout, so no installed directory is in reach.
            executionDirectories: [], searchDirectories: [], searchPathRelativeEntry: null, secretFileIdentities: [], protectedFilesLinked: false,
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
            const { policy } = result.result
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
