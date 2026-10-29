import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createSelftestFixture } from '../../test-support/selftest-fixture.js'
import type { ExecutionStep } from '../environment/contract.js'
import { runSurfaceSelftestCommand } from './command.js'

const roots: string[] = []
const windowsFilesystem = vi.hoisted(() => ({
    files: new Set<string>(),
    candidatePaths: [] as string[],
    identityPaths: [] as string[],
}))

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    const windowsPath = (path: string) => process.platform === 'win32' && /^[A-Za-z]:\\/.test(path)
    return {
        ...actual,
        lstat: async (...args: Parameters<typeof actual.lstat>) => {
            const path = String(args[0])
            if (!windowsPath(path)) return actual.lstat(...args)
            windowsFilesystem.candidatePaths.push(path)
            if (!windowsFilesystem.files.has(path)) {
                throw Object.assign(new Error(`synthetic Windows candidate is absent: ${path}`), { code: 'ENOENT' })
            }
            return { isFile: () => true, isSymbolicLink: () => false }
        },
        realpath: async (...args: Parameters<typeof actual.realpath>) => {
            const path = String(args[0])
            if (!windowsPath(path)) return actual.realpath(...args)
            windowsFilesystem.identityPaths.push(path)
            throw new Error(`Windows candidate reached identity resolution: ${path}`)
        },
        open: async (...args: Parameters<typeof actual.open>) => {
            const path = String(args[0])
            if (!windowsPath(path)) return actual.open(...args)
            windowsFilesystem.identityPaths.push(path)
            throw new Error(`Windows candidate reached identity reads: ${path}`)
        },
    }
})

const {
    fakeHarnesses,
    issuedApplication,
    specifications,
    syntheticOperatorApprovals,
} = createSelftestFixture(roots)

let sharedFixture: Awaited<ReturnType<typeof issuedApplication>> | undefined

beforeAll(async () => {
    sharedFixture = await issuedApplication()
}, 180_000)

afterEach(async () => {
    windowsFilesystem.files.clear()
    windowsFilesystem.candidatePaths.length = 0
    windowsFilesystem.identityPaths.length = 0
    if (!sharedFixture) return
    await Promise.all([
        rm(join(sharedFixture.root, 'internal'), { recursive: true, force: true }),
        rm(join(sharedFixture.root, 'harness-bin'), { recursive: true, force: true }),
    ])
})

afterAll(async () => {
    sharedFixture = undefined
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fixture() {
    if (!sharedFixture) throw new Error('shared selftest fixture is unavailable')
    return sharedFixture
}

async function withPlatform<T>(platform: NodeJS.Platform, action: () => Promise<T>): Promise<T> {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (descriptor === undefined) throw new Error('process.platform descriptor is unavailable')
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    try { return await action() } finally { Object.defineProperty(process, 'platform', descriptor) }
}

describe('surface selftest command', () => {
    it('drives candidate and broken controls through authenticated execution', async () => {
        const { root, application } = fixture()
        const bin = await fakeHarnesses(root)
        const operator = await syntheticOperatorApprovals(bin)
        const steps: ExecutionStep[] = []
        const outcome = await runSurfaceSelftestCommand(
            { application, root, specifications: specifications(application), env: { PATH: bin } },
            { ...operator.adapters, execute: async step => {
                steps.push(step)
                return operator.adapters.execute(step)
            } },
        )
        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
        if (outcome.kind !== 'complete') return
        expect(outcome.evidence.errors).toEqual([])
        expect(outcome.bundle.records).toHaveLength(27)
        expect(outcome.evidence.evidence).toHaveLength(27)
        expect(outcome.evidence.pending).toEqual([])
        expect(operator.requests).toHaveLength(3)
        expect(steps.length).toBeGreaterThan(0)
        expect(steps.every(step => Object.keys(step.env).length === 0)).toBe(true)
        expect(outcome.bundle.skillReviews).toEqual(expect.arrayContaining([
            expect.objectContaining({ harness: 'Claude Code', status: 'human_needed' }),
            expect.objectContaining({ harness: 'Codex', status: 'human_needed' }),
        ]))
        expect(await runSurfaceSelftestCommand({
            application: { ...application }, root, specifications: specifications(application), env: { PATH: bin },
        })).toEqual(expect.objectContaining({ kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID' }))
    }, 180_000)

    it.each([
        { suffix: '.EXE', pathExt: '.EXE;.CMD', reason: 'Windows native executable identity authority is unavailable' },
        { suffix: '.CMD', pathExt: '.CMD;.EXE', reason: 'Windows batch executable requires an authenticated command interpreter' },
    ])('reports $suffix authority refusal from captured Windows search aliases without executing', async ({ suffix, pathExt, reason }) => {
        const { root, application } = fixture()
        for (const name of ['claude', 'codex', 'opencode']) {
            windowsFilesystem.files.add(`C:\\Harnesses\\${name}.EXE`)
            windowsFilesystem.files.add(`C:\\Harnesses\\${name}.CMD`)
        }
        const execute = vi.fn(async () => { throw new Error('unavailable Windows executable must not run') })
        const requestExecutableApproval = vi.fn(async () => undefined)

        const outcome = await withPlatform('win32', () => runSurfaceSelftestCommand({
            application, root, specifications: specifications(application),
            env: { Path: 'C:\\Harnesses', PathExt: pathExt },
        }, { execute, requestExecutableApproval }))

        expect(outcome).toMatchObject({ kind: 'complete', status: 0 })
        if (outcome.kind !== 'complete') throw new Error('Windows authority refusal did not produce pending selftest evidence')
        expect(outcome.evidence.errors).toEqual([])
        expect(outcome.evidence.evidence).toEqual([])
        expect(outcome.evidence.pending).toHaveLength(27)
        expect(outcome.bundle.records.every(record => record.kind === 'human_needed'
            && record.reason === 'executable_missing' && record.operatorAction.includes(reason))).toBe(true)
        expect(new Set(windowsFilesystem.candidatePaths)).toEqual(new Set([
            `C:\\Harnesses\\claude${suffix}`, `C:\\Harnesses\\codex${suffix}`, `C:\\Harnesses\\opencode${suffix}`,
        ]))
        expect(windowsFilesystem.identityPaths).toEqual([])
        expect(requestExecutableApproval).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    }, 180_000)

    it.each([
        { name: 'PATH', aliases: { PATH: 'C:\\OtherHarnesses' } },
        { name: 'PATH', aliases: { PATH: undefined } },
        { name: 'PATHEXT', aliases: { PATHEXT: '.CMD' } },
        { name: 'PATHEXT', aliases: { PATHEXT: undefined } },
    ])('retains ambiguous $name aliases before Windows candidate observation: $aliases', async ({ name, aliases }) => {
        const { root, application } = fixture()
        const execute = vi.fn(async () => { throw new Error('ambiguous search input must not execute') })
        const requestExecutableApproval = vi.fn(async () => undefined)

        const outcome = await withPlatform('win32', () => runSurfaceSelftestCommand({
            application, root, specifications: specifications(application),
            env: { Path: 'C:\\Harnesses', PathExt: '.EXE', ...aliases },
        }, { execute, requestExecutableApproval }))

        expect(outcome).toMatchObject({ kind: 'complete', status: 0 })
        if (outcome.kind !== 'complete') throw new Error('ambiguous search input did not produce pending selftest evidence')
        expect(outcome.evidence.errors).toEqual([])
        expect(outcome.evidence.evidence).toEqual([])
        expect(outcome.evidence.pending).toHaveLength(27)
        expect(outcome.bundle.records.every(record => record.kind === 'human_needed'
            && record.reason === 'executable_missing'
            && record.operatorAction.includes(`Executable search environment has ambiguous ${name} spellings`))).toBe(true)
        expect(windowsFilesystem.candidatePaths).toEqual([])
        expect(windowsFilesystem.identityPaths).toEqual([])
        expect(requestExecutableApproval).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    }, 180_000)

    it('preserves POSIX executable approval with an undefined search alias without reading unrelated values', async () => {
        const { root, application } = fixture()
        const bin = await fakeHarnesses(root)
        const unrelated = vi.fn(() => { throw new Error('unrelated environment value must not be read') })
        const env = Object.defineProperty({ PATH: bin, Path: undefined }, 'UNRELATED', { enumerable: true, get: unrelated })
        const execute = vi.fn(async () => { throw new Error('unapproved executable must not run') })
        const requestExecutableApproval = vi.fn(async () => undefined)

        const outcome = await runSurfaceSelftestCommand({
            application, root, specifications: specifications(application), env,
        }, { execute, requestExecutableApproval })

        expect(outcome).toMatchObject({ kind: 'complete', status: 0 })
        if (outcome.kind !== 'complete') throw new Error('captured POSIX search input did not reach executable approval')
        expect(outcome.evidence.errors).toEqual([])
        expect(outcome.evidence.evidence).toEqual([])
        expect(outcome.evidence.pending).toHaveLength(27)
        expect(outcome.bundle.records.every(record => record.kind === 'human_needed'
            && record.reason === 'authentication_required')).toBe(true)
        expect(requestExecutableApproval).toHaveBeenCalledWith(expect.objectContaining({ canonicalPath: join(bin, 'claude') }))
        expect(unrelated).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    }, 180_000)

    it('refuses a selected search accessor before reading it or executing', async () => {
        const { root, application } = fixture()
        const selected = vi.fn(() => { throw new Error('search accessor must not be read') })
        const env = Object.defineProperty({}, 'PATH', { enumerable: true, get: selected })
        const execute = vi.fn(async () => { throw new Error('invalid search input must not execute') })

        const outcome = await runSurfaceSelftestCommand({
            application, root, specifications: specifications(application), env,
        }, { execute })

        expect(outcome).toMatchObject({ kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID' })
        expect(selected).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    }, 180_000)

    it('redacts native structured streams and the version before returning or persisting evidence', async () => {
        const { root, application } = fixture()
        const bin = await fakeHarnesses(root, true)
        const operator = await syntheticOperatorApprovals(bin)
        const outcome = await runSurfaceSelftestCommand(
            { application, root, specifications: specifications(application), env: { PATH: bin } }, operator.adapters,
        )
        expect(outcome).toMatchObject({ kind: 'complete', status: 0 })
        if (outcome.kind !== 'complete') throw new Error('native stream selftest failed')
        const transcripts = await Promise.all(outcome.bundle.records.filter(row => row.kind === 'evidence')
            .map(row => readFile(join(root, row.transcriptPath), 'utf8')))
        const returnedAndPersisted = JSON.stringify(outcome) + transcripts.join('\n')
        for (const value of ['version-canary', 'json-canary', 'nested-canary', 'scalar-canary', 'object-canary']) {
            expect(returnedAndPersisted).not.toContain(value)
        }
        expect(returnedAndPersisted).toContain('public diagnostic')
        expect(returnedAndPersisted).toContain('[redacted]')
    }, 180_000)

    it.each(['partial', 'deep'] as const)('refuses %s structured streams before persisting a transcript', async shape => {
        const { root, application } = fixture()
        const bin = await fakeHarnesses(root, shape)
        const operator = await syntheticOperatorApprovals(bin)
        const outcome = await runSurfaceSelftestCommand(
            { application, root, specifications: specifications(application), env: { PATH: bin } }, operator.adapters,
        )
        expect(outcome).toMatchObject({ kind: 'refusal', code: 'SELFTEST_EXECUTION_INVALID' })
        expect(await readdir(join(root, 'internal/probes'), { recursive: true }))
            .not.toContainEqual(expect.stringContaining('transcript.json'))
        expect(JSON.stringify(outcome)).not.toMatch(/pretty-canary|deep-canary/)
    }, 180_000)
})
