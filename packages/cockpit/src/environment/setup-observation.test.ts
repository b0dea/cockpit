import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkoutId, cockpitId } from './identity.js'
import { resolveGitExecutable } from './executable.js'
import {
    consumeSetupCheckoutProjection,
    observeEnvironmentIgnore,
    observeSetupPath,
    observeSetupCheckout,
    observeGeneratedCheckoutIdentity,
    observeSurfacesCheckoutIdentity,
    revalidateGeneratedCheckoutIdentity,
    withSetupCheckoutProjection,
    type SetupCheckoutProjection,
} from './setup-observation.js'
import { gitEnvironment } from './setup.js'
import { formatShellCommand } from '../fix-catalogue.js'

const directoryResolutionControl = vi.hoisted(() => ({
    path: undefined as string | undefined,
    mutation: undefined as (() => Promise<void>) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        realpath: async (...args: Parameters<typeof actual.realpath>) => {
            const result = await actual.realpath(...args)
            if (typeof args[0] === 'string' && args[0] === directoryResolutionControl.path && directoryResolutionControl.mutation) {
                const mutation = directoryResolutionControl.mutation
                directoryResolutionControl.path = undefined
                directoryResolutionControl.mutation = undefined
                await mutation()
            }
            return result
        },
    }
})

const run = promisify(execFile)
const scratch: string[] = []
const declaration = { template: '.env.example', instance: '.env' }

function workspaceForConfig(): string {
    const path = join(realpathSync(tmpdir()), `cockpit-config-${randomUUID()}`)
    scratch.push(path)
    return path
}

function configText(overrides = ''): string {
    return `[cockpit]\nname = "sample"\nsiblings_root = "."\n\n[[sibling]]\nslug = "service"\ndir = "."\nremote = "https://example.invalid/service.git"\nmount = "none"\nacquire = "manual"\nvar = "SERVICE_DIR"\npurpose = "synthetic service"\n${overrides}\n[[sibling.environment_files]]\ntemplate = ".env.example"\ninstance = ".env"\n\n[ports]\nbases = { APP_PORT = 4100 }\n`
}

async function repository(): Promise<string> {
    const root = join(tmpdir(), `cockpit-ignore-${randomUUID()}`)
    scratch.push(root)
    return initializeRepository(root)
}

async function initializeRepository(root: string): Promise<string> {
    await mkdir(root, { recursive: true })
    await run('git', ['init', '--quiet', root])
    await writeFile(join(root, 'cockpit.toml'), configText())
    await writeFile(join(root, declaration.template), 'PUBLIC_NAME=\n')
    await writeFile(join(root, '.gitignore'), `${declaration.instance}\n`)
    await run('git', ['-C', root, 'add', 'cockpit.toml', declaration.template, '.gitignore'])
    return realpath(root)
}

async function authority(root: string, observedAt = new Date().toISOString()) {
    const resolved = await resolveGitExecutable(Object.freeze({ PATH: process.env.PATH ?? '' }))
    if (resolved.state !== 'available') throw new Error(resolved.reason)
    const bytes = await readFile(join(root, 'cockpit.toml'))
    return {
        source: {
            path: join(root, 'cockpit.toml'),
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        siblingIndex: 0,
        siblingSlug: 'service',
        mainCheckoutPath: root,
        siblingsRoot: root,
        siblingRoot: root,
        checkoutId: checkoutId({ checkoutPath: root }),
        environmentFileIndex: 0,
        environmentFile: declaration,
        observedAt,
        env: Object.freeze({ PATH: process.env.PATH ?? '' }),
        gitExecutable: resolved.value,
    }
}

async function committedRepository(options: { separateGitDirectory?: boolean } = {}): Promise<{
    root: string
    main: string
    gitDirectory?: string
}> {
    const root = join(tmpdir(), `cockpit-checkout-${randomUUID()}`)
    const main = join(root, 'main')
    const gitDirectory = options.separateGitDirectory ? join(root, 'repository.git') : undefined
    scratch.push(root)
    await mkdir(root)
    await run('git', [
        'init', '--quiet', '--initial-branch=main',
        ...(gitDirectory ? [`--separate-git-dir=${gitDirectory}`] : []),
        main,
    ])
    await writeFile(join(main, 'cockpit.toml'), '[cockpit]\nname = "sample"\n')
    await run('git', ['-C', main, 'add', 'cockpit.toml'])
    await run('git', ['-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'seed'])
    return { root: await realpath(root), main: await realpath(main), ...(gitDirectory ? { gitDirectory: await realpath(gitDirectory) } : {}) }
}

async function checkoutAuthority(
    configPath: string,
    observedAt = new Date().toISOString(),
    env: Readonly<Record<string, string>> = Object.freeze({ PATH: process.env.PATH ?? '' }),
) {
    const bytes = await readFile(configPath)
    const resolved = await resolveGitExecutable(env)
    if (resolved.state !== 'available') throw new Error(resolved.reason)
    return {
        source: {
            path: configPath,
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        cockpitName: 'sample',
        observedAt,
        env,
        gitExecutable: resolved.value,
    }
}

afterEach(async () => {
    vi.useRealTimers()
    directoryResolutionControl.path = undefined
    directoryResolutionControl.mutation = undefined
    await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('setup path observation', () => {
    async function executable(env: Readonly<Record<string, string>> = { PATH: process.env.PATH ?? '' }) {
        const resolved = await resolveGitExecutable(env)
        if (resolved.state !== 'available') throw new Error(resolved.reason)
        return resolved.value
    }

    it('classifies a checkout whose .git entry is a symbolic link', async () => {
        const root = workspaceForConfig()
        const target = join(root, 'service')
        const external = join(root, 'external.git')
        await mkdir(target, { recursive: true })
        await run('git', ['init', '--quiet', '--bare', external])
        await symlink(external, join(target, '.git'))
        const env = gitEnvironment({ PATH: process.env.PATH ?? '' })

        const observation = await observeSetupPath(target, root, env, await executable(env))

        expect(observation).toMatchObject({ state: 'available', value: { kind: 'symlink' } })
    })

    it('names the first absent parent of a nested checkout', async () => {
        const root = workspaceForConfig()
        await mkdir(root)
        const target = join(root, 'group', 'service')
        const env = gitEnvironment({ PATH: process.env.PATH ?? '' })

        const observation = await observeSetupPath(target, root, env, await executable(env))

        expect(observation).toMatchObject({
            state: 'available',
            value: { kind: 'absent', missingParent: join(root, 'group') },
        })
    })

    it('does not substitute another remote when origin has no URL', async () => {
        const root = workspaceForConfig()
        const target = join(root, 'service')
        await mkdir(target, { recursive: true })
        await run('git', ['init', '--quiet', target])
        await run('git', ['-C', target, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
        await run('git', ['-C', target, 'remote', 'add', 'upstream', 'https://example.invalid/upstream.git'])
        const env = gitEnvironment({ PATH: process.env.PATH ?? '' })

        const observation = await observeSetupPath(target, root, env, await executable(env))

        expect(observation).toMatchObject({ state: 'available', value: { kind: 'repository', remotes: {} } })
    })

    it('reports malformed Git metadata instead of classifying an ordinary directory', async () => {
        const root = workspaceForConfig()
        const target = join(root, 'service')
        await mkdir(target, { recursive: true })
        await writeFile(join(target, '.git'), 'not a gitdir\n')
        const env = gitEnvironment({ PATH: process.env.PATH ?? '' })

        const observation = await observeSetupPath(target, root, env, await executable(env))

        expect(observation).toMatchObject({ state: 'failed', reason: 'Git could not identify the checkout' })
    })

    it('returns a named failure when the checkout is replaced during its identity probe', async () => {
        const root = workspaceForConfig()
        const target = join(root, 'service')
        const bin = join(root, 'bin')
        await mkdir(join(target, '.git'), { recursive: true })
        await mkdir(bin)
        const fakeGit = join(bin, 'git')
        await writeFile(fakeGit, [
            '#!/usr/bin/env node',
            "const fs = require('node:fs')",
            `process.stdout.write(${JSON.stringify(`${target}\n${join(target, '.git')}\n${join(target, '.git')}\n`)})`,
            `fs.rmSync(${JSON.stringify(target)}, { recursive: true, force: true })`,
        ].join('\n'))
        await chmod(fakeGit, 0o755)
        const ambient = { PATH: `${bin}:${process.env.PATH ?? ''}` }
        const env = gitEnvironment(ambient)

        const observation = await observeSetupPath(target, root, env, await executable(ambient))

        expect(observation).toMatchObject({
            state: 'failed',
            reason: 'checkout identity changed during observation',
        })
    })

    it('accepts a linked checkout whose Git directory remains inside the siblings root', async () => {
        const root = workspaceForConfig()
        const primary = join(root, 'primary')
        const target = join(root, 'service')
        await mkdir(primary, { recursive: true })
        await run('git', ['init', '--quiet', primary])
        await writeFile(join(primary, 'tracked'), 'value')
        await run('git', ['-C', primary, 'add', 'tracked'])
        await run('git', ['-C', primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'seed'])
        await run('git', ['-C', primary, 'remote', 'add', 'origin', 'https://example.invalid/service.git'])
        await run('git', ['-C', primary, 'worktree', 'add', '--quiet', target])
        const env = gitEnvironment({ PATH: process.env.PATH ?? '' })

        const observation = await observeSetupPath(target, root, env, await executable(env))

        expect(observation).toMatchObject({
            state: 'available',
            value: { kind: 'repository', remotes: { origin: 'https://example.invalid/service.git' } },
        })
    })

    it('refuses a checkout replaced by a symlink during its identity probe', async () => {
        const root = workspaceForConfig()
        const target = join(root, 'service')
        const replacement = join(root, 'replacement')
        const observed = join(root, 'observed')
        const log = join(root, 'probe.log')
        const bin = join(root, 'bin')
        await mkdir(root)
        await run('git', ['init', '--quiet', target])
        await run('git', ['init', '--quiet', replacement])
        await mkdir(bin)
        const realGit = await realpath((await run('which', ['git'])).stdout.trim())
        await writeFile(join(bin, 'git'), `#!/bin/sh\nset -e\nprintf 'called\\n' >> '${log}'\n/bin/mv '${target}' '${observed}'\n/bin/ln -s '${replacement}' '${target}'\nexec ${realGit} "$@"\n`, { mode: 0o700 })
        const ambient = { PATH: bin }
        const env = gitEnvironment(ambient)
        const git = await executable(ambient)
        expect(git.canonicalPath).toBe(join(bin, 'git'))

        const observation = await observeSetupPath(target, root, env, git)

        expect(await readFile(log, 'utf8')).toBe('called\n')
        expect((await lstat(target)).isSymbolicLink()).toBe(true)
        expect(observation).toMatchObject({
            state: 'failed',
            reason: 'checkout identity changed during observation',
        })
    })

    it('refuses a repository whose remote can come from an external include', async () => {
        const root = workspaceForConfig()
        const target = join(root, 'service')
        const included = join(root, 'included-config')
        await mkdir(root)
        await run('git', ['init', '--quiet', target])
        await writeFile(included, '[remote "origin"]\nurl = https://example.invalid/included.git\n')
        await run('git', ['-C', target, 'config', 'include.path', included])
        const env = gitEnvironment({ PATH: process.env.PATH ?? '' })

        const observation = await observeSetupPath(target, root, env, await executable(env))

        expect(observation).toMatchObject({
            state: 'failed',
            reason: 'Git configuration origins are unsupported',
        })
    })

    it('refuses worktree-local configuration changed while the remote is read', async () => {
        const root = workspaceForConfig()
        const target = join(root, 'service')
        const bin = join(root, 'bin')
        await mkdir(root)
        await run('git', ['init', '--quiet', target])
        await run('git', ['-C', target, 'config', 'extensions.worktreeConfig', 'true'])
        await run('git', ['-C', target, 'config', '--worktree', 'remote.origin.url', 'https://example.invalid/original.git'])
        await mkdir(bin)
        const realGit = await realpath((await run('which', ['git'])).stdout.trim())
        const worktreeConfig = join(target, '.git', 'config.worktree')
        await writeFile(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" config --get remote.origin.url "*) printf '[remote "origin"]\\nurl = https://example.invalid/replacement.git\\n' > '${worktreeConfig}';; esac\nexec ${realGit} "$@"\n`, { mode: 0o700 })
        const ambient = { PATH: bin }
        const env = gitEnvironment(ambient)

        const observation = await observeSetupPath(target, root, env, await executable(ambient))

        expect(observation).toMatchObject({
            state: 'failed',
            reason: 'Git could not inspect the origin remote',
        })
    })

    it('refuses a linked checkout whose common Git directory escapes the siblings root', async () => {
        const root = workspaceForConfig()
        const external = workspaceForConfig()
        const primary = join(external, 'primary')
        const target = join(root, 'service')
        await mkdir(root)
        await mkdir(primary, { recursive: true })
        await run('git', ['init', '--quiet', primary])
        await writeFile(join(primary, 'tracked'), 'value')
        await run('git', ['-C', primary, 'add', 'tracked'])
        await run('git', ['-C', primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'seed'])
        await run('git', ['-C', primary, 'worktree', 'add', '--quiet', target])
        const env = gitEnvironment({ PATH: process.env.PATH ?? '' })

        const observation = await observeSetupPath(target, root, env, await executable(env))

        expect(observation).toMatchObject({ state: 'failed', code: 'SETUP_PATH_OUTSIDE_ROOT' })
    })
})

describe('environment ignore observation', () => {
    it('authorizes one synchronous operation with a configuration-relative sibling root', async () => {
        const root = await repository()
        const cockpitRoot = join(root, 'control')
        await mkdir(cockpitRoot)
        const configPath = join(cockpitRoot, 'cockpit.toml')
        const bytes = Buffer.from(configText().replace('siblings_root = "."', 'siblings_root = ".."'))
        await writeFile(configPath, bytes)
        const input = await authority(root)
        let calls = 0
        const evidence = await observeEnvironmentIgnore({ ...input, source: {
            path: configPath, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        } }, (...facts: unknown[]) => {
            calls += 1
            expect(facts).toEqual([])
            return 'authorized'
        })
        expect(evidence).toBe('authorized')
        expect(calls).toBe(1)
    })

    it('reports exact Git exit-one facts without treating them as execution failures', async () => {
        const root = await repository()
        await writeFile(join(root, '.gitignore'), '')
        const input = await authority(root)

        await expect(observeEnvironmentIgnore(input, () => 'used')).resolves.toEqual({
            kind: 'refusal', code: 'INSTANCE_NOT_IGNORED', path: declaration.instance,
        })
    })

    it('checks the ignored instance and unignored template in the same Git invocation', async () => {
        const root = await repository()
        const bin = join(root, 'bin')
        const invocations = join(tmpdir(), `cockpit-ignore-invocations-${randomUUID()}`)
        const realGit = await realpath((await run('which', ['git'])).stdout.trim())
        scratch.push(invocations)
        await mkdir(bin)
        await writeFile(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" check-ignore "*) printf '%s\\n' "$*" >> '${invocations}' ;; esac\nexec ${realGit} "$@"\n`, { mode: 0o700 })
        const input = await authority(root)
        const resolution = await resolveGitExecutable(Object.freeze({ PATH: bin }))
        if (resolution.state !== 'available') throw new Error(resolution.reason)

        await expect(observeEnvironmentIgnore({
            ...input,
            env: Object.freeze({ PATH: bin }),
            gitExecutable: resolution.value,
        }, () => 'authorized')).resolves.toBe('authorized')

        const ignoreInvocations = (await readFile(invocations, 'utf8')).trimEnd().split('\n')
        expect(ignoreInvocations).toHaveLength(1)
        expect(ignoreInvocations[0]).toContain(`-- ${declaration.instance} ${declaration.template}`)
    })

    it('authorizes a tracked template restored by a negated ignore rule in the paired Git result', async () => {
        const root = await repository()
        await writeFile(join(root, '.gitignore'), '.env*\n!.env.example\n')

        await expect(observeEnvironmentIgnore(await authority(root), () => 'authorized'))
            .resolves.toBe('authorized')
    })

    it('runs no fsmonitor the repository configures while it asks Git about ignore rules and the index', async () => {
        const root = await repository()
        await writeFile(join(root, '.gitignore'), '.env*\n!.env.example\n')
        const marker = join(root, 'monitor-ran')
        const monitor = join(root, 'monitor.sh')
        await writeFile(monitor, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
        await run('git', ['-C', root, 'config', 'core.fsmonitor', monitor])

        await expect(observeEnvironmentIgnore(await authority(root), () => 'authorized')).resolves.toBe('authorized')
        await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('does not mistake an escaped leading bang for a negated ignore rule', async () => {
        const root = await repository()
        const literalBang = { template: '!public.env', instance: '.env' }
        await writeFile(join(root, 'cockpit.toml'), configText()
            .replace('template = ".env.example"', 'template = "!public.env"'))
        await writeFile(join(root, literalBang.template), 'PUBLIC_NAME=\n')
        await writeFile(join(root, '.gitignore'), '.env\n\\!public.env\n')
        await run('git', ['-C', root, 'add', '--force', 'cockpit.toml', literalBang.template, '.gitignore'])
        const input = await authority(root)

        await expect(observeEnvironmentIgnore({ ...input, environmentFile: literalBang }, () => 'authorized'))
            .resolves.toEqual({ kind: 'refusal', code: 'TEMPLATE_IGNORED', path: literalBang.template })
    })

    it('distinguishes a tracked ignored template from an untracked template', async () => {
        const ignoredTemplateRoot = await repository()
        await writeFile(join(ignoredTemplateRoot, '.gitignore'), '.env*\n')
        await expect(observeEnvironmentIgnore(await authority(ignoredTemplateRoot), () => 'used')).resolves.toEqual({
            kind: 'refusal', code: 'TEMPLATE_IGNORED', path: declaration.template,
        })

        const untrackedTemplateRoot = await repository()
        await run('git', ['-C', untrackedTemplateRoot, 'rm', '--quiet', '--cached', '--', declaration.template])
        await expect(observeEnvironmentIgnore(await authority(untrackedTemplateRoot), () => 'used')).resolves.toEqual({
            kind: 'refusal', code: 'TEMPLATE_NOT_TRACKED', path: declaration.template,
        })
    })

    it('parses quoted Git path output without weakening the paired decision', async () => {
        const root = await repository()
        const quoted = { template: 'public"name', instance: 'private"name' }
        await writeFile(join(root, 'cockpit.toml'), configText()
            .replace('template = ".env.example"', 'template = "public\\"name"')
            .replace('instance = ".env"', 'instance = "private\\"name"'))
        await writeFile(join(root, quoted.template), 'PUBLIC_NAME=\n')
        await writeFile(join(root, '.gitignore'), `${quoted.instance}\n`)
        await run('git', ['-C', root, 'add', 'cockpit.toml', quoted.template, '.gitignore'])
        const input = await authority(root)

        await expect(observeEnvironmentIgnore({ ...input, environmentFile: quoted }, () => 'authorized'))
            .resolves.toBe('authorized')
    })

    it('rejects copied, replayed, mismatched, stale, and hostile authority', async () => {
        const root = await repository()
        const mismatch = await authority(root)
        await expect(observeEnvironmentIgnore({ ...mismatch, checkoutId: checkoutId({ checkoutPath: join(root, 'other') }) }, () => 'used'))
            .resolves.toBeUndefined()

        const now = Date.now()
        vi.useFakeTimers()
        vi.setSystemTime(now)
        await expect(observeEnvironmentIgnore(await authority(root, new Date(now - 60_001).toISOString()), () => 'used'))
            .resolves.toBeUndefined()

        let reads = 0
        const hostile = Object.defineProperty(await authority(root), 'siblingRoot', {
            enumerable: true,
            get() { reads += 1; throw new Error('must not execute') },
        })
        await expect(observeEnvironmentIgnore(hostile, () => 'used')).resolves.toBeUndefined()
        expect(reads).toBe(0)
    })

    it('revokes promptly when a callback returns a PromiseLike', async () => {
        const root = await repository()
        await expect(observeEnvironmentIgnore(await authority(root), (() => {
            return new Promise(() => undefined)
        }) as never)).rejects.toThrow('environment ignore projection callback must be synchronous')

        if (false) {
            // @ts-expect-error an asynchronous callback would outlive the authenticated probe scope
            await observeEnvironmentIgnore(await authority(root), async () => 'late')
        }
    })

    it('rejects a replaced root and never reads environment-file contents', async () => {
        const root = await repository()
        await writeFile(join(root, declaration.instance), 'SECRET_CANARY=private-value\n')
        const original = await authority(root)
        const moved = `${root}-moved`
        scratch.push(moved)
        await rename(root, moved)
        await mkdir(root)
        await expect(observeEnvironmentIgnore(original, () => 'used')).resolves.toBeUndefined()

        const restored = await repository()
        await writeFile(join(restored, declaration.instance), 'SECRET_CANARY=private-value\n')
        const evidence = await observeEnvironmentIgnore(await authority(restored), () => 'authorized')
        expect(JSON.stringify(evidence)).not.toContain('private-value')
        expect(JSON.stringify(evidence)).not.toContain('SECRET_CANARY')
    })

    it('rejects mismatched source, sibling, root, identity, declaration index, and declared paths', async () => {
        const root = await repository()
        const base = await authority(root)
        for (const change of [
            { source: { ...base.source, sha256: createHash('sha256').update('other').digest('hex') } },
            { siblingIndex: 1 },
            { siblingSlug: 'other' },
            { mainCheckoutPath: join(root, 'other') },
            { siblingsRoot: join(root, 'other') },
            { siblingRoot: join(root, 'other') },
            { environmentFileIndex: 1 },
            { environmentFile: { template: declaration.template, instance: 'other.env' } },
        ]) {
            await expect(observeEnvironmentIgnore({ ...base, ...change }, () => 'used')).resolves.toBeUndefined()
        }
    })

    it('anchors the declared sibling root to the authenticated main checkout, not the config checkout', async () => {
        const base = workspaceForConfig()
        const root = await initializeRepository(join(base, 'siblings', 'service'))
        const main = join(base, 'cockpit', 'main')
        await mkdir(join(base, 'cockpit'), { recursive: true })
        await run('git', ['init', '--quiet', '--initial-branch=main', main])
        const configPathInMain = join(main, 'cockpit.toml')
        await writeFile(configPathInMain, configText()
            .replace('siblings_root = "."', 'siblings_root = "../../siblings"')
            .replace('dir = "."', 'dir = "service"'))
        await run('git', ['-C', main, 'add', 'cockpit.toml'])
        await run('git', ['-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'seed'])
        const currentPath = join(base, 'cockpit', 'linked')
        await run('git', ['-C', main, 'worktree', 'add', '--quiet', '--detach', currentPath])
        const current = await realpath(currentPath)
        const configPath = join(current, 'cockpit.toml')
        const bytes = await readFile(configPath)
        const input = await authority(root)

        await expect(observeEnvironmentIgnore({
            ...input,
            source: {
                path: configPath,
                byteLength: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            },
            mainCheckoutPath: await realpath(main),
            siblingsRoot: await realpath(join(base, 'siblings')),
        }, () => 'authorized')).resolves.toBe('authorized')
    })

    it('ignores caller Git redirects', async () => {
        const root = await repository()
        const redirected = await repository()
        await writeFile(join(redirected, '.gitignore'), '')
        const input = await authority(root)
        const sanitized = await observeEnvironmentIgnore({
            ...input,
            env: {
                ...input.env,
                GIT_DIR: join(redirected, '.git'),
                GIT_WORK_TREE: redirected,
                GIT_INDEX_FILE: join(redirected, '.git', 'index'),
                GIT_CONFIG_GLOBAL: join(redirected, 'global-config'),
            },
        }, () => 'authorized')
        expect(sanitized).toBe('authorized')
    })

    it('refuses hardlinked repository files used as ignore authority', async () => {
        for (const relativePath of ['.gitignore', '.git/index', '.git/info/exclude']) {
            const root = await repository()
            await link(join(root, relativePath), join(root, `${relativePath.replaceAll('/', '-')}.alias`))
            await expect(observeEnvironmentIgnore(await authority(root), () => 'used')).resolves.toBeUndefined()
        }
    })

    it('refuses local includes instead of trusting an unbound configuration origin', async () => {
        const root = await repository()
        const included = join(root, 'included.config')
        await writeFile(included, '[core]\nexcludesFile = /dev/null\n')
        await run('git', ['-C', root, 'config', 'include.path', included])

        await expect(observeEnvironmentIgnore(await authority(root), () => 'used')).resolves.toBeUndefined()
    })

    it.each(['cockpit.toml', '.gitignore', '.git/index', '.git/info/exclude', '.git/config', '.git/authority-change'])(
        'refuses a %s change at the final authorization barrier',
        async (relativePath) => {
            const root = await repository()
            const bin = join(root, 'bin')
            const realGit = await realpath((await run('which', ['git'])).stdout.trim())
            const target = join(root, relativePath)
            await mkdir(bin)
            await writeFile(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" --absolute-git-dir "*) ;; *" rev-parse --path-format=absolute --show-toplevel "*) printf '\\n' >> '${target}';; esac\nexec ${realGit} "$@"\n`, { mode: 0o700 })
            const input = await authority(root)
            const resolution = await resolveGitExecutable(Object.freeze({ PATH: bin }))
            if (resolution.state !== 'available') throw new Error(resolution.reason)

            await expect(observeEnvironmentIgnore({
                ...input,
                env: Object.freeze({ PATH: bin }),
                gitExecutable: resolution.value,
            }, () => 'used')).resolves.toBeUndefined()
        },
    )
})

describe('setup checkout observation', () => {
    it('explains how to inspect and initialize a new directory without creating a repository', async () => {
        const root = join(workspaceForConfig(), "new checkout's docs")
        await mkdir(root, { recursive: true })
        const configPath = join(root, 'cockpit.toml')
        await writeFile(configPath, configText())
        await expect(run('git', ['-C', root, 'rev-parse', '--show-toplevel'])).rejects.toMatchObject({ code: 128 })

        await expect(observeSetupCheckout(await checkoutAuthority(configPath))).resolves.toMatchObject({
            state: 'failed',
            code: 'SETUP_PATH_TYPE_INVALID',
            reason: 'Git could not authenticate the current checkout; setup requires a Git working tree to bound repository writes. '
                + `Inspect it with ${formatShellCommand(['git', '-C', root, 'rev-parse', '--show-toplevel'])}; `
                + `if this is a new directory, initialize it with ${formatShellCommand(['git', '-C', root, 'init'])}, `
                + `then retry ${formatShellCommand(['npx', '--no', 'cockpit', 'setup', '--config', configPath])}`,
        })
        await expect(lstat(join(root, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(configPath, 'utf8')).toBe(configText())
    })

    it('revalidates generated checkout identity while projecting only bounded Git child variables', async () => {
        const repository = await committedRepository()
        const input = await checkoutAuthority(join(repository.main, 'cockpit.toml'))
        const bin = join(repository.root, 'bin')
        const calls = join(repository.root, 'git-calls')
        await mkdir(bin)
        await writeFile(join(bin, 'git'), `#!/bin/sh
if [ "${'${Path+x}'}" = x ] || [ "${'${UNRELATED_SEARCH_VALUE+x}'}" = x ]; then
    printf 'unexpected search input in Git child environment\n' >&2
    exit 64
fi
printf 'called\n' >> '${calls}'
exec '${input.gitExecutable.canonicalPath}' "$@"
`, { mode: 0o700 })
        const now = Date.now()
        vi.useFakeTimers({ toFake: ['Date'] })
        try {
            vi.setSystemTime(now)
            const generated = await observeGeneratedCheckoutIdentity({
                source: input.source,
                cockpitName: input.cockpitName,
                env: { PATH: `./node_modules/.bin:${bin}`, Path: '/must-not-reach-git', UNRELATED_SEARCH_VALUE: 'private' },
            })
            if (generated.state !== 'available') throw new Error(generated.reason)
            vi.setSystemTime(now + 60_001)
            expect(await revalidateGeneratedCheckoutIdentity(generated)).toBe(true)
            expect((await readFile(calls, 'utf8')).trim().split('\n').length).toBeGreaterThan(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps generated standalone identity current across unrelated ancestor children and refuses a mode change', async () => {
        const root = join(realpathSync(tmpdir()), `cockpit-generated-${randomUUID()}`)
        const ancestor = join(root, 'shared-temporary-root')
        const standalone = join(ancestor, 'standalone')
        const configPath = join(standalone, 'cockpit.toml')
        scratch.push(root)
        await mkdir(standalone, { recursive: true })
        await writeFile(configPath, '[cockpit]\nname = "sample"\n')
        const input = await checkoutAuthority(configPath)

        directoryResolutionControl.path = ancestor
        directoryResolutionControl.mutation = () => mkdir(join(ancestor, 'unrelated-observation'))
        const generated = await observeGeneratedCheckoutIdentity({
            source: input.source, cockpitName: input.cockpitName, env: input.env,
        })
        if (generated.state !== 'available') throw new Error(generated.reason)
        expect(generated).toMatchObject({ state: 'available', kind: 'standalone' })

        directoryResolutionControl.path = ancestor
        directoryResolutionControl.mutation = () => mkdir(join(ancestor, 'unrelated-revalidation'))
        expect(await revalidateGeneratedCheckoutIdentity(generated)).toBe(true)

        const originalMode = (await lstat(ancestor)).mode & 0o777
        directoryResolutionControl.path = ancestor
        directoryResolutionControl.mutation = () => chmod(ancestor, originalMode === 0o700 ? 0o755 : 0o700)
        try {
            expect(await revalidateGeneratedCheckoutIdentity(generated)).toBe(false)
        } finally {
            await chmod(ancestor, originalMode)
        }
    })

    it('derives ordinary main and linked checkout identities from authenticated Git evidence', async () => {
        const repository = await committedRepository()
        const linked = join(repository.root, 'linked')
        await run('git', ['-C', repository.main, 'worktree', 'add', '--quiet', '--detach', linked])
        const canonicalLinked = await realpath(linked)
        const redirected = await committedRepository()

        for (const current of [repository.main, canonicalLinked]) {
            const input = await checkoutAuthority(join(current, 'cockpit.toml'), new Date().toISOString(), {
                PATH: process.env.PATH ?? '',
                GIT_DIR: join(redirected.main, '.git'),
                GIT_WORK_TREE: redirected.main,
            })
            const observation = await observeSetupCheckout(input)
            const evidence = await withSetupCheckoutProjection(observation, {
                source: input.source,
                cockpitName: input.cockpitName,
                evaluatedAt: Date.parse(input.observedAt),
            }, (projection) => consumeSetupCheckoutProjection(projection))
            expect(evidence).toMatchObject({
                source: input.source,
                currentCheckoutPath: current,
                mainCheckoutPath: repository.main,
                cockpitId: cockpitId({ name: 'sample', mainCheckoutPath: repository.main }),
                checkoutId: checkoutId({ checkoutPath: current }),
                observedAt: input.observedAt,
            })
            const generated = await observeGeneratedCheckoutIdentity({
                source: input.source, cockpitName: input.cockpitName, env: input.env,
            })
            expect(generated).toMatchObject({ state: 'available', kind: 'checkout',
                mainCheckoutPath: repository.main, currentCheckoutPath: current,
                cockpitId: evidence?.cockpitId, checkoutId: evidence?.checkoutId })
            if (generated.state !== 'available') throw new Error(generated.reason)
            expect(await revalidateGeneratedCheckoutIdentity({ ...generated })).toBe(false)
            await expect(withSetupCheckoutProjection(generated, {
                source: input.source, cockpitName: input.cockpitName, evaluatedAt: Date.parse(input.observedAt),
            }, consumeSetupCheckoutProjection)).resolves.toBeUndefined()
            await writeFile(join(current, 'published-instructions.md'), 'Synthetic generated instructions.\n')
            // Any command that locks the index, git status among them, moves the Git directory's timestamps.
            await writeFile(join(repository.main, '.git/index.lock'), '')
            await rm(join(repository.main, '.git/index.lock'))
            expect(await revalidateGeneratedCheckoutIdentity(generated)).toBe(true)
            const gitConfig = join(repository.main, '.git/config')
            await writeFile(gitConfig, `${await readFile(gitConfig, 'utf8')}\n# changed administrative authority\n`)
            expect(await revalidateGeneratedCheckoutIdentity(generated)).toBe(false)
        }
    })

    it.each(['config', 'worktree'])('retries a %s read that Git activity interrupted, and names that cause when it does not stop', async (word) => {
        const repository = await committedRepository()
        const input = await checkoutAuthority(join(repository.main, 'cockpit.toml'))
        const bin = join(repository.root, 'bin')
        const interrupted = join(repository.root, 'interrupted')
        await mkdir(bin)
        const shim = (persistent: boolean) => writeFile(join(bin, 'git'), `#!/bin/sh
for word in "$@"; do
    if [ "$word" = ${word} ] && { ${persistent} || [ ! -e '${interrupted}' ]; }; then
        : > '${interrupted}'
        /bin/mkdir '${repository.main}/.git/activity' && /bin/rmdir '${repository.main}/.git/activity'
    fi
done
exec '${input.gitExecutable.canonicalPath}' "$@"
`, { mode: 0o700 })
        const observe = () => observeGeneratedCheckoutIdentity({ source: input.source, cockpitName: input.cockpitName, env: { PATH: bin } })
        await shim(false)
        await expect(observe()).resolves.toMatchObject({ state: 'available', kind: 'checkout' })
        await shim(true)
        await expect(observe()).resolves.toMatchObject({ state: 'failed', reason: expect.stringContaining('another Git command was running') })
        // A replaced executable fails the same way every time, so nothing here may blame Git activity.
        const resolved = await resolveGitExecutable({ PATH: bin })
        if (resolved.state !== 'available') throw new Error(resolved.reason)
        await writeFile(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
        const replaced = await observeSetupCheckout({ ...input, env: { PATH: bin }, gitExecutable: resolved.value })
        expect(replaced.state).toBe('failed')
        expect(replaced).not.toMatchObject({ reason: expect.stringContaining('another Git command') })
    })

    it('names the checkout setup names, wherever setup can read one, and holds it through Git activity', async () => {
        const repository = await committedRepository()
        const separate = await committedRepository({ separateGitDirectory: true })
        const linked = join(repository.root, 'linked')
        await run('git', ['-C', repository.main, 'worktree', 'add', '--quiet', '--detach', linked])
        const nested = join(repository.main, 'nested')
        await mkdir(nested)
        await writeFile(join(nested, 'cockpit.toml'), '[cockpit]\nname = "sample"\n')
        for (const config of [repository.main, await realpath(linked), nested, separate.main].map(directory => join(directory, 'cockpit.toml'))) {
            const input = await checkoutAuthority(config)
            const observed = { source: input.source, cockpitName: input.cockpitName, env: input.env }
            const strict = await observeGeneratedCheckoutIdentity(observed)
            const narrow = await observeSurfacesCheckoutIdentity(observed)
            expect(strict.state, config).toBe('available')
            expect(narrow).toEqual(strict)
            if (narrow.state !== 'available') throw new Error(narrow.reason)
            const lock = join(narrow.mainCheckoutPath === separate.main ? separate.gitDirectory! : join(narrow.mainCheckoutPath, '.git'), 'index.lock')
            await writeFile(lock, '')
            await rm(lock)
            expect(await revalidateGeneratedCheckoutIdentity(narrow)).toBe(true)
        }
        const linkedInput = await checkoutAuthority(join(await realpath(linked), 'cockpit.toml'))
        const held = await observeSurfacesCheckoutIdentity({ source: linkedInput.source, cockpitName: linkedInput.cockpitName, env: linkedInput.env })
        if (held.state !== 'available') throw new Error(held.reason)
        const pointer = join(await realpath(linked), '.git')
        await writeFile(pointer, await readFile(pointer))
        expect(await revalidateGeneratedCheckoutIdentity(held)).toBe(false)
    })

    it.each([
        ['an empty .git directory', 'not a git repository', async (root: string) => { await mkdir(join(root, '.git')) }],
        ['a stale .git file', 'not a git repository', async (root: string) => { await writeFile(join(root, '.git'), 'gitdir: /synthetic/missing\n') }],
    ] as const)('takes a directory with %s as standalone and says why', async (_name, stated, arrange) => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-standalone-')))
        scratch.push(root)
        await writeFile(join(root, 'cockpit.toml'), '[cockpit]\nname = "sample"\n')
        await arrange(root)
        const input = await checkoutAuthority(join(root, 'cockpit.toml'))
        const generated = await observeSurfacesCheckoutIdentity({ source: input.source, cockpitName: input.cockpitName, env: input.env })
        expect(generated).toMatchObject({ state: 'available', kind: 'standalone', currentCheckoutPath: root, mainCheckoutPath: root,
            standaloneReason: expect.stringContaining(join(root, '.git')) })
        if (generated.state !== 'available') throw new Error(generated.reason)
        expect(generated.standaloneReason!.toLowerCase()).toContain(stated)
        expect(generated.standaloneReason).not.toMatch(/git init|setup/)
        expect(await revalidateGeneratedCheckoutIdentity(generated)).toBe(true)
        await rm(join(root, '.git'), { recursive: true })
        expect(await revalidateGeneratedCheckoutIdentity(generated)).toBe(false)
    })

    it('takes a linked checkout whose main moved, or a checkout without Git on PATH, as standalone and says why', async () => {
        const repository = await committedRepository()
        const linked = join(repository.root, 'linked')
        await run('git', ['-C', repository.main, 'worktree', 'add', '--quiet', '--detach', linked])
        const canonicalLinked = await realpath(linked)
        const input = await checkoutAuthority(join(canonicalLinked, 'cockpit.toml'))
        const empty = join(repository.root, 'empty-bin')
        await mkdir(empty)
        for (const PATH of [empty, './node_modules/.bin', '']) {
            await expect(observeSurfacesCheckoutIdentity({ source: input.source, cockpitName: input.cockpitName, env: { PATH } })).resolves.toMatchObject({
                state: 'available', kind: 'standalone', currentCheckoutPath: canonicalLinked,
                standaloneReason: expect.stringContaining('Git cannot be looked up'),
            })
        }
        await rename(repository.main, join(repository.root, 'moved-main'))
        await expect(observeSurfacesCheckoutIdentity({ source: input.source, cockpitName: input.cockpitName, env: input.env })).resolves.toMatchObject({
            state: 'available', kind: 'standalone', currentCheckoutPath: canonicalLinked,
            standaloneReason: expect.stringContaining('does not accept'),
        })
    })

    it('reads a repository-local include without running what any configuration names, and still refuses a noncanonical PATH entry', async () => {
        const repository = await committedRepository()
        const marker = join(repository.root, 'configured-command-ran')
        const command = join(repository.root, 'configured-command')
        await writeFile(command, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o700 })
        const included = join(repository.root, 'included-config')
        await writeFile(included, `[core]\n\tfsmonitor = ${command}\n\tsshCommand = ${command}\n[alias]\n\trev-parse = !${command}\n`)
        await run('git', ['-C', repository.main, 'config', 'include.path', included])
        await run('git', ['-C', repository.main, 'config', 'core.hooksPath', repository.root])
        await writeFile(join(repository.root, 'post-index-change'), `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o700 })
        const input = await checkoutAuthority(join(repository.main, 'cockpit.toml'))
        await expect(observeGeneratedCheckoutIdentity({ source: input.source, cockpitName: input.cockpitName, env: input.env }))
            .resolves.toMatchObject({ state: 'failed', reason: 'Git configuration origins are unsupported' })
        await expect(observeSurfacesCheckoutIdentity({ source: input.source, cockpitName: input.cockpitName, env: input.env })).resolves.toMatchObject({
            state: 'available', kind: 'checkout', currentCheckoutPath: repository.main, mainCheckoutPath: repository.main,
        })
        await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(observeSurfacesCheckoutIdentity({ source: input.source, cockpitName: input.cockpitName, env: { PATH: '/usr/bin/../bin:/bin' } }))
            .resolves.toMatchObject({ state: 'failed', reason: expect.stringContaining('noncanonical') })
    })

    it('supports a separate Git directory for its main checkout and refuses its linked topology', async () => {
        const repository = await committedRepository({ separateGitDirectory: true })
        const mainInput = await checkoutAuthority(join(repository.main, 'cockpit.toml'))
        const mainObservation = await observeSetupCheckout(mainInput)
        await expect(withSetupCheckoutProjection(mainObservation, {
            source: mainInput.source,
            cockpitName: 'sample',
            evaluatedAt: Date.parse(mainInput.observedAt),
        }, (projection) => consumeSetupCheckoutProjection(projection))).resolves.toMatchObject({
            currentCheckoutPath: repository.main,
            mainCheckoutPath: repository.main,
        })
        await expect(observeGeneratedCheckoutIdentity({ source: mainInput.source, cockpitName: mainInput.cockpitName, env: mainInput.env }))
            .resolves.toMatchObject({ state: 'available', kind: 'checkout',
                currentCheckoutPath: repository.main, mainCheckoutPath: repository.main })

        const linked = join(repository.root, 'linked')
        await run('git', ['-C', repository.main, 'worktree', 'add', '--quiet', '--detach', linked])
        const linkedInput = await checkoutAuthority(join(await realpath(linked), 'cockpit.toml'))
        await expect(observeSetupCheckout(linkedInput)).resolves.toMatchObject({
            state: 'failed',
            code: 'SETUP_PATH_TYPE_INVALID',
        })
        await expect(observeGeneratedCheckoutIdentity({ source: linkedInput.source, cockpitName: linkedInput.cockpitName, env: linkedInput.env }))
            .resolves.toMatchObject({ state: 'failed', code: 'SETUP_PATH_TYPE_INVALID' })
    })

    it.each(['backwards', 'expired', 'refreshed', 'reversed'] as const)('validates %s publication time after asynchronous identity validation', async (clockChange) => {
        const repository = await committedRepository()
        const input = await checkoutAuthority(join(repository.main, 'cockpit.toml'))
        const bin = join(repository.root, 'bin')
        await mkdir(bin)
        const git = join(bin, 'git')
        await symlink(input.gitExecutable.canonicalPath, git)
        const now = Date.now()
        vi.useFakeTimers({ toFake: ['Date'] })
        try {
            vi.setSystemTime(now)
            const generated = await observeGeneratedCheckoutIdentity({
                source: input.source, cockpitName: input.cockpitName, env: { PATH: bin },
            })
            if (generated.state !== 'available') throw new Error(generated.reason)
            if (clockChange === 'reversed') vi.setSystemTime(now + 61_000)
            const pending = revalidateGeneratedCheckoutIdentity(generated)
            vi.setSystemTime(now + (clockChange === 'reversed' ? 59_000 : clockChange === 'backwards' ? -60_001 : 60_001))
            if (clockChange === 'expired') await rename(git, join(bin, 'git-held'))
            expect(await pending).toBe(clockChange === 'refreshed')
        } finally {
            vi.useRealTimers()
        }
    })

    it('rejects copied, replayed, stale, mismatched, aliased, and replaced authority', async () => {
        const repository = await committedRepository()
        const configPath = join(repository.main, 'cockpit.toml')
        const input = await checkoutAuthority(configPath)

        const copied = await observeSetupCheckout(input)
        await expect(withSetupCheckoutProjection(structuredClone(copied), {
            source: input.source, cockpitName: 'sample', evaluatedAt: Date.parse(input.observedAt),
        }, () => 'used')).resolves.toBeUndefined()

        const replayed = await observeSetupCheckout(input)
        const context = { source: input.source, cockpitName: 'sample', evaluatedAt: Date.parse(input.observedAt) }
        await expect(withSetupCheckoutProjection(replayed, context, () => 'first')).resolves.toBe('first')
        await expect(withSetupCheckoutProjection(replayed, context, () => 'second')).resolves.toBeUndefined()

        const mismatch = await observeSetupCheckout(input)
        await expect(withSetupCheckoutProjection(mismatch, { ...context, cockpitName: 'other' }, () => 'used'))
            .resolves.toBeUndefined()

        const generated = await observeGeneratedCheckoutIdentity({ source: input.source, cockpitName: input.cockpitName, env: input.env })
        if (generated.state !== 'available') throw new Error(generated.reason)
        const now = Date.now()
        vi.useFakeTimers()
        vi.setSystemTime(now)
        await expect(observeSetupCheckout(await checkoutAuthority(configPath, new Date(now - 60_001).toISOString())))
            .resolves.toMatchObject({ state: 'failed' })
        vi.setSystemTime(now - 60_001)
        expect(await revalidateGeneratedCheckoutIdentity(generated)).toBe(false)
        vi.useRealTimers()
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Number.NaN)
        try { expect(await revalidateGeneratedCheckoutIdentity(generated)).toBe(false) } finally { clock.mockRestore() }

        const alias = join(repository.root, 'alias.toml')
        await symlink(configPath, alias)
        const aliasedInput = await checkoutAuthority(alias)
        await expect(observeSetupCheckout(aliasedInput)).resolves.toMatchObject({ state: 'failed' })

        const replaced = await observeSetupCheckout(input)
        await writeFile(configPath, '[cockpit]\nname = "replacement"\n')
        await expect(withSetupCheckoutProjection(replaced, context, () => 'used')).resolves.toBeUndefined()

        await writeFile(configPath, '[cockpit]\nname = "sample"\n')
        const restored = await checkoutAuthority(configPath)
        const metadataChanged = await observeSetupCheckout(restored)
        await writeFile(join(repository.main, '.git', 'config'), '\n[changed]\n', { flag: 'a' })
        await expect(withSetupCheckoutProjection(metadataChanged, {
            source: restored.source, cockpitName: 'sample', evaluatedAt: Date.parse(restored.observedAt),
        }, () => 'used')).resolves.toBeUndefined()
    })

    it('executes only the bounded identity probes and revokes asynchronous callbacks promptly', async () => {
        const repository = await committedRepository()
        const bin = join(repository.root, 'bin')
        const log = join(repository.root, 'probe.log')
        const realGit = await realpath((await run('which', ['git'])).stdout.trim())
        await mkdir(bin)
        await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf 'CALL\\n' >> '${log}'\nprintf '%s\\n' "$@" >> '${log}'\nexec ${realGit} "$@"\n`, { mode: 0o700 })
        const env = Object.freeze({ PATH: bin })
        const input = await checkoutAuthority(join(repository.main, 'cockpit.toml'), new Date().toISOString(), env)
        const observation = await observeSetupCheckout(input)
        const calls = (await readFile(log, 'utf8')).split('CALL\n').filter(Boolean)
        // The main checkout is the current one, so its identity is probed once and confirmed once.
        const probe = ['-c', 'core.excludesFile=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', repository.main]
        expect(calls).toEqual([
            [...probe, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', ''].join('\n'),
            [...probe, 'config', '--show-origin', '--null', '--list', ''].join('\n'),
            [...probe, 'worktree', 'list', '--porcelain', '-z', ''].join('\n'),
            [...probe, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', ''].join('\n'),
        ])

        let escaped: SetupCheckoutProjection | undefined
        await expect(withSetupCheckoutProjection(observation, {
            source: input.source, cockpitName: 'sample', evaluatedAt: Date.parse(input.observedAt),
        }, ((projection: SetupCheckoutProjection) => {
            escaped = projection
            return new Promise(() => undefined)
        }) as never)).rejects.toThrow('setup checkout projection callback must be synchronous')
        expect(consumeSetupCheckoutProjection(escaped!)).toBeUndefined()

        if (false) {
            const asynchronous = async () => 'late'
            // @ts-expect-error an asynchronous callback would outlive the authenticated checkout scope
            await withSetupCheckoutProjection(observation, { source: input.source, cockpitName: 'sample', evaluatedAt: Date.parse(input.observedAt) }, asynchronous)
        }
    })

    it('rejects missing, malformed, and duplicate current worktree inventory records', async () => {
        const repository = await committedRepository()
        const other = await committedRepository()
        const revision = (await run('git', ['-C', repository.main, 'rev-parse', 'HEAD'])).stdout.trim()
        const inventories = [
            `worktree ${other.main}\\0HEAD ${revision}\\0branch refs/heads/main\\0\\0`,
            `worktree ${repository.main}\\0HEAD ${revision}\\0branch refs/heads/main\\0mystery value\\0\\0`,
            `worktree ${repository.main}\\0HEAD ${revision}\\0branch refs/heads/main\\0\\0worktree ${repository.main}\\0HEAD ${revision}\\0detached\\0\\0`,
            `worktree ${repository.main}\\0HEAD ${revision}\\0branch refs/heads/topic..invalid\\0\\0`,
        ]
        for (const [index, inventory] of inventories.entries()) {
            const bin = join(repository.root, `inventory-bin-${index}`)
            await mkdir(bin)
            const realGit = await realpath((await run('which', ['git'])).stdout.trim())
            await writeFile(join(bin, 'git'), `#!/bin/sh\nif [ "$9" = "worktree" ]; then printf '${inventory}'; exit 0; fi\nexec ${realGit} "$@"\n`, { mode: 0o700 })
            const input = await checkoutAuthority(join(repository.main, 'cockpit.toml'), new Date().toISOString(), { PATH: bin })
            await expect(observeSetupCheckout(input)).resolves.toMatchObject({ state: 'failed' })
        }
    })

    it('refuses hardlinked configuration and Git administrative authority', async () => {
        const sourceRepository = await committedRepository()
        const sourcePath = join(sourceRepository.main, 'cockpit.toml')
        await link(sourcePath, join(sourceRepository.root, 'source.alias'))
        await expect(observeSetupCheckout(await checkoutAuthority(sourcePath))).resolves.toMatchObject({ state: 'failed' })

        const configRepository = await committedRepository()
        await link(join(configRepository.main, '.git', 'config'), join(configRepository.root, 'config.alias'))
        await expect(observeSetupCheckout(await checkoutAuthority(join(configRepository.main, 'cockpit.toml'))))
            .resolves.toMatchObject({ state: 'failed' })

        const linkedRepository = await committedRepository()
        const linked = join(linkedRepository.root, 'linked')
        await run('git', ['-C', linkedRepository.main, 'worktree', 'add', '--quiet', '--detach', linked])
        await link(join(linked, '.git'), join(linkedRepository.root, 'git-entry.alias'))
        await expect(observeSetupCheckout(await checkoutAuthority(join(await realpath(linked), 'cockpit.toml'))))
            .resolves.toMatchObject({ state: 'failed' })

        const metadataRepository = await committedRepository()
        const metadataLinked = join(metadataRepository.root, 'metadata-linked')
        await run('git', ['-C', metadataRepository.main, 'worktree', 'add', '--quiet', '--detach', metadataLinked])
        const linkedGitDirectory = (await run('git', ['-C', metadataLinked, 'rev-parse', '--absolute-git-dir'])).stdout.trim()
        await link(join(linkedGitDirectory, 'gitdir'), join(metadataRepository.root, 'gitdir.alias'))
        await expect(observeSetupCheckout(await checkoutAuthority(join(await realpath(metadataLinked), 'cockpit.toml'))))
            .resolves.toMatchObject({ state: 'failed' })

        const worktreeConfigRepository = await committedRepository()
        await run('git', ['-C', worktreeConfigRepository.main, 'config', 'extensions.worktreeConfig', 'true'])
        await run('git', ['-C', worktreeConfigRepository.main, 'config', '--worktree', 'test.value', 'local'])
        await link(
            join(worktreeConfigRepository.main, '.git', 'config.worktree'),
            join(worktreeConfigRepository.root, 'config-worktree.alias'),
        )
        await expect(observeSetupCheckout(await checkoutAuthority(join(worktreeConfigRepository.main, 'cockpit.toml'))))
            .resolves.toMatchObject({ state: 'failed' })
    })

    it('binds worktree-local configuration through projection', async () => {
        const repository = await committedRepository()
        await run('git', ['-C', repository.main, 'config', 'extensions.worktreeConfig', 'true'])
        await run('git', ['-C', repository.main, 'config', '--worktree', 'test.value', 'original'])
        const input = await checkoutAuthority(join(repository.main, 'cockpit.toml'))
        const observation = await observeSetupCheckout(input)
        expect(observation).toMatchObject({ state: 'available' })
        await writeFile(join(repository.main, '.git', 'config.worktree'), '[test]\nvalue = replacement\n')
        await expect(withSetupCheckoutProjection(observation, {
            source: input.source, cockpitName: 'sample', evaluatedAt: Date.parse(input.observedAt),
        }, () => 'used')).resolves.toBeUndefined()
    })

    it('refuses local include files that can change Git controls', async () => {
        const includedRepository = await committedRepository()
        const included = join(includedRepository.root, 'included-config')
        await writeFile(included, '[extensions]\nworktreeConfig = true\n')
        await run('git', ['-C', includedRepository.main, 'config', 'include.path', included])
        await link(included, join(includedRepository.root, 'included-config.alias'))
        await expect(observeSetupCheckout(await checkoutAuthority(join(includedRepository.main, 'cockpit.toml'))))
            .resolves.toMatchObject({ state: 'failed' })

        const linkedRepository = await committedRepository()
        const linked = join(linkedRepository.root, 'included-linked')
        const linkedInclude = join(linkedRepository.root, 'main-worktree-include')
        await run('git', ['-C', linkedRepository.main, 'config', 'extensions.worktreeConfig', 'true'])
        await run('git', ['-C', linkedRepository.main, 'worktree', 'add', '--quiet', '--detach', linked])
        await writeFile(linkedInclude, '[core]\nignorecase = false\n')
        await run('git', ['-C', linkedRepository.main, 'config', '--worktree', 'include.path', linkedInclude])
        await expect(observeSetupCheckout(await checkoutAuthority(join(await realpath(linked), 'cockpit.toml'))))
            .resolves.toMatchObject({ state: 'failed' })
    })

    it('refuses a repository replacement that remains present for the next authenticated probe', async () => {
        const repository = await committedRepository()
        const replacement = await committedRepository()
        const bin = join(repository.root, 'replacement-bin')
        const realGit = await realpath((await run('which', ['git'])).stdout.trim())
        await mkdir(bin)
        await writeFile(join(bin, 'git'), `#!/bin/sh\nif [ "$9" = "worktree" ]; then /bin/mv '${join(repository.main, '.git')}' '${join(repository.main, '.git.original')}'; /bin/cp -R '${join(replacement.main, '.git')}' '${join(repository.main, '.git')}'; fi\nexec ${realGit} "$@"\n`, { mode: 0o700 })
        const input = await checkoutAuthority(join(repository.main, 'cockpit.toml'), new Date().toISOString(), { PATH: bin })
        await expect(observeSetupCheckout(input)).resolves.toMatchObject({ state: 'failed' })
    })

    it('refuses a repository swapped only while a probe is producing its result', async () => {
        const repository = await committedRepository()
        const replacement = await committedRepository()
        const bin = join(repository.root, 'transient-replacement-bin')
        const realGit = await realpath((await run('which', ['git'])).stdout.trim())
        const dotGit = join(repository.main, '.git')
        await mkdir(bin)
        await writeFile(join(bin, 'git'), `#!/bin/sh\nif [ "$9" = "worktree" ]; then\n  /bin/mv '${dotGit}' '${dotGit}.original'\n  /bin/cp -R '${join(replacement.main, '.git')}' '${dotGit}'\n  ${realGit} "$@"\n  status=$?\n  /bin/rm -rf '${dotGit}'\n  /bin/mv '${dotGit}.original' '${dotGit}'\n  exit $status\nfi\nexec ${realGit} "$@"\n`, { mode: 0o700 })
        const input = await checkoutAuthority(join(repository.main, 'cockpit.toml'), new Date().toISOString(), { PATH: bin })
        await expect(observeSetupCheckout(input)).resolves.toMatchObject({ state: 'failed' })
    })

    it('accepts Git porcelain bare records without HEAD and NUL-delimited multiline lock reasons', async () => {
        const separate = await committedRepository({ separateGitDirectory: true })
        const bareBin = join(separate.root, 'bare-inventory-bin')
        const realGit = await realpath((await run('which', ['git'])).stdout.trim())
        await mkdir(bareBin)
        await writeFile(join(bareBin, 'git'), `#!/bin/sh\nif [ "$9" = "worktree" ]; then printf 'worktree %s\\0bare\\0\\0' '${separate.gitDirectory!}'; exit 0; fi\nexec ${realGit} "$@"\n`, { mode: 0o700 })
        const bareInput = await checkoutAuthority(join(separate.main, 'cockpit.toml'), new Date().toISOString(), { PATH: bareBin })
        await expect(observeSetupCheckout(bareInput)).resolves.toMatchObject({ state: 'available' })

        const repository = await committedRepository()
        const revision = (await run('git', ['-C', repository.main, 'rev-parse', 'HEAD'])).stdout.trim()
        const lockedBin = join(repository.root, 'locked-inventory-bin')
        await mkdir(lockedBin)
        await writeFile(join(lockedBin, 'git'), `#!/bin/sh\nif [ "$9" = "worktree" ]; then printf 'worktree %s\\0HEAD %s\\0branch refs/heads/main\\0locked first line\\nsecond line\\0\\0' '${repository.main}' '${revision}'; exit 0; fi\nexec ${realGit} "$@"\n`, { mode: 0o700 })
        const lockedInput = await checkoutAuthority(join(repository.main, 'cockpit.toml'), new Date().toISOString(), { PATH: lockedBin })
        await expect(observeSetupCheckout(lockedInput)).resolves.toMatchObject({ state: 'available' })
    })
})
