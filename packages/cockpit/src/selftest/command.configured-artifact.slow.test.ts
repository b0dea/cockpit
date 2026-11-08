import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createSelftestFixture } from '../../test-support/selftest-fixture.js'
import { runCli } from '../cli.js'
import { renderHumanValue, renderHumanDiagnostics } from '../diagnostics.js'
import { syncGeneratedEnvironment } from '../generated-environment/command.js'
import { executeProbe } from '../environment-exec/execute.js'
import {
    runConfiguredSurfaceSelftestApplication,
    runConfiguredSurfaceSelftestOutcome,
    runSurfaceSelftestApplication,
    type SurfaceSelftestProbeSpecificationsCandidate,
} from '../environment/selftest-application.js'

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
        rm(join(sharedFixture.root, '.cockpit/local/probes'), { recursive: true, force: true }),
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
        const outcome = await runSurfaceSelftestApplication({
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
        expect(outcome.evidence.pending).toHaveLength(27)
        expect(outcome.bundle.records).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'human_needed', reason: 'authentication_required',
                operatorAction: expect.stringContaining('operator-approved absolute executable identity'),
            }),
        ]))
        expect(executions).toBe(0)
    }, 180_000)

    it('shows a real-sized native run as its summary and keeps inherited instructions out of the output', async () => {
        const { root, configPath } = await prepareFixture()
        const bin = join(root, 'native-bin')
        await mkdir(bin)
        // A real prompt-input stream holds the person's global instructions and runs to about 100 KB.
        const executable = join(bin, 'codex')
        await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs')
if (process.argv[2] === '--version') process.stdout.write('codex-cli 0.0.0-synthetic')
else if (process.argv[2] === '--help') process.stdout.write('debug prompt-input')
else process.stdout.write(JSON.stringify([
 {type:'message',role:'developer',content:[{type:'input_text',text:'PRIVATE-INHERITED-CANARY '.repeat(4000)}]},
 {type:'message',role:'user',content:[{type:'input_text',text:'# AGENTS.md instructions for '+process.cwd()+'\\n\\n<INSTRUCTIONS>\\n'+fs.readFileSync('AGENTS.md','utf8')+'\\n</INSTRUCTIONS>'}]},
]))
`)
        await chmod(executable, 0o700)
        const artifactPath = join(root, 'probe-specifications.json')
        const output: string[] = []
        const io = { stdout: { write: (chunk: string) => output.push(chunk) > 0 }, stderr: { write: (chunk: string) => output.push(chunk) > 0 } }
        expect(await runCli(['selftest', '--config', configPath, '--write-probe-specifications', artifactPath], io), output.join('')).toBe(0)
        const outcome = await runConfiguredSurfaceSelftestOutcome({
            configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin },
            requestProbeSpecificationsApproval: async candidate => candidate.sha256,
            requestExecutableApproval: async candidate => candidate.sha256,
        })
        expect(outcome.status, JSON.stringify(outcome.diagnostics)).toBe(0)
        expect(outcome.result).toMatchObject({ summary: { measuredCells: 1, pendingCells: 26, measurementComplete: false } })
        expect(JSON.stringify(outcome)).not.toContain('PRIVATE-INHERITED-CANARY')
        const shown = renderHumanValue(outcome.result)
        expect(shown).toContain('pendingCells')
        expect(shown).not.toContain('Result is not available')
        const terminal = renderHumanDiagnostics([], { command: 'selftest', outcome })
        expect(terminal).toMatch(/^Selftest incomplete: 1 measured, 26 pending\./)
        expect(terminal).not.toContain('candidateControl')
        // Cells whose native protocol exists but whose tool is absent here are the operator's to fix;
        // cells with no protocol yet stay pending until cockpit adds one. Each group is one diagnostic.
        expect(outcome.diagnostics.map(row => [row.code, row.message])).toEqual([
            ['EVIDENCE_UNAVAILABLE', expect.stringMatching(/^9 pending cell\(s\)\. Operator: install or locate the named tool/)],
            ['EVIDENCE_UNAVAILABLE', expect.stringMatching(/^17 pending cell\(s\)\. Unmeasurable by selftest as the files stand/)],
        ])
        const reportPath = (outcome.result as { reportPath: string }).reportPath
        expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual({ result: outcome.result, diagnostics: outcome.diagnostics })
        expect((await stat(reportPath)).mode & 0o777).toBe(0o600)
        // The run itself stays checkable: the private transcript still holds what was measured.
        const record = (outcome.result as { evidence: { evidence: { transcriptPath: string; events: { candidateControl: { stdoutSha256: string } } }[] } }).evidence.evidence[0]!
        expect(record.events.candidateControl.stdoutSha256).toMatch(/^[a-f0-9]{64}$/)
        const transcript = join(root, record.transcriptPath)
        expect(await readFile(transcript, 'utf8')).toContain('PRIVATE-INHERITED-CANARY')
        expect((await stat(transcript)).mode & 0o777).toBe(0o600)
    }, 180_000)

    it('keeps the structured report in the reviewed root when a config alias changes during approval', async () => {
        const { root, configPath } = fixture()
        const artifactPath = join(root, 'probe-specifications.json')
        const alias = join(root, 'config-alias.toml')
        const decoy = join(root, 'other-project')
        await mkdir(decoy)
        await writeFile(join(decoy, 'cockpit.toml'), '# A different project.\n')
        await symlink(configPath, alias)
        try {
            const io = { stdout: { write: () => true }, stderr: { write: () => true } }
            expect(await runCli(['selftest', '--config', alias, '--write-probe-specifications', artifactPath], io)).toBe(0)
            const outcome = await runConfiguredSurfaceSelftestOutcome({ configPath: alias, probeSpecificationsPath: artifactPath, env: {},
                requestProbeSpecificationsApproval: async candidate => {
                    await rm(alias)
                    await symlink(join(decoy, 'cockpit.toml'), alias)
                    return candidate.sha256
                } })
            expect(outcome.status).toBe(0)
            const reportPath = (outcome.result as { reportPath: string }).reportPath
            expect(reportPath.startsWith(join(root, '.cockpit/local/probes/'))).toBe(true)
            expect(JSON.parse(await readFile(reportPath, 'utf8')).result).toEqual(outcome.result)
            await expect(stat(join(decoy, '.cockpit'))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            await rm(alias, { force: true })
            await rm(decoy, { recursive: true, force: true })
        }
    }, 180_000)

    it.each(['artifact', 'configuration', 'executable-review'] as const)('refuses a changed %s after review before execution', async subject => {
        const { root, configPath, bin } = await prepareFixture()
        const artifactPath = join(root, 'probe-specifications.json')
        const io = { stdout: { write: () => true }, stderr: { write: () => true } }
        expect(await runCli(['selftest', '--config', configPath, '--write-probe-specifications', artifactPath], io)).toBe(0)
        let executions = 0
        let approvals = 0
        const outcome = await runConfiguredSurfaceSelftestApplication({ configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin } }, {
            execute: async () => { executions++; throw new Error('changed review must not execute') },
            requestExecutableApproval: async candidate => {
                approvals++
                await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n`)
                return candidate.sha256
            },
            requestProbeSpecificationsApproval: async candidate => {
                if (subject === 'executable-review') return candidate.sha256
                const path = subject === 'artifact' ? artifactPath : configPath
                await writeFile(path, `${await readFile(path, 'utf8')}\n`)
                return candidate.sha256
            },
        })
        expect(outcome).toMatchObject({ kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID', reason: expect.stringContaining('changed after review') })
        expect(executions).toBe(0)
        expect(approvals).toBe(subject === 'executable-review' ? 1 : 0)
    }, 180_000)

    it('writes a probe specification file that selftest admits once filled, and carries the filled rows past a config change', async () => {
        // Its own checkout: this case edits cockpit.toml.
        const { root, configPath, application, bin } = await prepareFixture()
        const artifactPath = join(root, 'probe-specifications.json')
        const output: string[] = []
        const io = { stdout: { write: (chunk: string) => output.push(chunk) > 0 }, stderr: { write: (chunk: string) => output.push(chunk) > 0 } }
        expect(await runCli(['selftest', '--config', configPath, '--write-probe-specifications', artifactPath], io), output.join('')).toBe(0)
        const draft = JSON.parse(await readFile(artifactPath, 'utf8')) as { specifications: Record<string, unknown>[] }
        expect(draft).toMatchObject({
            schema: 'cockpit-selftest-probe-specifications/v1',
            sourceSha256: application.sourceSha256,
            generatedManifestSha256: application.surfaceSelftest.manifestSha256,
        })

        const unapproved = await runConfiguredSurfaceSelftestApplication({
            configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin },
        }, { execute: async () => { throw new Error('an unapproved file must not run a probe') } })
        expect(unapproved).toMatchObject({
            kind: 'refusal', code: 'SELFTEST_EXECUTION_INVALID',
            reason: expect.stringContaining('requires independent approval'),
        })

        // A file from before the native rows can still hold nulls, and never runs a probe.
        await writeFile(artifactPath, JSON.stringify({ ...draft, specifications: draft.specifications.map(row =>
            ({ ...row, invocation: null, candidateCode: null, brokenCode: null })) }))
        const unfilled = await runConfiguredSurfaceSelftestApplication({
            configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin },
        }, { execute: async () => { throw new Error('an unfilled file must not run a probe') } })
        expect(unfilled).toMatchObject({
            kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID',
            reason: expect.stringContaining('Claude Code guard-firing: invocation, candidateCode, brokenCode'),
        })

        // Previously filled exact-code rows remain a supported legacy protocol.
        const supplied = specifications(application)
        const filled = supplied.map(row => ({ ...row }))
        const artifactBytes = JSON.stringify({ ...draft, specifications: filled })
        await writeFile(artifactPath, artifactBytes)

        let approvalCandidate: SurfaceSelftestProbeSpecificationsCandidate | undefined
        const outcome = await runConfiguredSurfaceSelftestApplication({
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
        expect(outcome.bundle.records).toHaveLength(27)
        expect(outcome.evidence.errors).toEqual([])

        // A config change makes the filled file stale. The new file keeps each complete row whose
        // cell is unchanged; a row the person left partly null starts over.
        await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n# a reviewed change\n`)
        expect(await syncGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
        expect(await runConfiguredSurfaceSelftestApplication({ configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin } },
            { execute: async () => { throw new Error('a stale file must not run a probe') } })).toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('written for a different cockpit.toml'),
            fix: expect.stringContaining('--write-probe-specifications <new file> --probe-specifications <this file>'),
        })
        const partial = filled.map((row, index) => index === 0 ? { ...row, candidateCode: null } : row)
        await writeFile(artifactPath, JSON.stringify({ ...draft, specifications: partial }))
        const rewrittenPath = join(root, 'probe-specifications-rewritten.json')
        output.length = 0
        expect(await runCli(['selftest', '--config', configPath, '--write-probe-specifications', rewrittenPath,
            '--probe-specifications', artifactPath], io), output.join('')).toBe(0)
        const rewritten = JSON.parse(await readFile(rewrittenPath, 'utf8')) as typeof draft & { sourceSha256: string }
        expect(rewritten.sourceSha256).not.toBe(application.sourceSha256)
        expect(rewritten.specifications).toEqual([draft.specifications[0], ...filled.slice(1)])
        expect(output.join('')).toContain(`${filled.length - 1} of ${filled.length} row(s) kept unchanged`)
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
            specifications: forgedSpecifications,
        }))
        let executions = 0

        const outcome = await runConfiguredSurfaceSelftestApplication({
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

    it('authenticates configured probe artifacts with undefined search aliases without reading unrelated values', async () => {
        const { root, configPath, application, bin } = fixture()
        const probeSpecifications = specifications(application)
        const artifactPath = join(root, 'probe-specifications.json')
        const artifactBytes = JSON.stringify({
            schema: 'cockpit-selftest-probe-specifications/v1',
            sourceSha256: application.sourceSha256,
            generatedManifestSha256: application.surfaceSelftest.manifestSha256,
            specifications: probeSpecifications,
        })
        await writeFile(artifactPath, artifactBytes)
        const unrelated = vi.fn(() => { throw new Error('unrelated environment value must not be read') })
        const env = Object.defineProperty({ PATH: bin, Path: undefined }, 'UNRELATED', { enumerable: true, get: unrelated })
        const execute = vi.fn(async () => { throw new Error('unapproved executable must not run') })
        const requestProbeSpecificationsApproval = vi.fn(async (candidate: SurfaceSelftestProbeSpecificationsCandidate) => candidate.sha256)

        const outcome = await runConfiguredSurfaceSelftestApplication({
            configPath, probeSpecificationsPath: artifactPath, env,
        }, { execute, requestProbeSpecificationsApproval })

        expect(outcome).toMatchObject({ kind: 'complete', status: 0 })
        if (outcome.kind !== 'complete') throw new Error('captured configured search input did not reach artifact authentication')
        expect(requestProbeSpecificationsApproval).toHaveBeenCalledWith(expect.objectContaining({
            canonicalPath: artifactPath,
            sha256: createHash('sha256').update(artifactBytes).digest('hex'),
            sourceSha256: application.sourceSha256,
            generatedManifestSha256: application.surfaceSelftest.manifestSha256,
        }))
        expect(outcome.evidence.errors).toEqual([])
        expect(outcome.evidence.evidence).toEqual([])
        expect(outcome.evidence.pending).toHaveLength(27)
        expect(outcome.bundle.records.every(record => record.kind === 'human_needed'
            && record.reason === 'authentication_required')).toBe(true)
        expect(unrelated).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    }, 180_000)

    it('refuses absent, malformed and mismatched probe artifacts before executing a probe', async () => {
        const { root, configPath, application, bin } = fixture()
        let executions = 0
        const execute = async () => {
            executions += 1
            throw new Error('probe execution must not start')
        }
        const missing = await runConfiguredSurfaceSelftestApplication({
            configPath, probeSpecificationsPath: join(root, 'missing.json'), env: { PATH: bin },
        }, { execute })
        const producer = './node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --config <your cockpit.toml> --write-probe-specifications <new file>'
        expect(missing).toEqual(expect.objectContaining({
            kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID', fix: expect.stringContaining(producer),
        }))

        const artifactPath = join(root, 'probe-specifications.json')
        await writeFile(artifactPath, '{')
        const malformed = await runConfiguredSurfaceSelftestApplication({
            configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin },
        }, { execute })
        expect(malformed).toEqual(expect.objectContaining({ kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID' }))

        const probeSpecifications = specifications(application)
        await writeFile(artifactPath, JSON.stringify({
            schema: 'cockpit-selftest-probe-specifications/v1',
            sourceSha256: '0'.repeat(64),
            generatedManifestSha256: application.surfaceSelftest.manifestSha256,
            specifications: probeSpecifications,
        }))
        const mismatched = await runConfiguredSurfaceSelftestApplication({
            configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin },
        }, { execute })
        expect(mismatched).toEqual(expect.objectContaining({
            kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID',
            reason: expect.stringContaining('written for a different cockpit.toml'), fix: expect.stringContaining(producer),
        }))
        expect(executions).toBe(0)
    }, 180_000)
})
