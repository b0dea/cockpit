import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { runWorkApplication } from './application.js'
import { createConfiguredWorkApplicationComposition } from './composition.js'
import { parseWorkOrder } from './contract.js'
import { createWorkCompositionFixtureSupport, stopChild, waitForChildLine } from '../../test-support/work-composition-fixture.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const { configuredFixture } = createWorkCompositionFixtureSupport(roots)

describe('configured durable work application composition', () => {
    it('reports an authenticated dead transaction owner and requires explicit recovery after process termination', async () => {
        const fixture = await configuredFixture()
        const lockDirectory = join(fixture.root, '.cockpit/work-orders/WO-001')
        const lockPath = join(lockDirectory, 'transaction.lock')
        const contractPath = join(fixture.root, 'workorders/WO-001.md'); const contractBytes = await readFile(contractPath)
        const afterContract = Buffer.from(contractBytes.toString('utf8').replace(/^status: .*$/m, 'status: parked'))
        const afterParsed = parseWorkOrder(afterContract); if (!afterParsed.ok) throw new Error('crash fixture contract refused')
        const afterCurrent = Buffer.from(JSON.stringify({ version: 1, generation: 1, contractPath: 'workorders/WO-001.md',
            contractDigest: afterParsed.value.digest, files: { 'contract.md': createHash('sha256').update(afterContract).digest('hex') } }))
        const plannedGeneration = join(lockDirectory, 'generation-00000001')
        await mkdir(plannedGeneration, { recursive: true }); await writeFile(join(plannedGeneration, 'contract.md'), afterContract)
        const journalDirectory = join(fixture.root, '.cockpit/transactions'); await mkdir(journalDirectory, { recursive: true })
        const journalPath = join(journalDirectory, `${randomUUID()}.json`)
        const journalBytes = Buffer.from(JSON.stringify({ version: 1, kind: 'work-order', owner: 'WO-001', stage: 'prepared', entries: [
            { path: 'workorders/WO-001.md', before: contractBytes.toString('base64'), beforeDigest: createHash('sha256').update(contractBytes).digest('hex'),
                after: afterContract.toString('base64'), afterDigest: createHash('sha256').update(afterContract).digest('hex') },
            { path: '.cockpit/work-orders/WO-001/current.json', before: null, beforeDigest: null,
                after: afterCurrent.toString('base64'), afterDigest: createHash('sha256').update(afterCurrent).digest('hex') },
        ] }))
        await writeFile(journalPath, journalBytes)
        const token = randomUUID()
        const owner = spawn(process.execPath, ['-e', `
const fs = require('node:fs')
const [path, token, lockId] = process.argv.slice(1)
fs.mkdirSync(require('node:path').dirname(path), { recursive: true, mode: 0o700 })
const claimant = path + '.claim-' + token
const descriptor = fs.openSync(claimant, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
fs.writeFileSync(descriptor, JSON.stringify({ version: 1, lockId, pid: process.pid, acquiredAt: new Date().toISOString(), token }) + '\\n')
fs.fsyncSync(descriptor); fs.closeSync(descriptor)
fs.linkSync(claimant, path)
process.stdout.write('ready\\n')
setInterval(() => {}, 1_000)
`, lockPath, token, 'WO-001'], { stdio: ['ignore', 'pipe', 'pipe'] })
        onTestFinished(async () => {
            await stopChild(owner)
        })
        const deadPid = owner.pid
        if (!deadPid) throw new Error('lock owner process did not start')
        await waitForChildLine(owner, 'ready')
        const live = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: fixture.environment })
        if (live.kind !== 'complete') throw new Error(live.reason)
        await expect(runWorkApplication({ operation: 'work-status' }, live.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining(`owner pid ${String(deadPid)} is live`),
        })
        await expect(live.composition.recovery('WO-001', false)).resolves.toMatchObject({
            kind: 'held', lockId: 'WO-001', holder: 'live', pid: deadPid,
        })
        await expect(live.composition.recovery('WO-001', true)).resolves.toMatchObject({ kind: 'held', holder: 'live', pid: deadPid })
        await expect(runWorkApplication({ operation: 'work-recover', lockId: 'WO-001', apply: false }, live.composition)).resolves.toEqual({
            kind: 'refusal', operation: 'work-recover',
            reason: `Recovery held for lock WO-001 at ${lockPath}; holder=live; pid=${String(deadPid)}; wait for the live holder or establish positive dead-holder evidence`,
        })
        const ownerRecord = await readFile(lockPath)
        await expect(readFile(journalPath)).resolves.toEqual(journalBytes)
        await stopChild(owner)

        const unrelatedToken = randomUUID(); const unrelatedClaimant = `${lockPath}.claim-${unrelatedToken}`
        const unrelatedRecord = Buffer.from(`${JSON.stringify({ version: 1, lockId: 'WO-001', pid: deadPid,
            acquiredAt: new Date().toISOString(), token: unrelatedToken })}\n`)
        await writeFile(unrelatedClaimant, unrelatedRecord, { flag: 'wx', mode: 0o600 })
        const recoveryQuarantine = join(lockDirectory, `transaction.lock.recovery-${randomUUID()}`)
        await rename(lockPath, recoveryQuarantine)

        const restarted = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: fixture.environment })
        if (restarted.kind !== 'complete') throw new Error(restarted.reason)
        await expect(runWorkApplication({ operation: 'work-status' }, restarted.composition)).resolves.toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('recovery evidence'),
        })
        await expect(restarted.composition.recovery('WO-001', false)).resolves.toMatchObject({
            kind: 'held', lockId: 'WO-001', target: recoveryQuarantine, holder: 'dead', pid: deadPid,
        })
        await expect(Promise.all([readFile(recoveryQuarantine), readFile(journalPath)])).resolves.toEqual([ownerRecord, journalBytes])
        await expect(restarted.composition.recovery('WO-001', true)).resolves.toEqual({ kind: 'recovered', lockId: 'WO-001', target: lockPath })
        await expect(readFile(unrelatedClaimant)).resolves.toEqual(unrelatedRecord)
        await expect(restarted.composition.recovery('WO-001', false)).resolves.toMatchObject({ kind: 'held', holder: 'dead', pid: deadPid })
        await expect(restarted.composition.recovery('WO-001', true)).resolves.toEqual({ kind: 'recovered', lockId: 'WO-001', target: lockPath })
        const orphanClaimant = `${lockPath}.claim-${token}`; const orphanQuarantine = join(lockDirectory, `transaction.lock.recovery-${randomUUID()}`)
        await writeFile(orphanClaimant, ownerRecord, { flag: 'wx', mode: 0o600 }); await rename(orphanClaimant, orphanQuarantine)
        await expect(restarted.composition.recovery('WO-001', false)).resolves.toMatchObject({ kind: 'held', holder: 'dead', pid: deadPid })
        await expect(restarted.composition.recovery('WO-001', true)).resolves.toEqual({ kind: 'recovered', lockId: 'WO-001', target: lockPath })
        await expect(restarted.composition.recovery('.admission-capacity', false)).resolves.toMatchObject({ kind: 'unlocked', lockId: '.admission-capacity' })
        await expect(restarted.composition.recovery('programme-cache', false)).resolves.toMatchObject({ kind: 'unlocked', lockId: 'programme-cache' })
        await expect(restarted.composition.recovery('programme-missing', false)).resolves.toMatchObject({ kind: 'unlocked', lockId: 'programme-missing' })
        await expect(runWorkApplication({ operation: 'work-status' }, restarted.composition)).resolves.toMatchObject({ kind: 'complete' })
        await expect(readFile(journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readdir(plannedGeneration)).rejects.toMatchObject({ code: 'ENOENT' })
        const resumed = await createConfiguredWorkApplicationComposition({ configPath: fixture.configPath, env: fixture.environment })
        if (resumed.kind !== 'complete') throw new Error(resumed.reason)
        await expect(runWorkApplication({ operation: 'work-status' }, resumed.composition)).resolves.toMatchObject({ kind: 'complete' })
        await expect(readFile(contractPath)).resolves.toEqual(contractBytes)

        const sentinel = Buffer.from('replacement-owner\n')
        await writeFile(lockPath, sentinel, { flag: 'wx', mode: 0o600 })
        await expect(resumed.composition.recovery('WO-001', true)).resolves.toMatchObject({ kind: 'held', holder: 'invalid', pid: null })
        await expect(readFile(lockPath)).resolves.toEqual(sentinel)
        await rm(lockPath)
        const quarantine = join(lockDirectory, `transaction.lock.recovery-${randomUUID()}`)
        await writeFile(quarantine, sentinel, { flag: 'wx', mode: 0o600 })
        await expect(resumed.composition.recovery('WO-001', true)).resolves.toMatchObject({ kind: 'held', holder: 'invalid', target: quarantine })
        await expect(readFile(quarantine)).resolves.toEqual(sentinel)
    }, 120_000)

})
