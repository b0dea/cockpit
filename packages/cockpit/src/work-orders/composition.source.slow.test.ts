import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { CockpitConfig } from '../schema.js'
import { loadCockpitConfig } from '../config/load.js'
import { browserRuntimeCoordination } from '../browser/runtime.js'
import { prepareGeneratedEnvironmentCurrentness, syncGeneratedEnvironment } from '../generated-environment/command.js'
import type { HolderId } from '../environment/contract.js'
import { cockpitId, checkoutId, stackId } from '../environment/identity.js'
import { deriveEntrypoints, leasePortFamily, projectPortLeaseResult } from '../environment/ports.js'
import { recordLifecycleStarted } from '../environment/lifecycle-stage.js'
import { selectStateRoot, transactState } from '../environment/state.js'
import { runWorkApplication } from './application.js'
import { createConfiguredWorkApplicationComposition } from './composition.js'
import { parseWorkOrder, type ParsedWorkOrder } from './contract.js'
import { observeWorkOrderIdentity, type WorkOrderIdentityGit } from './identity-observation.js'
import { intakeWorkOrder } from './intake.js'
import { workOrderFixture } from '../test-support/work-order.js'
import { createWorkCompositionFixtureSupport, reidentifyWorkOrder } from '../../test-support/work-composition-fixture.js'

const filesystemRace = vi.hoisted(() => ({
    path: '', descriptor: -1, armed: false, mutated: false, replaceWithFifo: false, openFlags: -1,
    ancestorPath: '', ancestorTarget: '', heldAncestorPath: '', ancestorAnchored: false, leafLstatCalls: 0,
    restoreAncestorAfterOpen: false, siblingEntryPath: '',
}))
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    const childProcess = await import('node:child_process')
    return {
        ...actual,
        openSync: (...args: unknown[]) => {
            if (filesystemRace.armed && filesystemRace.ancestorPath && args[0] === filesystemRace.ancestorPath) {
                filesystemRace.ancestorAnchored = true
            }
            if (filesystemRace.armed && args[0] === filesystemRace.path && filesystemRace.replaceWithFifo) {
                filesystemRace.openFlags = Number(args[1])
                actual.renameSync(filesystemRace.path, `${filesystemRace.path}.regular`)
                const replacement = childProcess.spawnSync('/usr/bin/mkfifo', [filesystemRace.path], {
                    cwd: process.cwd(), encoding: 'utf8', timeout: 5_000,
                })
                if (replacement.status !== 0) throw new Error('fixture could not replace the source with a FIFO')
                filesystemRace.mutated = true
                if ((filesystemRace.openFlags & actual.constants.O_NONBLOCK) === 0) throw new Error('source open would block on a FIFO replacement')
            }
            if (filesystemRace.armed && !filesystemRace.mutated && filesystemRace.siblingEntryPath && args[0] === filesystemRace.path) {
                actual.writeFileSync(filesystemRace.siblingEntryPath, 'Synthetic unrelated directory entry.\n')
                filesystemRace.mutated = true
            }
            const descriptor = Reflect.apply(actual.openSync, actual, args) as number
            if (filesystemRace.armed && filesystemRace.restoreAncestorAfterOpen && args[0] === filesystemRace.path) {
                actual.unlinkSync(filesystemRace.ancestorPath)
                actual.renameSync(filesystemRace.heldAncestorPath, filesystemRace.ancestorPath)
            }
            if (filesystemRace.armed && args[0] === filesystemRace.path) filesystemRace.descriptor = descriptor
            return descriptor
        },
        fstatSync: (...args: unknown[]) => {
            const status = Reflect.apply(actual.fstatSync, actual, args) as ReturnType<typeof actual.fstatSync>
            if (filesystemRace.armed && !filesystemRace.mutated && args[0] === filesystemRace.descriptor) {
                actual.appendFileSync(filesystemRace.path, ' '.repeat(262_145))
                filesystemRace.mutated = true
            }
            return status
        },
        lstatSync: (...args: unknown[]) => {
            if (filesystemRace.armed && filesystemRace.ancestorPath && args[0] === filesystemRace.path) {
                filesystemRace.leafLstatCalls += 1
                const replacementCall = filesystemRace.ancestorAnchored ? 1 : 2
                if (!filesystemRace.mutated && filesystemRace.leafLstatCalls === replacementCall) {
                    actual.renameSync(filesystemRace.ancestorPath, filesystemRace.heldAncestorPath)
                    actual.symlinkSync(filesystemRace.ancestorTarget, filesystemRace.ancestorPath, 'dir')
                    filesystemRace.mutated = true
                }
            }
            return Reflect.apply(actual.lstatSync, actual, args) as ReturnType<typeof actual.lstatSync>
        },
    }
})

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const { configuredFixture } = createWorkCompositionFixtureSupport(roots)

describe('configured durable work application composition', () => {
    it('revalidates selected source evidence outside repository observations', async () => {
        const fixture = await configuredFixture()
        const accepted = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-001' }, fixture.composition)
        if (accepted.kind !== 'human-needed') throw new Error('selected-source fixture acceptance continuation unavailable')
        await expect(accepted.continuation.decide(`accept ${accepted.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        const eventPath = join(fixture.root, 'intents/selected-source.json')
        const selectedPath = join(fixture.root, 'workorders/WO-002.md')
        await writeFile(eventPath, JSON.stringify({ kind: 'evidence', layer: 'source', reference: 'workorders/WO-002.md' }))
        await expect(runWorkApplication({ operation: 'work-record', workOrderId: 'WO-001', eventFile: 'intents/selected-source.json' }, fixture.composition))
            .resolves.toMatchObject({ kind: 'complete' })
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { orders: [{ layers: { source: [expect.objectContaining({ freshness: 'current' })] } }] },
        })

        const selected = await readFile(selectedPath, 'utf8')
        await writeFile(selectedPath, selected.replace('Return current values after a cache refresh.', 'Return current values after a selected source refresh.'))
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { orders: [{ layers: { source: [expect.objectContaining({ freshness: 'stale' })] } }] },
        })
        await rm(selectedPath)
        await expect(runWorkApplication({ operation: 'work-status', workOrderId: 'WO-001' }, fixture.composition)).resolves.toMatchObject({
            kind: 'complete', value: { orders: [{ layers: { source: [expect.objectContaining({ freshness: 'unavailable' })] } }] },
        })
    }, 120_000)

    it('refuses an event file that grows after descriptor admission', async () => {
        const fixture = await configuredFixture()
        await reidentifyWorkOrder(fixture.root, 'WO-001', 'WO-601')
        const accepted = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-601' }, fixture.composition)
        if (accepted.kind !== 'human-needed') throw new Error('event growth fixture acceptance continuation unavailable')
        await expect(accepted.continuation.decide(`accept ${accepted.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        const eventPath = join(fixture.root, 'intents/heartbeat.json')
        Object.assign(filesystemRace, { path: eventPath, descriptor: -1, armed: true, mutated: false })
        try {
            await expect(runWorkApplication({ operation: 'work-record', workOrderId: 'WO-601', eventFile: 'intents/heartbeat.json' }, fixture.composition))
                .resolves.toMatchObject({ kind: 'refusal', reason: expect.stringContaining('changed during read') })
            expect(filesystemRace.mutated).toBe(true)
        } finally {
            Object.assign(filesystemRace, { path: '', descriptor: -1, armed: false, mutated: false })
        }
    }, 120_000)

    it('refuses a configuration source that grows after descriptor admission', async () => {
        const fixture = await configuredFixture()
        Object.assign(filesystemRace, { path: fixture.configPath, descriptor: -1, armed: true, mutated: false })
        try {
            await expect(runWorkApplication({ operation: 'work-status' }, fixture.composition)).resolves.toMatchObject({
                kind: 'refusal', reason: expect.stringContaining('configuration source changed after admission'),
            })
            expect(filesystemRace.mutated).toBe(true)
        } finally {
            Object.assign(filesystemRace, { path: '', descriptor: -1, armed: false, mutated: false })
        }
    }, 120_000)

    it('refuses a configuration source replaced by a FIFO before descriptor open', async () => {
        const fixture = await configuredFixture()
        Object.assign(filesystemRace, { path: fixture.configPath, descriptor: -1, armed: true, mutated: false, replaceWithFifo: true, openFlags: -1 })
        try {
            await expect(runWorkApplication({ operation: 'work-status' }, fixture.composition)).resolves.toMatchObject({
                kind: 'refusal', reason: expect.stringContaining('configuration source changed after admission'),
            })
            expect(filesystemRace.mutated).toBe(true)
            expect(filesystemRace.openFlags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
        } finally {
            Object.assign(filesystemRace, { path: '', descriptor: -1, armed: false, mutated: false, replaceWithFifo: false, openFlags: -1 })
        }
    }, 120_000)

    it('refuses source evidence whose admitted parent is replaced before leaf admission', async () => {
        const fixture = await configuredFixture()
        const accepted = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-001' }, fixture.composition)
        if (accepted.kind !== 'human-needed') throw new Error('ancestor replacement fixture acceptance continuation unavailable')
        await expect(accepted.continuation.decide(`accept ${accepted.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        const outside = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-work-ancestor-outside-'))); roots.push(outside)
        await writeFile(join(outside, 'heartbeat.json'), JSON.stringify({ kind: 'heartbeat' }))
        const eventPath = join(fixture.root, 'intents/heartbeat.json')
        Object.assign(filesystemRace, {
            path: eventPath, descriptor: -1, armed: true, mutated: false,
            ancestorPath: join(fixture.root, 'intents'), ancestorTarget: outside,
            heldAncestorPath: join(fixture.root, 'intents-held'), ancestorAnchored: false, leafLstatCalls: 0,
            restoreAncestorAfterOpen: false,
        })
        try {
            await expect(runWorkApplication({ operation: 'work-record', workOrderId: 'WO-001', eventFile: 'intents/heartbeat.json' }, fixture.composition))
                .resolves.toMatchObject({ kind: 'refusal', reason: 'contained file or ancestor changed during read' })
            expect(filesystemRace.mutated).toBe(true)
        } finally {
            Object.assign(filesystemRace, {
                path: '', descriptor: -1, armed: false, mutated: false,
                ancestorPath: '', ancestorTarget: '', heldAncestorPath: '', ancestorAnchored: false, leafLstatCalls: 0,
                restoreAncestorAfterOpen: false,
            })
        }
    }, 120_000)

    it('refuses source evidence when its admitted parent is restored after leaf open', async () => {
        const fixture = await configuredFixture()
        const accepted = await runWorkApplication({ operation: 'work-accept', workOrderId: 'WO-001' }, fixture.composition)
        if (accepted.kind !== 'human-needed') throw new Error('restored ancestor fixture acceptance continuation unavailable')
        await expect(accepted.continuation.decide(`accept ${accepted.continuation.digest}`)).resolves.toMatchObject({ kind: 'complete' })
        const eventPath = join(fixture.root, 'intents/heartbeat.json')
        const heldAncestorPath = join(fixture.root, 'intents-held')
        Object.assign(filesystemRace, {
            path: eventPath, descriptor: -1, armed: true, mutated: false,
            ancestorPath: join(fixture.root, 'intents'), ancestorTarget: heldAncestorPath,
            heldAncestorPath, ancestorAnchored: false, leafLstatCalls: 0,
            restoreAncestorAfterOpen: true,
        })
        try {
            await expect(runWorkApplication({ operation: 'work-record', workOrderId: 'WO-001', eventFile: 'intents/heartbeat.json' }, fixture.composition))
                .resolves.toMatchObject({ kind: 'refusal', reason: 'contained file or ancestor changed during read' })
            expect(filesystemRace.mutated).toBe(true)
        } finally {
            Object.assign(filesystemRace, {
                path: '', descriptor: -1, armed: false, mutated: false,
                ancestorPath: '', ancestorTarget: '', heldAncestorPath: '', ancestorAnchored: false, leafLstatCalls: 0,
                restoreAncestorAfterOpen: false,
            })
        }
    }, 120_000)

})
