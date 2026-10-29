import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isResolvedDockerExecutable, isResolvedExecutable, isResolvedGitExecutable, resolveDiskCapacityExecutable, resolveDockerExecutable, resolveExecutable, resolveExecutablePath, resolveGitExecutable, resolvePathRemovalExecutable } from './executable.js'

const digest = 'a'.repeat(64)
const scratch: string[] = []
const windowsFilesystem = vi.hoisted(() => ({
    files: new Set<string>(),
    lstatPaths: [] as string[],
    identityPaths: [] as string[],
}))

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        lstat: async (...args: Parameters<typeof actual.lstat>) => {
            const path = String(args[0])
            if (process.platform !== 'win32' || !path.includes('\\')) return actual.lstat(...args)
            windowsFilesystem.lstatPaths.push(path)
            if (!windowsFilesystem.files.has(path)) {
                throw Object.assign(new Error(`synthetic Windows candidate is absent: ${path}`), { code: 'ENOENT' })
            }
            return {
                isFile: () => true,
                isSymbolicLink: () => false,
                mode: 0o700,
                size: 1,
            }
        },
        realpath: async (...args: Parameters<typeof actual.realpath>) => {
            const path = String(args[0])
            if (process.platform !== 'win32') return actual.realpath(...args)
            windowsFilesystem.identityPaths.push(path)
            throw new Error(`Windows candidate reached POSIX identity resolution: ${path}`)
        },
        open: async (...args: Parameters<typeof actual.open>) => {
            const path = String(args[0])
            if (process.platform !== 'win32') return actual.open(...args)
            windowsFilesystem.identityPaths.push(path)
            throw new Error(`Windows candidate reached POSIX no-follow open: ${path}`)
        },
    }
})

afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
    windowsFilesystem.files.clear()
    windowsFilesystem.lstatPaths.length = 0
    windowsFilesystem.identityPaths.length = 0
})

function directory(): string {
    const path = mkdtempSync(join(tmpdir(), 'cockpit-executable-'))
    scratch.push(path)
    return path
}

async function withPlatform<T>(platform: NodeJS.Platform, action: () => Promise<T>): Promise<T> {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (descriptor === undefined) throw new Error('process.platform descriptor is unavailable')
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    try { return await action() } finally { Object.defineProperty(process, 'platform', descriptor) }
}

const searchResolvers = [
    ['generic', 'comparison-tool', (env: Readonly<Record<string, string>>) => resolveExecutable('comparison-tool', env)],
    ['Git', 'git', resolveGitExecutable],
    ['Docker', 'docker', resolveDockerExecutable],
] as const

describe('resolved executable identity', () => {
    it('separates canonical bytes from the bound invocation identity', () => {
        expect(isResolvedExecutable({
            canonicalPath: '/opt/runtime/docker-tools',
            invocationPath: '/usr/local/bin/docker',
            sha256: digest,
            executionMode: 'staged',
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

    it('rejects an unreadable execution mode without propagating the getter failure', () => {
        const identity = { canonicalPath: '/bin/tool', invocationPath: '/bin/tool', sha256: digest }
        Object.defineProperty(identity, 'executionMode', { enumerable: true, get: () => { throw new Error('unreadable') } })
        expect(() => isResolvedExecutable(identity)).not.toThrow()
        expect(isResolvedExecutable(identity)).toBe(false)
    })

    it('classifies specialized identities from one owned property read', () => {
        let reads = 0
        const docker = { canonicalPath: '/opt/runtime/tool', sha256: digest, executionMode: 'staged' }
        Object.defineProperty(docker, 'invocationPath', {
            enumerable: true,
            get: () => ++reads === 1 ? '/usr/local/bin/docker' : '/tmp/not-docker',
        })
        const classified = isResolvedDockerExecutable(docker)
        expect(classified).toBe(true)
        expect(reads).toBe(1)

        const revoked = Proxy.revocable({
            canonicalPath: '/opt/runtime/tool', invocationPath: '/usr/local/bin/git', sha256: digest, executionMode: 'verified-path',
        }, {})
        revoked.revoke()
        expect(() => isResolvedGitExecutable(revoked.proxy)).not.toThrow()
        expect(isResolvedGitExecutable(revoked.proxy)).toBe(false)
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
            executionMode: 'staged',
        })).toBe(false)
    })

    it('accepts a canonical multicall binary with the Docker invocation name', () => {
        expect(isResolvedDockerExecutable({
            canonicalPath: '/opt/runtime/docker-tools',
            invocationPath: '/usr/local/bin/docker',
            sha256: digest,
            executionMode: 'staged',
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

    it.each([
        ['Git', 'GIT.EXE', 'verified-path', isResolvedGitExecutable],
        ['Git', 'git.COM', 'verified-path', isResolvedGitExecutable],
        ['Docker', 'DOCKER.EXE', 'staged', isResolvedDockerExecutable],
        ['Docker', 'docker.COM', 'staged', isResolvedDockerExecutable],
    ] as const)('classifies the Windows native %s suffix in a structural object: %s', async (_label, name, executionMode, classify) => {
        const identity = {
            canonicalPath: '/synthetic/runtime-tool', invocationPath: `/synthetic/${name}`, sha256: digest, executionMode,
        }

        expect(await withPlatform('win32', async () => classify(identity))).toBe(true)
    })

    it.each([
        ['Git batch', 'git.CMD', 'verified-path', isResolvedGitExecutable],
        ['Git unsupported', 'git.ps1', 'verified-path', isResolvedGitExecutable],
        ['Git wrong name', 'not-git.EXE', 'verified-path', isResolvedGitExecutable],
        ['Docker batch', 'docker.BAT', 'staged', isResolvedDockerExecutable],
        ['Docker unsupported', 'docker.ps1', 'staged', isResolvedDockerExecutable],
        ['Docker wrong name', 'not-docker.COM', 'staged', isResolvedDockerExecutable],
    ] as const)('rejects %s from Windows specialized structural admission', async (_label, name, executionMode, classify) => {
        const identity = {
            canonicalPath: '/synthetic/runtime-tool', invocationPath: `/synthetic/${name}`, sha256: digest, executionMode,
        }

        expect(await withPlatform('win32', async () => classify(identity))).toBe(false)
    })

    it('keeps specialized POSIX invocation names exact and lowercase', () => {
        expect(isResolvedGitExecutable({
            canonicalPath: '/synthetic/runtime-tool', invocationPath: '/synthetic/GIT', sha256: digest, executionMode: 'verified-path',
        })).toBe(false)
        expect(isResolvedDockerExecutable({
            canonicalPath: '/synthetic/runtime-tool', invocationPath: '/synthetic/DOCKER', sha256: digest, executionMode: 'staged',
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
        await expect(withPlatform('darwin', () => resolveExecutable('comparison-tool', { Path: root })))
            .resolves.toEqual({ state: 'unavailable', reason: 'Executable search path is missing or invalid' })
    })

    it('uses Windows directory then PATHEXT order without manufacturing executable identity', async () => {
        const selected = String.raw`D:\Tools\comparison-tool.EXE`
        windowsFilesystem.files.add(selected)

        const result = await withPlatform('win32', () => resolveExecutable('comparison-tool', {
            Path: String.raw`C:\Program Files\Tools;D:\Tools`,
            PathExt: '.CMD;.EXE',
        }))

        expect(windowsFilesystem.lstatPaths).toEqual([
            String.raw`C:\Program Files\Tools\comparison-tool.CMD`,
            String.raw`C:\Program Files\Tools\comparison-tool.EXE`,
            String.raw`D:\Tools\comparison-tool.CMD`,
            selected,
        ])
        expect(result).toEqual({
            state: 'unavailable',
            reason: expect.stringMatching(/native executable identity authority.*D:\\Tools\\comparison-tool\.EXE/i),
        })
        expect(windowsFilesystem.identityPaths).toEqual([])
    })

    it('stops at a selected Windows batch shim instead of falling through to a native candidate', async () => {
        const batch = String.raw`C:\Tools\comparison-tool.CMD`
        windowsFilesystem.files.add(batch)
        windowsFilesystem.files.add(String.raw`D:\Tools\comparison-tool.EXE`)

        const result = await withPlatform('win32', () => resolveExecutable('comparison-tool', {
            PATH: String.raw`C:\Tools;D:\Tools`, PATHEXT: '.CMD;.EXE',
        }))

        expect(windowsFilesystem.lstatPaths).toEqual([batch])
        expect(result).toEqual({
            state: 'unavailable',
            reason: expect.stringMatching(/authenticated command interpreter.*C:\\Tools\\comparison-tool\.CMD/i),
        })
        expect(windowsFilesystem.identityPaths).toEqual([])
    })

    it('requires PATHEXT only for suffix expansion and keeps explicit Windows suffixes closed', async () => {
        await expect(withPlatform('win32', () => resolveExecutable('comparison-tool', { PATH: String.raw`C:\Tools` })))
            .resolves.toEqual({ state: 'unavailable', reason: expect.stringMatching(/PATHEXT.*missing/i) })
        expect(windowsFilesystem.lstatPaths).toEqual([])

        const native = String.raw`C:\Tools\comparison-tool.exe`
        windowsFilesystem.files.add(native)
        const nativeResult = await withPlatform('win32', () => resolveExecutable('comparison-tool.exe', { PATH: String.raw`C:\Tools` }))
        expect(nativeResult).toEqual({
            state: 'unavailable', reason: expect.stringMatching(/native executable identity authority.*comparison-tool\.exe/i),
        })

        windowsFilesystem.lstatPaths.length = 0
        const batch = String.raw`C:\Tools\comparison-tool.bat`
        windowsFilesystem.files.add(batch)
        const batchResult = await withPlatform('win32', () => resolveExecutable('comparison-tool.bat', { PATH: String.raw`C:\Tools` }))
        expect(batchResult).toEqual({
            state: 'unavailable', reason: expect.stringMatching(/authenticated command interpreter.*comparison-tool\.bat/i),
        })
        expect(windowsFilesystem.lstatPaths).toEqual([batch])
        expect(windowsFilesystem.identityPaths).toEqual([])
    })

    it.each([
        ['empty entry', String.raw`C:\Tools;;D:\Tools`],
        ['drive-relative entry', String.raw`C:Tools`],
        ['root-relative entry', String.raw`\Tools`],
        ['UNC entry', String.raw`\\server\share\Tools`],
        ['device entry', String.raw`\\?\C:\Tools`],
        ['NUL', `C:\\Tools\0;D:\\Tools`],
        ['too many entries', Array.from({ length: 257 }, (_, index) => `C:\\Tools${index}`).join(';')],
        ['oversized value', `C:\\${'x'.repeat(65_535)}`],
    ])('refuses a Windows PATH with %s before filesystem access', async (_label, path) => {
        const result = await withPlatform('win32', () => resolveExecutable('comparison-tool', { PATH: path, PATHEXT: '.EXE' }))

        expect(result).toEqual(expect.objectContaining({ state: 'unavailable' }))
        expect(windowsFilesystem.lstatPaths).toEqual([])
        expect(windowsFilesystem.identityPaths).toEqual([])
    })

    it.each([
        ['unsupported PATHEXT entry', 'comparison-tool', { PATH: String.raw`C:\Tools`, PATHEXT: '.PS1;.EXE' }],
        ['unsupported explicit suffix', 'comparison-tool.ps1', { PATH: String.raw`C:\Tools` }],
    ] as const)('refuses %s before Windows filesystem access', async (_label, name, env) => {
        const result = await withPlatform('win32', () => resolveExecutable(name, env))

        expect(result).toEqual(expect.objectContaining({ state: 'unavailable' }))
        expect(windowsFilesystem.lstatPaths).toEqual([])
        expect(windowsFilesystem.identityPaths).toEqual([])
    })

    it.each([
        ['Git', 'git.com', resolveGitExecutable],
        ['Docker', 'docker.exe', resolveDockerExecutable],
    ] as const)('admits the actual Windows %s native name only as an unauthenticated candidate', async (_label, name, resolve) => {
        const selected = `C:\\Tools\\${name}`
        windowsFilesystem.files.add(selected)

        const result = await withPlatform('win32', () => resolve({ PATH: String.raw`C:\Tools`, PATHEXT: '.com;.exe' }))

        expect(windowsFilesystem.lstatPaths).toContain(selected)
        expect(result).toEqual({
            state: 'unavailable', reason: expect.stringMatching(new RegExp(`native executable identity authority.*${name.replace('.', '\\.')}\\b`, 'i')),
        })
        expect(windowsFilesystem.identityPaths).toEqual([])
    })

    it('classifies an absolute Windows native name without treating it as a PATH entry', async () => {
        const selected = String.raw`C:\Tools\comparison-tool.exe`
        windowsFilesystem.files.add(selected)

        const result = await withPlatform('win32', () => resolveExecutable(selected, {}))

        expect(windowsFilesystem.lstatPaths).toEqual([selected])
        expect(result).toEqual({
            state: 'unavailable', reason: expect.stringMatching(/native executable identity authority.*comparison-tool\.exe/i),
        })
        expect(windowsFilesystem.identityPaths).toEqual([])
    })

    it.each(searchResolvers)('refuses ambiguous PATH spellings before %s resolution on Windows', async (_label, name, resolve) => {
        const root = directory()
        writeFileSync(join(root, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 })

        const result = await withPlatform('win32', () => resolve({ PATH: root, Path: root }))

        expect(result).toEqual({ state: 'unavailable', reason: 'Executable search environment has ambiguous PATH spellings' })
    })

    it.each(searchResolvers)('refuses ambiguous PATHEXT spellings before %s resolution on Windows', async (_label, name, resolve) => {
        const root = directory()
        writeFileSync(join(root, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 })

        const result = await withPlatform('win32', () => resolve({ PATH: root, PATHEXT: '.EXE', PathExt: '.EXE' }))

        expect(result).toEqual({ state: 'unavailable', reason: 'Executable search environment has ambiguous PATHEXT spellings' })
    })

    it('binds disk capacity to the current Node executable without searching PATH', async () => {
        const result = await resolveDiskCapacityExecutable()

        expect(result).toEqual({
            state: 'available',
            value: { canonicalPath: realpathSync(process.execPath), invocationPath: process.execPath,
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/), executionMode: 'verified-path' },
        })
    })

    it('refuses direct-path authentication under the Windows host policy before POSIX identity reads', async () => {
        const root = directory()
        const path = join(root, 'direct-tool')
        writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 })

        const result = await withPlatform('win32', () => resolveExecutablePath(path))

        expect(result).toEqual({
            state: 'unavailable', reason: expect.stringMatching(/Windows.*executable identity authority.*unavailable/i),
        })
        expect(windowsFilesystem.identityPaths).toEqual([])
    })

    it('keeps fixed disk and removal executable owners unavailable on Windows before POSIX identity reads', async () => {
        const results = await withPlatform('win32', () => Promise.all([
            resolveDiskCapacityExecutable(), resolvePathRemovalExecutable(),
        ]))

        expect(results).toEqual([
            { state: 'unavailable', reason: expect.stringMatching(/Windows.*executable identity authority.*unavailable/i) },
            { state: 'unavailable', reason: expect.stringMatching(/Windows.*executable identity authority.*unavailable/i) },
        ])
        expect(windowsFilesystem.identityPaths).toEqual([])
    })

    it('resolves Docker from its invocation while binding staged canonical bytes', async () => {
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
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/), executionMode: 'staged',
            },
        })
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
