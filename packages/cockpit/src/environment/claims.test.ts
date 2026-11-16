import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { readlinkSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    ENVIRONMENT_CODES,
    type CheckoutId,
    type CockpitId,
    type HolderId,
    type StackId,
} from './contract.js'
import {
    coordinationStateRecord,
    decodeCoordinationRecord,
    observeProcessStart,
    liveHolderMessage,
    listenerHost,
    observeProcessAncestry,
    observeSessionListeners,
    processHost,
    releaseDeadSessionHolders,
    removeExactCoordinationHolder,
    releaseClaim,
    readActiveStackInventory,
    readRootPortInventory,
    type ListenerHost,
    type ProcessHost,
} from './claims.js'
import { executeProbe } from '../environment-exec/execute.js'
import { STRUCTURED_INPUT_ENTRY_LIMIT } from '../schema.js'
import { readState, selectStateRoot, transactState, withStateNamespaceInventory, type StateNamespace, type StateRecord } from './state.js'

const inventoryIdentityGate = vi.hoisted(() => ({
    target: undefined as string | undefined,
    reached: undefined as (() => void) | undefined,
    continuation: undefined as Promise<void> | undefined,
}))

const checkoutAbsenceGate = vi.hoisted(() => ({
    target: undefined as string | undefined,
    reached: undefined as (() => void) | undefined,
    continuation: undefined as Promise<void> | undefined,
}))

const coordinationCommitGate = vi.hoisted(() => ({
    temporaryPrefix: undefined as string | undefined,
    reached: undefined as (() => void) | undefined,
    continuation: undefined as Promise<void> | undefined,
}))

// Stands in for a read that fails with something other than a system error, which can quote what it read.
const inventoryFault = vi.hoisted(() => ({ paths: [] as string[], message: '' }))

const inventoryReadControl = vi.hoisted(() => ({ paths: [] as string[], opened: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
            if (typeof args[0] === 'string' && inventoryReadControl.paths.includes(args[0]) && typeof args[1] === 'number') {
                inventoryReadControl.opened.push(args[0])
            }
            return actual.open(...args)
        },
        lstat: async (...args: unknown[]) => {
            if (typeof args[0] === 'string' && inventoryFault.paths.includes(args[0])) throw new Error(inventoryFault.message)
            let result: Awaited<ReturnType<typeof actual.lstat>>
            try {
                result = await actual.lstat(args[0] as string, args[1] as never)
            } catch (error) {
                if (args[0] === checkoutAbsenceGate.target && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                    checkoutAbsenceGate.target = undefined
                    checkoutAbsenceGate.reached?.()
                    await checkoutAbsenceGate.continuation
                }
                throw error
            }
            if (args[0] === inventoryIdentityGate.target && (args[1] as { bigint?: boolean } | undefined)?.bigint) {
                inventoryIdentityGate.target = undefined
                inventoryIdentityGate.reached?.()
                await inventoryIdentityGate.continuation
            }
            if (typeof args[0] === 'string' && coordinationCommitGate.temporaryPrefix
                && args[0].startsWith(coordinationCommitGate.temporaryPrefix) && args[0].endsWith('.tmp')) {
                coordinationCommitGate.temporaryPrefix = undefined
                coordinationCommitGate.reached?.()
                await coordinationCommitGate.continuation
            }
            return result
        },
    }
})

const cockpitId = `cockpit:coordination-a1:${'a'.repeat(64)}` as CockpitId
const stackId = `stack:${'b'.repeat(64)}` as StackId
const checkoutA = `checkout:${'c'.repeat(64)}` as CheckoutId
const checkoutB = `checkout:${'d'.repeat(64)}` as CheckoutId
const holderA = `holder:${'e'.repeat(64)}:session` as HolderId
const holderB = `holder:${'f'.repeat(64)}:session` as HolderId
const holderC = `holder:${'1'.repeat(64)}:session` as HolderId
const roots: string[] = []

afterEach(async () => {
    vi.useRealTimers()
    inventoryReadControl.paths = []
    inventoryReadControl.opened = []
    inventoryFault.paths = []
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function namespace(): Promise<StateNamespace> {
    const home = await mkdtemp(join(tmpdir(), 'cockpit-claims-'))
    roots.push(home)
    const selected = await selectStateRoot({ platform: 'linux', home, cockpitId })
    if (selected.kind !== 'complete') throw new Error(`state root unavailable: ${selected.kind}`)
    return selected.value
}

async function reissueNamespace(state: StateNamespace, identity = cockpitId): Promise<StateNamespace> {
    const selected = await selectStateRoot({
        platform: 'linux',
        home: undefined,
        xdgStateHome: dirname(dirname(state.root)),
        cockpitId: identity,
    })
    if (selected.kind !== 'complete') throw new Error(`state root unavailable: ${selected.kind}`)
    return selected.value
}

function claimRecord(holders: readonly {
    holderId: HolderId
    checkoutId: CheckoutId
    claimedAt: string
    pid?: number
    processStart?: string
}[]): StateRecord {
    return {
        format: 'cockpit-state/v1',
        kind: 'coordination',
        cockpitId,
        subjectId: stackId,
        revision: 0,
        updatedAt: '2026-09-07T12:00:00.000Z',
        value: {
            holders: holders.map((holder) => ({ ...holder })),
            lease: {
                offset: 0,
                ports: { WEB: 3000 },
                released: holders.length === 0,
                declaration: { step: 100, count: 3, bases: { WEB: 3000 } },
            },
            lastReleasedHolder: null,
        },
    }
}

async function seedCoordination(
    state: StateNamespace,
    holders: Parameters<typeof claimRecord>[0] = [{
        holderId: holderC,
        checkoutId: checkoutA,
        claimedAt: '2026-09-07T11:59:00.000Z',
    }],
): Promise<void> {
    const result = await transactState(
        state,
        state.paths.coordination(stackId),
        { ownerId: holderA },
        () => ({ ...claimRecord(holders), cockpitId: state.paths.coordination(stackId).cockpitId }),
    )
    if (result.kind !== 'complete') throw new Error(JSON.stringify(result))
}

describe('acquired-holder compensation reduction', () => {
    const activeLease = {
        offset: 0,
        ports: { WEB: 3000 },
        released: false,
        declaration: { step: 100, count: 3, bases: { WEB: 3000 } },
    }
    const claimedA = { holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }
    const claimedB = { holderId: holderB, checkoutId: checkoutB, claimedAt: '2026-09-07T11:59:01.000Z' }

    it('removes only the exact holder and marks a retained active lease', () => {
        expect(removeExactCoordinationHolder({
            holders: [claimedA, claimedB], lease: activeLease, lastReleasedHolder: null,
        }, holderA)).toEqual({
            holders: [claimedB], lease: activeLease, lastReleasedHolder: holderA,
        })
        expect(removeExactCoordinationHolder({
            holders: [claimedA], lease: activeLease, lastReleasedHolder: null,
        }, holderA)).toEqual({
            holders: [], lease: activeLease, lastReleasedHolder: holderA,
        })
    })

    it('refuses a missing holder or a shape that cannot retain an active lease', () => {
        expect(removeExactCoordinationHolder({
            holders: [claimedB], lease: activeLease, lastReleasedHolder: null,
        }, holderA)).toBeUndefined()
        expect(removeExactCoordinationHolder({
            holders: [claimedA], lease: { ...activeLease, released: true }, lastReleasedHolder: null,
        }, holderA)).toBeUndefined()
    })

    it('decodes only the narrowly marked ownerless retained-lease shape', () => {
        const record = claimRecord([])
        const recordValue = record.value as Record<string, unknown>
        const retained = {
            ...record,
            value: { ...recordValue, lease: activeLease, lastReleasedHolder: holderA },
        }
        expect(decodeCoordinationRecord(retained, stackId)).toMatchObject({
            holders: [], lease: { released: false }, lastReleasedHolder: holderA,
        })
        expect(decodeCoordinationRecord({
            ...retained, value: { ...retained.value, lastReleasedHolder: null },
        }, stackId)).toBeUndefined()
        expect(decodeCoordinationRecord({
            ...retained, value: { ...retained.value, holders: [claimedA] },
        }, stackId)).toBeUndefined()
    })
})
async function mutateInventoryAfterIdentity(
    state: StateNamespace,
    directory: string,
    mutate: () => Promise<void>,
    read = () => readActiveStackInventory(state),
) {
    let releaseInspection: () => void = () => undefined
    let reportInspection: () => void = () => undefined
    const inspectionReached = new Promise<void>((resolve) => { reportInspection = resolve })
    const continueInspection = new Promise<void>((resolve) => { releaseInspection = resolve })
    inventoryIdentityGate.target = directory
    inventoryIdentityGate.reached = reportInspection
    inventoryIdentityGate.continuation = continueInspection
    try {
        const reading = read()
        await inspectionReached
        await mutate()
        releaseInspection()
        return await reading
    } finally {
        releaseInspection()
        inventoryIdentityGate.target = undefined
        inventoryIdentityGate.reached = undefined
        inventoryIdentityGate.continuation = undefined
    }
}


describe('active stack inventory', () => {
    it('qualifies equal stack IDs by cockpit in root port inventory while preserving local claim inventory', async () => {
        const state = await namespace()
        const otherId = `cockpit:coordination-b2:${'b'.repeat(64)}` as CockpitId
        const other = await reissueNamespace(state, otherId)
        for (const current of [state, other]) {
            await seedCoordination(current, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T12:00:00.000Z' }])
        }
        expect(await readActiveStackInventory(state)).toMatchObject({ kind: 'complete', value: [{ stackId }] })
        const inventory = await readRootPortInventory(state)
        if (inventory.kind !== 'complete') throw new Error(JSON.stringify(inventory))
        expect(inventory.value.map((row) => [row.cockpitId, row.stackId])).toEqual([[cockpitId, stackId], [otherId, stackId]])
        expect(await readRootPortInventory({ ...state })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }],
        })
    })

    it('skips and names another cockpit namespace it cannot read, and refuses only on its own', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T12:00:00.000Z' }])
        // An earlier development build named namespace directories with colons; one left on disk
        // used to block every cockpit on the machine.
        const legacy = join(dirname(state.cockpitRoot), `cockpit:legacy:${'a'.repeat(64)}`)
        await mkdir(join(legacy, 'records', 'coordination'), { recursive: true, mode: 0o700 })
        const other = await reissueNamespace(state, `cockpit:coordination-b2:${'b'.repeat(64)}` as CockpitId)
        await seedCoordination(other)
        const unreadable = JSON.stringify({ format: 'cockpit-state/v0' })
        await writeFile(other.paths.coordination(stackId).path, unreadable)

        expect(await readRootPortInventory(state)).toEqual({ kind: 'complete', value: [expect.objectContaining({ cockpitId, stackId })],
            skipped: [
                { path: legacy, reason: expect.stringContaining('invalid cockpit namespace') },
                { path: other.cockpitRoot, reason: expect.stringContaining('format is not supported') },
            ] })

        await writeFile(state.paths.coordination(stackId).path, unreadable)
        expect(await readRootPortInventory(state)).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: ENVIRONMENT_CODES.STATE_FORMAT_UNSUPPORTED, target: state.paths.coordination(stackId).path,
        }] })
    })

    it.each(['rewritten record', 'new namespace'] as const)('rejects a %s after an earlier cockpit was captured by root port inventory', async (mutation) => {
        const state = await namespace()
        const other = await reissueNamespace(state, `cockpit:coordination-b2:${'b'.repeat(64)}` as CockpitId)
        for (const current of [state, other]) {
            await seedCoordination(current, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T12:00:00.000Z' }])
        }
        const result = await mutateInventoryAfterIdentity(state, dirname(other.paths.coordination(stackId).path), async () => {
            if (mutation === 'rewritten record') {
                const path = state.paths.coordination(stackId).path
                const before = JSON.parse(await readFile(path, 'utf8'))
                await writeFile(path, JSON.stringify({ ...before, revision: before.revision + 1 }))
            } else {
                const added = await reissueNamespace(state, `cockpit:coordination-c3:${'c'.repeat(64)}` as CockpitId)
                await mkdir(added.cockpitRoot, { mode: 0o700 })
            }
        }, () => readRootPortInventory(state))
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, message: expect.stringContaining('changed during observation'),
        }] })
    })

    it('bounds inactive coordination entries across multiple cockpit stores in root port inventory', async () => {
        const state = await namespace()
        const other = await reissueNamespace(state, `cockpit:coordination-b2:${'b'.repeat(64)}` as CockpitId)
        const value = decodeCoordinationRecord(null, stackId)!
        for (const current of [state, other]) {
            await mkdir(dirname(current.paths.coordination(stackId).path), { recursive: true, mode: 0o700 })
            for (let start = 0; start < STRUCTURED_INPUT_ENTRY_LIMIT / 2; start += 64) {
                await Promise.all(Array.from({ length: 64 }, async (_, index) => {
                    const identity = `stack:${(start + index).toString(16).padStart(64, '0')}` as StackId
                    const record = coordinationStateRecord(current, identity, null, '2026-09-07T12:00:00.000Z', value)
                    await writeFile(current.paths.coordination(identity).path, JSON.stringify(record), { mode: 0o600 })
                }))
            }
        }
        expect(await readRootPortInventory(state)).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, message: expect.stringContaining('aggregate entry boundary'),
        }] })
    })

    it('bounds aggregate record bytes across individually bounded foreign records', async () => {
        const state = await namespace()
        const other = await reissueNamespace(state, `cockpit:coordination-b2:${'b'.repeat(64)}` as CockpitId)
        for (const current of [state, other]) {
            await seedCoordination(current, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T12:00:00.000Z' }])
            const path = current.paths.coordination(stackId).path
            const bytes = await readFile(path, 'utf8')
            await writeFile(path, bytes.padEnd(600_000, ' '))
        }
        expect(await readRootPortInventory(state)).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, message: expect.stringContaining('aggregate byte boundary'),
        }] })
    })

    it('stops aggregate reads when a previously captured foreign record grows', async () => {
        const state = await namespace()
        const other = await reissueNamespace(state, `cockpit:coordination-b2:${'b'.repeat(64)}` as CockpitId)
        for (const current of [state, other]) await seedCoordination(current)
        const paths = [state.paths.coordination(stackId).path, other.paths.coordination(stackId).path]
        inventoryReadControl.paths = paths
        const result = await mutateInventoryAfterIdentity(state, dirname(paths[1]!), async () => {
            for (const path of paths) {
                const bytes = await readFile(path, 'utf8')
                await writeFile(path, bytes.padEnd(600_000, ' '))
            }
        }, () => readRootPortInventory(state))
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
        expect(inventoryReadControl.opened).toEqual([paths[0]])
    })

    it('reports an unexpected inventory failure by class, never by the text it quoted', async () => {
        const state = await namespace()
        const cockpits = dirname(state.cockpitRoot)
        const other = (await reissueNamespace(state, `cockpit:coordination-b2:${'b'.repeat(64)}` as CockpitId)).cockpitRoot
        await mkdir(join(other, 'records'), { recursive: true, mode: 0o700 })
        inventoryFault.message = 'unexpected token near CANARY_SECRET_7f3a'

        inventoryFault.paths = [join(other, 'records')]
        const skipped = await withStateNamespaceInventory(state, async (_namespaces, unreadable) => unreadable)
        expect(skipped).toMatchObject({ kind: 'complete', value: [{ path: other, reason: 'Error' }] })

        inventoryFault.paths = [cockpits]
        const refused = await withStateNamespaceInventory(state, async () => undefined)
        expect(refused).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, target: cockpits })
        expect(JSON.stringify([skipped, refused])).not.toContain('CANARY_SECRET_7f3a')
    })

    it('treats only an initially absent coordination directory as empty', async () => {
        const state = await namespace()

        await expect(readActiveStackInventory(state)).resolves.toEqual({ kind: 'complete', value: [] })
    })

    it('reads only the current coordination store', async () => {
        const state = await namespace()
        for (const directory of ['claims', 'leases']) {
            const path = join(state.cockpitRoot, 'records', directory, `${stackId.replace(':', '_')}.json`)
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, 'unrelated bytes')
        }

        await expect(readActiveStackInventory(state)).resolves.toEqual({ kind: 'complete', value: [] })
    })

    it('refuses when the coordination directory disappears after inspection starts', async () => {
        const state = await namespace()
        const directory = dirname(state.paths.coordination(stackId).path)
        await mkdir(directory, { recursive: true })

        const result = await mutateInventoryAfterIdentity(state, directory, async () => {
            await rm(directory, { recursive: true })
        })
        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [{
                code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                message: 'coordination store changed during observation',
            }],
        })
    })

    it('refuses direct symlinks and directory replacement during observation', async () => {
        const state = await namespace()
        const directory = dirname(state.paths.coordination(stackId).path)
        const target = join(state.root, 'replacement-target')
        await mkdir(target, { recursive: true })
        await mkdir(dirname(directory), { recursive: true })
        await symlink(target, directory)
        await expect(readActiveStackInventory(state)).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }],
        })

        await rm(directory)
        await mkdir(directory)
        const displaced = `${directory}-displaced`
        const result = await mutateInventoryAfterIdentity(state, directory, async () => {
            await rename(directory, displaced)
            await mkdir(directory)
        })
        expect(result).toMatchObject({
            kind: 'refusal', diagnostics: [{
                code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                message: 'coordination store changed during observation',
            }],
        })
    })

    it('refuses before retaining more than the structured input entry boundary', async () => {
        const state = await namespace()
        const directory = dirname(state.paths.coordination(stackId).path)
        await mkdir(directory, { recursive: true })
        for (let index = 0; index <= STRUCTURED_INPUT_ENTRY_LIMIT; index += 1) {
            await mkdir(join(directory, `entry-${index}`))
        }

        await expect(readActiveStackInventory(state)).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{
                code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                message: 'coordination store exceeds its entry boundary',
            }],
        })
    })

    it('reports an in-flight coordination publication as busy', async () => {
        const state = await namespace()
        const address = state.paths.coordination(stackId)
        let reportPrepared: () => void = () => undefined
        let continuePublication: () => void = () => undefined
        const prepared = new Promise<void>((resolve) => { reportPrepared = resolve })
        const continuation = new Promise<void>((resolve) => { continuePublication = resolve })
        const publishing = transactState(state, address, {
            ownerId: holderA,
            beforePublish: async () => {
                reportPrepared()
                await continuation
            },
        }, () => claimRecord([]))
        try {
            await prepared
            await expect(readActiveStackInventory(state)).resolves.toMatchObject({
                kind: 'refusal', diagnostics: [{
                    code: ENVIRONMENT_CODES.STATE_LOCKED,
                    message: 'coordination publication is in progress',
                }],
            })
        } finally {
            continuePublication()
        }
        await expect(publishing).resolves.toMatchObject({ kind: 'complete' })
    })

    it('preserves and names an orphaned coordination publication residue', async () => {
        const state = await namespace()
        const directory = dirname(state.paths.coordination(stackId).path)
        await mkdir(directory, { recursive: true })
        const residue = join(directory, `.${stackId.replace(':', '_')}.12345678-1234-4123-8123-123456789abc.tmp`)
        await writeFile(residue, 'unverified bytes')

        for (let attempt = 0; attempt < 2; attempt += 1) {
            await expect(readActiveStackInventory(state)).resolves.toMatchObject({
                kind: 'refusal', diagnostics: [{
                    code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                    message: 'coordination store contains an orphaned unverified publication residue',
                    target: residue,
                    fix: expect.stringContaining('inspect'),
                }],
            })
            await expect(readFile(residue, 'utf8')).resolves.toBe('unverified bytes')
        }
    })

    it.each([
        ['empty', undefined, undefined],
        ['malformed', '{', undefined],
        ['dead', `${JSON.stringify({
            format: 'cockpit-state/v1', kind: 'state-lock', ownerId: holderA, pid: 2_147_483_647,
            acquiredAt: '2026-09-07T12:00:00.000Z', token: '12345678-1234-4123-8123-123456789abc',
            host: hostname(), ...(process.platform === 'linux' ? { pidNamespace: readlinkSync('/proc/self/ns/pid') } : {}),
        })}\n`, async () => ({ state: 'absent' as const })],
    ])('does not treat an abandoned %s lock as a live publication', async (_label, owner, observeProcess) => {
        const state = await namespace()
        const directory = dirname(state.paths.coordination(stackId).path)
        await mkdir(directory, { recursive: true })
        const residue = join(directory, `.${stackId.replace(':', '_')}.12345678-1234-4123-8123-123456789abc.tmp`)
        await writeFile(residue, 'unverified bytes')
        await mkdir(state.paths.stateLock, { recursive: true })
        if (owner !== undefined) await writeFile(join(state.paths.stateLock, 'owner.json'), owner)

        await expect(readActiveStackInventory(state, { observeProcess })).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{
                code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                message: 'coordination store contains an orphaned unverified publication residue',
                target: residue,
                fix: expect.stringContaining('remove the residue'),
            }],
        })
        await expect(readFile(residue, 'utf8')).resolves.toBe('unverified bytes')
    })

    it('reports a changed store when publication completes during lock inspection', async () => {
        const state = await namespace()
        const directory = dirname(state.paths.coordination(stackId).path)
        await mkdir(directory, { recursive: true })
        const residue = join(directory, `.${stackId.replace(':', '_')}.12345678-1234-4123-8123-123456789abc.tmp`)
        await writeFile(residue, 'prepared bytes')
        await mkdir(state.paths.stateLock, { recursive: true })
        await writeFile(join(state.paths.stateLock, 'owner.json'), `${JSON.stringify({
            format: 'cockpit-state/v1', kind: 'state-lock', ownerId: holderA, pid: process.pid,
            acquiredAt: '2026-09-07T12:00:00.000Z', token: '12345678-1234-4123-8123-123456789abc',
            host: hostname(), ...(process.platform === 'linux' ? { pidNamespace: readlinkSync('/proc/self/ns/pid') } : {}),
        })}\n`)
        let inspectionReached!: () => void
        let continueInspection!: () => void
        const reached = new Promise<void>((resolve) => { inspectionReached = resolve })
        const continuation = new Promise<void>((resolve) => { continueInspection = resolve })

        const reading = readActiveStackInventory(state, {
            observeProcess: async () => {
                inspectionReached()
                await continuation
                return { state: 'unknown' as const, reason: 'held for the test' }
            },
        })
        await reached
        await rm(residue)
        await rm(state.paths.stateLock, { recursive: true })
        continueInspection()

        await expect(reading).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{
                code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                message: 'coordination store changed during observation',
            }],
        })
    })

    it('does not claim a valid but unobserved lock owner is live', async () => {
        const state = await namespace()
        const directory = dirname(state.paths.coordination(stackId).path)
        await mkdir(directory, { recursive: true })
        const residue = join(directory, `.${stackId.replace(':', '_')}.12345678-1234-4123-8123-123456789abc.tmp`)
        await writeFile(residue, 'prepared bytes')
        await mkdir(state.paths.stateLock, { recursive: true })
        await writeFile(join(state.paths.stateLock, 'owner.json'), `${JSON.stringify({
            format: 'cockpit-state/v1', kind: 'state-lock', ownerId: holderA, pid: process.pid,
            acquiredAt: '2026-09-07T12:00:00.000Z', token: '12345678-1234-4123-8123-123456789abc',
        })}\n`)

        await expect(readActiveStackInventory(state)).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{
                code: ENVIRONMENT_CODES.STATE_LOCKED,
                message: 'coordination publication ownership is unverified',
                target: residue,
                fix: expect.stringContaining('inspect the named holder'),
            }],
        })
    })
})

// A `cockpit session` killed with SIGKILL never runs its closing sleep; its hold made down, reset
// and sleep refuse forever while naming a session nobody could end.
describe('dead session holders', () => {
    const exitedProcess = async () => {
        const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
        await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()) })
        return child.pid!
    }
    const ownStart = async () => {
        const observed = await observeProcessStart(process.pid, processHost(executeProbe))
        if (observed.state !== 'present') throw new Error(JSON.stringify(observed))
        return observed.start
    }
    const holders = async (state: StateNamespace) => {
        const stored = await readState(state.paths.coordination(stackId))
        if (stored.kind !== 'complete') throw new Error('expected coordination record')
        return decodeCoordinationRecord(stored.value, stackId)!
    }

    it('releases a session whose process is gone and hands a stack it held alone to the requester', async () => {
        const state = await namespace()
        const pid = await exitedProcess()
        await seedCoordination(state, [{ holderId: holderB, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z', pid, processStart: 'lstart:2026-09-07T11:58:59.000Z' }])

        const result = await releaseDeadSessionHolders({ namespace: state, stackId, successor: { holderId: holderA, checkoutId: checkoutA },
            now: '2026-09-07T12:00:00.000Z', observe: (candidate) => observeProcessStart(candidate, processHost(executeProbe)) })

        expect(result).toMatchObject({ kind: 'complete', released: [{ holderId: holderB, pid }] })
        expect(await holders(state)).toMatchObject({ holders: [{ holderId: holderA, checkoutId: checkoutA }], lastReleasedHolder: holderB, lease: { released: false } })
    })

    // A hold recorded without a start identity (ps or /proc unreadable) was never released, even
    // after its process was killed; a gone pid proves the session gone either way.
    it('keeps a running session, releases a stranger reusing its pid, and releases any hold whose pid is gone', async () => {
        const state = await namespace()
        const holderD = `holder:${'3'.repeat(64)}:session` as HolderId
        const own = await ownStart()
        // Another process's start, read the same way this machine reads one.
        const stranger = own.startsWith('proc:') ? own.replace(/:[0-9]+$/, ':1') : 'lstart:2000-01-01T00:00:00.000Z'
        await seedCoordination(state, [
            { holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z', pid: process.pid, processStart: own },
            { holderId: holderB, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z', pid: process.pid, processStart: stranger },
            { holderId: holderC, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z', pid: await exitedProcess() },
            { holderId: holderD, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z', pid: process.pid },
        ])

        const result = await releaseDeadSessionHolders({ namespace: state, stackId, successor: { holderId: `holder:${'2'.repeat(64)}:session` as HolderId, checkoutId: checkoutA },
            now: '2026-09-07T12:00:00.000Z', observe: (candidate) => observeProcessStart(candidate, processHost(executeProbe)) })

        expect(result).toMatchObject({ kind: 'complete', released: [{ holderId: holderC }, { holderId: holderB }] })
        expect((await holders(state)).holders.map(({ holderId }) => holderId)).toEqual([holderD, holderA])
    })

    // Each probe spawns node and ps, and a record may name thousands of holders; probing them all at
    // once spawned them all at once.
    it('probes at most four holders at a time and releases the dead ones in holder order', async () => {
        const state = await namespace()
        const seeded = Array.from({ length: 10 }, (_, index) => ({
            holderId: `holder:${(index + 16).toString(16).padStart(64, '0')}:session` as HolderId,
            checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z', pid: 4000 + index,
        }))
        await seedCoordination(state, seeded)
        let active = 0
        let peak = 0
        const observe = async (pid: number) => {
            peak = Math.max(peak, ++active)
            // Later holders answer first, so completion order differs from holder order.
            await new Promise((resolve) => setTimeout(resolve, (4010 - pid) * 2))
            active -= 1
            return pid % 2 === 0 ? { state: 'absent' as const } : { state: 'unknown' as const, reason: 'synthetic' }
        }

        const result = await releaseDeadSessionHolders({ namespace: state, stackId, successor: { holderId: holderA, checkoutId: checkoutA },
            now: '2026-09-07T12:00:00.000Z', observe })

        expect(peak).toBe(4)
        expect(result).toMatchObject({ kind: 'complete', released: seeded.filter(({ pid }) => pid % 2 === 0).map(({ holderId }) => ({ holderId })) })
    })

    it('refuses a malformed or oversized holder list without observing any process', async () => {
        const observed: number[] = []
        const observe = async (pid: number) => { observed.push(pid); return { state: 'unknown' as const, reason: 'must not be asked' } }
        const successor = { holderId: holderA, checkoutId: checkoutA }
        const overLimit = Array.from({ length: STRUCTURED_INPUT_ENTRY_LIMIT + 1 }, (_, index) => ({
            holderId: `holder:${index.toString(16).padStart(64, '0')}:session`, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z', pid: 1 + index,
        }))
        const malformed = [
            [{ holderId: 'holder:invalid:session', checkoutId: checkoutA, claimedAt: 'not-a-date', pid: 4242 }],
            [{ holderId: holderB, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z', pid: 2_147_483_648 }],
            overLimit,
        ]
        for (const holders of malformed) {
            const state = await namespace()
            const seeded = await transactState(state, state.paths.coordination(stackId), { ownerId: holderA }, () => {
                const record = claimRecord([])
                record.value = { holders, lease: { offset: 0, ports: { WEB: 3000 }, released: false, declaration: { step: 100, count: 3, bases: { WEB: 3000 } } }, lastReleasedHolder: null }
                return { ...record, cockpitId: state.paths.coordination(stackId).cockpitId }
            })
            if (seeded.kind !== 'complete') throw new Error(JSON.stringify(seeded))
            const before = await readFile(state.paths.coordination(stackId).path)
            expect(await releaseDeadSessionHolders({ namespace: state, stackId, successor, now: '2026-09-07T12:00:00.000Z', observe }))
                .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
            expect(await readFile(state.paths.coordination(stackId).path)).toEqual(before)
        }
        expect(observed).toEqual([])
    })

    // A pid outlives its process, and a hold can stand on a pid alone, so advice to kill one has to
    // make the reader confirm it first: a reused pid names a stranger.
    it('tells the reader to confirm a held pid before stopping it, and admits it may be unconfirmed', () => {
        const holder = (pid?: number) => ({ holderId: `holder:${'d'.repeat(64)}:session`, checkoutId: `checkout:${'e'.repeat(64)}`,
            claimedAt: '2026-09-07T12:00:00.000Z', ...pid === undefined ? {} : { pid } }) as Parameters<typeof liveHolderMessage>[0][number]
        const message = liveHolderMessage([holder(4242), holder(4343)])
        expect(message).toContain('or its process could not be confirmed gone')
        expect(message).toContain('once `ps -o pid,ppid,command -p 4242,4343` shows it is that session and not one your own agent started (an MCP server, say), stop it with `kill 4242 4343`')
        expect(liveHolderMessage([holder()])).not.toMatch(/kill|ps -/)
    })

    // macOS's Seatbelt refuses to run /bin/ps, which is setuid, even under an allow-all profile, and a
    // bare "ps did not report" sent people looking at the process rather than the sandbox.
    it('points at a sandbox when ps cannot report a process start', async () => {
        const refused = processHost(async () => ({ kind: 'refusal' }) as never)
        expect(await refused.psStart(4242)).toEqual({ kind: 'failed',
            reason: 'ps did not report when process 4242 started; a sandbox can refuse to run ps, so if one is in use, run this command outside it' })
    })

    // procps derives a wall-clock start from the boot time, which moves when the wall clock is
    // stepped (NTP, a resumed VM): a running session read that way looked like a stranger, lost its
    // hold, and another session's down stopped its stack.
    it('identifies a Linux process by its start ticks and boot, so a wall-clock step keeps a running session', async () => {
        const state = await namespace()
        const bootId = '0f0e0d0c-0b0a-4908-8706-050403020100'
        const processes = new Map<number, number>([[4242, 98_765]])
        let wallClock = 'Mon Sep  7 11:58:59 2026'
        const host: ProcessHost = {
            platform: 'linux',
            presence: async (pid) => processes.has(pid) ? 'live' : 'absent',
            psStart: async () => ({ kind: 'complete', text: wallClock }),
            readFile: async (path) => {
                if (path === '/proc/sys/kernel/random/boot_id') return `${bootId}\n`
                const ticks = processes.get(Number(/^\/proc\/(\d+)\/stat$/.exec(path)?.[1]))
                if (ticks === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
                // A command name may hold spaces and parentheses; the fields are read after the last `)`.
                return `4242 (agent (x) y) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${ticks} 1000 10 18446744073709551615\n`
            },
        }
        const recorded = await observeProcessStart(4242, host)
        expect(recorded).toEqual({ state: 'present', start: `proc:${bootId}:98765` })
        await seedCoordination(state, [{ holderId: holderB, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z', pid: 4242,
            processStart: (recorded as { start: string }).start }])
        const release = () => releaseDeadSessionHolders({ namespace: state, stackId, successor: { holderId: holderA, checkoutId: checkoutA },
            now: '2026-09-07T12:00:00.000Z', observe: (pid) => observeProcessStart(pid, host) })

        wallClock = 'Mon Sep  7 11:59:41 2026'
        expect(await release()).toEqual({ kind: 'complete', released: [] })

        // Without a /proc for this pid namespace a running process has no entry; that is not proof it is gone.
        const withoutProc: ProcessHost = { ...host, readFile: async (path) => { throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }) } }
        expect(await observeProcessStart(4242, withoutProc)).toMatchObject({ state: 'unknown' })

        processes.set(4242, 123_456)
        expect(await release()).toMatchObject({ kind: 'complete', released: [{ holderId: holderB, pid: 4242 }] })
    })
    // A listener on a leased port counts as a session's only through its process. Every read that
    // could not be made leaves ownership unproven, never owned. macOS lists sockets with lsof and Linux with ss; both
    // listings of the same sockets must reach the same verdicts.
    const listings = {
        lsof: { owned: 'p302\nf12\nn127.0.0.1:4100\nf13\nn*:4300\np400\nf9\nn[::1]:4200\n', malformed: 'n127.0.0.1:4100\n' },
        ss: {
            owned: [
                'LISTEN 0      511        127.0.0.1:4100       0.0.0.0:* users:(("node",pid=302,fd=12))',
                'LISTEN 0      511                *:4300             *:* users:(("node",pid=302,fd=13))',
                // A process name may spell `pid=`; the real owner's pid is still read.
                'LISTEN 0      511            [::1]:4200          [::]:* users:(("x\\",pid=302,fd=1",pid=400,fd=9))',
                'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*',
            ].join('\n') + '\n',
            malformed: 'ESTAB 0 0 127.0.0.1:4100 127.0.0.1:5000\n',
        },
    } as const
    it.each(['lsof', 'ss'] as const)('proves a listener a session\'s from one read of the session, the socket and its process chain (%s)', async (format) => {
        const session = { pid: 300, processStart: 'lstart:2026-09-07T11:00:00.000Z' }
        const table = '    1     0 Mon Sep  7 09:00:00 2026\n  300     1 Mon Sep  7 11:00:00 2026\n  301   300 Mon Sep  7 11:01:00 2026\n  302   301 Mon Sep  7 11:02:00 2026\n  400     1 Mon Sep  7 11:03:00 2026\n'
        const listing = (text: string) => async () => ({ kind: 'complete' as const, format, text })
        const host = (overrides: Partial<ListenerHost> = {}, starts: string[] = ['Mon Sep  7 11:00:00 2026']): ListenerHost => ({
            process: { platform: 'darwin', presence: async () => 'live', readFile: async () => '',
                psStart: async () => ({ kind: 'complete', text: starts.length > 1 ? starts.shift()! : starts[0]! }) },
            listeners: listing(listings[format].owned),
            processTable: async () => ({ kind: 'complete', text: table }),
            ...overrides,
        })
        const probed = [{ port: 4100, address: '127.0.0.1' }, { port: 4200, address: '::1' }, { port: 4300, address: '127.0.0.1' },
            { port: 4300, address: '::1' }, { port: 4400, address: '127.0.0.1' }] as const
        const observe = (listenerHost: ListenerHost) => observeSessionListeners({ listeners: probed, holders: [session], host: listenerHost })

        expect(await observe(host())).toMatchObject({ kind: 'complete', ports: [
            { port: 4100, owned: true },
            { port: 4200, owned: false, reason: 'process 400 was not started by a live cockpit session holding this stack' },
            { port: 4300, owned: true },
            { port: 4400, owned: false, reason: 'its listener on 127.0.0.1 belongs to a process this user cannot see' },
        ] })
        // The session's socket on one address does not vouch for an answer on another: the ::1
        // listener may be another user's, which lsof leaves out and ss lists without its process.
        const otherUser = format === 'ss'
            ? listing(`${listings.ss.owned}LISTEN 0      511            [::1]:4100          [::]:*\n`) : undefined
        expect(await observeSessionListeners({ listeners: [{ port: 4100, address: '127.0.0.1' }, { port: 4100, address: '::1' }],
            holders: [session], host: host(otherUser ? { listeners: otherUser } : {}) }))
            .toMatchObject({ kind: 'complete', ports: [{ port: 4100, owned: false, reason: 'its listener on [::1] belongs to a process this user cannot see' }] })
        // A pid alone, or a pid whose start differs from the recorded one, is not the session.
        for (const [holder, starts] of [[{ pid: 300 }, undefined], [session, ['Mon Sep  7 11:30:00 2026']]] as const) {
            expect(await observeSessionListeners({ listeners: [{ port: 4100, address: '127.0.0.1' }], holders: [holder],
                host: host({}, starts ? [...starts] : undefined) }))
                .toMatchObject({ kind: 'complete', ports: [{ port: 4100, owned: false, reason: 'no live cockpit session holds this stack' }] })
        }

        for (const unproven of [
            host({ listeners: async () => ({ kind: 'failed', reason: 'the socket listing is not installed' }) }),
            host({ processTable: async () => ({ kind: 'failed', reason: 'ps is not installed' }) }),
            host({ listeners: listing(listings[format].malformed) }),
            // A session whose start cannot be read may be running its own listener.
            { ...host(), process: { ...host().process, psStart: async () => ({ kind: 'failed' as const, reason: 'ps was refused' }) } },
        ]) expect(await observe(unproven)).toMatchObject({ kind: 'unavailable' })
    })

    // lsof exits 1 when it lists nothing, which the executor reports as a failed step; Linux has ss
    // rather than lsof in common images.
    it('reads this platform\'s socket listing when nothing listens on the port, not as a failure', async () => {
        const server = (await import('node:net')).createServer()
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const port = (server.address() as { port: number }).port
        await new Promise<void>(resolve => server.close(() => resolve()))
        const listed = await listenerHost(executeProbe).listeners([port])
        expect(listed).toMatchObject({ kind: 'complete', format: process.platform === 'linux' ? 'ss' : 'lsof' })
        expect(listed.kind === 'complete' && listed.text).not.toContain(`:${port} `)
    })

    // Recording a hold against a process the command does not run under would let that process's
    // children count as a session's listeners.
    it('confirms a session process only as the process itself or one of its ancestors', async () => {
        const host = listenerHost(executeProbe)
        const self = await observeProcessStart(process.pid, host.process)
        if (self.state !== 'present') throw new Error(JSON.stringify(self))
        const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
        try {
            await new Promise<void>((resolve, reject) => { stranger.once('error', reject); stranger.once('spawn', () => resolve()) })
            const started = await observeProcessStart(stranger.pid!, host.process)
            if (started.state !== 'present') throw new Error(JSON.stringify(started))
            expect(await observeProcessAncestry({ pid: process.pid, ancestor: { pid: process.pid, processStart: self.start }, host })).toBe('ancestor')
            expect(await observeProcessAncestry({ pid: stranger.pid!, ancestor: { pid: process.pid, processStart: self.start }, host })).toBe('ancestor')
            expect(await observeProcessAncestry({ pid: process.pid, ancestor: { pid: stranger.pid!, processStart: started.start }, host })).toBe('unrelated')
            expect(await observeProcessAncestry({ pid: process.pid, ancestor: { pid: process.pid, processStart: 'lstart:2000-01-01T00:00:00.000Z' }, host }))
                .toBe('unrelated')
        } finally {
            stranger.kill('SIGKILL')
        }
    })
})

describe('session-aware claims', () => {
    it('records self-release with observed time rather than caller time', async () => {
        const state = await namespace()
        await seedCoordination(state, [
            { holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' },
            { holderId: holderB, checkoutId: checkoutB, claimedAt: '2026-09-07T11:59:00.000Z' },
        ])
        const before = Date.now()
        expect(await releaseClaim({
            namespace: state, stackId, requesterId: holderA, holderId: holderA,
            now: '2026-09-07T12:00:00.000Z',
        })).toMatchObject({ kind: 'complete', change: 'released' })
        const stored = await readState(state.paths.coordination(stackId))
        if (stored.kind !== 'complete') throw new Error('expected coordination record')
        expect(Date.parse(stored.value.updatedAt)).toBeGreaterThanOrEqual(before)
    })

    it('snapshots a release request before coordination yields', async () => {
        const state = await namespace()
        await seedCoordination(state, [
            { holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' },
            { holderId: holderB, checkoutId: checkoutB, claimedAt: '2026-09-07T11:59:30.000Z' },
        ])
        const release = { namespace: state, stackId, requesterId: holderB, holderId: holderB, now: '2026-09-07T12:00:01.000Z' }
        const releasing = releaseClaim(release)
        release.stackId = `stack:${'8'.repeat(64)}` as StackId
        release.holderId = holderA
        release.now = 'invalid'
        await expect(releasing).resolves.toMatchObject({ kind: 'complete', change: 'released', remaining: [holderA] })
    })

    it('returns a named refusal when a claim release getter throws', async () => {
        const hostile = {} as Parameters<typeof releaseClaim>[0]
        Object.defineProperty(hostile, 'namespace', { get: () => { throw new Error('hostile namespace getter') } })
        await expect(releaseClaim(hostile)).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }],
        })
    })

    it('releases only the exact non-final holder and leaves the final holder to sleep or down', async () => {
        const state = await namespace()
        await seedCoordination(state, [
            { holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' },
            { holderId: holderB, checkoutId: checkoutB, claimedAt: '2026-09-07T12:00:00.000Z' },
        ])

        // Another holder's claim is never this call's to drop, whatever the requester says.
        const beforeCrossRelease = await readFile(state.paths.coordination(stackId).path)
        expect(await releaseClaim({ namespace: state, stackId, requesterId: holderA, holderId: holderB, now: '2026-09-07T12:00:00.500Z' }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        expect(await readFile(state.paths.coordination(stackId).path)).toEqual(beforeCrossRelease)
        expect(await releaseClaim({ namespace: state, stackId, requesterId: holderA, holderId: holderA, now: '2026-09-07T12:00:01.000Z' }))
            .toMatchObject({ kind: 'complete', change: 'released', decision: 'retain', remaining: [holderB] })
        const beforeDuplicate = await readFile(state.paths.coordination(stackId).path)
        expect(await releaseClaim({ namespace: state, stackId, requesterId: holderA, holderId: holderA, now: '2026-09-07T12:00:02.000Z' }))
            .toMatchObject({ kind: 'complete', change: 'unchanged', decision: 'retain', remaining: [holderB] })
        expect(await releaseClaim({
            namespace: state, stackId, requesterId: holderC, holderId: holderC,
            now: '2026-09-07T12:00:02.000Z',
        })).toMatchObject({ kind: 'complete', change: 'unchanged', decision: 'retain', remaining: [holderB] })
        expect(await readFile(state.paths.coordination(stackId).path)).toEqual(beforeDuplicate)
        expect(await releaseClaim({ namespace: state, stackId, requesterId: holderB, holderId: holderB, now: '2026-09-07T12:00:03.000Z' }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        const afterFinal = await readFile(state.paths.coordination(stackId).path)
        expect(await releaseClaim({ namespace: state, stackId, requesterId: holderB, holderId: holderB, now: '2026-09-07T12:00:04.000Z' }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        expect(await readFile(state.paths.coordination(stackId).path)).toEqual(afterFinal)
        const stored = JSON.parse(await readFile(state.paths.coordination(stackId).path, 'utf8'))
        expect(stored.value).toMatchObject({ lastReleasedHolder: holderA })
        expect(stored.value).not.toHaveProperty('releasedHolders')
    })

})
