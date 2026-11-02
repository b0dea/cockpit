import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createSelftestFixture } from '../../test-support/selftest-fixture.js'
import { runCli } from '../cli.js'
import { ENVIRONMENT_CODES } from '../environment/contract.js'
import { executeProbe } from '../environment-exec/execute.js'
import { surfaceSelftestExpectation } from '../surfaces/selftest.js'
import { runSelftestOperatorCommand, runSurfaceSelftestCommand } from './command.js'

const roots: string[] = []
const {
    fakeHarnesses,
    issuedCustomApplication,
    specifications,
    syntheticExecutableAuthorities,
} = createSelftestFixture(roots)

type CustomFixture = Awaited<ReturnType<typeof issuedCustomApplication>>

let instructedFixture: CustomFixture | undefined
let enforcedFixture: CustomFixture | undefined

beforeAll(async () => {
    instructedFixture = await issuedCustomApplication()
    enforcedFixture = await issuedCustomApplication(true)
}, 180_000)

afterEach(async () => {
    await Promise.all([instructedFixture, enforcedFixture].flatMap((entry) => entry ? [
        rm(join(entry.root, '.cockpit/local/probes'), { recursive: true, force: true }),
        rm(join(entry.root, 'harness-bin'), { recursive: true, force: true }),
    ] : []))
})

afterAll(async () => {
    instructedFixture = undefined
    enforcedFixture = undefined
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fixture(enforced = false) {
    const entry = enforced ? enforcedFixture : instructedFixture
    if (!entry) throw new Error('shared custom selftest fixture is unavailable')
    return entry
}

describe('surface selftest command', () => {
    it('writes no probe row for a custom cell, refuses one added by hand and records the cell pending', async () => {
        const { root, configPath, application } = fixture()
        const draftPath = join(root, 'probe-specifications.json')
        const output: string[] = []
        const io = { stdout: { write: (chunk: string) => output.push(chunk) > 0 }, stderr: { write: (chunk: string) => output.push(chunk) > 0 } }
        try {
            expect(await runCli(['selftest', '--config', configPath, '--write-probe-specifications', draftPath], io), output.join('')).toBe(0)
            const draft = JSON.parse(await readFile(draftPath, 'utf8')) as { specifications: { harness: { kind: string } }[] }
            expect(draft.specifications.length).toBeGreaterThan(0)
            expect(draft.specifications.filter((row) => row.harness.kind !== 'builtin')).toEqual([])
            expect(output.join('')).toMatch(/SELFTEST_CUSTOM_PROBE_UNSUPPORTED[^\n]*synthetic-harness instruction-loading/)
        } finally { await rm(draftPath, { force: true }) }

        const bin = await fakeHarnesses(root)
        const customCell = surfaceSelftestExpectation(application.surfaceSelftest)!.cells.find((cell) => cell.harness.kind === 'custom')!
        const [template] = specifications(application)
        const handAdded = { ...template!, harness: customCell.harness, capability: customCell.capability,
            invocation: ['{node}', '--probe', '{control}'], versionCommand: ['{node}', '--version'], helpCommand: ['{node}', '--help'] }
        const refused = await runSurfaceSelftestCommand(
            { application, root, specifications: [...specifications(application), handAdded] as never, env: { PATH: bin } },
            syntheticExecutableAuthorities(bin),
        )
        expect(refused).toMatchObject({ kind: 'refusal', code: 'SELFTEST_SOURCE_INVALID',
            reason: expect.stringContaining('custom harnesses cannot run and would be ignored, so they are refused: synthetic-harness instruction-loading') })

        const outcome = await runSurfaceSelftestCommand(
            { application, root, specifications: specifications(application), env: { PATH: bin } },
            syntheticExecutableAuthorities(bin),
        )
        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
        if (outcome.kind !== 'complete') return
        const record = outcome.bundle.records.find((row) => row.harness.kind === 'custom')
        expect(record).toEqual(expect.objectContaining({
            kind: 'human_needed', capability: 'instruction-loading', reason: 'enforcement_probe_required',
            harness: expect.objectContaining({ kind: 'custom', id: 'synthetic-harness' }),
            operatorAction: expect.stringContaining('record it in cockpit.toml for synthetic-harness instruction-loading'),
        }))
        expect(outcome.evidence.errors).toEqual([])
        expect(outcome.evidence.pending).toContainEqual(record)
    }, 180_000)

    it('does not execute a constructed worker for an instructed custom probe', async () => {
        const { root, application } = fixture()
        const bin = await fakeHarnesses(root)
        let customExecutions = 0
        const outcome = await runSurfaceSelftestCommand(
            { application, root, specifications: specifications(application), env: { PATH: bin } },
            {
                ...syntheticExecutableAuthorities(bin),
                execute: async (step) => {
                    if (step.labels.harness === 'synthetic-harness') {
                        customExecutions += 1
                        throw new Error('constructed custom probe command must not execute')
                    }
                    return executeProbe(step)
                },
            },
        )
        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
        if (outcome.kind !== 'complete') return
        expect(customExecutions).toBe(0)
        expect(outcome.bundle.records.find((row) => row.harness.kind === 'custom')).toEqual(expect.objectContaining({
            kind: 'human_needed', reason: 'enforcement_probe_required',
        }))
    }, 180_000)

    it('leaves declared custom enforcement for a real operator probe', async () => {
        const { root, application } = fixture(true)
        const bin = await fakeHarnesses(root)
        const outcome = await runSurfaceSelftestCommand(
            { application, root, specifications: specifications(application), env: { PATH: bin } },
            syntheticExecutableAuthorities(bin),
        )
        expect(outcome).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
        if (outcome.kind !== 'complete') return
        expect(outcome.bundle.records.find((row) => row.harness.kind === 'custom')).toEqual(expect.objectContaining({
            kind: 'human_needed', reason: 'enforcement_probe_required',
        }))
    }, 180_000)
})

describe('selftest operator admission', () => {
    it('refuses JSON, CI and missing terminal authority before dispatch or approval', async () => {
        let calls = 0
        let approvals = 0
        const input = { configPath: 'cockpit.toml', probeSpecificationsPath: 'probe.json', env: {} }
        const handler = async () => {
            calls += 1
            return { status: 0, diagnostics: [], result: null }
        }
        const confirm = async () => { approvals += 1; return 'a'.repeat(64) }
        const approvedIo = {
            stderr: { write: () => true },
            confirmSelftestExecutable: confirm,
            confirmSelftestProbeSpecifications: confirm,
        }
        for (const options of [
            { interactive: true, json: true, ci: undefined },
            { interactive: true, json: false, ci: '1' },
        ]) {
            expect(await runSelftestOperatorCommand(input, options, approvedIo, handler)).toMatchObject({
                status: 2, result: null,
                diagnostics: [{ code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE }],
            })
        }
        expect(await runSelftestOperatorCommand(input, { interactive: true, json: false, ci: undefined }, {
            stderr: { write: () => true },
            confirmSelftestExecutable: confirm,
        }, handler)).toMatchObject({ status: 2, result: null })
        expect(calls).toBe(0)
        expect(approvals).toBe(0)
    })

    it('leaves noninteractive requests without independently supplied executable or probe approval', async () => {
        const input = { configPath: 'cockpit.toml', probeSpecificationsPath: 'probe.json', env: {} }
        let observed: unknown
        let approvals = 0
        const confirm = async () => { approvals += 1; return 'a'.repeat(64) }
        expect(await runSelftestOperatorCommand(input, { interactive: false, json: true, ci: '1' }, {
            stderr: { write: () => true },
            confirmSelftestExecutable: confirm,
            confirmSelftestProbeSpecifications: confirm,
        }, async (request) => {
            observed = request
            return { status: 0, diagnostics: [], result: null }
        })).toEqual({ status: 0, diagnostics: [], result: null })
        expect(observed).toBe(input)
        expect(approvals).toBe(0)
    })
})
