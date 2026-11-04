import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isResolvedDockerExecutable, isResolvedExecutable, isResolvedGitExecutable, locateExecutable, resolveDiskCapacityExecutable, resolveDockerExecutable, resolveExecutable, resolveExecutablePath, resolveGitExecutable, resolvePathRemovalExecutable } from './executable.js'

const digest = 'a'.repeat(64)
const scratch: string[] = []
afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

function directory(): string {
    const path = mkdtempSync(join(tmpdir(), 'cockpit-executable-'))
    scratch.push(path)
    return path
}

describe('resolved executable identity', () => {
    it('separates canonical bytes from the bound invocation identity', () => {
        expect(isResolvedExecutable({
            canonicalPath: '/opt/runtime/docker-tools',
            invocationPath: '/usr/local/bin/docker',
            sha256: digest,
            executionMode: 'verified-path',
        })).toBe(true)
    })

    it.each([
        null,
        {},
        { canonicalPath: '/bin/tool', invocationPath: '/bin/tool', sha256: digest, policy: 'accept' },
        { canonicalPath: 'tool', invocationPath: '/bin/tool', sha256: digest },
        { canonicalPath: '/bin/tool', invocationPath: '/bin/../bin/tool', sha256: digest },
        { canonicalPath: '/bin/tool', invocationPath: '', sha256: digest },
        { canonicalPath: '/bin/tool', invocationPath: 'tool\0hidden', sha256: digest },
        { canonicalPath: '/bin/tool', invocationPath: '/bin/tool', sha256: 'unbound' },
        { canonicalPath: '/bin/tool', invocationPath: '/bin/tool', sha256: digest, executionMode: 'ambient' },
    ])('rejects unresolved or inexact identity %#', (identity) => {
        expect(() => isResolvedExecutable(identity)).not.toThrow()
        expect(isResolvedExecutable(identity)).toBe(false)
    })

    it('classifies specialized identities from one property read', () => {
        let reads = 0
        const docker = { canonicalPath: '/opt/runtime/tool', sha256: digest, executionMode: 'verified-path' }
        Object.defineProperty(docker, 'invocationPath', {
            enumerable: true,
            get: () => ++reads === 1 ? '/usr/local/bin/docker' : '/tmp/not-docker',
        })
        const classified = isResolvedDockerExecutable(docker)
        expect(classified).toBe(true)
        expect(reads).toBe(1)

    })

    it.each([
        '/tmp/not-docker',
        '/usr/local/bin/docker-tools',
        '/usr/local/bin/DOCKER',
    ])('rejects unsupported Docker invocation %s', (invocationPath) => {
        expect(isResolvedDockerExecutable({
            canonicalPath: '/opt/runtime/docker-tools',
            invocationPath,
            sha256: digest,
            executionMode: 'verified-path',
        })).toBe(false)
    })

    it('accepts a canonical multicall binary with the Docker invocation name', () => {
        expect(isResolvedDockerExecutable({
            canonicalPath: '/opt/runtime/docker-tools',
            invocationPath: '/usr/local/bin/docker',
            sha256: digest,
            executionMode: 'verified-path',
        })).toBe(true)
    })

    it('requires the Git invocation name independently of the canonical binary name', () => {
        expect(isResolvedGitExecutable({
            canonicalPath: '/opt/runtime/multicall-tool',
            invocationPath: '/usr/local/bin/git',
            sha256: digest,
            executionMode: 'verified-path',
        })).toBe(true)
        expect(isResolvedGitExecutable({
            canonicalPath: '/opt/runtime/git',
            invocationPath: '/usr/local/bin/not-git',
            sha256: digest,
            executionMode: 'verified-path',
        })).toBe(false)
    })

    it('keeps specialized POSIX invocation names exact and lowercase', () => {
        expect(isResolvedGitExecutable({
            canonicalPath: '/synthetic/runtime-tool', invocationPath: '/synthetic/GIT', sha256: digest, executionMode: 'verified-path',
        })).toBe(false)
        expect(isResolvedDockerExecutable({
            canonicalPath: '/synthetic/runtime-tool', invocationPath: '/synthetic/DOCKER', sha256: digest, executionMode: 'verified-path',
        })).toBe(false)
    })

    it('resolves a Git invocation symlink separately from its canonical bytes', async () => {
        const root = directory()
        const canonicalPath = join(root, 'multicall-tool')
        const invocationPath = join(root, 'git')
        const source = '#!/bin/sh\nexit 0\n'
        writeFileSync(canonicalPath, source, { mode: 0o700 })
        symlinkSync(canonicalPath, invocationPath)

        const result = await resolveGitExecutable({ PATH: root })

        expect(result).toEqual({
            state: 'available',
            value: { canonicalPath: realpathSync(canonicalPath), invocationPath, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), executionMode: 'verified-path' },
        })
    })

    it('resolves a bounded generic PATH executable to authenticated invocation bytes', async () => {
        const root = directory()
        const canonicalPath = join(root, 'comparison-tool')
        writeFileSync(canonicalPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })

        const result = await resolveExecutable('comparison-tool', { PATH: root })

        expect(result).toEqual({
            state: 'available',
            value: { canonicalPath: realpathSync(canonicalPath), invocationPath: canonicalPath,
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/), executionMode: 'verified-path' },
        })
        await expect(resolveExecutable('../comparison-tool', { PATH: root })).resolves.toEqual(expect.objectContaining({ state: 'unavailable' }))
        await expect(resolveExecutable('comparison-tool', { Path: root }))
            .resolves.toEqual({ state: 'unavailable', reason: 'Executable search path is missing or invalid' })
        await expect(resolveExecutablePath(join(root, 'absent-tool')))
            .resolves.toEqual({ state: 'unavailable', reason: expect.stringMatching(/absent-tool: ENOENT/) })
    })

    it('binds disk capacity to the current Node executable without searching PATH', async () => {
        const result = await resolveDiskCapacityExecutable()

        expect(result).toEqual({
            state: 'available',
            value: { canonicalPath: realpathSync(process.execPath), invocationPath: process.execPath,
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/), executionMode: 'verified-path' },
        })
    })

    it('resolves Docker from its invocation while binding its canonical bytes', async () => {
        const root = directory()
        const canonicalPath = join(root, 'runtime-tool')
        const invocationPath = join(root, 'docker')
        writeFileSync(canonicalPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
        symlinkSync(canonicalPath, invocationPath)

        const result = await resolveDockerExecutable({ PATH: root })

        expect(result).toEqual({
            state: 'available',
            value: {
                canonicalPath: realpathSync(canonicalPath), invocationPath,
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/), executionMode: 'verified-path',
            },
        })
    })

    it('re-hashes a resolved executable whose bytes changed under a restored size and modification time', async () => {
        const root = directory()
        const path = join(root, 'docker')
        writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
        utimesSync(path, 1_700_000_000, 1_700_000_000)
        const first = await resolveDockerExecutable({ PATH: root })
        // Same length, timestamps put back: only the change time moves, and the remembered digest must not apply.
        writeFileSync(path, '#!/bin/sh\nexit 1\n')
        utimesSync(path, 1_700_000_000, 1_700_000_000)
        const second = await resolveDockerExecutable({ PATH: root })

        expect(first.state === 'available' && second.state === 'available').toBe(true)
        if (first.state !== 'available' || second.state !== 'available') return
        expect(second.value.sha256).toBe(createHash('sha256').update('#!/bin/sh\nexit 1\n').digest('hex'))
        expect(second.value.sha256).not.toBe(first.value.sha256)
    })

    it.each([
        ['missing', () => ({ PATH: directory() })],
        ['relative path', () => ({ PATH: 'relative/bin' })],
        ['non-executable', () => { const root = directory(); writeFileSync(join(root, 'docker'), 'data', { mode: 0o600 }); return { PATH: root } }],
        ['oversized', () => { const root = directory(); const path = join(root, 'docker'); writeFileSync(path, '', { mode: 0o700 }); truncateSync(path, 536_870_913); return { PATH: root } }],
    ] as const)('refuses %s Docker resolution without invoking a process', async (_label, makeEnv) => {
        await expect(resolveDockerExecutable(makeEnv())).resolves.toEqual(expect.objectContaining({ state: 'unavailable' }))
    })

    it('resolves the exact verified-path removal executable required by reclaim', async () => {
        const result = await resolvePathRemovalExecutable()

        expect(result).toEqual({
            state: 'available',
            value: {
                canonicalPath: realpathSync('/bin/rm'), invocationPath: '/bin/rm',
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/), executionMode: 'verified-path',
            },
        })
    })

    it('continues past an unusable PATH entry to the next Git invocation', async () => {
        const first = directory()
        const second = directory()
        writeFileSync(join(first, 'git'), 'not executable', { mode: 0o600 })
        const canonicalPath = join(second, 'multicall-tool')
        const invocationPath = join(second, 'git')
        writeFileSync(canonicalPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
        symlinkSync(canonicalPath, invocationPath)

        const result = await resolveGitExecutable({ PATH: `${first}:${second}` })

        expect(result).toEqual({
            state: 'available',
            value: { canonicalPath: realpathSync(canonicalPath), invocationPath, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), executionMode: 'verified-path' },
        })
    })

    it.each([
        ['missing', () => ({ PATH: directory() })],
        ['relative path', () => ({ PATH: 'relative/bin' })],
        ['non-executable', () => { const root = directory(); writeFileSync(join(root, 'git'), 'data', { mode: 0o600 }); return { PATH: root } }],
        ['unreadable', () => { const root = directory(); const path = join(root, 'git'); writeFileSync(path, 'data', { mode: 0o100 }); chmodSync(path, 0o100); return { PATH: root } }],
        ['directory', () => { const root = directory(); const target = join(root, 'git'); writeFileSync(join(root, 'placeholder'), 'x'); symlinkSync(root, target); return { PATH: root } }],
        ['oversized', () => { const root = directory(); const path = join(root, 'git'); writeFileSync(path, '', { mode: 0o700 }); truncateSync(path, 536_870_913); return { PATH: root } }],
    ] as const)('refuses %s Git resolution without invoking a process', async (_label, makeEnv) => {
        await expect(resolveGitExecutable(makeEnv())).resolves.toEqual(expect.objectContaining({ state: 'unavailable' }))
    })
})

describe('executable presence', () => {
    it('finds a command on PATH or relative to the working directory without reading it, and names why one is absent', async () => {
        const root = directory()
        writeFileSync(join(root, 'tool'), '#!/bin/sh\n')
        chmodSync(join(root, 'tool'), 0o755)
        writeFileSync(join(root, 'plain'), 'data')
        expect(await locateExecutable('tool', { PATH: root }, '/')).toEqual({ state: 'present', path: join(root, 'tool'), canonicalPath: realpathSync(join(root, 'tool')) })
        expect(await locateExecutable('./tool', { PATH: '' }, root)).toMatchObject({ state: 'present', path: join(root, 'tool') })
        expect(await locateExecutable('plain', { PATH: root }, '/')).toEqual({ state: 'unavailable', reason: `Executable was not found in the supplied search path: plain` })
        expect(await locateExecutable('tool', { PATH: 'relative' }, '/')).toEqual({ state: 'unavailable', reason: 'Executable search path must contain bounded absolute directories' })
        expect(await locateExecutable('./absent', {}, root)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining(`Executable is unavailable: ${join(root, 'absent')}`) })
    })
})
