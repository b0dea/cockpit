import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createSelftestFixture } from '../../test-support/selftest-fixture.js'
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

describe('surface selftest command', () => {
    it('drives candidate and broken controls through authenticated execution', async () => {
        const { root, application } = fixture()
        const bin = await fakeHarnesses(root)
        const operator = await syntheticOperatorApprovals(bin)
        const outcome = await runSurfaceSelftestCommand(
            { application, root, specifications: specifications(application), env: { PATH: bin } },
            operator.adapters,
        )
        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
        if (outcome.kind !== 'complete') return
        expect(outcome.evidence.errors).toEqual([])
        expect(outcome.bundle.records).toHaveLength(27)
        expect(outcome.evidence.evidence).toHaveLength(27)
        expect(outcome.evidence.pending).toEqual([])
        expect(operator.requests).toHaveLength(3)
        expect(outcome.bundle.skillReviews).toEqual(expect.arrayContaining([
            expect.objectContaining({ harness: 'Claude Code', status: 'human_needed' }),
            expect.objectContaining({ harness: 'Codex', status: 'human_needed' }),
        ]))
        expect(await runSurfaceSelftestCommand({
            application: { ...application }, root, specifications: specifications(application), env: { PATH: bin },
        })).toEqual(expect.objectContaining({ kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID' }))
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
