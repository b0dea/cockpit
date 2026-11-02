import { existsSync } from 'node:fs'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runWorkApplication } from './application.js'
import { workOrderFixture } from '../test-support/work-order.js'
import { createWorkCompositionFixtureSupport, reidentifyWorkOrder } from '../../test-support/work-composition-fixture.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const { configuredFixture } = createWorkCompositionFixtureSupport(roots)

describe('configured durable work application composition', () => {
    it('keeps acceptance evidence current, persists human gaps and completes accepted Evidence spacing', async () => {
        const fixture = await configuredFixture()
        const contractPath = join(fixture.root, 'workorders/WO-001.md')
        const auditPath = join(fixture.root, 'workorders/WO-001.source-audit.json')
        const skillPath = join(fixture.root, 'skills/planning.md')
        const objectiveCheckbox = '1. [ ] Preserve this objective checklist example.'
        const nonGoalCheckbox = '2. [ ] Preserve this non-goal checklist example.'
        const contract = (await readFile(contractPath, 'utf8'))
            .replace('Return current values after a cache refresh.', `Return current values after a cache refresh.\n${objectiveCheckbox}`)
            .replace('Changing the storage provider.', `Changing the storage provider.\n${nonGoalCheckbox}`)
        await writeFile(contractPath, contract.replace('## Evidence\n- none\n## Decisions', '## Evidence\u00a0\n\uFEFF\n- none\u00a0\n## Decisions'))
        const audit = await readFile(auditPath, 'utf8'); const decodedAudit = JSON.parse(audit) as Record<string, unknown>
        const changedAudit = JSON.stringify({ ...decodedAudit, gaps: [{ kind: 'question', reference: 'S1', detail: 'Confirm the current cache boundary.' }] })
        const skill = await readFile(skillPath)

        await expect(runWorkApplication({ operation: 'work-intake', workOrderId: 'WO-001' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete' })
        await writeFile(auditPath, changedAudit)
        await expect(runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-001' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('Named source') })
        await writeFile(auditPath, audit)

        const staleAudit = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-001' }, fixture.composition)
        if (staleAudit.kind !== 'human-needed') throw new Error('source-audit race continuation unavailable')
        await writeFile(auditPath, changedAudit)
        await expect(staleAudit.continuation.decide(`accept ${staleAudit.continuation.digest}`))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('source audit changed') })
        await writeFile(auditPath, audit)

        const staleSkill = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-001' }, fixture.composition)
        if (staleSkill.kind !== 'human-needed') throw new Error('installed-skill race continuation unavailable')
        await writeFile(skillPath, 'Changed planning guidance.\n')
        await expect(staleSkill.continuation.decide(`accept ${staleSkill.continuation.digest}`))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('installed-skill audit bytes changed') })
        await writeFile(skillPath, skill)

        const accepted = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-001' }, fixture.composition)
        if (accepted.kind !== 'human-needed') throw new Error('current acceptance continuation unavailable')
        await expect(accepted.continuation.decide(`accept ${accepted.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        await writeFile(join(fixture.root, 'intents/gap.json'), JSON.stringify({ kind: 'gap', id: 'cache-owner', step: 1,
            question: 'Which owner confirms the cache boundary?' }))
        const gapRecorded = await runWorkApplication({ operation: 'work-record', workOrderId: 'WO-001', eventFile: 'intents/gap.json' }, fixture.composition)
        expect(gapRecorded).toMatchObject({ kind: 'complete', value: { value: { gaps: [expect.objectContaining({ id: 'cache-owner' })] } } })
        if (gapRecorded.kind !== 'complete') throw new Error('Gap recording did not complete')
        expect(((gapRecorded.value as { value: { gaps: object[] } }).value.gaps)[0]).not.toHaveProperty('answer')
        await writeFile(join(fixture.root, 'intents/resolve-gap.json'), JSON.stringify({ kind: 'resolve-gap', id: 'cache-owner', answer: 'The repository owner confirmed it.' }))
        await expect(runWorkApplication({ operation: 'work-record', workOrderId: 'WO-001', eventFile: 'intents/resolve-gap.json' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('current checked proof for every step') })
        await expect(readFile(contractPath, 'utf8')).resolves.toMatch(/^---[\s\S]*^status: active$/m)
        await expect(readFile(join(fixture.root, '.native-calls'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(runWorkApplication({ operation: 'work-review', workOrderId: 'WO-001' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('current checked proof for every step') })
        await expect(readFile(join(fixture.root, '.native-calls'))).rejects.toMatchObject({ code: 'ENOENT' })
        for (const approach of ['reproduce current behavior', 'verify the correction']) {
            await expect(runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-001', approach }, fixture.composition))
                .resolves.toMatchObject({ kind: 'complete' })
        }
        await expect(runWorkApplication({ operation: 'work-review', workOrderId: 'WO-001' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-001' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete', value: { completed: true } })
        const completedContract = await readFile(contractPath, 'utf8')
        expect(completedContract).toMatch(/## Evidence\u00a0\n\uFEFF\n- local \| grade:[a-f0-9]{64} \|/)
        expect(completedContract).toContain(objectiveCheckbox)
        expect(completedContract).toContain(nonGoalCheckbox)
        expect(completedContract).toContain('1. [x] Reproduce the stale value through the cache interface.')
    }, 120_000)

    it('preserves selected source freshness after completion', async () => {
        const fixture = await configuredFixture()
        await reidentifyWorkOrder(fixture.root, 'WO-001', 'WO-602')
        const accepted = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-602' }, fixture.composition)
        if (accepted.kind !== 'human-needed') throw new Error('completion source fixture acceptance continuation unavailable')
        await expect(accepted.continuation.decide(`accept ${accepted.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        await writeFile(join(fixture.root, 'intents/gap.json'), JSON.stringify({ kind: 'gap', id: 'cache-owner', step: 1,
            question: 'Which owner confirms the cache boundary?' }))
        await expect(runWorkApplication({ operation: 'work-record', workOrderId: 'WO-602', eventFile: 'intents/gap.json' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete' })
        await writeFile(join(fixture.root, 'intents/resolve-gap.json'), JSON.stringify({ kind: 'resolve-gap', id: 'cache-owner', answer: 'The repository owner confirmed it.' }))
        await expect(runWorkApplication({ operation: 'work-record', workOrderId: 'WO-602', eventFile: 'intents/resolve-gap.json' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'work-record', workOrderId: 'WO-602', eventFile: 'intents/source-evidence.json' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete' })
        for (const approach of ['reproduce current behavior', 'verify the correction']) {
            await expect(runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-602', approach }, fixture.composition))
                .resolves.toMatchObject({ kind: 'complete' })
        }
        await expect(runWorkApplication({ operation: 'work-review', workOrderId: 'WO-602' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'work-grade', workOrderId: 'WO-602' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete', value: { completed: true } })
        const sourcePath = join(fixture.root, 'src/cache.ts')
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-602' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { orders: [{ layers: { source: [expect.objectContaining({ freshness: 'current' })] } }] },
        })
        await writeFile(sourcePath, "export function refresh() { return 'changed-after-completion' }\n")
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-602' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { orders: [{ layers: { source: [expect.objectContaining({ freshness: 'stale' })] } }] },
        })
        await rm(sourcePath)
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-602' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { orders: [{ layers: { source: [expect.objectContaining({ freshness: 'unavailable' })] } }] },
        })
    }, 120_000)

    it('refuses a dangling symlink repository subject instead of treating it as absent', async () => {
        const fixture = await configuredFixture()
        await rm(join(fixture.root, 'src/cache.ts'))
        await symlink('missing-target.ts', join(fixture.root, 'src/cache.ts'))
        await expect(runWorkApplication({ operation: 'work-status' }, fixture.composition)).resolves.toMatchObject({
            kind: 'refusal', operation: 'work-status', reason: expect.stringContaining('symbolic link'),
        })
    }, 120_000)

    it('refuses renewal while an authenticated execution reservation is outstanding', async () => {
        const fixture = await configuredFixture()
        await reidentifyWorkOrder(fixture.root, 'WO-001', 'WO-401')
        const accepted = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-401' }, fixture.composition)
        if (accepted.kind !== 'human-needed') throw new Error('reservation fixture acceptance continuation unavailable')
        await expect(accepted.continuation.decide(`accept ${accepted.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })

        const hold = join(fixture.root, '.execution-hold'); const started = join(fixture.root, '.execution-started')
        await writeFile(hold, 'hold\n')
        const execution = runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-401', approach: 'reserved execution' }, fixture.composition)
        const deadline = Date.now() + 10_000
        while (!existsSync(started) && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 20))
        if (!existsSync(started)) throw new Error('reserved execution did not reach the authenticated process boundary')
        const contractPath = join(fixture.root, 'workorders/WO-401.md')
        const decisionDate = new Date().toISOString().slice(0, 10)
        await writeFile(contractPath, workOrderFixture().replaceAll('WO-001', 'WO-401')
            .replace('Refresh 1 completes.', 'Refresh 1 and reservation safety complete.')
            + `- ${decisionDate} | Preserve the active reservation during renewal | accepted | An in-flight command owns it | Reconcile execution before renewal.\n`)

        let renewalAttempt: Awaited<ReturnType<typeof runWorkApplication>> | undefined
        let renewalResult: Awaited<ReturnType<typeof runWorkApplication>> | undefined
        let executionResult: Awaited<ReturnType<typeof runWorkApplication>>
        try {
            renewalAttempt = await runWorkApplication({ operation: 'work-renew', workOrderId: 'WO-401' }, fixture.composition)
            renewalResult = renewalAttempt.kind === 'human-needed'
                ? await renewalAttempt.continuation.decide(`accept ${renewalAttempt.continuation.digest}`)
                : renewalAttempt
        } finally {
            await rm(hold, { force: true })
            executionResult = await execution
        }
        expect(renewalAttempt).toMatchObject({ kind: 'refusal', operation: 'work-renew', reason: expect.stringContaining('outstanding execution reservation') })
        expect(renewalResult).toMatchObject({ kind: 'refusal', operation: 'work-renew', reason: expect.stringContaining('outstanding execution reservation') })
        expect(executionResult).toMatchObject({ kind: 'complete', operation: 'work-execute' })
    }, 120_000)

})
