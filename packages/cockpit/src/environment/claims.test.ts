import { chmod, link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    ENVIRONMENT_CODES,
    type CheckoutId,
    type CockpitId,
    type HolderId,
    type StackId,
} from './contract.js'
import {
    finalizeDrainOutcome,
    matchReclaimDrainContinuation,
    reduceDrainOutcome,
    inspectDrainAttemptAuthority,
    inspectDestructiveDrainRecovery,
    inspectSleepDrainRecovery,
    inspectFailedReclaimRecovery,
    issueRestoreExecutionAuthority,
    consumeRestoreExecutionAuthority,
    settleRestoreExecutionAuthority,
    consumeFailedReclaimRecovery,
    consumeDrainReservationAuthority,
    coordinationStateRecord,
    decodeCoordinationRecord,
    observeProcessStart,
    processHost,
    prepareDrainOutcomePublication,
    releaseDeadSessionHolders,
    removeExactCoordinationHolder,
    openReclaimDrainExecution,
    openRuntimeDrainExecution,
    recoverDrainReservation,
    recoverSleepDrainReservation,
    releaseClaim,
    reserveDrainAttempt,
    reserveDrain,
    settleReclaimDrainFailure,
    settleReclaimDrainSuccess,
    settleRuntimeDrainFailure,
    settleRuntimeDrainSuccess,
    settleInterruptedDrainRepair,
    readActiveStackInventory,
    readRootPortInventory,
    type ProcessHost,
    type DrainReservationRequest,
    type DrainReservation,
    type DrainAttemptResult,
    type ReclaimDrainExecutionAuthority,
    type RuntimeDrainExecutionAuthority,
    type RestoreExecutionAuthority,
    type SleepDrainRecoveryAuthority,
} from './claims.js'
import { executeProbe, repairFencedExecution } from '../environment-exec/execute.js'
import { leasePortFamily } from './ports.js'
import { STRUCTURED_INPUT_ENTRY_LIMIT } from '../schema.js'
import { readState, selectStateRoot, SERIALIZED_RECORD_BYTE_LIMIT, transactState, withStateNamespaceInventory, type StateNamespace, type StateRecord } from './state.js'

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

async function interceptDirectorySync(
    directoryPath: string,
    intercept: () => Promise<void> | void,
): Promise<{ readonly calls: () => number; readonly restore: () => void }> {
    const handle = await open(directoryPath, 'r')
    const expected = await handle.stat()
    const prototype = Object.getPrototypeOf(handle) as { sync: typeof handle.sync }
    const realSync = prototype.sync
    await handle.close()
    let calls = 0
    const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: typeof handle) {
        const actual = await this.stat()
        if (actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino) {
            calls += 1
            await intercept()
        }
        await realSync.call(this)
    })
    return { calls: () => calls, restore: () => spy.mockRestore() }
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

function after(instant: string, millis: number): string {
    return new Date(Date.parse(instant) + millis).toISOString()
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

// The live co-tenant join: a second holder takes the stack's existing port lease.
function joinStack(state: StateNamespace, now: string) {
    return leasePortFamily({
        namespace: state, stackId, holderId: holderB, checkoutId: checkoutB, now,
        config: { step: 100, count: 3, bases: { WEB: 3000 } }, listenerTimeoutMs: 100,
        // The seeded lease is at offset 0, the only family the join observes.
        listenerEvidence: [{ ports: [3000], observation: { state: 'available', value: [], observedAt: now, producer: 'test-listener-probe' } }],
    })
}

describe('restore execution authority', () => {
    const stepSha256 = '3'.repeat(64)
    // The restoring process's start identity as `observeProcessStart` would read it.
    const restoringStart = 'lstart:2026-09-07T11:58:00.000Z'
    const observe = async () => ({ state: 'present' as const, start: restoringStart })

    async function config(state: StateNamespace) {
        const configPath = join(state.cockpitRoot, 'restore-config.toml')
        const bytes = Buffer.from('synthetic = true\n')
        await mkdir(dirname(configPath), { recursive: true })
        await writeFile(configPath, bytes)
        return { configPath, configSha256: createHash('sha256').update(bytes).digest('hex') }
    }

    it('binds one use to the exact current sole holder and execution step', async () => {
        const state = await namespace()
        const { configPath, configSha256 } = await config(state)
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const issued = await issueRestoreExecutionAuthority({ namespace: state, stackId, holderId: holderA, requesterId: holderA, configPath, configSha256, stepSha256, observe })
        if (issued.kind !== 'complete') throw new Error(JSON.stringify(issued))

        await expect(consumeRestoreExecutionAuthority({
            namespace: state, authority: { ...issued.authority } as RestoreExecutionAuthority,
            stackId, holderId: holderA, requesterId: holderA, configPath, configSha256, stepSha256,
        })).resolves.toMatchObject({ kind: 'refusal' })
        const consumed = await consumeRestoreExecutionAuthority({
            namespace: state, authority: issued.authority, stackId, holderId: holderA, configSha256, stepSha256,
            requesterId: holderA, configPath,
        })
        expect(consumed).toMatchObject({ kind: 'complete' })
        await expect(consumeRestoreExecutionAuthority({
            namespace: state, authority: issued.authority, stackId, holderId: holderA, requesterId: holderA, configPath, configSha256, stepSha256,
        })).resolves.toMatchObject({ kind: 'refusal' })
        if (consumed.kind !== 'complete') throw new Error('expected restore lease')
        await expect(settleRestoreExecutionAuthority({ namespace: state, lease: consumed.lease })).resolves.toEqual({ kind: 'complete' })

        const mismatched = await issueRestoreExecutionAuthority({ namespace: state, stackId, holderId: holderA, requesterId: holderA, configPath, configSha256, stepSha256, observe })
        if (mismatched.kind !== 'complete') throw new Error('expected restore authority')
        await expect(consumeRestoreExecutionAuthority({
            namespace: state, authority: mismatched.authority, stackId, holderId: holderA,
            requesterId: holderA, configPath, configSha256: '4'.repeat(64), stepSha256,
        })).resolves.toMatchObject({ kind: 'refusal' })
        await expect(consumeRestoreExecutionAuthority({
            namespace: state, authority: mismatched.authority, stackId, holderId: holderA, requesterId: holderA, configPath, configSha256, stepSha256,
        })).resolves.toMatchObject({ kind: 'refusal' })
    })

    it('blocks co-tenants while a restore lease is active and releases after settlement', async () => {
        const state = await namespace()
        const { configPath, configSha256 } = await config(state)
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const issued = await issueRestoreExecutionAuthority({ namespace: state, stackId, holderId: holderA, requesterId: holderA, configPath, configSha256, stepSha256, observe })
        if (issued.kind !== 'complete') throw new Error(JSON.stringify(issued))
        await expect(joinStack(state, '2026-09-07T12:00:01.000Z')).resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })

        const consumed = await consumeRestoreExecutionAuthority({
            namespace: state, authority: issued.authority, stackId, holderId: holderA, requesterId: holderA, configPath, configSha256, stepSha256,
        })
        expect(consumed).toMatchObject({ kind: 'complete' })
        if (consumed.kind !== 'complete') throw new Error('expected restore lease')
        const otherState = await namespace()
        await expect(settleRestoreExecutionAuthority({ namespace: otherState, lease: consumed.lease }))
            .resolves.toMatchObject({ kind: 'refusal' })
        await expect(settleRestoreExecutionAuthority({ namespace: state, lease: consumed.lease })).resolves.toEqual({ kind: 'complete' })
        await expect(joinStack(state, '2026-09-07T12:00:02.000Z')).resolves.toMatchObject({ kind: 'complete' })
        await expect(consumeRestoreExecutionAuthority({
            namespace: state, authority: issued.authority, stackId, holderId: holderA, requesterId: holderA, configPath, configSha256, stepSha256,
        })).resolves.toMatchObject({ kind: 'refusal' })
    })

    // A restore whose process died before settling (SIGKILL, out of memory, a closed terminal) left
    // its reservation behind, and every later up, sleep, down and reset refused with no way out.
    it('releases a restore whose process is gone, and keeps one that is running or unconfirmed', async () => {
        const state = await namespace()
        const { configPath, configSha256 } = await config(state)
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const issued = await issueRestoreExecutionAuthority({ namespace: state, stackId, holderId: holderA, requesterId: holderA, configPath, configSha256, stepSha256, observe })
        if (issued.kind !== 'complete') throw new Error(JSON.stringify(issued))
        // The authority is never consumed or settled, as when its process dies mid-restore.
        const reap = (observed: Awaited<ReturnType<typeof observeProcessStart>>) => releaseDeadSessionHolders({
            namespace: state, stackId, successor: { holderId: holderA, checkoutId: checkoutA },
            now: '2026-09-07T12:00:00.000Z', observe: async (pid) => pid === process.pid ? observed : { state: 'unknown', reason: `unexpected process ${pid}` },
        })

        for (const observed of [{ state: 'present', start: restoringStart }, { state: 'unknown', reason: 'ps is not installed' }] as const) {
            expect(await reap(observed)).toEqual({ kind: 'complete', released: [] })
            await expect(joinStack(state, '2026-09-07T12:00:01.000Z')).resolves.toMatchObject({ kind: 'refusal', diagnostics: [{
                code: ENVIRONMENT_CODES.CLAIM_CO_TENANT, message: `port leasing waits while process ${process.pid} restores the stack's data`,
                fix: expect.stringContaining('then rerun this command, which releases a restore whose process has ended'),
            }] })
        }
        expect(await reap({ state: 'absent' })).toEqual({ kind: 'complete', released: [], interruptedRestore: expect.objectContaining({
            severity: 'warning', code: 'RESTORE_INTERRUPTED', message: expect.stringContaining(`by process ${process.pid}, reserved at `) }) })
        await expect(joinStack(state, '2026-09-07T12:00:02.000Z')).resolves.toMatchObject({ kind: 'complete' })
    })

    it('keeps a reservation active when a malformed envelope cannot authenticate its authority', async () => {
        const state = await namespace()
        const { configPath, configSha256 } = await config(state)
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const issued = await issueRestoreExecutionAuthority({
            namespace: state, stackId, holderId: holderA, requesterId: holderA,
            configPath, configSha256, stepSha256, observe,
        })
        if (issued.kind !== 'complete') throw new Error(JSON.stringify(issued))

        await expect(consumeRestoreExecutionAuthority({
            namespace: state, authority: issued.authority, stackId, holderId: holderA,
            requesterId: holderA, configPath, configSha256, stepSha256, extra: true,
        } as never)).resolves.toMatchObject({ kind: 'refusal' })
        await expect(joinStack(state, '2026-09-07T12:00:01.000Z')).resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })

        const consumed = await consumeRestoreExecutionAuthority({
            namespace: state, authority: issued.authority, stackId, holderId: holderA,
            requesterId: holderA, configPath, configSha256, stepSha256,
        })
        if (consumed.kind !== 'complete') throw new Error(JSON.stringify(consumed))
        await expect(settleRestoreExecutionAuthority({ namespace: state, lease: consumed.lease })).resolves.toEqual({ kind: 'complete' })
        await expect(joinStack(state, '2026-09-07T12:00:02.000Z')).resolves.toMatchObject({ kind: 'complete' })
    })

    it('refuses a copied namespace and configuration drift before execution', async () => {
        const state = await namespace()
        const { configPath, configSha256 } = await config(state)
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        await expect(issueRestoreExecutionAuthority({
            namespace: { ...state } as StateNamespace, stackId, holderId: holderA, requesterId: holderA,
            configPath, configSha256, stepSha256, observe,
        })).resolves.toMatchObject({ kind: 'refusal' })

        const issued = await issueRestoreExecutionAuthority({
            namespace: state, stackId, holderId: holderA, requesterId: holderA,
            configPath, configSha256, stepSha256, observe,
        })
        if (issued.kind !== 'complete') throw new Error(JSON.stringify(issued))
        await writeFile(configPath, 'synthetic = false\n')
        await expect(consumeRestoreExecutionAuthority({
            namespace: state, authority: issued.authority, stackId, holderId: holderA, requesterId: holderA,
            configPath, configSha256, stepSha256,
        })).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED }],
        })
        await expect(joinStack(state, '2026-09-07T12:00:03.000Z')).resolves.toMatchObject({ kind: 'complete' })
    })
})

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
            holders: [claimedA, claimedB], lease: activeLease, lastReleasedHolder: null, drain: null,
        }, holderA)).toEqual({
            holders: [claimedB], lease: activeLease, lastReleasedHolder: holderA, drain: null,
        })
        expect(removeExactCoordinationHolder({
            holders: [claimedA], lease: activeLease, lastReleasedHolder: null, drain: null,
        }, holderA)).toEqual({
            holders: [], lease: activeLease, lastReleasedHolder: holderA, drain: null,
        })
    })

    it('refuses a missing holder or a shape that cannot retain an active lease', () => {
        expect(removeExactCoordinationHolder({
            holders: [claimedB], lease: activeLease, lastReleasedHolder: null, drain: null,
        }, holderA)).toBeUndefined()
        expect(removeExactCoordinationHolder({
            holders: [claimedA], lease: { ...activeLease, released: true }, lastReleasedHolder: null, drain: null,
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

function stoppedFact(reservation: DrainReservation) {
    if (!reservation.attempt) throw new Error('expected a committed drain attempt')
    return {
        purpose: reservation.purpose, stackId: reservation.stackId, configSha256: reservation.configSha256,
        planDigest: reservation.planDigest, operationBasis: reservation.operationBasis,
        coordinationRevision: reservation.coordinationRevision, reservationId: reservation.reservationId,
        reservedAt: reservation.reservedAt, generation: reservation.attempt.generation,
        attemptId: reservation.attempt.attemptId, attemptRevision: reservation.attempt.committedRevision,
        attemptCommittedAt: reservation.attempt.committedAt, validThrough: reservation.attempt.validThrough,
        actionIndex: reservation.attempt.actionIndex, currentTarget: reservation.attempt.currentTarget,
        currentStage: reservation.attempt.currentStage,
        observedAt: reservation.attempt.committedAt,
    }
}

function drainActions(stack: StackId, reclaimTargets: readonly string[] = []) {
    return [
        { stage: 'runtime-stop' as const, targetId: stack, validForMs: 30_000 },
        ...reclaimTargets.map((targetId) => {
            const body = JSON.stringify({ targetId })
            return {
                stage: 'reclaim' as const, targetId, validForMs: 30_000,
                targetCommitment: {
                    format: 'cockpit-reclaim-target/v1' as const,
                    sha256: createHash('sha256').update(body).digest('hex'), body,
                },
            }
        }),
    ]
}

async function seedPersistedSleepDrain(state: StateNamespace, overrides: Record<string, unknown> = {}) {
    await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
    const current = await readState(state.paths.coordination(stackId))
    if (current.kind !== 'complete') throw new Error('expected coordination seed')
    const value = decodeCoordinationRecord(current.value, stackId)
    if (!value) throw new Error('expected coordination value')
    const reservation = {
        purpose: 'sleep' as const,
        stackId,
        holderId: holderA,
        requesterId: holderA,
        configSha256: '2'.repeat(64),
        planDigest: '3'.repeat(64),
        operationBasis: '4'.repeat(64),
        generation: '5'.repeat(64),
        targetIds: [stackId],
        actions: drainActions(stackId),
        expectedCoordinationRevision: 0,
        coordinationRevision: 1,
        reservedAt: '2026-09-07T12:00:01.000Z',
        reservationId: createHash('sha256').update(state.root).digest('hex'),
        completedActionCount: 0,
        progressRevision: 1,
        attempt: null,
        ...overrides,
    }
    const published = await transactState(
        state,
        state.paths.coordination(stackId),
        { ownerId: holderA },
        (record) => coordinationStateRecord(state, stackId, record, '2026-09-07T12:00:01.000Z', { ...value, drain: reservation as DrainReservation }),
    )
    if (published.kind !== 'complete') throw new Error('expected persisted sleep drain')
    return reservation
}

function sleepDrainRequest(
    persisted: DrainReservation,
    overrides: Partial<DrainReservationRequest> = {},
): DrainReservationRequest {
    return {
        purpose: 'sleep',
        stackId,
        holderId: holderA,
        requesterId: holderA,
        configSha256: persisted.configSha256,
        planDigest: persisted.planDigest,
        operationBasis: persisted.operationBasis,
        generation: persisted.generation,
        targetIds: [stackId],
        actions: drainActions(stackId),
        expectedCoordinationRevision: 1,
        ...overrides,
    }
}

describe('sleep drain recovery ownership', () => {
    it('distinguishes no persisted drain without caller-authored coordination policy', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])

        await expect(inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA }))
            .resolves.toEqual({ kind: 'none' })
    })

    it('recovers an exact persisted sleep request from fresh planning evidence without exposing it during inspection', async () => {
        const state = await namespace()
        const persisted = await seedPersistedSleepDrain(state)

        const inspected = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        if (inspected.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        expect(inspected).toEqual({
            kind: 'recoverable',
            generation: persisted.generation,
            runtimeStopValidForMs: 30_000,
            authority: expect.any(Object),
        })
        expect(Object.keys(inspected.authority)).toEqual([])
        expect('reservation' in inspected).toBe(false)

        const freshRequest = sleepDrainRequest(persisted)
        expect(await recoverSleepDrainReservation({
            namespace: state,
            authority: { ...inspected.authority } as SleepDrainRecoveryAuthority,
            request: freshRequest,
        })).toMatchObject({ kind: 'refusal' })
        const recovered = await recoverSleepDrainReservation({ namespace: state, authority: inspected.authority, request: freshRequest })
        if (recovered.kind !== 'complete') throw new Error('expected recovered sleep drain')
        expect(recovered.reservation.expectedCoordinationRevision).toBe(0)
        expect(await reserveDrainAttempt({ namespace: state, authority: recovered.authority })).toMatchObject({ kind: 'complete' })
        expect(await recoverSleepDrainReservation({ namespace: state, authority: inspected.authority, request: freshRequest }))
            .toMatchObject({ kind: 'refusal' })
    })

    it('recovers an unstarted sleep reservation after attempt lock contention', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'sleep' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected sleep reservation')
        let reportLocked!: () => void
        let releaseLock!: () => void
        const locked = new Promise<void>((resolve) => { reportLocked = resolve })
        const release = new Promise<void>((resolve) => { releaseLock = resolve })
        const address = state.paths.dataOutcome(stackId)
        const competing = transactState(state, address, {
            ownerId: holderA,
            beforePublish: async () => {
                reportLocked()
                await release
            },
        }, (current) => ({
            format: 'cockpit-state/v1', kind: 'data-outcome', cockpitId: address.cockpitId,
            subjectId: stackId, revision: current === null ? 0 : current.revision + 1,
            updatedAt: new Date().toISOString(), value: {},
        }))
        try {
            await locked
            await expect(reserveDrainAttempt({ namespace: state, authority: reserved.authority }))
                .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_LOCKED }] })
        } finally {
            releaseLock()
            await competing
        }

        const inspected = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        expect(inspected).toMatchObject({ kind: 'recoverable' })
        if (inspected.kind !== 'recoverable') throw new Error('expected recoverable sleep reservation')
        const recovered = await recoverSleepDrainReservation({
            namespace: state,
            authority: inspected.authority,
            request: { ...request, expectedCoordinationRevision: 1 },
        })
        if (recovered.kind !== 'complete') throw new Error('expected recovered sleep reservation')
        await expect(reserveDrainAttempt({ namespace: state, authority: recovered.authority }))
            .resolves.toMatchObject({ kind: 'complete' })
    })

    it('requires fresh planning evidence to name the current coordination revision', async () => {
        const state = await namespace()
        const persisted = await seedPersistedSleepDrain(state)
        const inspected = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        if (inspected.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        const staleRequest = sleepDrainRequest(persisted, { expectedCoordinationRevision: 0 })

        expect(await recoverSleepDrainReservation({ namespace: state, authority: inspected.authority, request: staleRequest }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED }] })
        expect(await recoverSleepDrainReservation({
            namespace: state,
            authority: inspected.authority,
            request: { ...staleRequest, expectedCoordinationRevision: 1 },
        })).toMatchObject({ kind: 'refusal' })
    })

    it('burns genuine recovery authority on malformed sibling inputs without letting a copy burn it', async () => {
        const state = await namespace()
        const persisted = await seedPersistedSleepDrain(state)
        const request = sleepDrainRequest(persisted)
        const copiedAuthorityInspection = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        if (copiedAuthorityInspection.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        expect(await recoverSleepDrainReservation({
            namespace: state,
            authority: { ...copiedAuthorityInspection.authority } as SleepDrainRecoveryAuthority,
            request,
        })).toMatchObject({ kind: 'refusal' })
        expect(await recoverSleepDrainReservation({
            namespace: state,
            authority: copiedAuthorityInspection.authority,
            request,
        })).toMatchObject({ kind: 'complete' })

        const malformedNamespaceState = await namespace()
        const malformedNamespacePersisted = await seedPersistedSleepDrain(malformedNamespaceState)
        const malformedNamespaceInspection = await inspectSleepDrainRecovery({
            namespace: malformedNamespaceState, stackId, holderId: holderA,
        })
        if (malformedNamespaceInspection.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        const malformedNamespaceRequest = sleepDrainRequest(malformedNamespacePersisted)
        expect(await recoverSleepDrainReservation({
            namespace: { ...malformedNamespaceState } as StateNamespace,
            authority: malformedNamespaceInspection.authority,
            request: malformedNamespaceRequest,
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
        expect(await recoverSleepDrainReservation({
            namespace: malformedNamespaceState,
            authority: malformedNamespaceInspection.authority,
            request: malformedNamespaceRequest,
        })).toMatchObject({ kind: 'refusal' })

        const malformedRequestState = await namespace()
        const malformedRequestPersisted = await seedPersistedSleepDrain(malformedRequestState)
        const malformedRequest = sleepDrainRequest(malformedRequestPersisted)
        const malformedRequestInspection = await inspectSleepDrainRecovery({
            namespace: malformedRequestState, stackId, holderId: holderA,
        })
        if (malformedRequestInspection.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        expect(await recoverSleepDrainReservation({
            namespace: malformedRequestState,
            authority: malformedRequestInspection.authority,
            request: { ...malformedRequest, actions: 'malformed' } as never,
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
        expect(await recoverSleepDrainReservation({
            namespace: malformedRequestState,
            authority: malformedRequestInspection.authority,
            request: malformedRequest,
        })).toMatchObject({ kind: 'refusal' })
    })

    it('refuses an independently authenticated namespace object for the same state root', async () => {
        const state = await namespace()
        const persisted = await seedPersistedSleepDrain(state)
        const inspected = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        if (inspected.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        const sameRoot = await reissueNamespace(state)
        const request = sleepDrainRequest(persisted)

        expect(await recoverSleepDrainReservation({ namespace: sameRoot, authority: inspected.authority, request }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED }] })
    })

    it('burns recovery authority when state or fresh semantic intent does not match', async () => {
        const state = await namespace()
        const persisted = await seedPersistedSleepDrain(state)
        const inspected = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        if (inspected.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        const request = {
            purpose: 'sleep' as const,
            stackId,
            holderId: holderA,
            requesterId: holderA,
            configSha256: persisted.configSha256,
            planDigest: '7'.repeat(64),
            operationBasis: persisted.operationBasis,
            generation: persisted.generation,
            targetIds: [stackId],
            actions: drainActions(stackId),
            expectedCoordinationRevision: 1,
        }
        expect(await recoverSleepDrainReservation({ namespace: state, authority: inspected.authority, request }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        expect(await recoverSleepDrainReservation({
            namespace: state,
            authority: inspected.authority,
            request: { ...request, planDigest: persisted.planDigest },
        })).toMatchObject({ kind: 'refusal' })
    })

    it('binds recovery authority to its exact namespace and coordination bytes', async () => {
        const state = await namespace()
        const persisted = await seedPersistedSleepDrain(state)
        const request = {
            purpose: 'sleep' as const,
            stackId,
            holderId: holderA,
            requesterId: holderA,
            configSha256: persisted.configSha256,
            planDigest: persisted.planDigest,
            operationBasis: persisted.operationBasis,
            generation: persisted.generation,
            targetIds: [stackId],
            actions: drainActions(stackId),
            expectedCoordinationRevision: 1,
        }
        const foreign = await namespace()
        const foreignInspection = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        if (foreignInspection.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        expect(await recoverSleepDrainReservation({ namespace: foreign, authority: foreignInspection.authority, request }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED }] })
        expect(await recoverSleepDrainReservation({ namespace: state, authority: foreignInspection.authority, request }))
            .toMatchObject({ kind: 'refusal' })

        const changed = await namespace()
        await seedPersistedSleepDrain(changed)
        const changedInspection = await inspectSleepDrainRecovery({ namespace: changed, stackId, holderId: holderA })
        if (changedInspection.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        const address = changed.paths.coordination(stackId)
        const before = await readState(address)
        if (before.kind !== 'complete') throw new Error('expected persisted sleep drain')
        await writeFile(address.path, `${JSON.stringify({ ...before.value, updatedAt: '2026-09-07T12:00:02.000Z' })}\n`)
        expect(await recoverSleepDrainReservation({ namespace: changed, authority: changedInspection.authority, request }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED }] })
    })

    it.each(['stack', 'holder'] as const)('refuses fresh planning evidence for another %s', async (field) => {
        const state = await namespace()
        const persisted = await seedPersistedSleepDrain(state)
        const inspected = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        if (inspected.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        const otherStack = `stack:${'8'.repeat(64)}` as StackId
        const request = {
            purpose: 'sleep' as const,
            stackId: field === 'stack' ? otherStack : stackId,
            holderId: field === 'holder' ? holderB : holderA,
            requesterId: field === 'holder' ? holderB : holderA,
            configSha256: persisted.configSha256,
            planDigest: persisted.planDigest,
            operationBasis: persisted.operationBasis,
            generation: persisted.generation,
            targetIds: [field === 'stack' ? otherStack : stackId],
            actions: drainActions(field === 'stack' ? otherStack : stackId),
            expectedCoordinationRevision: 1,
        }
        expect(await recoverSleepDrainReservation({ namespace: state, authority: inspected.authority, request }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
    })

    it('refuses foreign, active, and non-sleep persisted work inside the claims owner', async () => {
        const state = await namespace()
        await seedPersistedSleepDrain(state)
        expect(await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderB }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })

        const other = await namespace()
        await seedPersistedSleepDrain(other, { purpose: 'down' })
        expect(await inspectSleepDrainRecovery({ namespace: other, stackId, holderId: holderA }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }] })

        const active = await namespace()
        await seedCoordination(active, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const reserved = await reserveDrain({ namespace: active, request: {
            purpose: 'sleep', stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId), expectedCoordinationRevision: 0,
        } })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const attempted = await reserveDrainAttempt({ namespace: active, authority: reserved.authority })
        expect(attempted).toMatchObject({ kind: 'complete' })
        if (attempted.kind !== 'complete') throw new Error('expected active sleep attempt')
        expect(await inspectSleepDrainRecovery({ namespace: active, stackId, holderId: holderA }))
            .toMatchObject({ kind: 'repairable' })
        vi.useFakeTimers()
        vi.setSystemTime(Date.parse(attempted.attempt.validThrough) + 1)
        expect(await inspectSleepDrainRecovery({ namespace: active, stackId, holderId: holderA }))
            .toMatchObject({ kind: 'repairable' })
        expect(await readState(active.paths.coordination(stackId))).toMatchObject({
            kind: 'complete', value: { value: { drain: { attempt: { status: 'active' } } } },
        })
    })
})

describe('destructive drain recovery inspection', () => {
    it('records authenticated fenced termination before exposing the exact failed attempt for retry', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId],
            actions: [{ stage: 'runtime-stop' as const, targetId: stackId, validForMs: 30_000 }], expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected destructive reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected destructive attempt')
        const repairable = await inspectDestructiveDrainRecovery({ namespace: state, stackId, holderId: holderA, purpose: 'down' })
        if (repairable.kind !== 'repairable') throw new Error('expected repairable execution fence')
        const outcome = await executeProbe({
            id: 'synthetic-fenced-action', argv: [process.execPath, '-e', 'process.exit(0)'], argv0: process.execPath,
            cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' }, timeoutMs: 10_000,
            stdoutLimitBytes: 1_024, stderrLimitBytes: 1_024, paths: [], ports: [], labels: {}, expected: [],
            consumedFiles: [], filesystemChecks: [], executionFence: repairable.fence, compensation: [],
        })
        expect(outcome.kind).toBe('complete')
        expect(await readActiveStackInventory(state)).toMatchObject({ kind: 'complete', value: [{ stackId }] })
        expect(await readRootPortInventory(state)).toMatchObject({ kind: 'complete', value: [{ cockpitId, stackId }] })
        const termination = await repairFencedExecution(repairable.fence)
        if (termination.kind !== 'complete') throw new Error('expected authenticated termination')
        const settled = await settleInterruptedDrainRepair({ authority: repairable.authority, evidence: termination.evidence })
        expect(settled).toMatchObject({ kind: 'complete', value: { value: { drain: { attempt: { status: 'failed' } } } } })
        expect(await readActiveStackInventory(state)).toMatchObject({ kind: 'complete', value: [{ stackId }] })
        expect(await inspectDestructiveDrainRecovery({ namespace: state, stackId, holderId: holderA, purpose: 'down' }))
            .toEqual({ kind: 'recoverable', request })
    })

    it('does not retry an expired attempt while its orphaned executor is still alive', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const reserved = await reserveDrain({ namespace: state, request: {
            purpose: 'down', stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId],
            actions: [{ stage: 'runtime-stop', targetId: stackId, validForMs: 50 }], expectedCoordinationRevision: 0,
        } })
        if (reserved.kind !== 'complete') throw new Error('expected destructive reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected destructive attempt')

        const marker = join(state.cockpitRoot, 'orphan-pid')
        const source = [
            "const { spawn } = require('node:child_process')",
            "const { writeFileSync } = require('node:fs')",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
            'writeFileSync(process.argv[1], String(child.pid))',
            'child.unref()',
        ].join(';')
        await new Promise<void>((resolve, reject) => {
            const parent = spawn(process.execPath, ['-e', source, marker], { stdio: 'ignore' })
            parent.once('error', reject)
            parent.once('exit', code => code === 0 ? resolve() : reject(new Error(`executor parent exited ${code}`)))
        })
        const orphanPid = Number(await readFile(marker, 'utf8'))
        try {
            await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(attempted.attempt.validThrough) - Date.now() + 20)))
            expect(() => process.kill(orphanPid, 0)).not.toThrow()
            let retryStarts = 0
            const inspected = await inspectDestructiveDrainRecovery({
                namespace: state, stackId, holderId: holderA, purpose: 'down',
            })
            if (inspected.kind === 'recoverable') retryStarts += 1
            expect(inspected).toMatchObject({ kind: 'repairable' })
            expect(retryStarts).toBe(0)
        } finally {
            try { process.kill(orphanPid, 'SIGKILL') } catch { /* The synthetic orphan may already be gone. */ }
        }
    })

    it('distinguishes missing and drain-free coordination state', async () => {
        const missing = await namespace()
        await expect(inspectDestructiveDrainRecovery({ namespace: missing, stackId, holderId: holderA, purpose: 'down' }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })

        const empty = await namespace()
        await seedCoordination(empty, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        await expect(inspectDestructiveDrainRecovery({ namespace: empty, stackId, holderId: holderA, purpose: 'down' }))
            .resolves.toEqual({ kind: 'none' })
    })

    it('refuses drain-free coordination without exact retained holder and lease ownership', async () => {
        const coTenant = await namespace()
        await seedCoordination(coTenant, [
            { holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' },
            { holderId: holderB, checkoutId: checkoutB, claimedAt: '2026-09-07T11:59:00.000Z' },
        ])
        await expect(inspectDestructiveDrainRecovery({ namespace: coTenant, stackId, holderId: holderA, purpose: 'down' }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })

        const released = await namespace()
        await seedCoordination(released, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const changed = await transactState(released, released.paths.coordination(stackId), { ownerId: holderA }, (current) => ({
            ...current!, revision: current!.revision + 1, updatedAt: new Date().toISOString(),
            value: {
                ...(current!.value as object), holders: [], lastReleasedHolder: holderA,
                lease: { ...((current!.value as { lease: object }).lease), released: true },
            },
        } as never))
        expect(changed).toMatchObject({ kind: 'complete' })
        await expect(inspectDestructiveDrainRecovery({ namespace: released, stackId, holderId: holderA, purpose: 'down' }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
    })

    it('returns an immutable exact request for an authentic failed reservation and rejects later record drift', async () => {
        vi.useFakeTimers()
        vi.setSystemTime('2026-09-07T12:00:00.000Z')
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId, 'volume:data'].sort(),
            actions: drainActions(stackId, ['volume:data']), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected destructive reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected destructive attempt')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active destructive record')
        vi.setSystemTime(Date.parse(attempted.attempt.validThrough) + 1)
        const failedAt = new Date().toISOString()
        const failure = settleRuntimeDrainFailure({
            authority: drainExecution(attempted), fact: { ...attempted.attempt, failedAt },
        })
        if (!failure) throw new Error('expected failed destructive outcome')
        const reduced = reduceDrainOutcome({ authority: failure, record: active.value })
        if (!reduced) throw new Error('expected failed destructive reduction')
        const publication = await prepareDrainOutcomePublication({ authority: failure, namespace: state, stackId })
        if ('diagnostics' in publication) throw new Error('expected failed destructive publication')
        expect(finalizeDrainOutcome({ authority: failure, publication, address: state.paths.coordination(stackId) })).toBe(true)

        const inspected = await inspectDestructiveDrainRecovery({ namespace: state, stackId, holderId: holderA, purpose: 'down' })
        expect(inspected).toEqual({ kind: 'recoverable', request })
        if (inspected.kind !== 'recoverable') throw new Error('expected destructive recovery basis')
        expect(Object.isFrozen(inspected.request)).toBe(true)
        expect(Object.isFrozen(inspected.request.targetIds)).toBe(true)
        expect(Object.isFrozen(inspected.request.actions)).toBe(true)

        const changed = await transactState(state, state.paths.coordination(stackId), { ownerId: holderA }, (current) => ({
            ...current!, revision: current!.revision + 1, updatedAt: after(failedAt, 1),
        }))
        expect(changed).toMatchObject({ kind: 'complete' })
        await expect(inspectDestructiveDrainRecovery({ namespace: state, stackId, holderId: holderA, purpose: 'down' }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
    })

    it('rejects another holder, another destructive purpose, an active attempt, and malformed state', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId, 'volume:data'].sort(),
            actions: drainActions(stackId, ['volume:data']), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected destructive reservation')
        await expect(inspectDestructiveDrainRecovery({ namespace: state, stackId, holderId: holderB, purpose: 'down' }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        await expect(inspectDestructiveDrainRecovery({ namespace: state, stackId, holderId: holderA, purpose: 'reset' }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }] })

        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        expect(attempted).toMatchObject({ kind: 'complete' })
        if (attempted.kind !== 'complete') throw new Error('expected active destructive attempt')
        await expect(inspectDestructiveDrainRecovery({ namespace: state, stackId, holderId: holderA, purpose: 'down' }))
            .resolves.toMatchObject({ kind: 'repairable' })
        vi.useFakeTimers()
        vi.setSystemTime(Date.parse(attempted.attempt.validThrough) + 1)
        await expect(inspectDestructiveDrainRecovery({ namespace: state, stackId, holderId: holderA, purpose: 'down' }))
            .resolves.toMatchObject({ kind: 'repairable' })
        await expect(readState(state.paths.coordination(stackId))).resolves.toMatchObject({
            kind: 'complete', value: { value: { drain: { attempt: { status: 'active' } } } },
        })

        const malformed = await namespace()
        const published = await transactState(malformed, malformed.paths.coordination(stackId), { ownerId: holderA }, () => ({
            format: 'cockpit-state/v1', kind: 'coordination', cockpitId, subjectId: stackId,
            revision: 0, updatedAt: new Date().toISOString(), value: {},
        }))
        expect(published).toMatchObject({ kind: 'complete' })
        await expect(inspectDestructiveDrainRecovery({ namespace: malformed, stackId, holderId: holderA, purpose: 'down' }))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
    })
})

function drainExecution(
    attempted: Extract<DrainAttemptResult, { kind: 'complete' }>,
): RuntimeDrainExecutionAuthority
function drainExecution(
    attempted: Extract<DrainAttemptResult, { kind: 'complete' }>,
    planningRecord: StateRecord,
): ReclaimDrainExecutionAuthority
function drainExecution(
    attempted: Extract<DrainAttemptResult, { kind: 'complete' }>,
    planningRecord?: StateRecord,
): RuntimeDrainExecutionAuthority | ReclaimDrainExecutionAuthority {
    const candidate = inspectDrainAttemptAuthority(attempted.authority)
    if (!candidate) throw new Error('expected drain attempt candidate')
    const execution = attempted.attempt.currentStage === 'runtime-stop'
        ? openRuntimeDrainExecution({ authority: attempted.authority, candidate })
        : planningRecord && openReclaimDrainExecution({
            authority: attempted.authority, candidate,
            planningRecord, continuation: Object.freeze({}),
        })
    if (!execution) throw new Error('expected drain execution authority')
    return execution
}

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
    it.each(['orphaned', 'stale', 'foreign attempt', 'symlink', 'linked', 'writable', 'oversized', 'unknown name'] as const)(
        'refuses a %s executor marker without granting inventory authority', async (mutation) => {
            const state = await namespace()
            await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
            const reserved = await reserveDrain({ namespace: state, request: {
                purpose: 'down', stackId, holderId: holderA, requesterId: holderA,
                configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
                generation: '5'.repeat(64), targetIds: [stackId],
                actions: [{ stage: 'runtime-stop', targetId: stackId, validForMs: 30_000 }], expectedCoordinationRevision: 0,
            } })
            if (reserved.kind !== 'complete') throw new Error(JSON.stringify(reserved))
            const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
            if (attempted.kind !== 'complete') throw new Error(JSON.stringify(attempted))
            const inspected = await inspectDestructiveDrainRecovery({ namespace: state, stackId, holderId: holderA, purpose: 'down' })
            if (inspected.kind !== 'repairable') throw new Error(JSON.stringify(inspected))
            const marker = mutation === 'foreign attempt' ? inspected.fence.markerPath.replace(attempted.attempt.attemptId, '0'.repeat(64))
                : mutation === 'unknown name' ? join(dirname(inspected.fence.markerPath), 'unknown.executor.json') : inspected.fence.markerPath
            const outside = join(state.cockpitRoot, 'synthetic-marker')
            if (mutation === 'symlink' || mutation === 'linked') {
                await writeFile(outside, '{}', { mode: 0o600 })
                await (mutation === 'symlink' ? symlink(outside, marker) : link(outside, marker))
            } else await writeFile(marker, mutation === 'oversized' ? Buffer.alloc(SERIALIZED_RECORD_BYTE_LIMIT + 1) : '{}', { mode: 0o600 })
            if (mutation === 'writable') await chmod(marker, 0o666)
            if (mutation === 'orphaned') await rm(state.paths.coordination(stackId).path)
            if (mutation === 'stale') {
                const cleared = await transactState(state, state.paths.coordination(stackId), { ownerId: holderA }, current => {
                    const value = decodeCoordinationRecord(current, stackId)
                    if (!value) throw new Error('expected coordinated drain')
                    return coordinationStateRecord(state, stackId, current, new Date().toISOString(), { ...value, drain: null })
                })
                if (cleared.kind !== 'complete') throw new Error(JSON.stringify(cleared))
            }
            for (const inventory of [await readActiveStackInventory(state), await readRootPortInventory(state)]) {
                expect(inventory).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
            }
        },
    )

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
            await expect(readActiveStackInventory(state, {
                observeHolder: async (holder) => holder.ownerId === holderA && holder.pid === process.pid ? 'live' : 'unknown',
            })).resolves.toMatchObject({
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
        })}\n`, async () => 'dead' as const],
    ])('does not treat an abandoned %s lock as a live publication', async (_label, owner, observeHolder) => {
        const state = await namespace()
        const directory = dirname(state.paths.coordination(stackId).path)
        await mkdir(directory, { recursive: true })
        const residue = join(directory, `.${stackId.replace(':', '_')}.12345678-1234-4123-8123-123456789abc.tmp`)
        await writeFile(residue, 'unverified bytes')
        await mkdir(state.paths.stateLock, { recursive: true })
        if (owner !== undefined) await writeFile(join(state.paths.stateLock, 'owner.json'), owner)

        await expect(readActiveStackInventory(state, { observeHolder })).resolves.toMatchObject({
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
        })}\n`)
        let inspectionReached!: () => void
        let continueInspection!: () => void
        const reached = new Promise<void>((resolve) => { inspectionReached = resolve })
        const continuation = new Promise<void>((resolve) => { continueInspection = resolve })

        const reading = readActiveStackInventory(state, {
            observeHolder: async () => {
                inspectionReached()
                await continuation
                return 'unknown'
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
})

describe('session-aware claims', () => {
    it('keeps a settled runtime outcome reusable through reduction until finalization', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'reset' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId, 'volume:data'].sort(), actions: drainActions(stackId, ['volume:data']),
            expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const candidate = inspectDrainAttemptAuthority(attempted.authority)
        if (!candidate) throw new Error('expected drain attempt candidate')
        expect(openRuntimeDrainExecution({ authority: attempted.authority, candidate, extra: true,
        } as never)).toBeUndefined()
        expect(openRuntimeDrainExecution({ authority: attempted.authority, candidate,
            planningRecord: {} as never, continuation: Object.freeze({}),
        } as never)).toBeUndefined()
        const execution = openRuntimeDrainExecution({ authority: attempted.authority, candidate })
        if (!execution) throw new Error('expected drain execution authority')
        expect(Object.isFrozen(execution)).toBe(true)
        expect(settleRuntimeDrainSuccess({ authority: { ...execution } as never, fact: stoppedFact(attempted.reservation),
        })).toBeUndefined()
        expect(settleRuntimeDrainSuccess({ authority: execution, fact: { ...stoppedFact(attempted.reservation), extra: true } as never,
        })).toBeUndefined()
        const outcome = settleRuntimeDrainSuccess({ authority: execution, fact: stoppedFact(attempted.reservation) })
        if (!outcome) throw new Error('expected drain outcome authority')
        expect(Object.isFrozen(outcome)).toBe(true)
        expect(outcome).not.toBe(execution)
        expect(settleRuntimeDrainSuccess({ authority: execution, fact: stoppedFact(attempted.reservation) })).toBeUndefined()
        const record = await readState(state.paths.coordination(stackId))
        if (record.kind !== 'complete') throw new Error('expected active attempt record')
        expect(reduceDrainOutcome({ authority: { ...outcome } as never, record: record.value })).toBeUndefined()
        expect(reduceDrainOutcome({ authority: outcome, record: record.value, extra: true } as never)).toBeUndefined()
        const reduced = reduceDrainOutcome({ authority: outcome, record: record.value })
        expect(reduced).toMatchObject({ drain: { completedActionCount: 1, attempt: null } })
        expect(reduceDrainOutcome({ authority: outcome, record: record.value })).toEqual(reduced)
        if (!reduced) throw new Error('expected reduced drain outcome')
        const otherCockpitId = `cockpit:coordination-a1:${'9'.repeat(64)}` as CockpitId
        const otherHome = await mkdtemp(join(tmpdir(), 'cockpit-claims-other-'))
        roots.push(otherHome)
        const otherNamespace = await selectStateRoot({ platform: 'linux', home: otherHome, cockpitId: otherCockpitId })
        if (otherNamespace.kind !== 'complete') throw new Error('expected other namespace')
        const copiedToOtherCockpit = { ...record.value, cockpitId: otherCockpitId }
        expect(reduceDrainOutcome({ authority: outcome, record: copiedToOtherCockpit })).toEqual(reduced)
        expect(await prepareDrainOutcomePublication({
            authority: outcome, namespace: otherNamespace.value, stackId,
        })).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED },
        ] })
        const otherRoot = await namespace()
        expect(await prepareDrainOutcomePublication({
            authority: outcome, namespace: otherRoot, stackId,
        })).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED },
        ] })
        let suppliedClockReads = 0
        expect(await prepareDrainOutcomePublication({
            authority: outcome, namespace: state, stackId,
            get updatedAt() { suppliedClockReads += 1; return new Date().toISOString() },
        } as never)).toMatchObject({ kind: 'refusal' })
        expect(suppliedClockReads).toBe(0)
        expect(reduceDrainOutcome({ authority: outcome, record: record.value })).toEqual(reduced)
        const address = state.paths.coordination(stackId)
        const refused = await transactState(state, address, { ownerId: holderA }, () => record.value)
        if (!('kind' in refused)) throw new Error('expected refused publication')
        expect(refused).toMatchObject({ kind: 'refusal' })
        expect(finalizeDrainOutcome({ authority: outcome, publication: refused, address })).toBe(false)
        expect(reduceDrainOutcome({ authority: outcome, record: record.value })).toEqual(reduced)
        const otherStack = `stack:${'c'.repeat(64)}` as StackId
        const otherAddress = state.paths.coordination(otherStack)
        let otherPublication
        for (let revision = 0; revision <= record.value.revision + 1; revision += 1) {
            otherPublication = await transactState(state, otherAddress, { ownerId: holderA }, (current) =>
                coordinationStateRecord(state, otherStack, current, new Date().toISOString(), reduced))
        }
        if (!otherPublication || !('kind' in otherPublication)) throw new Error('expected other publication')
        expect(finalizeDrainOutcome({ authority: outcome, publication: otherPublication, address: otherAddress })).toBe(false)
        expect(reduceDrainOutcome({ authority: outcome, record: record.value })).toEqual(reduced)
        const beforeHostileOwner = await readFile(address.path)
        expect(await prepareDrainOutcomePublication({
            authority: outcome, namespace: state, stackId, ownerId: holderB,
        } as never)).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED },
        ] })
        expect(await readFile(address.path)).toEqual(beforeHostileOwner)
        const sync = await interceptDirectorySync(dirname(address.path), () => {
            throw new Error('injected directory sync failure')
        })
        let committed
        try {
            committed = await prepareDrainOutcomePublication({ authority: outcome, namespace: state, stackId })
        } finally {
            sync.restore()
        }
        if ('diagnostics' in committed || committed.kind !== 'indeterminate') throw new Error('expected indeterminate publication')
        expect(committed).toMatchObject({ kind: 'indeterminate' })
        expect(finalizeDrainOutcome({ authority: outcome, publication: { ...committed }, address })).toBe(false)
        let publicationReads = 0
        const accessor = { authority: outcome, address,
            get publication() { publicationReads += 1; return committed },
        }
        expect(finalizeDrainOutcome(accessor as never)).toBe(false)
        expect(publicationReads).toBe(0)
        expect(reduceDrainOutcome({ authority: outcome, record: record.value })).toEqual(reduced)
        expect(finalizeDrainOutcome({ authority: outcome, publication: committed, address })).toBe(true)
        expect(await readState(address)).toMatchObject({ kind: 'complete', value: { revision: record.value.revision + 1 } })
        expect(reduceDrainOutcome({ authority: outcome, record: record.value })).toBeUndefined()
        expect(finalizeDrainOutcome({ authority: outcome, publication: committed, address })).toBe(false)
        expect(await recoverDrainReservation({ namespace: state, request })).toMatchObject({ kind: 'complete' })
    })

    it('refuses caller-controlled directory sync behavior without consuming outcome authority', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const outcome = settleRuntimeDrainSuccess({
            authority: drainExecution(attempted), fact: stoppedFact(attempted.reservation),
        })
        if (!outcome) throw new Error('expected runtime outcome')
        const address = state.paths.coordination(stackId)
        const active = await readState(address)
        if (active.kind !== 'complete') throw new Error('expected active drain')
        const reduced = reduceDrainOutcome({ authority: outcome, record: active.value })
        if (!reduced) throw new Error('expected reduced outcome')
        const before = await readFile(address.path)
        expect(await prepareDrainOutcomePublication({
            authority: outcome, namespace: state, stackId,
            beforeDirectorySync: async () => undefined,
        } as never)).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED },
        ] })
        expect(await readFile(address.path)).toEqual(before)
        let reads = 0
        expect(await prepareDrainOutcomePublication({
            authority: outcome, namespace: state, stackId,
            get beforeDirectorySync() { reads += 1; return async () => undefined },
        } as never)).toMatchObject({ kind: 'refusal' })
        expect(reads).toBe(0)
        expect(reduceDrainOutcome({ authority: outcome, record: active.value })).toEqual(reduced)
        const publication = await prepareDrainOutcomePublication({ authority: outcome, namespace: state, stackId })
        expect(publication).toMatchObject({ kind: 'complete' })
    })

    it.each(['complete', 'indeterminate'] as const)(
        'retains outcome authority after a %s publication predating its evidence', async (kind) => {
        vi.useFakeTimers()
        vi.setSystemTime('2026-09-07T12:00:00.000Z')
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'reset' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId, 'volume:data'].sort(),
            actions: drainActions(stackId, ['volume:data']), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const outcome = settleRuntimeDrainSuccess({
            authority: drainExecution(attempted), fact: stoppedFact(attempted.reservation),
        })
        if (!outcome) throw new Error('expected runtime outcome')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active drain')
        const reduced = reduceDrainOutcome({ authority: outcome, record: active.value })
        if (!reduced) throw new Error('expected reduced outcome')
        const address = state.paths.coordination(stackId)
        vi.setSystemTime(Date.parse(attempted.attempt.committedAt) - 1)
        const sync = kind === 'indeterminate'
            ? await interceptDirectorySync(dirname(address.path), () => {
                throw new Error('injected directory sync failure')
            })
            : undefined
        const before = await readFile(address.path)
        const refused = await prepareDrainOutcomePublication({ authority: outcome, namespace: state, stackId })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED },
        ] })
        expect(await readFile(address.path)).toEqual(before)
        vi.setSystemTime(attempted.attempt.committedAt)
        expect(reduceDrainOutcome({ authority: outcome, record: active.value })).toEqual(reduced)
        let retry
        try {
            retry = await prepareDrainOutcomePublication({ authority: outcome, namespace: state, stackId })
        } finally {
            sync?.restore()
        }
        if ('diagnostics' in retry) throw new Error('expected repair publication')
        expect(retry.kind).toBe(kind)
        expect(finalizeDrainOutcome({ authority: outcome, publication: retry, address })).toBe(true)
        expect(await recoverDrainReservation({ namespace: state, request })).toMatchObject({ kind: 'complete' })
        },
    )

    it('vetoes a clock rollback at the publication boundary without consuming outcome authority', async () => {
        vi.useFakeTimers()
        vi.setSystemTime('2026-09-07T12:00:00.000Z')
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const outcome = settleRuntimeDrainSuccess({
            authority: drainExecution(attempted), fact: stoppedFact(attempted.reservation),
        })
        if (!outcome) throw new Error('expected runtime outcome')
        const address = state.paths.coordination(stackId)
        const active = await readState(address)
        if (active.kind !== 'complete') throw new Error('expected active drain')
        const reduced = reduceDrainOutcome({ authority: outcome, record: active.value })
        if (!reduced) throw new Error('expected drain outcome reduction')
        const before = await readFile(address.path)
        const refused = await prepareDrainOutcomePublication({
            authority: outcome, namespace: state, stackId,
            beforePublish: async () => { vi.setSystemTime(Date.parse(attempted.attempt.committedAt) - 1) },
        })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED },
        ] })
        expect(await readFile(address.path)).toEqual(before)
        vi.setSystemTime(attempted.attempt.committedAt)
        expect(reduceDrainOutcome({ authority: outcome, record: active.value })).toEqual(reduced)
        const committed = await prepareDrainOutcomePublication({
            authority: outcome, namespace: state, stackId,
        })
        if ('diagnostics' in committed || committed.kind !== 'complete') throw new Error('expected drain outcome commit')
        expect(finalizeDrainOutcome({ authority: outcome, publication: committed, address })).toBe(true)
        expect(await readState(address)).toMatchObject({ kind: 'complete', value: { value: { drain: null } } })
    })

    it.each(['complete', 'indeterminate'] as const)(
        'aborts a regressive failed outcome before a %s retry publishes and recovers', async (kind) => {
        vi.useFakeTimers()
        vi.setSystemTime('2026-09-07T12:00:00.000Z')
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active drain')
        vi.setSystemTime(Date.parse(attempted.attempt.validThrough) + 1)
        const failedAt = new Date().toISOString()
        const outcome = settleRuntimeDrainFailure({
            authority: drainExecution(attempted), fact: { ...attempted.attempt, failedAt },
        })
        if (!outcome) throw new Error('expected failed runtime outcome')
        const reduced = reduceDrainOutcome({ authority: outcome, record: active.value })
        if (!reduced) throw new Error('expected failed outcome reduction')
        const address = state.paths.coordination(stackId)
        const before = await readFile(address.path)
        vi.setSystemTime(Date.parse(attempted.attempt.committedAt) - 1)
        const refused = await prepareDrainOutcomePublication({ authority: outcome, namespace: state, stackId })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED },
        ] })
        expect(await readFile(address.path)).toEqual(before)
        vi.setSystemTime(failedAt)
        const sync = kind === 'indeterminate'
            ? await interceptDirectorySync(dirname(address.path), () => {
                throw new Error('injected directory sync failure')
            })
            : undefined
        let publication
        try {
            publication = await prepareDrainOutcomePublication({ authority: outcome, namespace: state, stackId })
        } finally {
            sync?.restore()
        }
        if ('diagnostics' in publication) throw new Error('expected failed outcome publication')
        expect(publication.kind).toBe(kind)
        expect(finalizeDrainOutcome({ authority: outcome, publication, address })).toBe(true)
        expect(await readState(address)).toMatchObject({ kind: 'complete', value: {
            revision: attempted.attempt.committedRevision + 1,
            value: { drain: { attempt: {
                committedRevision: attempted.attempt.committedRevision,
                failedRevision: attempted.attempt.committedRevision + 1,
            } } },
        } })
        expect(await recoverDrainReservation({ namespace: state, request })).toMatchObject({ kind: 'complete' })
        },
    )

    it('retains failure matching until an exact reclaim retry replaces it with progress', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'reset' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId, 'volume:first', 'volume:second'].sort(),
            actions: drainActions(stackId, ['volume:first', 'volume:second']), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const runtimeAttempt = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (runtimeAttempt.kind !== 'complete') throw new Error('expected runtime attempt')
        const runtimeRecord = await readState(state.paths.coordination(stackId))
        if (runtimeRecord.kind !== 'complete') throw new Error('expected runtime record')
        const runtimeSuccess = settleRuntimeDrainSuccess({ authority: drainExecution(runtimeAttempt), fact: stoppedFact(runtimeAttempt.reservation),
        })
        if (!runtimeSuccess) throw new Error('expected runtime success')
        const runtimeProgress = reduceDrainOutcome({ record: runtimeRecord.value, authority: runtimeSuccess })
        if (!runtimeProgress) throw new Error('expected runtime progress')
        const planningCommit = await transactState(
            state, state.paths.coordination(stackId), { ownerId: holderA },
            (current) => coordinationStateRecord(state, stackId, current, new Date().toISOString(), runtimeProgress),
        )
        if (planningCommit.kind !== 'complete') throw new Error('expected reclaim planning record')
        const recovered = await recoverDrainReservation({ namespace: state, request })
        if (recovered.kind !== 'complete') throw new Error('expected drain recovery')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: recovered.authority })
        if (attempted.kind !== 'complete') throw new Error('expected reclaim attempt')
        const candidate = inspectDrainAttemptAuthority(attempted.authority)
        if (!candidate) throw new Error('expected reclaim candidate')
        const continuation = Object.freeze({})
        const execution = openReclaimDrainExecution({ authority: attempted.authority, candidate,
            planningRecord: planningCommit.value, continuation,
        })
        if (!execution) throw new Error('expected reclaim execution authority')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active reclaim record')
        expect(matchReclaimDrainContinuation({ continuation, record: active.value,
        })).toBe('unmatched')
        expect(matchReclaimDrainContinuation({ continuation, record: active.value, extra: true,
        } as never)).toBe('unmatched')
        const failedAt = new Date().toISOString()
        const outcome = settleReclaimDrainFailure({ authority: execution, fact: { ...attempted.attempt, failedAt },
        })
        if (!outcome) throw new Error('expected reclaim failure outcome')
        const failed = reduceDrainOutcome({ authority: outcome, record: active.value })
        if (!failed || typeof failed === 'boolean' || typeof failed === 'string') throw new Error('expected failed drain state')
        const failedRecord = coordinationStateRecord(state, stackId, active.value, failedAt, failed)
        expect(matchReclaimDrainContinuation({ continuation, record: failedRecord })).toBe('failed')
        expect(matchReclaimDrainContinuation({ continuation, record: failedRecord })).toBe('failed')
        const failedCommit = await prepareDrainOutcomePublication({
            authority: outcome, namespace: state, stackId,
        })
        if (failedCommit.kind !== 'complete') throw new Error('expected failed reclaim commit')
        expect(finalizeDrainOutcome({ authority: outcome, publication: failedCommit,
            address: state.paths.coordination(stackId) })).toBe(true)
        const retryReservation = await recoverDrainReservation({ namespace: state, request })
        if (retryReservation.kind !== 'complete') throw new Error('expected retry reservation')
        const retry = await reserveDrainAttempt({ namespace: state, authority: retryReservation.authority })
        if (retry.kind !== 'complete') throw new Error('expected reclaim retry')
        const retryCandidate = inspectDrainAttemptAuthority(retry.authority)
        if (!retryCandidate) throw new Error('expected retry candidate')
        expect(openRuntimeDrainExecution({ authority: retry.authority, candidate: retryCandidate,
        })).toBeUndefined()
        expect(matchReclaimDrainContinuation({ continuation, record: failedRecord })).toBe('failed')
        const retryExecution = openReclaimDrainExecution({ authority: retry.authority, candidate: retryCandidate,
            planningRecord: failedCommit.value, continuation,
        })
        if (!retryExecution) throw new Error('expected retry execution authority')
        expect(matchReclaimDrainContinuation({ continuation, record: failedRecord })).toBe('unmatched')
        const retryActive = await readState(state.paths.coordination(stackId))
        if (retryActive.kind !== 'complete') throw new Error('expected retry record')
        expect(settleReclaimDrainSuccess({ authority: retryExecution, fact: stoppedFact(retry.reservation) as never,
        })).toBeUndefined()
        const retryOutcome = settleReclaimDrainSuccess({ authority: retryExecution,
            fact: { ...stoppedFact(retry.reservation), remainingTargetIds: ['volume:second'] },
        })
        if (!retryOutcome) throw new Error('expected retry success outcome')
        const progressed = reduceDrainOutcome({ authority: retryOutcome, record: retryActive.value })
        if (!progressed || typeof progressed === 'boolean' || typeof progressed === 'string') throw new Error('expected progressed drain state')
        const progressedRecord = coordinationStateRecord(state, stackId, retryActive.value, new Date().toISOString(), progressed)
        expect(matchReclaimDrainContinuation({ continuation, record: progressedRecord })).toBe('progressed')
    })

    it('routes a final settled success through complete drain reduction', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const candidate = inspectDrainAttemptAuthority(attempted.authority)
        if (!candidate) throw new Error('expected drain attempt candidate')
        const execution = openRuntimeDrainExecution({ authority: attempted.authority, candidate })
        if (!execution) throw new Error('expected drain execution authority')
        const outcome = settleRuntimeDrainSuccess({ authority: execution, fact: stoppedFact(attempted.reservation) })
        if (!outcome) throw new Error('expected drain outcome authority')
        const record = await readState(state.paths.coordination(stackId))
        if (record.kind !== 'complete') throw new Error('expected active attempt record')
        expect(reduceDrainOutcome({ authority: outcome, record: record.value }))
            .toMatchObject({ holders: [], lease: { released: true }, drain: null })
    })
    it('deeply freezes reclaim commitments in issued and parsed drain snapshots', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const actions = drainActions(stackId, ['volume:data'])
        const request = {
            purpose: 'reset' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId, 'volume:data'].sort(), actions,
            expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const issuedAction = reserved.authority.reservation.actions[1]
        if (issuedAction?.stage !== 'reclaim') throw new Error('expected issued reclaim action')
        const originalBody = issuedAction.targetCommitment.body
        expect(Object.isFrozen(issuedAction.targetCommitment)).toBe(true)
        expect(Reflect.set(issuedAction.targetCommitment, 'body', '{"targetId":"volume:changed"}')).toBe(false)
        expect(issuedAction.targetCommitment.body).toBe(originalBody)

        const stored = await readState(state.paths.coordination(stackId))
        if (stored.kind !== 'complete') throw new Error('expected persisted drain')
        const decoded = decodeCoordinationRecord(stored.value, stackId)
        if (!decoded?.drain) throw new Error('expected parsed drain')
        const parsedAction = decoded.drain.actions[1]
        if (parsedAction?.stage !== 'reclaim') throw new Error('expected parsed reclaim action')
        expect(Object.isFrozen(parsedAction.targetCommitment)).toBe(true)
        expect(Reflect.set(parsedAction.targetCommitment, 'body', '{"targetId":"volume:changed"}')).toBe(false)
        expect(parsedAction.targetCommitment.body).toBe(originalBody)
        expect(reserved.authority.reservation.actions).toEqual(decoded.drain?.actions)
    })

    it('persists an exact drain and never remints while its consumed execution path remains live', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId),
            expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        expect(reserved).toMatchObject({ kind: 'complete', reservation: { ...request, coordinationRevision: 1 } })
        if (reserved.kind !== 'complete') return
        expect(reserved.reservation.reservationId).toMatch(/^[a-f0-9]{64}$/)
        expect(reserved.reservation.reservedAt).toMatch(/\.\d{3}Z$/)
        expect(await joinStack(state, '2026-09-07T12:00:01.000Z'))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        expect(await releaseClaim({ namespace: state, stackId, requesterId: holderA, holderId: holderA, now: '2026-09-07T12:00:01.000Z' }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        expect(await recoverDrainReservation({ namespace: state, request })).toMatchObject({ kind: 'refusal' })
        expect(consumeDrainReservationAuthority({ ...reserved.authority } as never)).toBeUndefined()
        expect(consumeDrainReservationAuthority(reserved.authority)).toEqual(reserved.reservation)
        expect(consumeDrainReservationAuthority(reserved.authority)).toBeUndefined()
        expect(await recoverDrainReservation({ namespace: state, request }))
            .toMatchObject({ kind: 'refusal' })
        expect(await recoverDrainReservation({ namespace: state, request: { ...request, planDigest: '5'.repeat(64) } }))
            .toMatchObject({ kind: 'refusal' })
        expect(await recoverDrainReservation({ namespace: state, request: { ...request, generation: '6'.repeat(64) } }))
            .toMatchObject({ kind: 'refusal' })
        expect(await recoverDrainReservation({ namespace: state, request: { ...request, targetIds: ['stack:other'] } }))
            .toMatchObject({ kind: 'refusal' })
    })

    it('CAS-commits one exact attempt and retries only its persisted failed target', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'reset' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId, 'volume:data'].sort(), actions: drainActions(stackId, ['volume:data']),
            expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const reservedRecord = await readState(state.paths.coordination(stackId))
        if (reservedRecord.kind !== 'complete') throw new Error('expected reserved record')
        const first = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        expect(first).toMatchObject({ kind: 'complete', attempt: {
            purpose: 'reset', targetIds: request.targetIds, generation: request.generation,
            actionIndex: 0, currentTarget: stackId, currentStage: 'runtime-stop', status: 'active', committedRevision: 2,
        } })
        if (first.kind !== 'complete') return
        expect(first.attempt.attemptId).toMatch(/^[a-f0-9]{64}$/)
        expect(await recoverDrainReservation({ namespace: state, request })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }],
        })
        expect(await reserveDrainAttempt({ namespace: state, authority: reserved.authority })).toMatchObject({ kind: 'refusal' })

        expect(inspectDrainAttemptAuthority({ ...first.authority } as never)).toBeUndefined()
        const execution = drainExecution(first)
        expect(inspectDrainAttemptAuthority(first.authority)).toBeUndefined()
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active attempt')
        vi.useFakeTimers()
        vi.setSystemTime(Date.parse(first.attempt.validThrough) + 1)
        const failedAt = new Date().toISOString()
        expect(settleReclaimDrainFailure({
            authority: execution as never, fact: { ...first.attempt, failedAt },
        })).toBeUndefined()
        const failureAuthority = settleRuntimeDrainFailure({ authority: execution, fact: { ...first.attempt, failedAt },
        })
        if (!failureAuthority) throw new Error('expected failed outcome authority')
        const failedValue = reduceDrainOutcome({ record: active.value, authority: failureAuthority })
        expect(reduceDrainOutcome({ record: active.value, authority: failureAuthority })).toEqual(failedValue)
        expect(failedValue).toMatchObject({ drain: { attempt: { status: 'failed', failedRevision: 3, failedAt } } })
        if (!failedValue) return
        const committed = await prepareDrainOutcomePublication({
            authority: failureAuthority, namespace: state, stackId,
        })
        expect(committed).toMatchObject({ kind: 'complete', value: { revision: 3 } })
        if ('diagnostics' in committed) throw new Error('expected failed outcome publication')
        expect(finalizeDrainOutcome({ authority: failureAuthority, publication: committed,
            address: state.paths.coordination(stackId) })).toBe(true)
        expect(finalizeDrainOutcome({ authority: failureAuthority, publication: committed,
            address: state.paths.coordination(stackId) })).toBe(false)
        const recovered = await recoverDrainReservation({ namespace: state, request })
        expect(recovered).toMatchObject({ kind: 'complete', reservation: {
            reservationId: first.reservation.reservationId, generation: request.generation,
            targetIds: request.targetIds, attempt: { status: 'failed', currentTarget: stackId },
        } })
        if (recovered.kind !== 'complete') return
        expect(await reserveDrainAttempt({ namespace: state, authority: { ...recovered.authority } as never })).toMatchObject({ kind: 'refusal' })
        const retry = await reserveDrainAttempt({ namespace: state, authority: recovered.authority })
        expect(retry).toMatchObject({ kind: 'complete', reservation: {
            reservationId: first.reservation.reservationId, generation: request.generation,
            targetIds: request.targetIds,
        }, attempt: { status: 'active', committedRevision: 4, currentTarget: stackId } })
        if (retry.kind === 'complete') {
            expect(retry.attempt.attemptId).not.toBe(first.attempt.attemptId)
            const failedRecord = committed.kind === 'complete' ? committed.value : undefined
            if (!failedRecord) throw new Error('expected failed record')
            const retryRecord = await readState(state.paths.coordination(stackId))
            if (retryRecord.kind !== 'complete') throw new Error('expected persisted retry record')
            expect(decodeCoordinationRecord(retryRecord.value, stackId))
                .toMatchObject({ drain: { attempt: { attemptId: retry.attempt.attemptId } } })
        }
    })

    it('preserves a reservation when the clock rolls back before its first attempt', async () => {
        vi.useFakeTimers()
        vi.setSystemTime('2026-09-07T12:00:00.000Z')
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const address = state.paths.coordination(stackId)
        const before = await readFile(address.path)

        vi.setSystemTime('2026-09-07T11:59:59.999Z')
        expect(await reserveDrainAttempt({ namespace: state, authority: reserved.authority })).toMatchObject({ kind: 'refusal' })
        expect(await readFile(address.path)).toEqual(before)
        expect(await readState(address)).toMatchObject({ kind: 'complete', value: { revision: 1 } })
    })

    it('preserves a failed attempt when the clock rolls back before retry', async () => {
        vi.useFakeTimers()
        vi.setSystemTime('2026-09-07T12:00:00.000Z')
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected drain attempt')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active attempt')
        vi.setSystemTime(Date.parse(attempted.attempt.validThrough) + 1)
        const failedAt = new Date().toISOString()
        const failure = settleRuntimeDrainFailure({
            authority: drainExecution(attempted), fact: { ...attempted.attempt, failedAt },
        })
        if (!failure) throw new Error('expected failed outcome authority')
        const failed = reduceDrainOutcome({ record: active.value, authority: failure })
        if (!failed) throw new Error('expected failed drain state')
        const committed = await prepareDrainOutcomePublication({
            authority: failure, namespace: state, stackId,
        })
        if (committed.kind !== 'complete') throw new Error('expected failed attempt commit')
        expect(finalizeDrainOutcome({ authority: failure, publication: committed,
            address: state.paths.coordination(stackId) })).toBe(true)
        const recovered = await recoverDrainReservation({ namespace: state, request })
        if (recovered.kind !== 'complete') throw new Error('expected failed drain recovery')
        const address = state.paths.coordination(stackId)
        const before = await readFile(address.path)

        vi.setSystemTime(Date.parse(failedAt) - 1)
        expect(await reserveDrainAttempt({ namespace: state, authority: recovered.authority })).toMatchObject({ kind: 'refusal' })
        expect(await readFile(address.path)).toEqual(before)
        expect(await readState(address)).toMatchObject({ kind: 'complete', value: { revision: committed.value.revision } })
    })

    it('rejects impossible persisted drains and bounds the completion fact shape', async () => {
        const state = await namespace()
        const request = {
            purpose: 'reset' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId, 'volume:a'].sort(), actions: drainActions(stackId, ['volume:a']),
            expectedCoordinationRevision: 0,
        }
        const base = claimRecord([
            { holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' },
            { holderId: holderB, checkoutId: checkoutB, claimedAt: '2026-09-07T11:59:00.000Z' },
        ])
        const impossible: StateRecord = { ...base, revision: 1, value: { ...(base.value as object), drain: {
            ...request, coordinationRevision: 1, reservedAt: new Date().toISOString(), reservationId: '7'.repeat(64),
        } } }
        await transactState(state, state.paths.coordination(stackId), { ownerId: holderA }, () => impossible)
        expect(await recoverDrainReservation({ namespace: state, request })).toMatchObject({ kind: 'refusal' })

        const isolated = await namespace()
        await seedCoordination(isolated, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const reserved = await reserveDrain({ namespace: isolated, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const attempted = await reserveDrainAttempt({ namespace: isolated, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected drain attempt')
        const stored = await readState(isolated.paths.coordination(stackId))
        if (stored.kind !== 'complete') throw new Error('expected coordination record')
        const fact = stoppedFact(attempted.reservation)
        const execution = drainExecution(attempted)
        expect(settleRuntimeDrainSuccess({ authority: execution, fact: { ...fact, extra: true } as never })).toBeUndefined()
        expect(settleRuntimeDrainSuccess({ authority: execution,
            fact: { ...fact, validThrough: new Date(Date.now() - 1).toISOString() },
        })).toBeUndefined()
        const success = settleRuntimeDrainSuccess({ authority: execution, fact })
        if (!success) throw new Error('expected success authority')
        expect(reduceDrainOutcome({ record: stored.value, authority: { ...success } as never })).toBeUndefined()
        expect(reduceDrainOutcome({ record: stored.value, authority: success }))
            .toMatchObject({ drain: { completedActionCount: 1, progressRevision: 3, attempt: null } })
        expect(await reserveDrain({ namespace: isolated, request: {
            ...request, targetIds: [stackId, 'é'.repeat(257)].sort(), actions: drainActions(stackId, ['é'.repeat(257)]),
        } })).toMatchObject({ kind: 'refusal' })
    })

    it('keeps a reservation authority bound to its issuing state root', async () => {
        const state = await namespace()
        const otherRoot = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        await seedCoordination(otherRoot, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const issued = await readState(state.paths.coordination(stackId))
        if (issued.kind !== 'complete') throw new Error('expected issued reservation record')
        const issuedValue = decodeCoordinationRecord(issued.value, stackId)
        if (!issuedValue) throw new Error('expected issued reservation value')
        const copied = await transactState(
            otherRoot, otherRoot.paths.coordination(stackId), { ownerId: holderA },
            (current) => coordinationStateRecord(
                otherRoot, stackId, current, issued.value.updatedAt,
                issuedValue,
            ),
        )
        if (copied.kind !== 'complete') throw new Error('expected copied reservation record')
        const before = await readFile(otherRoot.paths.coordination(stackId).path)
        expect(await reserveDrainAttempt({ namespace: otherRoot, authority: reserved.authority })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }],
        })
        expect(await readFile(otherRoot.paths.coordination(stackId).path)).toEqual(before)
        expect(await reserveDrainAttempt({ namespace: state, authority: reserved.authority })).toMatchObject({ kind: 'complete' })
    })

    it('refuses co-tenant, mismatched-owner, stale-revision, and repeated drain reservations without changing bytes', async () => {
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId),
            expectedCoordinationRevision: 0,
        }
        const shared = await namespace()
        await seedCoordination(shared, [
            { holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' },
            { holderId: holderB, checkoutId: checkoutB, claimedAt: '2026-09-07T11:59:00.000Z' },
        ])
        const sharedBefore = await readFile(shared.paths.coordination(stackId).path)
        expect(await reserveDrain({ namespace: shared, request })).toMatchObject({ kind: 'refusal' })
        expect(await readFile(shared.paths.coordination(stackId).path)).toEqual(sharedBefore)

        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        expect(await reserveDrain({ namespace: state, request: { ...request, requesterId: holderB } })).toMatchObject({ kind: 'refusal' })
        expect(await reserveDrain({ namespace: state, request: { ...request, expectedCoordinationRevision: 1 } })).toMatchObject({ kind: 'refusal' })
        expect(await reserveDrain({ namespace: state, request: { ...request, targetIds: ['é'.repeat(257)] } })).toMatchObject({ kind: 'refusal' })
        expect(await reserveDrain({ namespace: state, request: { ...request,
            actions: [{ stage: 'reclaim', targetId: stackId, validForMs: 30_000 }] as never } })).toMatchObject({ kind: 'refusal' })
        const committed = drainActions(stackId, ['volume:data'])[1]
        if (committed?.stage !== 'reclaim') throw new Error('reclaim commitment fixture unavailable')
        expect(await reserveDrain({ namespace: state, request: { ...request,
            actions: [{ stage: 'runtime-stop', targetId: stackId, validForMs: 30_000,
                targetCommitment: committed.targetCommitment }] as never } })).toMatchObject({ kind: 'refusal' })
        expect(await reserveDrain({ namespace: state, request: { ...request,
            targetIds: [stackId, 'volume:data'].sort(), actions: [
                drainActions(stackId)[0]!,
                { ...committed, targetCommitment: { ...committed.targetCommitment, sha256: '0'.repeat(64) } },
            ] } })).toMatchObject({ kind: 'refusal' })
        for (const body of [
            '{ "targetId":"volume:data"}',
            '{"targetId":"volume:data","scope":"synthetic"}',
            '{"targetId":"volume:data","targetId":"volume:data"}',
        ]) {
            expect(await reserveDrain({ namespace: state, request: { ...request,
                targetIds: [stackId, 'volume:data'].sort(), actions: [drainActions(stackId)[0]!, {
                    ...committed, targetCommitment: { ...committed.targetCommitment,
                        body, sha256: createHash('sha256').update(body).digest('hex') },
                }] } })).toMatchObject({ kind: 'refusal' })
        }
        expect(await reserveDrain({ namespace: state, request: { ...request,
            actions: [{ stage: 'runtime-stop', targetId: stackId, validForMs: 300_001 }] } })).toMatchObject({ kind: 'refusal' })
        const accessorAction = {}
        Object.defineProperty(accessorAction, 'stage', { enumerable: true, get: () => 'runtime-stop' })
        Object.defineProperties(accessorAction, {
            targetId: { enumerable: true, value: stackId }, validForMs: { enumerable: true, value: 30_000 },
        })
        expect(await reserveDrain({ namespace: state, request: { ...request, actions: [accessorAction as never] } }))
            .toMatchObject({ kind: 'refusal' })
        const reserved = await reserveDrain({ namespace: state, request })
        expect(reserved.kind).toBe('complete')
        const reservedBytes = await readFile(state.paths.coordination(stackId).path)
        expect(await reserveDrain({ namespace: state, request: { ...request, expectedCoordinationRevision: 1 } })).toMatchObject({ kind: 'refusal' })
        expect(await readFile(state.paths.coordination(stackId).path)).toEqual(reservedBytes)
    })

    it('refuses an ordinary final release and reduces only the exact purpose evidence matrix', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        expect(await releaseClaim({ namespace: state, stackId, requesterId: holderA, holderId: holderA, now: '2026-09-07T12:00:01.000Z' }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        const request = {
            purpose: 'reset' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId, 'volume:synthetic'].sort(), actions: drainActions(stackId, ['volume:synthetic']),
            expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (attempted.kind !== 'complete') throw new Error('expected drain attempt')
        const stored = await readState(state.paths.coordination(stackId))
        if (stored.kind !== 'complete') throw new Error('expected coordination record')
        const fact = stoppedFact(attempted.reservation)
        const success = settleRuntimeDrainSuccess({ authority: drainExecution(attempted), fact })
        if (!success) throw new Error('expected runtime success authority')
        const progressed = reduceDrainOutcome({ record: stored.value, authority: success })
        expect(progressed).toMatchObject({ drain: { completedActionCount: 1, progressRevision: 3, attempt: null } })
        if (!progressed) return
        expect(await recoverDrainReservation({ namespace: state, request })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }],
        })
        const progressCommit = await prepareDrainOutcomePublication({
            authority: success, namespace: state, stackId,
        })
        expect(progressCommit).toMatchObject({ kind: 'complete', value: { revision: 3 } })
        if (progressCommit.kind !== 'complete') throw new Error('expected progress commit')
        expect(finalizeDrainOutcome({ authority: success, publication: progressCommit,
            address: state.paths.coordination(stackId) })).toBe(true)
        expect(await reserveDrainAttempt({ namespace: state, authority: reserved.authority })).toMatchObject({ kind: 'refusal' })
        const recovered = await recoverDrainReservation({ namespace: state, request })
        if (recovered.kind !== 'complete') throw new Error('expected progressed drain recovery')
        const reclaimAttempt = await reserveDrainAttempt({ namespace: state, authority: recovered.authority })
        if (reclaimAttempt.kind !== 'complete') throw new Error('expected reclaim attempt')
        expect(reclaimAttempt.attempt).toMatchObject({ actionIndex: 1, currentStage: 'reclaim', currentTarget: 'volume:synthetic' })
        const current = await readState(state.paths.coordination(stackId))
        if (current.kind !== 'complete') throw new Error('expected reclaim coordination record')
        const reclaimFact = { ...stoppedFact(reclaimAttempt.reservation), remainingTargetIds: [] }
        const reclaimExecution = drainExecution(reclaimAttempt, progressCommit.value)
        expect(settleReclaimDrainSuccess({ authority: reclaimExecution, fact: { ...reclaimFact, purpose: 'down' } as never,
        })).toBeUndefined()
        const reclaimSuccess = settleReclaimDrainSuccess({ authority: reclaimExecution, fact: reclaimFact })
        if (!reclaimSuccess) throw new Error('expected reclaim success authority')
        expect(reduceDrainOutcome({ record: current.value, authority: reclaimSuccess }))
            .toMatchObject({ holders: [], lease: { released: true }, drain: null })
    })

    it('authenticates the exact coordination record expected after reclaim progress', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const reclaimTargets = ['volume:first', 'volume:second']
        const request = {
            purpose: 'reset' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId, ...reclaimTargets].sort(), actions: drainActions(stackId, reclaimTargets),
            expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const runtimeAttempt = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (runtimeAttempt.kind !== 'complete') throw new Error('expected runtime attempt')
        const runtimeRecord = await readState(state.paths.coordination(stackId))
        if (runtimeRecord.kind !== 'complete') throw new Error('expected runtime record')
        const runtimeSuccess = settleRuntimeDrainSuccess({ authority: drainExecution(runtimeAttempt), fact: stoppedFact(runtimeAttempt.reservation),
        })
        if (!runtimeSuccess) throw new Error('expected runtime success')
        const runtimeProgress = reduceDrainOutcome({ record: runtimeRecord.value, authority: runtimeSuccess })
        if (!runtimeProgress) throw new Error('expected runtime progress')
        const planningCommit = await transactState(
            state, state.paths.coordination(stackId), { ownerId: holderA },
            (current) => coordinationStateRecord(state, stackId, current, new Date().toISOString(), runtimeProgress),
        )
        if (planningCommit.kind !== 'complete') throw new Error('expected planning predecessor')
        const recovered = await recoverDrainReservation({ namespace: state, request })
        if (recovered.kind !== 'complete') throw new Error('expected drain recovery')
        const reclaimAttempt = await reserveDrainAttempt({ namespace: state, authority: recovered.authority })
        if (reclaimAttempt.kind !== 'complete') throw new Error('expected reclaim attempt')
        const candidate = inspectDrainAttemptAuthority(reclaimAttempt.authority)
        const continuation = Object.freeze({})
        const execution = candidate && openReclaimDrainExecution({ authority: reclaimAttempt.authority, candidate,
            planningRecord: planningCommit.value, continuation,
        })
        if (!execution) throw new Error('expected reclaim execution authority')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active reclaim record')
        const success = settleReclaimDrainSuccess({ authority: execution, fact: {
            ...stoppedFact(reclaimAttempt.reservation), remainingTargetIds: ['volume:second'],
        } })
        if (!success) throw new Error('expected reclaim success')
        const progressed = reduceDrainOutcome({ record: active.value, authority: success })
        if (!progressed) throw new Error('expected reclaim progress')
        const expected = coordinationStateRecord(state, stackId, active.value, new Date().toISOString(), progressed)
        const expectedValue = decodeCoordinationRecord(expected, stackId)
        if (!expectedValue?.lease) throw new Error('expected coordinated lease')
        expect(matchReclaimDrainContinuation({ continuation, record: expected })).toBe('progressed')
        expect(matchReclaimDrainContinuation({ continuation: { ...continuation }, record: expected })).toBe('unmatched')
        expect(matchReclaimDrainContinuation({ continuation: {}, record: expected })).toBe('unmatched')
        const changedLease = coordinationStateRecord(state, stackId, active.value, expected.updatedAt, {
            ...expectedValue,
            lease: { ...expectedValue.lease, offset: 1, ports: { WEB: 3100 } },
        })
        expect(matchReclaimDrainContinuation({ continuation, record: changedLease })).toBe('unmatched')
    })

    it('authenticates persisted reclaim failure before reminting the same action', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'reset' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId, 'volume:first', 'volume:second'].sort(),
            actions: drainActions(stackId, ['volume:first', 'volume:second']),
            expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const runtimeAttempt = await reserveDrainAttempt({ namespace: state, authority: reserved.authority })
        if (runtimeAttempt.kind !== 'complete') throw new Error('expected runtime attempt')
        const runtimeRecord = await readState(state.paths.coordination(stackId))
        if (runtimeRecord.kind !== 'complete') throw new Error('expected runtime record')
        const runtimeSuccess = settleRuntimeDrainSuccess({ authority: drainExecution(runtimeAttempt), fact: stoppedFact(runtimeAttempt.reservation),
        })
        if (!runtimeSuccess) throw new Error('expected runtime success')
        const runtimeProgress = reduceDrainOutcome({ record: runtimeRecord.value, authority: runtimeSuccess })
        if (!runtimeProgress) throw new Error('expected runtime progress')
        const planningCommit = await transactState(
            state, state.paths.coordination(stackId), { ownerId: holderA },
            (current) => coordinationStateRecord(state, stackId, current, new Date().toISOString(), runtimeProgress),
        )
        if (planningCommit.kind !== 'complete') throw new Error('expected planning predecessor')
        const recovered = await recoverDrainReservation({ namespace: state, request })
        if (recovered.kind !== 'complete') throw new Error('expected drain recovery')
        const reclaimAttempt = await reserveDrainAttempt({ namespace: state, authority: recovered.authority })
        if (reclaimAttempt.kind !== 'complete') throw new Error('expected reclaim attempt')
        const candidate = inspectDrainAttemptAuthority(reclaimAttempt.authority)
        const continuation = Object.freeze({})
        const execution = candidate && openReclaimDrainExecution({ authority: reclaimAttempt.authority, candidate,
            planningRecord: planningCommit.value, continuation,
        })
        if (!execution) throw new Error('expected reclaim execution authority')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active reclaim record')
        const failedAt = new Date().toISOString()
        const failure = settleReclaimDrainFailure({ authority: execution, fact: { ...reclaimAttempt.attempt, failedAt },
        })
        if (!failure) throw new Error('expected reclaim failure authority')
        const failedValue = reduceDrainOutcome({ record: active.value, authority: failure })
        if (!failedValue) throw new Error('expected reclaim failure transition')
        const failedRecord = coordinationStateRecord(state, stackId, active.value, failedAt, failedValue)
        expect(matchReclaimDrainContinuation({ continuation, record: failedRecord })).toBe('failed')
        expect(matchReclaimDrainContinuation({ continuation: { ...continuation }, record: failedRecord,
        })).toBe('unmatched')
        expect(matchReclaimDrainContinuation({ continuation: {}, record: failedRecord })).toBe('unmatched')
        const decoded = decodeCoordinationRecord(failedRecord, stackId)
        if (!decoded?.lease) throw new Error('expected coordinated lease')
        const changedLease = coordinationStateRecord(state, stackId, active.value, failedAt, {
            ...decoded, lease: { ...decoded.lease, offset: 1, ports: { WEB: 3100 } },
        })
        expect(matchReclaimDrainContinuation({ continuation, record: changedLease })).toBe('unmatched')
        const committed = await prepareDrainOutcomePublication({
            authority: failure, namespace: state, stackId,
        })
        if (committed.kind !== 'complete') throw new Error('expected failed reclaim commit')
        expect(finalizeDrainOutcome({ authority: failure, publication: committed,
            address: state.paths.coordination(stackId) })).toBe(true)
        expect(matchReclaimDrainContinuation({ continuation, record: committed.value })).toBe('failed')
        const retryReservation = await recoverDrainReservation({ namespace: state, request })
        if (retryReservation.kind !== 'complete') throw new Error('expected failed reclaim recovery')
        const recoveredAction = retryReservation.authority.reservation.actions[1]
        if (recoveredAction?.stage !== 'reclaim') throw new Error('expected recovered reclaim action')
        const recoveredBody = recoveredAction.targetCommitment.body
        expect(Object.isFrozen(recoveredAction.targetCommitment)).toBe(true)
        expect(Reflect.set(recoveredAction.targetCommitment, 'body', '{"targetId":"volume:changed"}')).toBe(false)
        expect(recoveredAction.targetCommitment.body).toBe(recoveredBody)
        expect(inspectFailedReclaimRecovery({ authority: committed.value as never, record: committed.value })).toBeUndefined()
        expect(inspectFailedReclaimRecovery({ authority: { ...retryReservation.authority } as never, record: committed.value })).toBeUndefined()
        const changedRecords = [
            { ...committed.value, revision: committed.value.revision + 1 },
            { ...committed.value, updatedAt: after(committed.value.updatedAt, 1) },
            { ...committed.value, extra: undefined },
            { ...committed.value, extra: 'unexpected' },
            { ...committed.value, value: { ...(committed.value.value as object), drain: null } },
            { ...committed.value, value: { ...(committed.value.value as object), drain: {
                ...retryReservation.reservation, reservationId: '6'.repeat(64),
            } } },
            { ...committed.value, value: { ...(committed.value.value as object), drain: {
                ...retryReservation.reservation, generation: '6'.repeat(64),
            } } },
            { ...committed.value, value: { ...(committed.value.value as object), drain: {
                ...retryReservation.reservation, purpose: 'down',
            } } },
            { ...committed.value, value: { ...(committed.value.value as object), drain: {
                ...retryReservation.reservation, actions: [...retryReservation.reservation.actions].reverse(),
            } } },
            { ...committed.value, value: { ...(committed.value.value as object), drain: {
                ...retryReservation.reservation, completedActionCount: 2,
            } } },
            { ...committed.value, value: { ...(committed.value.value as object), drain: {
                ...retryReservation.reservation, attempt: { ...retryReservation.reservation.attempt!, currentTarget: 'volume:second' },
            } } },
            { ...committed.value, value: { ...(committed.value.value as object), drain: {
                ...retryReservation.reservation, attempt: { ...retryReservation.reservation.attempt!, currentStage: 'runtime-stop' },
            } } },
            { ...committed.value, value: { ...(committed.value.value as object), drain: {
                ...retryReservation.reservation, attempt: { ...retryReservation.reservation.attempt!, failedAt: after(failedAt, 1) },
            } } },
        ] as unknown as StateRecord[]
        for (const record of changedRecords) {
            expect(inspectFailedReclaimRecovery({ authority: retryReservation.authority, record })).toBeUndefined()
        }
        const accessorInput = { authority: retryReservation.authority }
        Object.defineProperty(accessorInput, 'record', { enumerable: true, get: () => committed.value })
        expect(inspectFailedReclaimRecovery(accessorInput as never)).toBeUndefined()
        const accessorRecord = { ...committed.value }
        Object.defineProperty(accessorRecord, 'value', { enumerable: true, get: () => committed.value.value })
        expect(inspectFailedReclaimRecovery({ authority: retryReservation.authority, record: accessorRecord })).toBeUndefined()
        const nonEnumerableRecord = { ...committed.value }
        Object.defineProperty(nonEnumerableRecord, 'extra', { value: undefined })
        expect(inspectFailedReclaimRecovery({ authority: retryReservation.authority, record: nonEnumerableRecord })).toBeUndefined()
        const symbolRecord = Object.assign({ ...committed.value }, { [Symbol('extra')]: undefined })
        expect(inspectFailedReclaimRecovery({ authority: retryReservation.authority, record: symbolRecord })).toBeUndefined()
        expect(inspectFailedReclaimRecovery(Object.assign(
            { authority: retryReservation.authority, record: committed.value }, { [Symbol('extra')]: true },
        ) as never)).toBeUndefined()
        const recovery = inspectFailedReclaimRecovery({ authority: retryReservation.authority, record: committed.value })
        if (!recovery) throw new Error('expected authenticated failed reclaim recovery')
        expect(consumeFailedReclaimRecovery({ ...recovery } as never)).toBeUndefined()
        const projection = consumeFailedReclaimRecovery(recovery)
        const recoveryPurpose: 'down' | 'reset' | undefined = projection?.purpose
        expect(recoveryPurpose).toBe('reset')
        expect(projection).toMatchObject({
            purpose: 'reset', stackId, configSha256: request.configSha256, planDigest: request.planDigest,
            freshAfter: committed.value.updatedAt,
            completed: [], current: { targetId: 'volume:first' }, pending: [{ targetId: 'volume:second' }],
        })
        expect(Object.isFrozen(projection)).toBe(true)
        expect(Object.isFrozen(projection?.current)).toBe(true)
        expect(Object.isFrozen(projection?.current.targetCommitment)).toBe(true)
        expect(consumeFailedReclaimRecovery(recovery)).toBeUndefined()
        const retry = await reserveDrainAttempt({ namespace: state, authority: retryReservation.authority })
        if (retry.kind !== 'complete') throw new Error('expected reclaim retry')
        const retryCandidate = inspectDrainAttemptAuthority(retry.authority)
        const retryExecution = retryCandidate && openReclaimDrainExecution({ authority: retry.authority, candidate: retryCandidate,
            planningRecord: committed.value, continuation: Object.freeze({}),
        })
        if (!retryExecution) throw new Error('expected retry execution authority')
        const retryRecord = await readState(state.paths.coordination(stackId))
        if (retryRecord.kind !== 'complete') throw new Error('expected retry record')
        const firstSuccess = settleReclaimDrainSuccess({ authority: retryExecution, fact: {
            ...stoppedFact(retry.reservation), remainingTargetIds: ['volume:second'],
        } })
        if (!firstSuccess) throw new Error('expected first reclaim success')
        const firstProgress = reduceDrainOutcome({ record: retryRecord.value, authority: firstSuccess })
        if (!firstProgress) throw new Error('expected first reclaim progress')
        const firstProgressCommit = await prepareDrainOutcomePublication({
            authority: firstSuccess, namespace: state, stackId,
        })
        if (firstProgressCommit.kind !== 'complete') throw new Error('expected first reclaim progress commit')
        expect(finalizeDrainOutcome({ authority: firstSuccess, publication: firstProgressCommit,
            address: state.paths.coordination(stackId) })).toBe(true)
        const secondReservation = await recoverDrainReservation({ namespace: state, request })
        if (secondReservation.kind !== 'complete') throw new Error('expected second reclaim recovery')
        const secondAttempt = await reserveDrainAttempt({ namespace: state, authority: secondReservation.authority })
        if (secondAttempt.kind !== 'complete') throw new Error('expected second reclaim attempt')
        const secondCandidate = inspectDrainAttemptAuthority(secondAttempt.authority)
        const secondExecution = secondCandidate && openReclaimDrainExecution({ authority: secondAttempt.authority, candidate: secondCandidate,
            planningRecord: firstProgressCommit.value, continuation: Object.freeze({}),
        })
        if (!secondExecution) throw new Error('expected second reclaim execution authority')
        const secondActive = await readState(state.paths.coordination(stackId))
        if (secondActive.kind !== 'complete') throw new Error('expected second active record')
        const secondFailedAt = new Date().toISOString()
        const secondFailure = settleReclaimDrainFailure({ authority: secondExecution, fact: { ...secondAttempt.attempt, failedAt: secondFailedAt },
        })
        if (!secondFailure) throw new Error('expected second reclaim failure')
        const secondFailedValue = reduceDrainOutcome({ record: secondActive.value, authority: secondFailure })
        if (!secondFailedValue) throw new Error('expected second reclaim failure transition')
        const secondFailedCommit = await prepareDrainOutcomePublication({
            authority: secondFailure, namespace: state, stackId,
        })
        if (secondFailedCommit.kind !== 'complete') throw new Error('expected second reclaim failure commit')
        expect(finalizeDrainOutcome({ authority: secondFailure, publication: secondFailedCommit,
            address: state.paths.coordination(stackId) })).toBe(true)
        const secondRecovery = await recoverDrainReservation({ namespace: state, request })
        if (secondRecovery.kind !== 'complete') throw new Error('expected persisted second reclaim recovery')
        const secondRecoveryAuthority = inspectFailedReclaimRecovery({
            authority: secondRecovery.authority, record: secondFailedCommit.value,
        })
        if (!secondRecoveryAuthority) throw new Error('expected second recovery projection')
        expect(consumeFailedReclaimRecovery(secondRecoveryAuthority)).toMatchObject({
            completed: [{ targetId: 'volume:first' }],
            current: { targetId: 'volume:second' },
            pending: [],
        })
    })
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

    it('releases only the exact non-final holder and requires a drain for the final holder', async () => {
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
