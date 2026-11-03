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
    matchReclaimDrainContinuation,
    reclaimDrainStep,
    reduceDrainOutcome,
    inspectDestructiveDrainRecovery,
    inspectSleepDrainRecovery,
    inspectFailedReclaimRecovery,
    coordinationStateRecord,
    decodeCoordinationRecord,
    observeProcessStart,
    processHost,
    commitDrainOutcome,
    releaseDeadSessionHolders,
    removeExactCoordinationHolder,
    recoverDrainReservation,
    recoverSleepDrainReservation,
    releaseClaim,
    reserveDrainAttempt,
    reserveDrain,
    settleInterruptedDrainRepair,
    readActiveStackInventory,
    readRootPortInventory,
    type ProcessHost,
    type DrainReservationRequest,
    type DrainReservation,
    type DrainAttemptResult,
    type DrainOutcome,
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
            record: expect.objectContaining({ revision: 1 }),
        })
        expect('reservation' in inspected).toBe(false)

        const freshRequest = sleepDrainRequest(persisted)
        const recovered = await recoverSleepDrainReservation({ namespace: state, record: inspected.record, request: freshRequest })
        if (recovered.kind !== 'complete') throw new Error('expected recovered sleep drain')
        expect(recovered.reservation.expectedCoordinationRevision).toBe(0)
        expect(await reserveDrainAttempt({ namespace: state, reservation: recovered.reservation })).toMatchObject({ kind: 'complete' })
        // The attempt moved the record past the one inspected, so the inspection cannot recover it again.
        expect(await recoverSleepDrainReservation({ namespace: state, record: inspected.record, request: freshRequest }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED }] })
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
            await expect(reserveDrainAttempt({ namespace: state, reservation: reserved.reservation }))
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
            record: inspected.record,
            request: { ...request, expectedCoordinationRevision: 1 },
        })
        if (recovered.kind !== 'complete') throw new Error('expected recovered sleep reservation')
        await expect(reserveDrainAttempt({ namespace: state, reservation: recovered.reservation }))
            .resolves.toMatchObject({ kind: 'complete' })
    })

    it('requires fresh planning evidence to name the current coordination revision', async () => {
        const state = await namespace()
        const persisted = await seedPersistedSleepDrain(state)
        const inspected = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        if (inspected.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        const staleRequest = sleepDrainRequest(persisted, { expectedCoordinationRevision: 0 })

        expect(await recoverSleepDrainReservation({ namespace: state, record: inspected.record, request: staleRequest }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED }] })
    })

    it('refuses a malformed namespace or request as malformed input', async () => {
        const state = await namespace()
        const persisted = await seedPersistedSleepDrain(state)
        const request = sleepDrainRequest(persisted)
        const inspected = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        if (inspected.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')

        expect(await recoverSleepDrainReservation({
            namespace: { ...state } as StateNamespace, record: inspected.record, request,
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
        expect(await recoverSleepDrainReservation({
            namespace: state, record: inspected.record, request: { ...request, actions: 'malformed' } as never,
        })).toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }] })
        expect(await recoverSleepDrainReservation({ namespace: state, record: inspected.record, request }))
            .toMatchObject({ kind: 'complete' })
    })

    it('refuses fresh planning evidence whose work differs from the persisted sleep drain', async () => {
        const state = await namespace()
        const persisted = await seedPersistedSleepDrain(state)
        const inspected = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        if (inspected.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        const request = sleepDrainRequest(persisted, { planDigest: '7'.repeat(64) })
        expect(await recoverSleepDrainReservation({ namespace: state, record: inspected.record, request }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
    })

    it('recovers only from the inspected coordination record in its own state root', async () => {
        const state = await namespace()
        const persisted = await seedPersistedSleepDrain(state)
        const request = sleepDrainRequest(persisted)
        const foreign = await namespace()
        const inspected = await inspectSleepDrainRecovery({ namespace: state, stackId, holderId: holderA })
        if (inspected.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        expect(await recoverSleepDrainReservation({ namespace: foreign, record: inspected.record, request }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED }] })

        const changed = await namespace()
        await seedPersistedSleepDrain(changed)
        const changedInspection = await inspectSleepDrainRecovery({ namespace: changed, stackId, holderId: holderA })
        if (changedInspection.kind !== 'recoverable') throw new Error('expected recoverable sleep drain')
        const address = changed.paths.coordination(stackId)
        const before = await readState(address)
        if (before.kind !== 'complete') throw new Error('expected persisted sleep drain')
        await writeFile(address.path, `${JSON.stringify({ ...before.value, updatedAt: '2026-09-07T12:00:02.000Z' })}\n`)
        expect(await recoverSleepDrainReservation({ namespace: changed, record: changedInspection.record, request }))
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
        expect(await recoverSleepDrainReservation({ namespace: state, record: inspected.record, request }))
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
        const attempted = await reserveDrainAttempt({ namespace: active, reservation: reserved.reservation })
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
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
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
        const settled = await settleInterruptedDrainRepair({ namespace: state, record: repairable.record, evidence: termination.evidence })
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
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
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

    it('returns the exact request of an authentic failed reservation and rejects later record drift', async () => {
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
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') throw new Error('expected destructive attempt')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active destructive record')
        vi.setSystemTime(Date.parse(attempted.attempt.validThrough) + 1)
        const failedAt = new Date().toISOString()
        const failure = failedOutcome(attempted, failedAt)
        const reduced = reduceDrainOutcome({ outcome: failure, record: active.value })
        if (!reduced) throw new Error('expected failed destructive reduction')
        const publication = await commitDrainOutcome({ outcome: failure, namespace: state, stackId })
        if ('diagnostics' in publication) throw new Error('expected failed destructive publication')

        const inspected = await inspectDestructiveDrainRecovery({ namespace: state, stackId, holderId: holderA, purpose: 'down' })
        expect(inspected).toEqual({ kind: 'recoverable', request })
        if (inspected.kind !== 'recoverable') throw new Error('expected destructive recovery basis')

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

        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
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

type Attempted = Extract<DrainAttemptResult, { kind: 'complete' }>

function stoppedOutcome(attempted: Attempted, fact: Record<string, unknown> = stoppedFact(attempted.reservation)): DrainOutcome {
    return { kind: 'success', reservation: attempted.reservation, fact: fact as never }
}

function failedOutcome(attempted: Attempted, failedAt: string): DrainOutcome {
    return { kind: 'failure', reservation: attempted.reservation, failedAt }
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
            const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
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
    it('reduces an exact settled outcome against its attempt and publishes it only into its own coordination record', async () => {
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
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const record = await readState(state.paths.coordination(stackId))
        if (record.kind !== 'complete') throw new Error('expected active attempt record')
        expect(reduceDrainOutcome({
            outcome: stoppedOutcome(attempted, { ...stoppedFact(attempted.reservation), extra: true }), record: record.value,
        })).toBeUndefined()
        const outcome = stoppedOutcome(attempted)
        const reduced = reduceDrainOutcome({ outcome, record: record.value })
        expect(reduced).toMatchObject({ drain: { completedActionCount: 1, attempt: null } })
        expect(reduceDrainOutcome({ outcome, record: record.value })).toEqual(reduced)
        if (!reduced) throw new Error('expected reduced drain outcome')
        const otherCockpitId = `cockpit:coordination-a1:${'9'.repeat(64)}` as CockpitId
        const otherHome = await mkdtemp(join(tmpdir(), 'cockpit-claims-other-'))
        roots.push(otherHome)
        const otherNamespace = await selectStateRoot({ platform: 'linux', home: otherHome, cockpitId: otherCockpitId })
        if (otherNamespace.kind !== 'complete') throw new Error('expected other namespace')
        const copiedToOtherCockpit = { ...record.value, cockpitId: otherCockpitId }
        expect(reduceDrainOutcome({ outcome, record: copiedToOtherCockpit })).toEqual(reduced)
        expect(await commitDrainOutcome({
            outcome, namespace: otherNamespace.value, stackId,
        })).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED },
        ] })
        const otherRoot = await namespace()
        expect(await commitDrainOutcome({
            outcome, namespace: otherRoot, stackId,
        })).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED },
        ] })
        expect(reduceDrainOutcome({ outcome, record: record.value })).toEqual(reduced)
        const address = state.paths.coordination(stackId)
        const sync = await interceptDirectorySync(dirname(address.path), () => {
            throw new Error('injected directory sync failure')
        })
        let committed
        try {
            committed = await commitDrainOutcome({ outcome, namespace: state, stackId })
        } finally {
            sync.restore()
        }
        if ('diagnostics' in committed || committed.kind !== 'indeterminate') throw new Error('expected indeterminate publication')
        expect(committed).toMatchObject({ kind: 'indeterminate' })
        expect(reduceDrainOutcome({ outcome, record: record.value })).toEqual(reduced)
        expect(await readState(address)).toMatchObject({ kind: 'complete', value: { revision: record.value.revision + 1 } })
        expect(await recoverDrainReservation({ namespace: state, request })).toMatchObject({ kind: 'complete' })
    })

    it('publishes with its own clock and directory sync whatever the caller supplies', async () => {
        const state = await namespace()
        await seedCoordination(state, [{ holderId: holderA, checkoutId: checkoutA, claimedAt: '2026-09-07T11:59:00.000Z' }])
        const request = {
            purpose: 'down' as const, stackId, holderId: holderA, requesterId: holderA,
            configSha256: '2'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '4'.repeat(64),
            generation: '5'.repeat(64), targetIds: [stackId], actions: drainActions(stackId), expectedCoordinationRevision: 0,
        }
        const reserved = await reserveDrain({ namespace: state, request })
        if (reserved.kind !== 'complete') throw new Error('expected drain reservation')
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const outcome = stoppedOutcome(attempted)
        const address = state.paths.coordination(stackId)
        const active = await readState(address)
        if (active.kind !== 'complete') throw new Error('expected active drain')
        const reduced = reduceDrainOutcome({ outcome, record: active.value })
        if (!reduced) throw new Error('expected reduced outcome')
        const beforeDirectorySync = vi.fn(async () => undefined)
        let suppliedClockReads = 0
        const startedAt = Date.now()
        const publication = await commitDrainOutcome({
            outcome, namespace: state, stackId, beforeDirectorySync,
            get updatedAt() { suppliedClockReads += 1; return '2000-01-01T00:00:00.000Z' },
        } as never)
        expect(publication).toMatchObject({ kind: 'complete', value: { value: reduced } })
        expect(beforeDirectorySync).not.toHaveBeenCalled()
        expect(suppliedClockReads).toBe(0)
        if (publication.kind === 'complete') expect(Date.parse(publication.value.updatedAt)).toBeGreaterThanOrEqual(startedAt)
    })

    it.each(['complete', 'indeterminate'] as const)(
        'refuses a publication predating its evidence and later publishes it as %s', async (kind) => {
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
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const outcome = stoppedOutcome(attempted)
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active drain')
        const reduced = reduceDrainOutcome({ outcome, record: active.value })
        if (!reduced) throw new Error('expected reduced outcome')
        const address = state.paths.coordination(stackId)
        vi.setSystemTime(Date.parse(attempted.attempt.committedAt) - 1)
        const sync = kind === 'indeterminate'
            ? await interceptDirectorySync(dirname(address.path), () => {
                throw new Error('injected directory sync failure')
            })
            : undefined
        const before = await readFile(address.path)
        const refused = await commitDrainOutcome({ outcome, namespace: state, stackId })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED },
        ] })
        expect(await readFile(address.path)).toEqual(before)
        vi.setSystemTime(attempted.attempt.committedAt)
        expect(reduceDrainOutcome({ outcome, record: active.value })).toEqual(reduced)
        let retry
        try {
            retry = await commitDrainOutcome({ outcome, namespace: state, stackId })
        } finally {
            sync?.restore()
        }
        if ('diagnostics' in retry) throw new Error('expected repair publication')
        expect(retry.kind).toBe(kind)
        expect(await recoverDrainReservation({ namespace: state, request })).toMatchObject({ kind: 'complete' })
        },
    )

    it('vetoes a clock rollback at the publication boundary and publishes once the clock recovers', async () => {
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
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const outcome = stoppedOutcome(attempted)
        const address = state.paths.coordination(stackId)
        const active = await readState(address)
        if (active.kind !== 'complete') throw new Error('expected active drain')
        const reduced = reduceDrainOutcome({ outcome, record: active.value })
        if (!reduced) throw new Error('expected drain outcome reduction')
        const before = await readFile(address.path)
        const refused = await commitDrainOutcome({
            outcome, namespace: state, stackId,
            beforePublish: async () => { vi.setSystemTime(Date.parse(attempted.attempt.committedAt) - 1) },
        })
        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED },
        ] })
        expect(await readFile(address.path)).toEqual(before)
        vi.setSystemTime(attempted.attempt.committedAt)
        expect(reduceDrainOutcome({ outcome, record: active.value })).toEqual(reduced)
        const committed = await commitDrainOutcome({
            outcome, namespace: state, stackId,
        })
        if ('diagnostics' in committed || committed.kind !== 'complete') throw new Error('expected drain outcome commit')
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
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active drain')
        vi.setSystemTime(Date.parse(attempted.attempt.validThrough) + 1)
        const failedAt = new Date().toISOString()
        const outcome = failedOutcome(attempted, failedAt)
        const reduced = reduceDrainOutcome({ outcome, record: active.value })
        if (!reduced) throw new Error('expected failed outcome reduction')
        const address = state.paths.coordination(stackId)
        const before = await readFile(address.path)
        vi.setSystemTime(Date.parse(attempted.attempt.committedAt) - 1)
        const refused = await commitDrainOutcome({ outcome, namespace: state, stackId })
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
            publication = await commitDrainOutcome({ outcome, namespace: state, stackId })
        } finally {
            sync?.restore()
        }
        if ('diagnostics' in publication) throw new Error('expected failed outcome publication')
        expect(publication.kind).toBe(kind)
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

    it('matches each reclaim try to the failure or progress its own outcome published', async () => {
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
        const runtimeAttempt = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (runtimeAttempt.kind !== 'complete') throw new Error('expected runtime attempt')
        const runtimeRecord = await readState(state.paths.coordination(stackId))
        if (runtimeRecord.kind !== 'complete') throw new Error('expected runtime record')
        const runtimeProgress = reduceDrainOutcome({ record: runtimeRecord.value, outcome: stoppedOutcome(runtimeAttempt) })
        if (!runtimeProgress) throw new Error('expected runtime progress')
        const planningCommit = await transactState(
            state, state.paths.coordination(stackId), { ownerId: holderA },
            (current) => coordinationStateRecord(state, stackId, current, new Date().toISOString(), runtimeProgress),
        )
        if (planningCommit.kind !== 'complete') throw new Error('expected reclaim planning record')
        const recovered = await recoverDrainReservation({ namespace: state, request })
        if (recovered.kind !== 'complete') throw new Error('expected drain recovery')
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: recovered.reservation })
        if (attempted.kind !== 'complete') throw new Error('expected reclaim attempt')
        expect(reclaimDrainStep({ planningRecord: planningCommit.value, reservation: runtimeAttempt.reservation })).toBeUndefined()
        const step = reclaimDrainStep({ planningRecord: planningCommit.value, reservation: attempted.reservation })
        if (!step) throw new Error('expected reclaim step')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active reclaim record')
        expect(matchReclaimDrainContinuation({ continuation: step, record: active.value })).toBe('unmatched')
        const failedAt = new Date().toISOString()
        const failed = reduceDrainOutcome({ outcome: failedOutcome(attempted, failedAt), record: active.value })
        if (!failed) throw new Error('expected failed drain state')
        const failedRecord = coordinationStateRecord(state, stackId, active.value, failedAt, failed)
        const failedStep = { ...step, failedAt }
        expect(matchReclaimDrainContinuation({ continuation: failedStep, record: failedRecord })).toBe('failed')
        expect(matchReclaimDrainContinuation({ continuation: step, record: failedRecord })).toBe('unmatched')
        const failedCommit = await commitDrainOutcome({
            outcome: failedOutcome(attempted, failedAt), namespace: state, stackId,
        })
        if (failedCommit.kind !== 'complete') throw new Error('expected failed reclaim commit')
        const retryReservation = await recoverDrainReservation({ namespace: state, request })
        if (retryReservation.kind !== 'complete') throw new Error('expected retry reservation')
        const retry = await reserveDrainAttempt({ namespace: state, reservation: retryReservation.reservation })
        if (retry.kind !== 'complete') throw new Error('expected reclaim retry')
        // A retry is planned from the published failure, never from the record that planned the first try.
        expect(reclaimDrainStep({ planningRecord: planningCommit.value, reservation: retry.reservation })).toBeUndefined()
        const retryStep = reclaimDrainStep({ planningRecord: failedCommit.value, reservation: retry.reservation })
        if (!retryStep) throw new Error('expected retry step')
        expect(matchReclaimDrainContinuation({ continuation: retryStep, record: failedRecord })).toBe('unmatched')
        const retryActive = await readState(state.paths.coordination(stackId))
        if (retryActive.kind !== 'complete') throw new Error('expected retry record')
        expect(reduceDrainOutcome({ outcome: stoppedOutcome(retry), record: retryActive.value })).toBeUndefined()
        const progressed = reduceDrainOutcome({
            outcome: stoppedOutcome(retry, { ...stoppedFact(retry.reservation), remainingTargetIds: ['volume:second'] }),
            record: retryActive.value,
        })
        if (!progressed) throw new Error('expected progressed drain state')
        const progressedRecord = coordinationStateRecord(state, stackId, retryActive.value, new Date().toISOString(), progressed)
        expect(matchReclaimDrainContinuation({ continuation: retryStep, record: progressedRecord })).toBe('progressed')
        expect(matchReclaimDrainContinuation({ continuation: null, record: progressedRecord })).toBe('unmatched')
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
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') throw new Error('expected runtime attempt')
        const outcome = stoppedOutcome(attempted)
        const record = await readState(state.paths.coordination(stackId))
        if (record.kind !== 'complete') throw new Error('expected active attempt record')
        expect(reduceDrainOutcome({ outcome, record: record.value }))
            .toMatchObject({ holders: [], lease: { released: true }, drain: null })
    })
    it('parses persisted reclaim commitments back to the issued drain actions', async () => {
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

        const stored = await readState(state.paths.coordination(stackId))
        if (stored.kind !== 'complete') throw new Error('expected persisted drain')
        const decoded = decodeCoordinationRecord(stored.value, stackId)
        if (!decoded?.drain) throw new Error('expected parsed drain')
        expect(decoded.drain.actions[1]?.stage).toBe('reclaim')
        expect(reserved.reservation.actions).toEqual(decoded.drain?.actions)
    })

    it('persists an exact drain and lets only one holder of it start an attempt', async () => {
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
        const recovered = await recoverDrainReservation({ namespace: state, request })
        if (recovered.kind !== 'complete') throw new Error('expected recovered reservation')
        expect(recovered.reservation).toEqual(reserved.reservation)
        expect(await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })).toMatchObject({ kind: 'complete' })
        const before = await readFile(state.paths.coordination(stackId).path)
        expect(await reserveDrainAttempt({ namespace: state, reservation: recovered.reservation }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.CLAIM_CO_TENANT }] })
        expect(await readFile(state.paths.coordination(stackId).path)).toEqual(before)
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
        const first = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        expect(first).toMatchObject({ kind: 'complete', attempt: {
            purpose: 'reset', targetIds: request.targetIds, generation: request.generation,
            actionIndex: 0, currentTarget: stackId, currentStage: 'runtime-stop', status: 'active', committedRevision: 2,
        } })
        if (first.kind !== 'complete') return
        expect(first.attempt.attemptId).toMatch(/^[a-f0-9]{64}$/)
        expect(await recoverDrainReservation({ namespace: state, request })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }],
        })
        expect(await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })).toMatchObject({ kind: 'refusal' })

        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active attempt')
        vi.useFakeTimers()
        vi.setSystemTime(Date.parse(first.attempt.validThrough) + 1)
        const failedAt = new Date().toISOString()
        const failure = failedOutcome(first, failedAt)
        const failedValue = reduceDrainOutcome({ record: active.value, outcome: failure })
        expect(reduceDrainOutcome({ record: active.value, outcome: failure })).toEqual(failedValue)
        expect(failedValue).toMatchObject({ drain: { attempt: { status: 'failed', failedRevision: 3, failedAt } } })
        if (!failedValue) return
        const committed = await commitDrainOutcome({
            outcome: failure, namespace: state, stackId,
        })
        expect(committed).toMatchObject({ kind: 'complete', value: { revision: 3 } })
        if ('diagnostics' in committed) throw new Error('expected failed outcome publication')
        // The outcome reduces only against the record it settled from, so it cannot be published twice.
        expect(await commitDrainOutcome({ outcome: failure, namespace: state, stackId }))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED }] })
        const recovered = await recoverDrainReservation({ namespace: state, request })
        expect(recovered).toMatchObject({ kind: 'complete', reservation: {
            reservationId: first.reservation.reservationId, generation: request.generation,
            targetIds: request.targetIds, attempt: { status: 'failed', currentTarget: stackId },
        } })
        if (recovered.kind !== 'complete') return
        const retry = await reserveDrainAttempt({ namespace: state, reservation: recovered.reservation })
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
        expect(await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })).toMatchObject({ kind: 'refusal' })
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
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') throw new Error('expected drain attempt')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active attempt')
        vi.setSystemTime(Date.parse(attempted.attempt.validThrough) + 1)
        const failedAt = new Date().toISOString()
        const failure = failedOutcome(attempted, failedAt)
        const failed = reduceDrainOutcome({ record: active.value, outcome: failure })
        if (!failed) throw new Error('expected failed drain state')
        const committed = await commitDrainOutcome({
            outcome: failure, namespace: state, stackId,
        })
        if (committed.kind !== 'complete') throw new Error('expected failed attempt commit')
        const recovered = await recoverDrainReservation({ namespace: state, request })
        if (recovered.kind !== 'complete') throw new Error('expected failed drain recovery')
        const address = state.paths.coordination(stackId)
        const before = await readFile(address.path)

        vi.setSystemTime(Date.parse(failedAt) - 1)
        expect(await reserveDrainAttempt({ namespace: state, reservation: recovered.reservation })).toMatchObject({ kind: 'refusal' })
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
        const attempted = await reserveDrainAttempt({ namespace: isolated, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') throw new Error('expected drain attempt')
        const stored = await readState(isolated.paths.coordination(stackId))
        if (stored.kind !== 'complete') throw new Error('expected coordination record')
        const fact = stoppedFact(attempted.reservation)
        expect(reduceDrainOutcome({ record: stored.value, outcome: stoppedOutcome(attempted, { ...fact, extra: true }) })).toBeUndefined()
        expect(reduceDrainOutcome({ record: stored.value,
            outcome: stoppedOutcome(attempted, { ...fact, validThrough: new Date(Date.now() - 1).toISOString() }),
        })).toBeUndefined()
        expect(reduceDrainOutcome({ record: stored.value, outcome: stoppedOutcome(attempted, fact) }))
            .toMatchObject({ drain: { completedActionCount: 1, progressRevision: 3, attempt: null } })
        expect(await reserveDrain({ namespace: isolated, request: {
            ...request, targetIds: [stackId, 'é'.repeat(257)].sort(), actions: drainActions(stackId, ['é'.repeat(257)]),
        } })).toMatchObject({ kind: 'refusal' })
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
        const attempted = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') throw new Error('expected drain attempt')
        const stored = await readState(state.paths.coordination(stackId))
        if (stored.kind !== 'complete') throw new Error('expected coordination record')
        const fact = stoppedFact(attempted.reservation)
        const success = stoppedOutcome(attempted, fact)
        const progressed = reduceDrainOutcome({ record: stored.value, outcome: success })
        expect(progressed).toMatchObject({ drain: { completedActionCount: 1, progressRevision: 3, attempt: null } })
        if (!progressed) return
        expect(await recoverDrainReservation({ namespace: state, request })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED }],
        })
        const progressCommit = await commitDrainOutcome({
            outcome: success, namespace: state, stackId,
        })
        expect(progressCommit).toMatchObject({ kind: 'complete', value: { revision: 3 } })
        if (progressCommit.kind !== 'complete') throw new Error('expected progress commit')
        expect(await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })).toMatchObject({ kind: 'refusal' })
        const recovered = await recoverDrainReservation({ namespace: state, request })
        if (recovered.kind !== 'complete') throw new Error('expected progressed drain recovery')
        const reclaimAttempt = await reserveDrainAttempt({ namespace: state, reservation: recovered.reservation })
        if (reclaimAttempt.kind !== 'complete') throw new Error('expected reclaim attempt')
        expect(reclaimAttempt.attempt).toMatchObject({ actionIndex: 1, currentStage: 'reclaim', currentTarget: 'volume:synthetic' })
        const current = await readState(state.paths.coordination(stackId))
        if (current.kind !== 'complete') throw new Error('expected reclaim coordination record')
        const reclaimFact = { ...stoppedFact(reclaimAttempt.reservation), remainingTargetIds: [] }
        expect(reduceDrainOutcome({ record: current.value, outcome: stoppedOutcome(reclaimAttempt, { ...reclaimFact, purpose: 'down' }) }))
            .toBeUndefined()
        const reclaimSuccess = stoppedOutcome(reclaimAttempt, reclaimFact)
        expect(reduceDrainOutcome({ record: current.value, outcome: reclaimSuccess }))
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
        const runtimeAttempt = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (runtimeAttempt.kind !== 'complete') throw new Error('expected runtime attempt')
        const runtimeRecord = await readState(state.paths.coordination(stackId))
        if (runtimeRecord.kind !== 'complete') throw new Error('expected runtime record')
        const runtimeSuccess = stoppedOutcome(runtimeAttempt)
        const runtimeProgress = reduceDrainOutcome({ record: runtimeRecord.value, outcome: runtimeSuccess })
        if (!runtimeProgress) throw new Error('expected runtime progress')
        const planningCommit = await transactState(
            state, state.paths.coordination(stackId), { ownerId: holderA },
            (current) => coordinationStateRecord(state, stackId, current, new Date().toISOString(), runtimeProgress),
        )
        if (planningCommit.kind !== 'complete') throw new Error('expected planning predecessor')
        const recovered = await recoverDrainReservation({ namespace: state, request })
        if (recovered.kind !== 'complete') throw new Error('expected drain recovery')
        const reclaimAttempt = await reserveDrainAttempt({ namespace: state, reservation: recovered.reservation })
        if (reclaimAttempt.kind !== 'complete') throw new Error('expected reclaim attempt')
        const continuation = reclaimDrainStep({ planningRecord: planningCommit.value, reservation: reclaimAttempt.reservation })
        if (!continuation) throw new Error('expected reclaim step')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active reclaim record')
        const success = stoppedOutcome(reclaimAttempt, {
            ...stoppedFact(reclaimAttempt.reservation), remainingTargetIds: ['volume:second'],
        })
        const progressed = reduceDrainOutcome({ record: active.value, outcome: success })
        if (!progressed) throw new Error('expected reclaim progress')
        const expected = coordinationStateRecord(state, stackId, active.value, new Date().toISOString(), progressed)
        const expectedValue = decodeCoordinationRecord(expected, stackId)
        if (!expectedValue?.lease) throw new Error('expected coordinated lease')
        expect(matchReclaimDrainContinuation({ continuation, record: expected })).toBe('progressed')
        expect(matchReclaimDrainContinuation({ continuation: null, record: expected })).toBe('unmatched')
        const changedLease = coordinationStateRecord(state, stackId, active.value, expected.updatedAt, {
            ...expectedValue,
            lease: { ...expectedValue.lease, offset: 1, ports: { WEB: 3100 } },
        })
        expect(matchReclaimDrainContinuation({ continuation, record: changedLease })).toBe('unmatched')
    })

    it('recovers a failed reclaim action only from the exact record that published its failure', async () => {
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
        const runtimeAttempt = await reserveDrainAttempt({ namespace: state, reservation: reserved.reservation })
        if (runtimeAttempt.kind !== 'complete') throw new Error('expected runtime attempt')
        const runtimeRecord = await readState(state.paths.coordination(stackId))
        if (runtimeRecord.kind !== 'complete') throw new Error('expected runtime record')
        const runtimeSuccess = stoppedOutcome(runtimeAttempt)
        const runtimeProgress = reduceDrainOutcome({ record: runtimeRecord.value, outcome: runtimeSuccess })
        if (!runtimeProgress) throw new Error('expected runtime progress')
        const planningCommit = await transactState(
            state, state.paths.coordination(stackId), { ownerId: holderA },
            (current) => coordinationStateRecord(state, stackId, current, new Date().toISOString(), runtimeProgress),
        )
        if (planningCommit.kind !== 'complete') throw new Error('expected planning predecessor')
        const recovered = await recoverDrainReservation({ namespace: state, request })
        if (recovered.kind !== 'complete') throw new Error('expected drain recovery')
        const reclaimAttempt = await reserveDrainAttempt({ namespace: state, reservation: recovered.reservation })
        if (reclaimAttempt.kind !== 'complete') throw new Error('expected reclaim attempt')
        const step = reclaimDrainStep({ planningRecord: planningCommit.value, reservation: reclaimAttempt.reservation })
        if (!step) throw new Error('expected reclaim step')
        const active = await readState(state.paths.coordination(stackId))
        if (active.kind !== 'complete') throw new Error('expected active reclaim record')
        const failedAt = new Date().toISOString()
        const continuation = { ...step, failedAt }
        const failure = failedOutcome(reclaimAttempt, failedAt)
        const failedValue = reduceDrainOutcome({ record: active.value, outcome: failure })
        if (!failedValue) throw new Error('expected reclaim failure transition')
        const failedRecord = coordinationStateRecord(state, stackId, active.value, failedAt, failedValue)
        expect(matchReclaimDrainContinuation({ continuation, record: failedRecord })).toBe('failed')
        expect(matchReclaimDrainContinuation({ continuation: step, record: failedRecord })).toBe('unmatched')
        const decoded = decodeCoordinationRecord(failedRecord, stackId)
        if (!decoded?.lease) throw new Error('expected coordinated lease')
        const changedLease = coordinationStateRecord(state, stackId, active.value, failedAt, {
            ...decoded, lease: { ...decoded.lease, offset: 1, ports: { WEB: 3100 } },
        })
        expect(matchReclaimDrainContinuation({ continuation, record: changedLease })).toBe('unmatched')
        const committed = await commitDrainOutcome({
            outcome: failure, namespace: state, stackId,
        })
        if (committed.kind !== 'complete') throw new Error('expected failed reclaim commit')
        expect(matchReclaimDrainContinuation({ continuation, record: committed.value })).toBe('failed')
        const retryReservation = await recoverDrainReservation({ namespace: state, request })
        if (retryReservation.kind !== 'complete') throw new Error('expected failed reclaim recovery')
        const recoveredAction = retryReservation.reservation.actions[1]
        if (recoveredAction?.stage !== 'reclaim') throw new Error('expected recovered reclaim action')
        const changedRecords = [
            { ...committed.value, revision: committed.value.revision + 1 },
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
            expect(inspectFailedReclaimRecovery({ reservation: retryReservation.reservation, record })).toBeUndefined()
        }
        const accessorRecord = { ...committed.value }
        Object.defineProperty(accessorRecord, 'value', { enumerable: true, get: () => committed.value.value })
        expect(inspectFailedReclaimRecovery({ reservation: retryReservation.reservation, record: accessorRecord })).toBeUndefined()
        const nonEnumerableRecord = { ...committed.value }
        Object.defineProperty(nonEnumerableRecord, 'extra', { value: undefined })
        expect(inspectFailedReclaimRecovery({ reservation: retryReservation.reservation, record: nonEnumerableRecord })).toBeUndefined()
        const symbolRecord = Object.assign({ ...committed.value }, { [Symbol('extra')]: undefined })
        expect(inspectFailedReclaimRecovery({ reservation: retryReservation.reservation, record: symbolRecord })).toBeUndefined()
        const projection = inspectFailedReclaimRecovery({ reservation: retryReservation.reservation, record: committed.value })
        const recoveryPurpose: 'down' | 'reset' | undefined = projection?.purpose
        expect(recoveryPurpose).toBe('reset')
        expect(projection).toMatchObject({
            purpose: 'reset', stackId, configSha256: request.configSha256, planDigest: request.planDigest,
            freshAfter: committed.value.updatedAt,
            completed: [], current: { targetId: 'volume:first' }, pending: [{ targetId: 'volume:second' }],
        })
        const retry = await reserveDrainAttempt({ namespace: state, reservation: retryReservation.reservation })
        if (retry.kind !== 'complete') throw new Error('expected reclaim retry')
        expect(reclaimDrainStep({ planningRecord: committed.value, reservation: retry.reservation })).toBeDefined()
        const retryRecord = await readState(state.paths.coordination(stackId))
        if (retryRecord.kind !== 'complete') throw new Error('expected retry record')
        const firstSuccess = stoppedOutcome(retry, { ...stoppedFact(retry.reservation), remainingTargetIds: ['volume:second'] })
        const firstProgress = reduceDrainOutcome({ record: retryRecord.value, outcome: firstSuccess })
        if (!firstProgress) throw new Error('expected first reclaim progress')
        const firstProgressCommit = await commitDrainOutcome({
            outcome: firstSuccess, namespace: state, stackId,
        })
        if (firstProgressCommit.kind !== 'complete') throw new Error('expected first reclaim progress commit')
        const secondReservation = await recoverDrainReservation({ namespace: state, request })
        if (secondReservation.kind !== 'complete') throw new Error('expected second reclaim recovery')
        const secondAttempt = await reserveDrainAttempt({ namespace: state, reservation: secondReservation.reservation })
        if (secondAttempt.kind !== 'complete') throw new Error('expected second reclaim attempt')
        expect(reclaimDrainStep({ planningRecord: firstProgressCommit.value, reservation: secondAttempt.reservation })).toBeDefined()
        const secondActive = await readState(state.paths.coordination(stackId))
        if (secondActive.kind !== 'complete') throw new Error('expected second active record')
        const secondFailedAt = new Date().toISOString()
        const secondFailure = failedOutcome(secondAttempt, secondFailedAt)
        const secondFailedValue = reduceDrainOutcome({ record: secondActive.value, outcome: secondFailure })
        if (!secondFailedValue) throw new Error('expected second reclaim failure transition')
        const secondFailedCommit = await commitDrainOutcome({
            outcome: secondFailure, namespace: state, stackId,
        })
        if (secondFailedCommit.kind !== 'complete') throw new Error('expected second reclaim failure commit')
        const secondRecovery = await recoverDrainReservation({ namespace: state, request })
        if (secondRecovery.kind !== 'complete') throw new Error('expected persisted second reclaim recovery')
        expect(inspectFailedReclaimRecovery({
            reservation: secondRecovery.reservation, record: secondFailedCommit.value,
        })).toMatchObject({
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
