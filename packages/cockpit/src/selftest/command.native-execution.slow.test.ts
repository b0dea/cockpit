import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createSelftestFixture } from '../../test-support/selftest-fixture.js'
import { draftSurfaceSelftestSpecifications, surfaceSelftestExpectation, type SelftestProbeSpecification } from '../surfaces/selftest.js'
import { validateSelftestEvidenceBundle } from '../../libexec/validate-harness-evidence.mjs'
import { executeProbe } from '../environment-exec/execute.js'
import type { ExecutionStep } from '../environment/contract.js'
import { runSurfaceSelftestApplication } from '../environment/selftest-application.js'

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
        const outcome = await runSurfaceSelftestApplication(
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
        expect(await runSurfaceSelftestApplication({
            application: { ...application }, root, specifications: specifications(application), env: { PATH: bin },
        })).toEqual(expect.objectContaining({ kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID' }))
    }, 180_000)

    it('loads exact generated instructions through the native discovery protocol and leaves unsupported cells pending', async () => {
        const { root, application } = fixture()
        const bin = join(root, 'harness-bin')
        await mkdir(bin)
        const executable = join(bin, 'codex')
        await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs')
if (process.argv[2] === '--version') process.stdout.write('codex-cli 0.0.0-synthetic')
else if (process.argv[2] === '--help') process.stdout.write('debug prompt-input')
else {
 const bytes = fs.readFileSync('AGENTS.md', 'utf8')
 process.stdout.write(JSON.stringify([{type:'message',role:'user',content:[{type:'input_text',text:
 '# AGENTS.md instructions for '+process.cwd()+'\\n\\n<INSTRUCTIONS>\\nInherited guidance.\\n\\n'+bytes+'\\n</INSTRUCTIONS>'}]}]))
}
`)
        await chmod(executable, 0o700)
        const draft = draftSurfaceSelftestSpecifications(application.surfaceSelftest)!
        const steps: ExecutionStep[] = []
        const outcome = await runSurfaceSelftestApplication({ root, application,
            specifications: draft.specifications as readonly SelftestProbeSpecification[], env: { PATH: bin } }, {
            testOnlyExecutableIdentities: { Codex: [executable] },
            execute: async step => { steps.push(step); return executeProbe(step) },
        })
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'complete', status: 0 })
        if (outcome.kind !== 'complete') throw new Error('native instruction evidence failed')
        expect(outcome.evidence.errors).toEqual([])
        expect(outcome.evidence.evidence).toHaveLength(1)
        expect(outcome.evidence.pending).toHaveLength(26)
        expect(outcome.evidence.pending.every(row => row.reason === 'native_protocol_unsupported')).toBe(true)
        const record = outcome.evidence.evidence[0]!
        expect(record).toMatchObject({ protocol: 'codex-prompt-input/v1', verdict: 'instructed' })
        expect(record.version).toBe('0.0.0-synthetic')
        const forged = structuredClone(outcome.bundle)
        const forgedRecord = forged.records.find(row => row.kind === 'evidence')!
        if (forgedRecord.kind !== 'evidence') throw new Error('native evidence missing')
        forgedRecord.candidateSha256 = 'f'.repeat(64)
        expect(validateSelftestEvidenceBundle(forged, surfaceSelftestExpectation(application.surfaceSelftest)!, root, {
            testOnlyExecutableIdentities: { Codex: [executable] },
        }).errors).toEqual(expect.arrayContaining([expect.stringContaining('native candidate does not match the generated AGENTS.md source authority')]))
        for (const events of [
            { ...record.events, candidateControl: { ...record.events.candidateControl, cwd: {} } },
            { ...record.events, version: { ...record.events.version, stdout: {} } },
        ]) {
            const malformed = { ...outcome.bundle, records: outcome.bundle.records.map(row => row.kind === 'evidence' && row.runId === record.runId ? { ...record, events } : row) }
            const check = () => validateSelftestEvidenceBundle(malformed, surfaceSelftestExpectation(application.surfaceSelftest)!, root, {
                testOnlyExecutableIdentities: { Codex: [executable] },
            })
            expect(check).not.toThrow()
            expect(check().errors).not.toEqual([])
        }
        expect(record.candidatePath).toMatch(/\/candidate\/AGENTS\.md$/)
        const generated = application.surfaceSelftest.entries.find(entry => entry.path === 'AGENTS.md')!
        const expectedBytes = generated.kind === 'file' ? generated.bytes
            : generated.region.format === 'markdown-delimited' ? generated.region.bytes : ''
        expect(await readFile(join(root, record.candidatePath), 'utf8')).toBe(expectedBytes)
        expect(steps.filter(step => step.labels.role === 'candidate')[0]?.filesystemChecks)
            .toContainEqual(expect.objectContaining({ path: join(root, record.candidatePath), sha256: record.candidateSha256 }))
    }, 180_000)

    it('preserves POSIX executable approval with an undefined search alias without reading unrelated values', async () => {
        const { root, application } = fixture()
        const bin = await fakeHarnesses(root)
        const unrelated = vi.fn(() => { throw new Error('unrelated environment value must not be read') })
        const env = Object.defineProperty({ PATH: bin, Path: undefined }, 'UNRELATED', { enumerable: true, get: unrelated })
        const execute = vi.fn(async () => { throw new Error('unapproved executable must not run') })
        const requestExecutableApproval = vi.fn(async () => undefined)

        const outcome = await runSurfaceSelftestApplication({
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

        const outcome = await runSurfaceSelftestApplication({
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
        const outcome = await runSurfaceSelftestApplication(
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
        const outcome = await runSurfaceSelftestApplication(
            { application, root, specifications: specifications(application), env: { PATH: bin } }, operator.adapters,
        )
        expect(outcome).toMatchObject({ kind: 'refusal', code: 'SELFTEST_EXECUTION_INVALID' })
        expect(await readdir(join(root, '.cockpit/local/probes'), { recursive: true }))
            .not.toContainEqual(expect.stringContaining('transcript.json'))
        expect(JSON.stringify(outcome)).not.toMatch(/pretty-canary|deep-canary/)
    }, 180_000)
})
