import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { Sibling } from '../schema.js'
import { executePlan } from '../environment-exec/execute.js'
import { observeSetupPath } from './setup-observation.js'
import { gitEnvironment, planSetup as planSetupRaw, type PlanSetupInput, type SetupObservation, type SetupPathEvidence } from './setup.js'

const scratch: string[] = []
const env = { PATH: process.env.PATH ?? '' }
const gitInvocationPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
const gitToolDirectory = mkdtempSync(join(tmpdir(), 'cockpit-git-tool-'))
const gitCanonicalPath = join(gitToolDirectory, 'git-executable')
writeFileSync(gitCanonicalPath, `#!/bin/sh\nexec ${JSON.stringify(gitInvocationPath)} "$@"\n`, { mode: 0o700 })
const gitExecutable = {
    canonicalPath: gitCanonicalPath,
    invocationPath: gitInvocationPath,
    sha256: createHash('sha256').update(readFileSync(gitCanonicalPath)).digest('hex'),
    executionMode: 'verified-path' as const,
}
const planSetup = (input: Omit<PlanSetupInput, 'gitExecutable'>) =>
    planSetupRaw({ ...input, gitExecutable } as PlanSetupInput)
const sibling = (overrides: Partial<Sibling> = {}): Sibling => ({
    slug: 'api', dir: 'api', remote: 'ssh://example.invalid/api.git', branch: 'main', mount: 'always',
    acquire: 'auto', var: 'API_DIR', toolchain: 'node', guides: [], purpose: 'Synthetic API', instruction_pointer: false,
    ...overrides,
})
const observed = (value: SetupPathEvidence): SetupObservation => ({
    state: 'available', value, observedAt: '2026-09-07T00:00:00.000Z', producer: 'synthetic-test',
})

afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }) })
afterAll(() => rmSync(gitToolDirectory, { recursive: true, force: true }))

function root(): string {
    const path = mkdtempSync(join(tmpdir(), 'cockpit-setup-'))
    scratch.push(path)
    return realpathSync(path)
}

describe('setup planner', () => {
    it('refuses a caller-supplied executable under the wrong invocation name', async () => {
        const outcome = await planSetupRaw({
            siblingsRoot: root(), sibling: sibling(), observation: observed({ kind: 'absent' }), env,
            gitExecutable: { ...gitExecutable, invocationPath: '/usr/bin/not-git' },
        })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ message: expect.stringContaining('identity') })])
    })

    it('owns caller-supplied executable identity before deriving setup steps', async () => {
        let reads = 0
        const volatile = { invocationPath: gitInvocationPath, sha256: gitExecutable.sha256, executionMode: 'verified-path' as const }
        Object.defineProperty(volatile, 'canonicalPath', {
            enumerable: true,
            get: () => ++reads === 1 ? gitCanonicalPath : '/tmp/relabelled-git',
        })

        const outcome = await planSetupRaw({
            siblingsRoot: root(), sibling: sibling(), observation: observed({ kind: 'absent' }), env,
            gitExecutable: volatile as typeof gitExecutable,
        })

        expect(outcome.kind).toBe('preview')
        if (outcome.kind !== 'preview') return
        expect(outcome.plan.steps[0].argv[0]).toBe(gitCanonicalPath)
        expect(reads).toBe(1)
    })

    it('resolves absent auto checkout to an exact confined clone', async () => {
        const siblingsRoot = root()
        const outcome = await planSetup({ siblingsRoot, sibling: sibling(), observation: observed({ kind: 'absent' }), env })
        expect(outcome.kind).toBe('preview')
        if (outcome.kind !== 'preview') return
        expect(outcome.plan.steps).toHaveLength(1)
        expect(outcome.plan.steps[0].argv).toEqual([
            gitCanonicalPath, 'clone', '--branch', 'main', '--', 'ssh://example.invalid/api.git', join(siblingsRoot, 'api'),
        ])
        expect(outcome.plan.steps[0]).toEqual(expect.objectContaining({
            argv0: gitInvocationPath,
            consumedFiles: [{ path: gitCanonicalPath, sha256: gitExecutable.sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: 'verified-path' }],
        }))
    })

    it('wires a manual checkout without cloning and becomes a no-op when already exact', async () => {
        const siblingsRoot = root()
        const declared = sibling({ acquire: 'manual' })
        const missingRemote = await planSetup({
            siblingsRoot, sibling: declared, observation: observed({ kind: 'repository', remotes: {} }), env,
        })
        expect(missingRemote.kind).toBe('preview')
        if (missingRemote.kind === 'preview') expect(missingRemote.plan.steps[0].argv).toEqual([
            gitCanonicalPath, '-C', join(siblingsRoot, 'api'), 'remote', 'add', '--', 'origin', 'ssh://example.invalid/api.git',
        ])
        const exact = await planSetup({
            siblingsRoot, sibling: declared,
            observation: observed({ kind: 'repository', remotes: { origin: 'ssh://example.invalid/api.git' } }), env,
        })
        expect(exact).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
    })

    it.each(['target', 'git directory', 'common directory', 'target ancestor'] as const)(
        'refuses a remote mutation after the observed %s is replaced',
        async (replacement) => {
            const siblingsRoot = root()
            const main = join(siblingsRoot, 'main')
            const targetParent = join(siblingsRoot, 'group')
            const target = join(targetParent, 'api')
            mkdirSync(targetParent)
            execFileSync('git', ['init', '--quiet', '--initial-branch=main', main])
            writeFileSync(join(main, 'seed'), 'seed\n')
            execFileSync('git', ['-C', main, 'add', 'seed'])
            execFileSync('git', ['-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'seed'])
            execFileSync('git', ['-C', main, 'worktree', 'add', '--quiet', '--detach', target])
            const gitDirectory = execFileSync('git', ['-C', target, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim()
            const commonDirectory = execFileSync('git', ['-C', target, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()
            const currentRemote = replacement === 'git directory' || replacement === 'target ancestor'
                ? 'ssh://example.invalid/old.git'
                : undefined
            if (currentRemote) execFileSync('git', ['-C', target, 'remote', 'add', 'origin', currentRemote])
            const observation = await observeSetupPath(target, siblingsRoot, gitEnvironment(env), gitExecutable)
            expect(observation).toMatchObject({ state: 'available' })
            const outcome = await planSetup({
                siblingsRoot,
                sibling: sibling({ acquire: 'manual' }),
                observation,
                env,
            })
            expect(outcome.kind).toBe('preview')
            if (outcome.kind !== 'preview') return

            if (replacement === 'target') {
                renameSync(target, `${target}.observed`)
                mkdirSync(target)
                cpSync(join(`${target}.observed`, '.git'), join(target, '.git'))
            } else if (replacement === 'git directory') {
                renameSync(gitDirectory, `${gitDirectory}.observed`)
                cpSync(`${gitDirectory}.observed`, gitDirectory, { recursive: true })
            } else if (replacement === 'common directory') {
                renameSync(commonDirectory, `${commonDirectory}.observed`)
                cpSync(`${commonDirectory}.observed`, commonDirectory, { recursive: true })
            } else {
                renameSync(targetParent, `${targetParent}.observed`)
                mkdirSync(targetParent)
                renameSync(join(`${targetParent}.observed`, 'api'), target)
            }

            await expect(executePlan(outcome.plan)).resolves.toEqual(expect.objectContaining({
                kind: 'refusal',
                diagnostics: [expect.objectContaining({ code: 'EXECUTION_PRECONDITION_CHANGED' })],
            }))
            if (currentRemote) {
                expect(execFileSync('git', ['-C', target, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim())
                    .toBe(currentRemote)
            } else {
                expect(() => execFileSync('git', ['-C', target, 'remote', 'get-url', 'origin'], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                })).toThrow()
            }
        },
    )

    it('sets a mismatched manual remote but refuses to repoint an auto checkout', async () => {
        const siblingsRoot = root()
        const observation = observed({ kind: 'repository', remotes: { origin: 'ssh://example.invalid/other.git' } })
        const manual = await planSetup({ siblingsRoot, sibling: sibling({ acquire: 'manual' }), observation, env })
        expect(manual.kind).toBe('preview')
        if (manual.kind === 'preview') expect(manual.plan.steps[0].argv).toContain('set-url')
        const auto = await planSetup({ siblingsRoot, sibling: sibling(), observation, env })
        expect(auto).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(auto.diagnostics).toEqual([expect.objectContaining({ code: 'SETUP_REMOTE_MISMATCH' })])
    })

    it.each([
        { label: 'add', current: undefined, verb: 'add' },
        { label: 'set-url', current: 'ssh://example.invalid/old.git', verb: 'set-url' },
    ])('terminates remote options before an option-like declared URL for $label', async ({ current, verb }) => {
        const siblingsRoot = root()
        const target = join(siblingsRoot, 'api')
        mkdirSync(target)
        execFileSync('git', ['init', '--quiet', target])
        if (current) execFileSync('git', ['-C', target, 'remote', 'add', 'origin', current])
        const remote = '--add=synthetic.invalid/repository.git'
        const outcome = await planSetup({
            siblingsRoot,
            sibling: sibling({ acquire: 'manual', remote }),
            observation: observed({ kind: 'repository', remotes: current ? { origin: current } : {} }),
            env,
        })

        expect(outcome.kind).toBe('preview')
        if (outcome.kind !== 'preview') return
        expect(outcome.plan.steps[0].argv).toEqual([
            gitCanonicalPath, '-C', target, 'remote', verb, '--', 'origin', remote,
        ])
        expect(await executePlan(outcome.plan)).toEqual(expect.objectContaining({ kind: 'complete' }))
        expect(execFileSync('git', ['-C', target, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim())
            .toBe(remote)
    })

    it('refuses an automatic checkout whose origin is missing', async () => {
        const outcome = await planSetup({
            siblingsRoot: root(), sibling: sibling(), observation: observed({ kind: 'repository', remotes: {} }), env,
        })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: 'SETUP_REMOTE_MISMATCH' })])
    })

    it('reports manual absence without emitting Git', async () => {
        const manual = await planSetup({
            siblingsRoot: root(), sibling: sibling({ acquire: 'manual' }), observation: observed({ kind: 'absent' }), env,
        })
        expect(manual).toEqual(expect.objectContaining({ kind: 'complete', result: expect.objectContaining({ action: 'report' }) }))
        expect(manual.diagnostics).toEqual([expect.objectContaining({ code: 'SETUP_MANUAL_MISSING' })])
    })

    it.each([
        { kind: 'absent', message: 'acquire = "none", so setup leaves this path alone: nothing exists there yet' },
        { kind: 'directory', message: 'acquire = "none", so setup leaves this path alone: it is a plain directory, not a Git checkout' },
        { kind: 'repository', message: 'acquire = "none", so setup leaves this path alone: it is an existing Git checkout' },
    ] as const)('preserves and reports none observation $kind', async ({ kind, message }) => {
        const outcome = await planSetup({
            siblingsRoot: root(), sibling: sibling({ acquire: 'none', remote: undefined }), observation: observed({ kind }), env,
        })

        expect(outcome).toEqual(expect.objectContaining({
            kind: 'complete',
            diagnostics: [expect.objectContaining({ code: `SETUP_NONE_${kind.toUpperCase()}`, message })],
            result: expect.objectContaining({ action: 'report', observed: kind }),
        }))
    })

    it.each([
        { dir: '../escape', observation: { kind: 'absent' } as const, code: 'SETUP_PATH_OUTSIDE_ROOT' },
        { dir: 'api', observation: { kind: 'symlink' } as const, code: 'SETUP_PATH_SYMLINK' },
        { dir: 'api', observation: { kind: 'directory' } as const, code: 'SETUP_PATH_TYPE_INVALID' },
    ])('refuses unsafe target $code', async ({ dir, observation, code }) => {
        const outcome = await planSetup({ siblingsRoot: root(), sibling: sibling({ dir }), observation: observed(observation), env })
        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code })])
    })

    it('preserves an actionable observation error from the filesystem adapter', async () => {
        const outcome = await planSetup({
            siblingsRoot: root(),
            sibling: sibling(),
            observation: {
                state: 'failed',
                code: 'SETUP_PATH_TYPE_INVALID',
                reason: 'a sibling path component could not be inspected (EACCES)',
                producer: 'synthetic-test',
            },
            env,
        })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(outcome.diagnostics).toEqual([
            expect.objectContaining({
                code: 'SETUP_PATH_TYPE_INVALID',
                message: 'a sibling path component could not be inspected (EACCES)',
            }),
        ])
    })

    it('refuses an escaped path before asking an adapter to observe it', async () => {
        const observe = vi.fn(async () => observed({ kind: 'absent' }))
        const outcome = await planSetup({ siblingsRoot: root(), sibling: sibling({ dir: '../escape' }), observe, env })
        expect(outcome.kind).toBe('refusal')
        expect(observe).not.toHaveBeenCalled()
    })

    it('clones a relative local remote and then accepts the origin Git recorded', async () => {
        const siblingsRoot = root()
        execFileSync('git', ['init', '--quiet', '--bare', join(siblingsRoot, 'api.git')])
        const declared = sibling({ remote: 'api.git', branch: undefined })
        const clone = await planSetup({ siblingsRoot, sibling: declared, observation: observed({ kind: 'absent' }), env })
        expect(clone.kind).toBe('preview')
        if (clone.kind !== 'preview') return
        expect(await executePlan(clone.plan)).toEqual(expect.objectContaining({ kind: 'complete' }))
        const origin = execFileSync('git', ['-C', join(siblingsRoot, 'api'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
        const again = await planSetup({
            siblingsRoot, sibling: declared, observation: observed({ kind: 'repository', remotes: { origin } }), env,
        })
        expect(again).toEqual(expect.objectContaining({ kind: 'complete', diagnostics: [] }))
        const stored = await planSetup({
            siblingsRoot, sibling: declared, observation: observed({ kind: 'repository', remotes: { origin: 'api.git' } }), env,
        })
        expect(stored.kind).toBe('complete')
        const other = await planSetup({
            siblingsRoot, sibling: declared, observation: observed({ kind: 'repository', remotes: { origin: 'other.git' } }), env,
        })
        expect(other.kind).toBe('refusal')
    })

    it('refuses with a named code when a local remote path cannot be resolved', async () => {
        const siblingsRoot = root()
        // A path through a regular file fails realpath with ENOTDIR, not the ENOENT of a missing path.
        writeFileSync(join(siblingsRoot, 'plain-file'), 'not a directory')
        const declared = sibling({ remote: 'plain-file/api.git', branch: undefined })
        const unresolved = expect.objectContaining({
            code: 'SETUP_REMOTE_UNRESOLVABLE',
            message: expect.stringMatching(/"plain-file\/api\.git".*ENOTDIR/),
            fix: expect.stringContaining('./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup'),
        })

        const clone = await planSetup({ siblingsRoot, sibling: declared, observation: observed({ kind: 'absent' }), env })
        expect(clone).toEqual(expect.objectContaining({ kind: 'refusal', status: 2, diagnostics: [unresolved] }))

        const wiring = await planSetup({
            siblingsRoot, sibling: sibling({ remote: 'api.git', branch: undefined, acquire: 'manual' }),
            observation: observed({ kind: 'repository', remotes: { origin: 'plain-file/api.git' } }), env,
        })
        expect(wiring).toEqual(expect.objectContaining({ kind: 'refusal', status: 2, diagnostics: [unresolved] }))
    })

    it('keeps option-like remote and branch values as single argv elements', async () => {
        const outcome = await planSetup({
            siblingsRoot: root(), sibling: sibling({ remote: '--upload-pack=touch injected', branch: '-danger' }),
            observation: observed({ kind: 'absent' }), env,
        })
        expect(outcome.kind).toBe('preview')
        if (outcome.kind === 'preview') {
            expect(outcome.plan.steps[0].argv).toContain('--upload-pack=touch injected')
            expect(outcome.plan.steps[0].argv).toContain('-danger')
        }
    })

    it('builds a minimal Git environment and excludes ambient redirects and secrets', async () => {
        const childEnvironment = gitEnvironment({
            PATH: process.env.PATH ?? '',
            HOME: '/tmp/synthetic-home',
            Path: '/case-preserved-search-only',
            UNRELATED_SECRET: 'secret-canary',
        })
        expect(childEnvironment).toEqual({
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            HOME: '/tmp/synthetic-home',
            PATH: process.env.PATH ?? '',
        })

        const outcome = await planSetup({
            siblingsRoot: root(),
            sibling: sibling(),
            observation: observed({ kind: 'absent' }),
            env: {
                PATH: process.env.PATH ?? '',
                HOME: '/tmp/synthetic-home',
                Path: '/case-preserved-search-only',
                GIT_DIR: '/tmp/redirected.git',
                GIT_WORK_TREE: '/tmp/redirected-tree',
                GIT_CONFIG_COUNT: '1',
                GIT_CONFIG_KEY_0: 'credential.helper',
                GIT_CONFIG_VALUE_0: 'echo secret-canary',
                GIT_SSH_COMMAND: 'echo secret-canary',
                UNRELATED_SECRET: 'secret-canary',
            },
        })

        expect(outcome.kind).toBe('preview')
        if (outcome.kind !== 'preview') return
        expect(outcome.plan.steps[0].env).toEqual({
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            HOME: '/tmp/synthetic-home',
            PATH: process.env.PATH ?? '',
        })
        expect(JSON.stringify(outcome)).not.toContain('secret-canary')
        expect(JSON.stringify(outcome)).not.toContain('redirected.git')
        expect(JSON.stringify(outcome)).not.toContain('case-preserved-search-only')
    })

    it('executes only the digest-bound Git bytes when PATH cannot resolve Git', async () => {
        const siblingsRoot = root()
        const target = join(siblingsRoot, 'api')
        mkdirSync(target)
        execFileSync('git', ['init', '--quiet', target])
        const outcome = await planSetup({
            siblingsRoot, sibling: sibling({ acquire: 'manual' }), observation: observed({ kind: 'repository', remotes: {} }), env: { PATH: '/untrusted' },
        })
        expect(outcome.kind).toBe('preview')
        if (outcome.kind !== 'preview') return
        expect(await executePlan(outcome.plan)).toEqual(expect.objectContaining({ kind: 'complete' }))
        expect(execFileSync('git', ['-C', target, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim())
            .toBe('ssh://example.invalid/api.git')
    })
})
