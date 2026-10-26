import { createHash } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createSelftestFixture, specificationsDigest } from '../../test-support/selftest-fixture.js'
import { executeProbe } from '../environment-exec/execute.js'
import {
    runConfiguredSurfaceSelftestCommand,
    runSurfaceSelftestCommand,
    type SurfaceSelftestProbeSpecificationsCandidate,
} from './command.js'

const roots: string[] = []
const {
    fakeHarnesses,
    issuedApplication,
    specifications,
    syntheticExecutableAuthorities,
} = createSelftestFixture(roots)

async function prepareFixture() {
    const issued = await issuedApplication()
    return { ...issued, bin: await fakeHarnesses(issued.root) }
}

let sharedFixture: Awaited<ReturnType<typeof prepareFixture>> | undefined

beforeAll(async () => {
    sharedFixture = await prepareFixture()
}, 180_000)

afterEach(async () => {
    if (!sharedFixture) return
    await Promise.all([
        rm(join(sharedFixture.root, 'internal'), { recursive: true, force: true }),
        rm(join(sharedFixture.root, 'probe-specifications.json'), { force: true }),
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
    it('does not promote PATH-shadowed builtins without independent executable authority', async () => {
        const { root, application, bin } = fixture()
        let executions = 0
        const outcome = await runSurfaceSelftestCommand({
            application, root, specifications: specifications(application), env: { PATH: bin },
        }, {
            execute: async () => {
                executions += 1
                throw new Error('unapproved executable must not run')
            },
            requestExecutableApproval: async () => 'not-the-executable-digest',
        })
        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
        if (outcome.kind !== 'complete') return
        expect(outcome.evidence.evidence).toEqual([])
        expect(outcome.evidence.pending).toHaveLength(24)
        expect(outcome.bundle.records).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'human_needed', reason: 'authentication_required',
                operatorAction: expect.stringContaining('operator-approved absolute executable identity'),
            }),
        ]))
        expect(executions).toBe(0)
    }, 180_000)

    it('checks configured output then admits an authenticated probe specification artifact', async () => {
        const { root, configPath, application, bin } = fixture()
        const probeSpecifications = specifications(application)
        const artifactPath = join(root, 'probe-specifications.json')
        const specificationsSha256 = specificationsDigest(probeSpecifications)
        const artifactBytes = JSON.stringify({
            schema: 'cockpit-selftest-probe-specifications/v1',
            sourceSha256: application.sourceSha256,
            generatedManifestSha256: application.surfaceSelftest.manifestSha256,
            specificationsSha256,
            specifications: probeSpecifications,
        })
        await writeFile(artifactPath, artifactBytes)

        let approvalCandidate: SurfaceSelftestProbeSpecificationsCandidate | undefined
        const outcome = await runConfiguredSurfaceSelftestCommand({
            configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin },
        }, {
            ...syntheticExecutableAuthorities(bin),
            requestProbeSpecificationsApproval: async (candidate) => {
                approvalCandidate = candidate
                return candidate.sha256
            },
        })
        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
        if (outcome.kind !== 'complete') return
        expect(approvalCandidate).toEqual(expect.objectContaining({
            canonicalPath: artifactPath,
            sha256: createHash('sha256').update(artifactBytes).digest('hex'),
            sourceSha256: application.sourceSha256,
            generatedManifestSha256: application.surfaceSelftest.manifestSha256,
            specificationsSha256,
            commandVectors: expect.arrayContaining([
                expect.objectContaining({
                    harness: 'Codex',
                    capability: 'instruction-loading',
                    invocation: ['{executable}', '--probe', 'instruction-loading', '{control}'],
                    versionCommand: ['{executable}', '--version'],
                    helpCommand: ['{executable}', '--help'],
                }),
            ]),
        }))
        expect(outcome.bundle.records).toHaveLength(24)
        expect(outcome.evidence.errors).toEqual([])
    }, 180_000)

    it('refuses a self-attested probe artifact before any submitted command vector executes', async () => {
        const { root, configPath, application, bin } = fixture()
        const forgedSpecifications = specifications(application).map((specification, index) => index === 0
            ? { ...specification, helpCommand: ['{executable}', '--forged-help-vector'] as const }
            : specification)
        const artifactPath = join(root, 'probe-specifications.json')
        await writeFile(artifactPath, JSON.stringify({
            schema: 'cockpit-selftest-probe-specifications/v1',
            sourceSha256: application.sourceSha256,
            generatedManifestSha256: application.surfaceSelftest.manifestSha256,
            specificationsSha256: specificationsDigest(forgedSpecifications),
            specifications: forgedSpecifications,
        }))
        let executions = 0

        const outcome = await runConfiguredSurfaceSelftestCommand({
            configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin },
        }, {
            ...syntheticExecutableAuthorities(bin),
            execute: async (step) => {
                executions += 1
                return executeProbe(step)
            },
        })

        expect(outcome).toEqual(expect.objectContaining({
            kind: 'refusal', code: 'SELFTEST_EXECUTION_INVALID',
        }))
        expect(executions).toBe(0)
    }, 180_000)

    it('refuses absent, malformed and mismatched probe artifacts before executing a probe', async () => {
        const { root, configPath, application, bin } = fixture()
        let executions = 0
        const execute = async () => {
            executions += 1
            throw new Error('probe execution must not start')
        }
        const missing = await runConfiguredSurfaceSelftestCommand({
            configPath, probeSpecificationsPath: join(root, 'missing.json'), env: { PATH: bin },
        }, { execute })
        expect(missing).toEqual(expect.objectContaining({ kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID' }))

        const artifactPath = join(root, 'probe-specifications.json')
        await writeFile(artifactPath, '{')
        const malformed = await runConfiguredSurfaceSelftestCommand({
            configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin },
        }, { execute })
        expect(malformed).toEqual(expect.objectContaining({ kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID' }))

        const probeSpecifications = specifications(application)
        await writeFile(artifactPath, JSON.stringify({
            schema: 'cockpit-selftest-probe-specifications/v1',
            sourceSha256: '0'.repeat(64),
            generatedManifestSha256: application.surfaceSelftest.manifestSha256,
            specificationsSha256: specificationsDigest(probeSpecifications),
            specifications: probeSpecifications,
        }))
        const mismatched = await runConfiguredSurfaceSelftestCommand({
            configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin },
        }, { execute })
        expect(mismatched).toEqual(expect.objectContaining({ kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID' }))
        expect(executions).toBe(0)
    }, 180_000)
})
