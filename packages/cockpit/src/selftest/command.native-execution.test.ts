import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createSelftestFixture } from '../../test-support/selftest-fixture.js'
import type { ExecutionStep } from '../environment/contract.js'
import { runSurfaceSelftestCommand } from './command.js'

const roots: string[] = []
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
    if (!sharedFixture) return
    await Promise.all([
        rm(join(sharedFixture.root, '.cockpit/local/probes'), { recursive: true, force: true }),
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

describe('surface selftest command', () => {
    it('drives signed-in tools through candidate and broken controls with only the non-secret environment', async () => {
        const { root, application } = fixture()
        const bin = await fakeHarnesses(root, false, true)
        const home = join(root, 'harness-bin', 'home')
        await mkdir(home)
        await writeFile(join(home, '.synthetic-sign-in'), 'signed in\n')
        const operator = await syntheticOperatorApprovals(bin)
        const steps: ExecutionStep[] = []
        const outcome = await runSurfaceSelftestCommand(
            { application, root, specifications: specifications(application),
                env: { PATH: bin, HOME: home, LANG: 'C', SYNTHETIC_TOKEN: 'synthetic-token-canary' } },
            { ...operator.adapters, execute: async step => {
                steps.push(step)
                return operator.adapters.execute(step)
            } },
        )
        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
        if (outcome.kind !== 'complete') return
        expect(outcome.evidence.errors).toEqual([])
        expect(outcome.bundle.records).toHaveLength(27)
        // Probe controls are machine-local state under the ignored .cockpit/local, never a tracked folder.
        expect(outcome.bundle.records.every(record => record.kind !== 'evidence'
            || record.candidatePath.startsWith('.cockpit/local/probes/'))).toBe(true)
        await expect(readdir(join(root, 'internal'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(outcome.evidence.evidence).toHaveLength(27)
        expect(outcome.evidence.pending).toEqual([])
        expect(operator.requests).toHaveLength(3)
        expect(steps.length).toBeGreaterThan(0)
        expect(new Set(steps.map(step => JSON.stringify(Object.entries(step.env).sort()))))
            .toEqual(new Set([JSON.stringify([['HOME', home], ['LANG', 'C'], ['PATH', bin]])]))
        expect(outcome.bundle.skillReviews).toEqual(expect.arrayContaining([
            expect.objectContaining({ harness: 'Claude Code', status: 'human_needed' }),
            expect.objectContaining({ harness: 'Codex', status: 'human_needed' }),
        ]))
        expect(await runSurfaceSelftestCommand({
            application: { ...application }, root, specifications: specifications(application), env: { PATH: bin },
        })).toEqual(expect.objectContaining({ kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID' }))
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
        expect(await readdir(join(root, '.cockpit/local/probes'), { recursive: true }))
            .not.toContainEqual(expect.stringContaining('transcript.json'))
        expect(JSON.stringify(outcome)).not.toMatch(/pretty-canary|deep-canary/)
    }, 180_000)
})
