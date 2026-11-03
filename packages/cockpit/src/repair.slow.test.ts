import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeConfigSource } from './config/load.js'
import { executeProbe } from './environment-exec/execute.js'
import { applyGeneratedEnvironmentRepair, checkGeneratedEnvironment, prepareGeneratedEnvironmentCurrentness, syncGeneratedEnvironment } from './environment/generated-application.js'
import * as transaction from './generated-environment/transaction.js'
import { proposeGeneratedEnvironmentRepair } from './repair.js'
import { runCli, type CliIo } from './cli.js'
import { initializeTeamMetadata } from '../test-support/team-metadata.js'

const roots: string[] = []
const firstInstant = '2026-10-22T12:00:00.000Z'
const nextInstant = '2026-10-23T12:00:00.000Z'
const ledgerPath = '.cockpit/generated-environment-ownership.json'
const overridePath = 'compose.cockpit.yml'
// The after-publish proof re-reads the agent surfaces it published, so those cases corrupt one of them.
const surfacePath = 'AGENTS.md'

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function consumer() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-repair-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    await mkdir(join(root, 'app'))
    await writeFile(configPath, `${(await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8')).replace(
        'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
    )}\n[environment]\ncompose_files = ["compose.yml"]\n`)
    await writeFile(join(root, 'compose.yml'), `services:\n  first:\n    image: node@sha256:${'8'.repeat(64)}\n    volumes: ["./app:/app"]\n`)
    const synced = await syncGeneratedEnvironment({ configPath }, { now: () => firstInstant })
    expect(synced).toMatchObject({ kind: 'complete' })
    if (synced.kind !== 'complete') throw new Error('Synthetic repair fixture failed')
    return { root, configPath, paths: [...synced.result.paths, ledgerPath] }
}

// A service added to compose.yml changes the ownership override the next sync writes.
async function addService(root: string, name: string) {
    const path = join(root, 'compose.yml')
    await writeFile(path, `${await readFile(path, 'utf8')}  ${name}:\n    image: node@sha256:${'9'.repeat(64)}\n`)
}

// Each case drives the real lifecycle owners through dozens of child processes (fenced execution,
// publication helpers, Git and runtime probes), so its wall time scales with machine load rather
// than with the work under test. The budget is sized for four concurrent workers on a busy host.
describe('canonical mechanical repair', { timeout: 180_000 }, () => {
    it('uses one admission and the same plan for catalogue repair with single consumption', async () => {
        const { root, configPath } = await consumer()
        expect(await initializeTeamMetadata(configPath)).toMatchObject({ kind: 'complete' })
        await addService(root, 'changed')
        let stdout = ''
        const io = { stdout: { write: (text: string) => { stdout += text; return true } }, stderr: { write: () => true } } as CliIo
        expect(await runCli(['check', '--config', configPath, '--json'], io, {}, { env: { CI: '1' } })).toBe(2)
        const envelope = JSON.parse(stdout)
        expect(envelope.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
            code: 'GENERATED_ARTIFACT_DRIFT', target: overridePath,
        })]))
        const displayed = envelope.result.repair
        expect(displayed.changes).toEqual(expect.arrayContaining([{ operation: 'write', path: overridePath }, { operation: 'write', path: ledgerPath }]))
        expect(displayed.fixes[0].argv).toEqual(['npx', '--no', 'cockpit', 'sync', '--config', configPath])
        const admit = vi.spyOn(transaction, 'admitPublicationPlan')
        const run = vi.spyOn(transaction, 'runPublicationPlan')
        try {
            const current = await prepareGeneratedEnvironmentCurrentness({ configPath }, { now: () => nextInstant })
            expect(admit).toHaveBeenCalledTimes(1)
            const admission = await admit.mock.results[0]!.value
            if (admission.kind !== 'complete' || !current.repairAuthority) throw new Error('Expected privately admitted repair')
            const proposal = proposeGeneratedEnvironmentRepair(current)
            expect(proposal.changes).toBe(current.changes)
            expect(proposal.fixes[0]?.argv).toEqual(['npx', '--no', 'cockpit', 'sync', '--config', configPath])
            const before = await readFile(join(root, overridePath), 'utf8')
            expect(before).toContain('first:')
            expect(before).not.toContain('changed:')
            expect(await applyGeneratedEnvironmentRepair(current.repairAuthority)).toMatchObject({ kind: 'complete' })
            expect(run).toHaveBeenCalledTimes(1)
            expect(run.mock.calls[0]![0]).toBe(admission.plan)
            expect(admit).toHaveBeenCalledTimes(1)
            expect(await readFile(join(root, overridePath), 'utf8')).toContain('changed:')
            expect(await applyGeneratedEnvironmentRepair(current.repairAuthority)).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ message: expect.stringMatching(/authority/) })] })
            expect(await applyGeneratedEnvironmentRepair({ ...current.repairAuthority })).toMatchObject({ kind: 'refusal' })
        } finally { admit.mockRestore(); run.mockRestore() }
    })

    // compose.yml is an input of compose.cockpit.yml just as cockpit.toml is, so an edit to either
    // between prepare and apply makes the prepared override stale.
    it.each([
        ['the configuration', async (_root: string, configPath: string) => writeFile(configPath, (await readFile(configPath, 'utf8'))
            .replace('purpose = "Synthetic application"', 'purpose = "Changed synthetic application"'))],
        ['a declared Compose file', async (root: string) => addService(root, 'changed-again')],
    ] as const)('refuses stale authority without changing exact output preimages when %s changes', async (_input, change) => {
        const { root, configPath, paths } = await consumer()
        await addService(root, 'changed')
        const current = await prepareGeneratedEnvironmentCurrentness({ configPath })
        if (!current.repairAuthority) throw new Error('Expected repair authority')
        const before = await Promise.all(paths.map(path => readFile(join(root, path))))
        await change(root, configPath)
        expect(await applyGeneratedEnvironmentRepair(current.repairAuthority)).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_SOURCE_CHANGED' })] })
        expect(await Promise.all(paths.map(path => readFile(join(root, path))))).toEqual(before)
    })

    it('compensates every preimage when canonical after-publish proof becomes unavailable', async () => {
        const { root, configPath, paths } = await consumer()
        await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('purpose = "Synthetic application"', 'purpose = "Changed synthetic application"'))
        const before = await Promise.all(paths.map(path => readFile(join(root, path))))
        let published = false
        let failed = false
        const current = await prepareGeneratedEnvironmentCurrentness({ configPath }, {
            observeSource: observeConfigSource,
            execute: async step => {
                const outcome = await executeProbe(step)
                if (step.labels.action === 'publish-batch' || step.labels.action === 'publish') published = true
                if (published && !failed && step.labels.action === 'read-batch') {
                    const request = JSON.parse(step.argv[3]!) as { entries: { action: string; segments?: string[]; name: string; output: string }[] }
                    const override = request.entries.find(entry => (entry.action === 'read-file' || entry.action === 'read-entry') && [...entry.segments ?? [], entry.name].join('/') === surfacePath)
                    if (override) {
                        await writeFile(override.output, 'synthetic invalid captured bytes\n')
                        failed = true
                    }
                }
                return outcome
            },
        })
        if (!current.repairAuthority) throw new Error('Expected repair authority')
        expect(await applyGeneratedEnvironmentRepair(current.repairAuthority)).toMatchObject({ kind: 'refusal' })
        expect(failed).toBe(true)
        expect(await Promise.all(paths.map(path => readFile(join(root, path))))).toEqual(before)
    })

    // The ownership manifest is committed, so a repair at a later time must not dirty it with a clock.
    it('repairs same-generation corrupted owned bytes without rewriting the committed ownership manifest', async () => {
        const { root, configPath } = await consumer()
        const before = await readFile(join(root, ledgerPath), 'utf8')
        const desired = await readFile(join(root, overridePath), 'utf8')
        await writeFile(join(root, overridePath), 'synthetic corruption\n')
        const admit = vi.spyOn(transaction, 'admitPublicationPlan')
        let current: Awaited<ReturnType<typeof prepareGeneratedEnvironmentCurrentness>>
        let admitted: Awaited<ReturnType<typeof transaction.admitPublicationPlan>>
        try {
            current = await prepareGeneratedEnvironmentCurrentness({ configPath }, { now: () => nextInstant })
            expect(admit).toHaveBeenCalledTimes(1)
            admitted = await admit.mock.results[0]!.value
        } finally { admit.mockRestore() }
        expect(current.repairAuthority, JSON.stringify(admitted)).toBeDefined()
        expect(current.outcome).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_ARTIFACT_DRIFT' })] })
        if (!current.repairAuthority) throw new Error('Corrupted owned leaf needs genuine repair authority')
        expect(await applyGeneratedEnvironmentRepair(current.repairAuthority)).toMatchObject({ kind: 'complete' })
        expect(await readFile(join(root, ledgerPath), 'utf8')).toBe(before)
        expect(await readFile(join(root, overridePath), 'utf8')).toBe(desired)
    })

    it('compensates corrupt preimages and explicitly syncs the identical admitted restoration once', async () => {
        const { root, configPath, paths } = await consumer()
        const desired = await readFile(join(root, overridePath))
        const originalLedger = await readFile(join(root, ledgerPath))
        const original = JSON.parse(originalLedger.toString())
        await writeFile(join(root, 'foreign.txt'), 'unowned synthetic control\n')
        await writeFile(join(root, overridePath), 'synthetic corrupt preimage\n')
        const preimages = await Promise.all(paths.map(path => readFile(join(root, path))))
        const admit = vi.spyOn(transaction, 'admitPublicationPlan')
        const run = vi.spyOn(transaction, 'runPublicationPlan')
        try {
            let published = false
            let failed = false
            const current = await prepareGeneratedEnvironmentCurrentness({ configPath }, {
                now: () => nextInstant,
                observeSource: observeConfigSource,
                execute: async step => {
                    const outcome = await executeProbe(step)
                    if (step.labels.action === 'publish-batch' || step.labels.action === 'publish') published = true
                    // One file is read alone and several in a batch, so the proof's read of the override is either.
                    if (published && !failed && (step.labels.action === 'read-batch' || step.labels.action === 'read-file')) {
                        type Entry = { action: string; segments?: string[]; name: string; output: string }
                        const request = JSON.parse(step.argv[3]!) as Entry & { entries?: Entry[] }
                        const override = (request.entries ?? [request]).find(entry => (entry.action === 'read-file' || entry.action === 'read-entry') && [...entry.segments ?? [], entry.name].join('/') === overridePath)
                        if (override) {
                            await writeFile(override.output, 'synthetic unavailable canonical proof\n')
                            failed = true
                        }
                    }
                    return outcome
                },
            })
            expect(current.changes).toEqual([{ operation: 'write', path: overridePath }])
            expect(admit).toHaveBeenCalledTimes(1)
            const admitted = await admit.mock.results[0]!.value
            if (admitted.kind !== 'complete' || !current.repairAuthority) throw new Error('Corrupt repair authority unavailable')
            expect(await applyGeneratedEnvironmentRepair(current.repairAuthority)).toMatchObject({ kind: 'refusal' })
            expect(failed).toBe(true)
            expect(run).toHaveBeenCalledTimes(1)
            expect(run.mock.calls[0]![0]).toBe(admitted.plan)
            expect(admit).toHaveBeenCalledTimes(1)
            expect(await Promise.all(paths.map(path => readFile(join(root, path))))).toEqual(preimages)
            expect(await applyGeneratedEnvironmentRepair(current.repairAuthority)).toMatchObject({ kind: 'refusal' })
            expect(run).toHaveBeenCalledTimes(1)
            admit.mockClear()
            run.mockClear()

            expect(await syncGeneratedEnvironment({ configPath }, { now: () => nextInstant })).toMatchObject({ kind: 'complete' })
            expect(admit).toHaveBeenCalledTimes(1)
            const syncAdmission = await admit.mock.results[0]!.value
            if (syncAdmission.kind !== 'complete') throw new Error('Explicit restoration refused')
            expect(run).toHaveBeenCalledTimes(1)
            expect(run.mock.calls[0]![0]).toBe(syncAdmission.plan)
            expect(await readFile(join(root, overridePath))).toEqual(desired)
            expect(JSON.parse(await readFile(join(root, ledgerPath), 'utf8'))).toEqual(original)
            expect(await checkGeneratedEnvironment({ configPath })).toMatchObject({ kind: 'complete' })
            expect(await readFile(join(root, 'foreign.txt'), 'utf8')).toBe('unowned synthetic control\n')
        } finally { admit.mockRestore(); run.mockRestore() }
    })
})
