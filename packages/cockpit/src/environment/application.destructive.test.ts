import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cockpitCommand } from '../fix-catalogue.js'
const executionFence = (id: string) => {
    const attemptId = createHash('sha256').update(`${process.pid}:${id}`).digest('hex')
    const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
    return { attemptId, markerPath: join(tmpdir(), `cockpit-test-${attemptId}.json`), socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`) }
}
const applicationOwners = vi.hoisted(() => ({
    lifecycle: {} as Partial<Pick<typeof import('./lifecycle.js'), 'consumeLifecycleIssuance' | 'planDown' | 'planResetLifecycle'>>,
    runtime: {} as Partial<Pick<typeof import('./runtime.js'), 'stopRuntime'>>,
    claims: {} as Partial<Pick<typeof import('./claims.js'), 'discardDrainReservationAuthority' | 'finalizeDrainOutcome' | 'prepareDrainOutcomePublication' | 'recoverDrainReservation' | 'reserveDrain' | 'reserveDrainAttempt'>>,
    reclaim: {} as Partial<Pick<typeof import('./reclaim.js'), 'consumeReclaimCompleted' | 'keptTeardownResources' | 'planReset' | 'planTeardown' | 'projectRecoveredResetActionTargets' | 'projectResetActionTargets' | 'projectTeardownActionTargets' | 'reconcileReclaimAction' | 'redeemReclaimAction'>>,
}))
vi.mock('./lifecycle.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./lifecycle.js')>()
    return {
        ...actual,
        consumeLifecycleIssuance: (...args: Parameters<typeof actual.consumeLifecycleIssuance>) => applicationOwners.lifecycle.consumeLifecycleIssuance?.(...args) ?? actual.consumeLifecycleIssuance(...args),
        planDown: (...args: Parameters<typeof actual.planDown>) => applicationOwners.lifecycle.planDown?.(...args) ?? actual.planDown(...args),
        planResetLifecycle: (...args: Parameters<typeof actual.planResetLifecycle>) => applicationOwners.lifecycle.planResetLifecycle?.(...args) ?? actual.planResetLifecycle(...args),
    }
})
vi.mock('./runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./runtime.js')>()
    return {
        ...actual,
        stopRuntime: (...args: Parameters<typeof actual.stopRuntime>) => applicationOwners.runtime.stopRuntime?.(...args) ?? actual.stopRuntime(...args),
    }
})
vi.mock('./claims.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./claims.js')>()
    return {
        ...actual,
        discardDrainReservationAuthority: (...args: Parameters<typeof actual.discardDrainReservationAuthority>) => applicationOwners.claims.discardDrainReservationAuthority?.(...args) ?? actual.discardDrainReservationAuthority(...args),
        finalizeDrainOutcome: (...args: Parameters<typeof actual.finalizeDrainOutcome>) => applicationOwners.claims.finalizeDrainOutcome?.(...args) ?? actual.finalizeDrainOutcome(...args),
        prepareDrainOutcomePublication: (...args: Parameters<typeof actual.prepareDrainOutcomePublication>) => applicationOwners.claims.prepareDrainOutcomePublication?.(...args) ?? actual.prepareDrainOutcomePublication(...args),
        recoverDrainReservation: (...args: Parameters<typeof actual.recoverDrainReservation>) => applicationOwners.claims.recoverDrainReservation?.(...args) ?? actual.recoverDrainReservation(...args),
        reserveDrain: (...args: Parameters<typeof actual.reserveDrain>) => applicationOwners.claims.reserveDrain?.(...args) ?? actual.reserveDrain(...args),
        reserveDrainAttempt: (...args: Parameters<typeof actual.reserveDrainAttempt>) => applicationOwners.claims.reserveDrainAttempt?.(...args) ?? actual.reserveDrainAttempt(...args),
    }
})
vi.mock('./reclaim.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./reclaim.js')>()
    return {
        ...actual,
        consumeReclaimCompleted: (...args: Parameters<typeof actual.consumeReclaimCompleted>) => applicationOwners.reclaim.consumeReclaimCompleted?.(...args) ?? actual.consumeReclaimCompleted(...args),
        keptTeardownResources: (...args: Parameters<typeof actual.keptTeardownResources>) => applicationOwners.reclaim.keptTeardownResources?.(...args) ?? actual.keptTeardownResources(...args),
        planReset: (...args: Parameters<typeof actual.planReset>) => applicationOwners.reclaim.planReset?.(...args) ?? actual.planReset(...args),
        planTeardown: (...args: Parameters<typeof actual.planTeardown>) => applicationOwners.reclaim.planTeardown?.(...args) ?? actual.planTeardown(...args),
        projectRecoveredResetActionTargets: (...args: Parameters<typeof actual.projectRecoveredResetActionTargets>) => applicationOwners.reclaim.projectRecoveredResetActionTargets?.(...args) ?? actual.projectRecoveredResetActionTargets(...args),
        projectResetActionTargets: (...args: Parameters<typeof actual.projectResetActionTargets>) => applicationOwners.reclaim.projectResetActionTargets?.(...args) ?? actual.projectResetActionTargets(...args),
        projectTeardownActionTargets: (...args: Parameters<typeof actual.projectTeardownActionTargets>) => applicationOwners.reclaim.projectTeardownActionTargets?.(...args) ?? actual.projectTeardownActionTargets(...args),
        reconcileReclaimAction: (...args: Parameters<typeof actual.reconcileReclaimAction>) => applicationOwners.reclaim.reconcileReclaimAction?.(...args) ?? actual.reconcileReclaimAction(...args),
        redeemReclaimAction: (...args: Parameters<typeof actual.redeemReclaimAction>) => applicationOwners.reclaim.redeemReclaimAction?.(...args) ?? actual.redeemReclaimAction(...args),
    }
})
import {
    beginOperatorReset,
    issueDestructiveRunContext,
    runDown,
    runReset,
} from './application.js'
import { decodeCoordinationRecord } from './claims.js'
import { readState, transactState } from './state.js'
import { resolveLifecycleStage } from './lifecycle-stage.js'
import { createApplicationFixtureSupport } from '../../test-support/application-fixture.js'

const scratch: string[] = []
const gitDirectory = mkdtempSync(join(tmpdir(), 'cockpit-application-git-'))
const gitCanonicalPath = join(gitDirectory, 'git-executable')
const gitInvocationPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
writeFileSync(gitCanonicalPath, `#!/bin/sh\nexec ${JSON.stringify(gitInvocationPath)} "$@"\n`, { mode: 0o700 })
const gitExecutable = {
    canonicalPath: gitCanonicalPath,
    invocationPath: gitInvocationPath,
    sha256: createHash('sha256').update(readFileSync(gitCanonicalPath)).digest('hex'),
    executionMode: 'verified-path' as const,
}

describe('destructive application contracts', () => {
    async function destructiveFixture() {
        const { configPath, context: lifecycle } = await lifecycleContextFixture()
        const candidate = Object.freeze({ stackId: lifecycle.stackId, checkoutId: lifecycle.checkoutId })
        const instance = Object.freeze({ served: candidate, launcher: candidate, claimInventory: Object.freeze([candidate]) })
        const issued = issueDestructiveRunContext({ lifecycle, instance })
        if (issued.kind !== 'complete') throw new Error('destructive context was not issued')
        const now = new Date().toISOString()
        const seeded = await transactState(
            issued.result.namespace,
            issued.result.namespace.paths.coordination(issued.result.stackId),
            { ownerId: issued.result.holderId },
            () => ({
                format: 'cockpit-state/v1', kind: 'coordination', cockpitId: issued.result.cockpitId,
                subjectId: issued.result.stackId, revision: 0, updatedAt: now,
                value: {
                    holders: [{ holderId: issued.result.holderId, checkoutId: issued.result.checkoutId, claimedAt: now }],
                    lease: { offset: 0, ports: { APP_PORT: 4100 }, released: false,
                        declaration: { step: 100, count: 1, bases: { APP_PORT: 4100 } } },
                    lastReleasedHolder: null, drain: null,
                },
            }),
        )
        if (seeded.kind !== 'complete') throw new Error('destructive coordination fixture was not seeded')
        return { configPath, context: issued.result, instance }
    }

    function resetObservation(
        instance: Awaited<ReturnType<typeof destructiveFixture>>['instance'],
        coordinationRecord: unknown = null,
    ) {
        return Object.freeze({
            instance,
            runtime: Object.freeze({}),
            ports: Object.freeze({}),
            down: Object.freeze({ discovery: Object.freeze({}), coordinationRecord }),
            reset: Object.freeze({ discovery: Object.freeze({}), coordinationRecord }),
        }) as never
    }

    function failedDestructiveRecord(
        context: Awaited<ReturnType<typeof destructiveFixture>>['context'],
        purpose: 'down' | 'reset',
    ) {
        const now = new Date().toISOString()
        const validThrough = new Date(Date.parse(now) + 47_000).toISOString()
        const reservationId = (purpose === 'down' ? '4' : '6').repeat(64)
        const attemptId = (purpose === 'down' ? '5' : '7').repeat(64)
        const targetCommitment = {
            format: 'cockpit-reclaim-target/v1' as const,
            sha256: createHash('sha256').update('{}').digest('hex'),
            body: '{}',
        }
        return Object.freeze({
            format: 'cockpit-state/v1', kind: 'coordination', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 13, updatedAt: now,
            value: {
                holders: [{ holderId: context.holderId, checkoutId: context.checkoutId, claimedAt: now }],
                lease: { offset: 0, ports: { APP_PORT: 4100 }, released: false,
                    declaration: { step: 100, count: 1, bases: { APP_PORT: 4100 } } },
                lastReleasedHolder: null,
                drain: {
                    purpose, stackId: context.stackId, holderId: context.holderId, requesterId: context.holderId,
                    configSha256: '1'.repeat(64), planDigest: '5'.repeat(64), operationBasis: '2'.repeat(64),
                    generation: '3'.repeat(64), targetIds: [context.stackId, 'volume:synthetic-volume'].sort(),
                    actions: [
                        { stage: 'runtime-stop', targetId: context.stackId, validForMs: 31_000 },
                        { stage: 'reclaim', targetId: 'volume:synthetic-volume', validForMs: 47_000, targetCommitment },
                    ],
                    expectedCoordinationRevision: 9, coordinationRevision: 10, reservedAt: now,
                    reservationId, completedActionCount: 1, progressRevision: 11,
                    attempt: {
                        attemptId, reservationId, purpose,
                        targetIds: [context.stackId, 'volume:synthetic-volume'].sort(), generation: '3'.repeat(64),
                        actionIndex: 1, currentTarget: 'volume:synthetic-volume', currentStage: 'reclaim',
                        committedRevision: 12, committedAt: now, validThrough,
                        status: 'failed', failedRevision: 13, failedAt: now,
                    },
                },
            },
        })
    }

    function persistFailedDestructiveRecord(
        context: Awaited<ReturnType<typeof destructiveFixture>>['context'],
        purpose: 'down' | 'reset',
    ) {
        const record = failedDestructiveRecord(context, purpose)
        const address = context.namespace.paths.coordination(context.stackId)
        mkdirSync(dirname(address.path), { recursive: true })
        writeFileSync(address.path, `${JSON.stringify(record)}\n`)
        return record
    }

    function persistedDrainRequest(
        context: Awaited<ReturnType<typeof destructiveFixture>>['context'],
        record: ReturnType<typeof failedDestructiveRecord>,
    ) {
        const drain = decodeCoordinationRecord(record as never, context.stackId)?.drain
        if (!drain) throw new Error('expected persisted drain request')
        const {
            coordinationRevision: _coordinationRevision, reservedAt: _reservedAt,
            reservationId: _reservationId, completedActionCount: _completedActionCount,
            progressRevision: _progressRevision, attempt: _attempt, ...request
        } = drain
        return request
    }

    it('returns reset preview data without consent or continuation authority', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        applicationOwners.reclaim.planReset = async () => Object.freeze({
            kind: 'preview', digest: '1'.repeat(64), coordinationRevision: 7,
            targets: Object.freeze([Object.freeze({ kind: 'volume', identity: 'synthetic-volume', declaration: 'data' })]),
            noop: false, consent: Object.freeze({}),
        }) as never

        const result = await runReset({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance),
            execute: vi.fn(),
        })

        expect(result).toMatchObject({
            kind: 'preview', result: { stackId: context.stackId, planDigest: '1'.repeat(64), noop: false },
        })
        expect(JSON.stringify(result)).not.toMatch(/consent|continuation|authority|decide/)
    })

    it.each([['down', runDown], ['reset', runReset]] as const)(
        'reports an unobservable %s precondition as evidence, not as an attempt needing repair', async (_command, run) => {
            const { configPath, context } = await destructiveFixture()
            const reserve = vi.fn()
            applicationOwners.claims.reserveDrain = reserve
            const execute = vi.fn()

            const result = await run({ configPath }, {
                load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
                observe: async () => undefined,
                execute,
            })

            expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
            expect(JSON.stringify(result)).not.toContain('DRAIN_ATTEMPT_REPAIR_REQUIRED')
            expect(reserve).not.toHaveBeenCalled()
            expect(execute).not.toHaveBeenCalled()
        })

    it('keeps a declined operator session one-shot and performs no destructive work', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        applicationOwners.reclaim.planReset = async () => Object.freeze({
            kind: 'preview', digest: '2'.repeat(64), coordinationRevision: 8,
            targets: Object.freeze([]), noop: true, consent: Object.freeze({}),
        }) as never
        const reserve = vi.fn()
        applicationOwners.claims.reserveDrain = reserve
        const execute = vi.fn()
        const adapters = {
            load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance),
            execute,
        }

        const session = await beginOperatorReset({ configPath }, adapters)
        if (!('decide' in session)) throw new Error('operator reset session was not issued')
        const decide = session.decide
        await expect(decide('decline')).resolves.toMatchObject({ kind: 'refusal' })
        await expect(decide('approve')).resolves.toMatchObject({ kind: 'refusal' })

        expect(execute).not.toHaveBeenCalled()
        expect(reserve).not.toHaveBeenCalled()
    })

    it('completes an approved noop reset as unchanged without reserving or executing', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        let calls = 0
        applicationOwners.reclaim.planReset = async () => {
            calls += 1
            return calls === 1 ? {
                kind: 'preview', digest: '7'.repeat(64), coordinationRevision: 8,
                targets: [], noop: true, consent: {},
            } as never : {
                kind: 'complete', step: null, actionAuthority: null, remaining: 0,
                noop: true, digest: '7'.repeat(64), continuation: null,
            } as never
        }
        const reserve = vi.fn()
        applicationOwners.claims.reserveDrain = reserve
        const execute = vi.fn()
        const adapters = {
            load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance), execute,
        }

        const session = await beginOperatorReset({ configPath }, adapters)
        if (!('decide' in session)) throw new Error('operator reset session was not issued')
        await expect(session.decide('approve')).resolves.toMatchObject({
            kind: 'complete', result: { stackId: context.stackId, change: 'unchanged' },
        })
        expect(reserve).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it('refuses an approved noop reset when fresh owner confirmation no longer matches', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        let calls = 0
        applicationOwners.reclaim.planReset = async () => {
            calls += 1
            return calls === 1 ? {
                kind: 'preview', digest: '7'.repeat(64), coordinationRevision: 8,
                targets: [], noop: true, consent: {},
            } as never : {
                kind: 'refusal', diagnostics: [{ severity: 'error', code: 'RESET_CONFIRMATION_MISMATCH', message: 'changed' }],
            } as never
        }
        const reserve = vi.fn()
        applicationOwners.claims.reserveDrain = reserve
        const execute = vi.fn()
        const adapters = {
            load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance), execute,
        }

        const session = await beginOperatorReset({ configPath }, adapters)
        if (!('decide' in session)) throw new Error('operator reset session was not issued')
        await expect(session.decide('approve')).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'RESET_CONFIRMATION_MISMATCH' }],
        })
        expect(reserve).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it('refuses a freshly confirmed noop while a failed destructive attempt remains unresolved', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        const failedRecord = persistFailedDestructiveRecord(context, 'down')
        let calls = 0
        applicationOwners.reclaim.planReset = async () => {
            calls += 1
            return calls === 1 ? {
                kind: 'preview', digest: '7'.repeat(64), coordinationRevision: failedRecord.revision,
                targets: [], noop: true, consent: {},
            } as never : {
                kind: 'complete', step: null, actionAuthority: null, remaining: 0,
                noop: true, digest: '7'.repeat(64), continuation: null,
            } as never
        }
        const reserve = vi.fn()
        const recover = vi.fn()
        applicationOwners.claims.reserveDrain = reserve
        applicationOwners.claims.recoverDrainReservation = recover
        const execute = vi.fn()
        const adapters = {
            load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance, failedRecord), execute,
        }

        const session = await beginOperatorReset({ configPath }, adapters)
        if (!('decide' in session)) throw new Error('operator reset session was not issued')
        await expect(session.decide('approve')).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'DRAIN_ATTEMPT_REPAIR_REQUIRED' }],
        })
        expect(calls).toBe(1)
        expect(reserve).not.toHaveBeenCalled()
        expect(recover).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it.each(['co-tenant', 'missing'] as const)(
        'refuses a freshly confirmed noop when coordination becomes %s before final admission',
        async (change) => {
            const { configPath, context, instance } = await destructiveFixture()
            let calls = 0
            applicationOwners.reclaim.planReset = async () => {
                calls += 1
                if (calls === 1) return {
                    kind: 'preview', digest: '7'.repeat(64), coordinationRevision: 0,
                    targets: [], noop: true, consent: {},
                } as never
                const address = context.namespace.paths.coordination(context.stackId)
                if (change === 'missing') {
                    rmSync(address.path)
                } else {
                    const changed = await transactState(context.namespace, address, { ownerId: context.holderId }, (current) => ({
                        ...current!, revision: current!.revision + 1, updatedAt: new Date().toISOString(),
                        value: {
                            ...(current!.value as object),
                            holders: [
                                ...((current!.value as { holders: unknown[] }).holders),
                                { holderId: `holder:${'9'.repeat(64)}:session`, checkoutId: context.checkoutId,
                                    claimedAt: new Date().toISOString() },
                            ],
                        },
                    } as never))
                    if (changed.kind !== 'complete') throw new Error('coordination race fixture was not published')
                }
                return {
                    kind: 'complete', step: null, actionAuthority: null, remaining: 0,
                    noop: true, digest: '7'.repeat(64), continuation: null,
                } as never
            }
            const execute = vi.fn()
            const adapters = {
                load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
                observe: async () => resetObservation(instance), execute,
            }

            const session = await beginOperatorReset({ configPath }, adapters)
            if (!('decide' in session)) throw new Error('operator reset session was not issued')
            await expect(session.decide('approve')).resolves.toMatchObject({ kind: 'refusal' })
            expect(calls).toBe(2)
            expect(execute).not.toHaveBeenCalled()
        },
    )

    it('commits the reset reservation and current attempt before stopping the runtime', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        const events: string[] = []
        const consent = Object.freeze({})
        let resetCalls = 0
        applicationOwners.reclaim.planReset = async () => {
            resetCalls += 1
            return resetCalls === 1 ? Object.freeze({
                kind: 'preview', digest: '3'.repeat(64), coordinationRevision: 9,
                targets: Object.freeze([Object.freeze({ kind: 'volume', identity: 'synthetic-volume', declaration: 'data' })]),
                noop: false, consent,
            }) as never : Object.freeze({
                kind: 'complete', step: null, actionAuthority: null, remaining: 0,
                noop: false, digest: '3'.repeat(64), continuation: null,
            }) as never
        }
        applicationOwners.reclaim.projectResetActionTargets = () => Object.freeze({}) as never
        const request = Object.freeze({
            purpose: 'reset', stackId: context.stackId, holderId: context.holderId, requesterId: context.holderId,
            configSha256: '1'.repeat(64), planDigest: '3'.repeat(64), operationBasis: '2'.repeat(64),
            generation: '3'.repeat(64), targetIds: Object.freeze([context.stackId]),
            actions: Object.freeze([{ stage: 'runtime-stop' as const, targetId: context.stackId, validForMs: 60_000 }]),
            expectedCoordinationRevision: 9,
        })
        const lifecyclePlan = Object.freeze({ diagnostics: Object.freeze([]) })
        applicationOwners.lifecycle.planResetLifecycle = () => ({ kind: 'drain', plan: lifecyclePlan, request }) as never
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: Object.freeze({}), drainRequest: request, reclaim: { purpose: 'reset' },
        }) as never
        const reservedAt = new Date().toISOString()
        const reservationId = '4'.repeat(64)
        const reservation = Object.freeze({
            ...request, coordinationRevision: 10, reservedAt, reservationId,
            completedActionCount: 0, progressRevision: 10, attempt: null,
        })
        const attempt = Object.freeze({
            attemptId: '5'.repeat(64), reservationId, purpose: 'reset' as const,
            targetIds: request.targetIds, generation: request.generation,
            actionIndex: 0, currentTarget: context.stackId, currentStage: 'runtime-stop' as const,
            committedRevision: 11, committedAt: reservedAt,
            validThrough: new Date(Date.parse(reservedAt) + 60_000).toISOString(),
            status: 'active' as const, failedRevision: null, failedAt: null,
        })
        applicationOwners.claims.reserveDrain = async () => {
            events.push('reservation')
            return {
                kind: 'complete', authority: Object.freeze({}),
                reservation,
            } as never
        }
        applicationOwners.claims.recoverDrainReservation = async () => ({ kind: 'refusal', diagnostics: [] }) as never
        applicationOwners.claims.reserveDrainAttempt = async () => {
            events.push('attempt')
            return {
                kind: 'complete', authority: Object.freeze({
                    reservation: Object.freeze({ ...reservation, attempt }), attempt,
                }),
            } as never
        }
        applicationOwners.runtime.stopRuntime = async ({ execute }) => {
            await execute({ id: 'runtime-stop' } as never)
            await execute({ id: 'runtime-observe' } as never)
            return { kind: 'stopped', authority: Object.freeze({}), fence: executionFence('reset-stop') } as never
        }
        applicationOwners.claims.prepareDrainOutcomePublication = async () => {
            events.push('publication')
            return { kind: 'complete', value: Object.freeze({}) } as never
        }
        applicationOwners.claims.finalizeDrainOutcome = () => {
            events.push('finalize')
            return true
        }
        const adapters = {
            load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance),
            execute: async (step: { id: string }) => {
                events.push(step.id)
                return Object.freeze({ kind: 'complete' }) as never
            },
        }

        const session = await beginOperatorReset({ configPath }, adapters as never)
        if (!('decide' in session)) throw new Error('operator reset session was not issued')
        const result = await session.decide('approve')

        expect(events).toEqual(['reservation', 'attempt', 'runtime-stop', 'runtime-observe', 'publication', 'finalize'])
        expect(result).toMatchObject({ kind: 'complete', result: { stackId: context.stackId, change: 'reset', targets: session.preview.result.targets } })
    })

    it('refuses co-tenancy before minting or executing a reset action', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        const planReset = vi.fn(async () => Object.freeze({
            kind: 'preview', digest: '4'.repeat(64), coordinationRevision: 10,
            targets: Object.freeze([Object.freeze({ kind: 'volume', identity: 'synthetic-volume', declaration: 'data' })]),
            noop: false, consent: Object.freeze({}),
        }) as never)
        applicationOwners.reclaim.planReset = planReset
        applicationOwners.reclaim.projectResetActionTargets = () => Object.freeze({}) as never
        applicationOwners.lifecycle.planResetLifecycle = () => ({
            kind: 'refusal', diagnostics: [{ severity: 'error', code: 'CLAIM_CO_TENANT', message: 'co-tenant', target: context.stackId }],
        }) as never
        const execute = vi.fn()
        const adapters = {
            load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance),
            execute,
        }

        const session = await beginOperatorReset({ configPath }, adapters)
        if (!('decide' in session)) throw new Error('operator reset session was not issued')
        const result = await session.decide('approve')

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'CLAIM_CO_TENANT' }] })
        expect(planReset).toHaveBeenCalledOnce()
        expect(execute).not.toHaveBeenCalled()
    })

    it('recovers a persisted failed down action with its original generation and validity windows', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        const failedRecord = persistFailedDestructiveRecord(context, 'down')
        const events: string[] = []
        let teardownCalls = 0
        applicationOwners.reclaim.planTeardown = async () => {
            teardownCalls += 1
            return teardownCalls === 1 ? {
                kind: 'complete', steps: [], actionAuthority: {}, remaining: 1, noop: false,
                discoveryDigest: '5'.repeat(64), byteAccounting: {}, consent: {}, continuation: null,
            } as never : {
                kind: 'complete', steps: [], actionAuthority: {}, remaining: 1, noop: false,
                discoveryDigest: '5'.repeat(64), byteAccounting: {}, consent: null, continuation: {},
            } as never
        }
        applicationOwners.reclaim.projectTeardownActionTargets = () => ({}) as never
        // The discoveries here are opaque stand-ins, so the kept-resource classification is too.
        applicationOwners.reclaim.keptTeardownResources = () => []
        const recoveredRequest = persistedDrainRequest(context, failedRecord)
        const request = { ...recoveredRequest, expectedCoordinationRevision: failedRecord.revision }
        const planDown = vi.fn(() => ({ kind: 'drain', plan: { diagnostics: [] }, request }) as never)
        applicationOwners.lifecycle.planDown = planDown
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: {}, drainRequest: request, reclaim: { purpose: 'down' },
        }) as never
        applicationOwners.claims.reserveDrainAttempt = async () => {
            events.push('attempt')
            return { kind: 'complete', authority: {} } as never
        }
        applicationOwners.reclaim.redeemReclaimAction = async () => {
            events.push('redeem')
            return { step: { id: 'reclaim', executionFence: executionFence('recovered-down') }, authority: {} } as never
        }
        applicationOwners.reclaim.reconcileReclaimAction = () => ({
            kind: 'complete', continuation: null, authority: {},
        }) as never
        applicationOwners.reclaim.consumeReclaimCompleted = () => ({}) as never
        applicationOwners.claims.prepareDrainOutcomePublication = async () => ({ kind: 'complete', value: {} }) as never
        applicationOwners.claims.finalizeDrainOutcome = () => true
        const result = await runDown({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance, failedRecord),
            execute: async () => {
                events.push('execute')
                return { kind: 'complete' } as never
            },
        })

        expect(planDown).toHaveBeenCalledWith(expect.objectContaining({
            operationGeneration: '3'.repeat(64), runtimeStopValidForMs: 31_000, reclaimValidForMs: 47_000,
        }))
        expect(events).toEqual(['attempt', 'redeem', 'execute'])
        expect(result).toMatchObject({ kind: 'complete', result: { change: 'removed' } })
    })

    it('refuses persisted down recovery when the fresh lifecycle projection changes its request', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        const failedRecord = persistFailedDestructiveRecord(context, 'down')
        const recoveredReservation = decodeCoordinationRecord(failedRecord as never, context.stackId)?.drain
        if (!recoveredReservation) throw new Error('expected persisted drain reservation')
        const recoveredRequest = persistedDrainRequest(context, failedRecord)
        const request = { ...recoveredRequest, expectedCoordinationRevision: failedRecord.revision }
        applicationOwners.reclaim.planTeardown = async () => ({
            kind: 'complete', steps: [], actionAuthority: {}, remaining: 1, noop: false,
            discoveryDigest: '5'.repeat(64), byteAccounting: {}, consent: {}, continuation: null,
        }) as never
        applicationOwners.reclaim.projectTeardownActionTargets = () => ({}) as never
        applicationOwners.lifecycle.planDown = () => ({
            kind: 'drain', plan: { diagnostics: [] }, request: { ...request, operationBasis: '8'.repeat(64) },
        }) as never
        const recoveredAuthority = Object.freeze({})
        const recover = vi.fn(async () => ({
            kind: 'complete', authority: recoveredAuthority,
            reservation: recoveredReservation,
        }) as never)
        const discard = vi.fn(() => true)
        const reserveAttempt = vi.fn()
        applicationOwners.claims.recoverDrainReservation = recover
        applicationOwners.claims.discardDrainReservationAuthority = discard
        applicationOwners.claims.reserveDrainAttempt = reserveAttempt
        const execute = vi.fn()

        await expect(runDown({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance, failedRecord), execute,
        })).resolves.toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'DRAIN_ATTEMPT_REPAIR_REQUIRED',
            message: expect.stringContaining('will not overlap it with another destructive action'),
        }] })
        expect(recover).toHaveBeenCalledOnce()
        expect(recover).toHaveBeenCalledWith({ namespace: context.namespace, request: recoveredRequest })
        expect(discard).toHaveBeenCalledOnce()
        expect(discard).toHaveBeenCalledWith(recoveredAuthority)
        expect(reserveAttempt).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it('measures the runtime once and plans each next removal from the discovery that reconciled the last', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        const failedRecord = persistFailedDestructiveRecord(context, 'down')
        const observations: string[] = []
        const reclaimObservation = () => {
            const discovery = Object.freeze({ observation: observations.length })
            return Object.freeze({
                instance,
                down: Object.freeze({ discovery, coordinationRecord: null }),
                reset: Object.freeze({ discovery, coordinationRecord: null }),
            }) as never
        }
        const discoveries: unknown[] = []
        const plans: Record<string, unknown>[] = []
        applicationOwners.reclaim.planTeardown = async (input) => {
            plans.push(input as never)
            return plans.length === 1 ? {
                kind: 'complete', steps: [], actionAuthority: {}, remaining: 2, noop: false,
                discoveryDigest: '5'.repeat(64), byteAccounting: {}, consent: {}, continuation: null,
            } as never : {
                kind: 'complete', steps: [], actionAuthority: {}, remaining: 1, noop: false,
                discoveryDigest: '5'.repeat(64), byteAccounting: {}, consent: null, continuation: {},
            } as never
        }
        applicationOwners.reclaim.projectTeardownActionTargets = () => ({}) as never
        // The discoveries here are opaque stand-ins, so the kept-resource classification is too.
        applicationOwners.reclaim.keptTeardownResources = () => []
        const request = { ...persistedDrainRequest(context, failedRecord), expectedCoordinationRevision: failedRecord.revision }
        applicationOwners.lifecycle.planDown = () => ({ kind: 'drain', plan: { diagnostics: [] }, request }) as never
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: {}, drainRequest: request, reclaim: { purpose: 'down' },
        }) as never
        applicationOwners.claims.recoverDrainReservation = async () => ({ kind: 'complete', authority: {}, reservation: { completedActionCount: 1 } }) as never
        applicationOwners.claims.reserveDrainAttempt = async () => ({ kind: 'complete', authority: {} }) as never
        applicationOwners.reclaim.redeemReclaimAction = async () => ({ step: { id: 'reclaim', executionFence: executionFence('reclaim-loop') }, authority: {} }) as never
        const continuation = Object.freeze({})
        let reconciliations = 0
        applicationOwners.reclaim.reconcileReclaimAction = ({ discovery }) => {
            discoveries.push(discovery)
            reconciliations += 1
            return { kind: 'complete', continuation: reconciliations === 1 ? continuation : null, authority: {} } as never
        }
        applicationOwners.reclaim.consumeReclaimCompleted = () => ({}) as never
        applicationOwners.claims.prepareDrainOutcomePublication = async () => ({ kind: 'complete', value: {} }) as never
        applicationOwners.claims.finalizeDrainOutcome = () => true

        const result = await runDown({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            observe: async () => {
                observations.push('runtime')
                return resetObservation(instance, failedRecord)
            },
            observeReclaim: async () => {
                observations.push('reclaim')
                return reclaimObservation()
            },
            execute: async () => ({ kind: 'complete' }) as never,
        })

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete', result: { change: 'removed' } })
        // Preview, plan, then one discovery per removal: the runtime is measured once, and no
        // removal is followed by a second discovery before the next one is planned.
        expect(observations).toEqual(['runtime', 'reclaim', 'reclaim', 'reclaim'])
        expect(plans).toHaveLength(3)
        expect(plans[2]!.discovery).toBe(discoveries[0])
        expect(plans[2]).toMatchObject({ continuation, coordinationRecord: failedRecord, expectedDiscoveryDigest: request.planDigest })
    })

    it('retires a stack that never started without writing a lifecycle record up would refuse', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        const failedRecord = persistFailedDestructiveRecord(context, 'down')
        applicationOwners.reclaim.planTeardown = async () => ({
            kind: 'complete', steps: [], actionAuthority: {}, remaining: 1, noop: false,
            discoveryDigest: '5'.repeat(64), byteAccounting: {}, consent: null, continuation: null,
        }) as never
        applicationOwners.reclaim.projectTeardownActionTargets = () => ({}) as never
        // The discoveries here are opaque stand-ins, so the kept-resource classification is too.
        applicationOwners.reclaim.keptTeardownResources = () => []
        const request = { ...persistedDrainRequest(context, failedRecord), expectedCoordinationRevision: failedRecord.revision }
        applicationOwners.lifecycle.planDown = () => ({ kind: 'drain', plan: { diagnostics: [] }, request }) as never
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: {}, drainRequest: request, reclaim: { purpose: 'down' },
        }) as never
        applicationOwners.claims.recoverDrainReservation = async () => ({ kind: 'complete', authority: {}, reservation: { completedActionCount: 1 } }) as never
        applicationOwners.claims.reserveDrainAttempt = async () => ({ kind: 'complete', authority: {} }) as never
        applicationOwners.reclaim.redeemReclaimAction = async () => ({ step: { id: 'reclaim', executionFence: executionFence('never-started') }, authority: {} }) as never
        applicationOwners.reclaim.reconcileReclaimAction = () => ({ kind: 'complete', continuation: null, authority: {} }) as never
        applicationOwners.reclaim.consumeReclaimCompleted = () => ({}) as never
        applicationOwners.claims.prepareDrainOutcomePublication = async () => ({ kind: 'complete', value: {} }) as never
        applicationOwners.claims.finalizeDrainOutcome = () => true
        const discovery = Object.freeze({ down: Object.freeze({ discovery: Object.freeze({}), coordinationRecord: null }) })

        const result = await runDown({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance, failedRecord),
            observeReclaim: async () => Object.freeze({ instance, ...discovery, reset: discovery.down }) as never,
            execute: async () => ({ kind: 'complete' }) as never,
        })

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete', result: { change: 'removed' } })
        // A lifecycle record without lifecycle history reads as malformed, so the next up refused.
        expect(await readState(context.namespace.paths.lifecycle(context.stackId))).toMatchObject({ kind: 'missing' })
        expect(await resolveLifecycleStage({ namespace: context.namespace, stackId: context.stackId, observedAt: new Date().toISOString() }))
            .toMatchObject({ kind: 'complete', authority: { stage: 'bootstrap' } })
    })

    it('refuses to report the stack removed while a resource it owns remains, and names what it kept', async () => {
        const downWith = async (resources: (labels: Record<string, string>) => readonly object[]) => {
            const { configPath, context, instance } = await destructiveFixture()
            const failedRecord = persistFailedDestructiveRecord(context, 'down')
            applicationOwners.reclaim.planTeardown = async () => ({
                kind: 'complete', steps: [], actionAuthority: null, remaining: 0, noop: true,
                discoveryDigest: '5'.repeat(64), byteAccounting: {}, consent: null, continuation: null,
            }) as never
            applicationOwners.reclaim.projectTeardownActionTargets = () => ({}) as never
            const request = { ...persistedDrainRequest(context, failedRecord), expectedCoordinationRevision: failedRecord.revision }
            applicationOwners.lifecycle.planDown = () => ({ kind: 'drain', plan: { diagnostics: [] }, request }) as never
            applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
                topology: {}, drainRequest: request, reclaim: { purpose: 'down' },
            }) as never
            applicationOwners.claims.recoverDrainReservation = async () => ({ kind: 'complete', authority: {}, reservation: { completedActionCount: 1 } }) as never
            const observed = Object.freeze({
                stackId: context.stackId, cockpitId: context.cockpitId, configSha256: context.source.sha256,
                coordinationRecord: failedRecord, declaredCacheIds: [],
                discovery: { observedAt: new Date().toISOString(), producer: 'runtime-resource-discovery', resources: resources({
                    'dev.b0dea.cockpit.stack-id': context.stackId,
                    'dev.b0dea.cockpit.config-sha256': context.source.sha256,
                    'dev.b0dea.cockpit.owner-id': context.cockpitId,
                }) },
            })
            const result = await runDown({ configPath }, {
                load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
                observe: async () => Object.freeze({ instance, runtime: {}, ports: {}, down: observed, reset: observed }) as never,
                execute: async () => ({ kind: 'complete' }) as never,
            })
            return { result, context }
        }
        const volume = (labels: Record<string, string>) => ({ id: 'synthetic_data', name: 'synthetic_data', kind: 'volume', labels, referenced: false, bytes: null, dataBearing: true })
        const network = (labels: Record<string, string>) => ({ id: 'network-held', name: 'synthetic_default', kind: 'network', labels, referenced: true, bytes: null })

        // A volume stays for reset to remove, so it does not keep down from finishing.
        expect((await downWith((labels) => [volume(labels)])).result).toMatchObject({ kind: 'complete', result: { change: 'removed' } })
        const { result: kept, context } = await downWith((labels) => [volume(labels), network(labels)])

        expect(kept).toMatchObject({ kind: 'refusal', status: 2, result: null, diagnostics: [{
            code: 'DOWN_RESOURCES_KEPT', target: context.stackId,
            message: expect.stringContaining('network synthetic_default (network-held): a container outside this stack is still attached to it'),
            fix: expect.stringContaining(cockpitCommand('down', { config: context.source.path })),
        }] })
        expect(kept.diagnostics[0]!.message).not.toContain('synthetic_data')
    })

    it('uses recovered failed-action authority without trying to recover the same epoch twice', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        const failedRecord = persistFailedDestructiveRecord(context, 'reset')
        const recoveredReservation = decodeCoordinationRecord(failedRecord as never, context.stackId)?.drain
        if (!recoveredReservation) throw new Error('expected persisted drain reservation')
        const events: string[] = []
        let resetCalls = 0
        const operatorPreview = Object.freeze({
            kind: 'preview', digest: '5'.repeat(64), coordinationRevision: 11,
            targets: Object.freeze([{ kind: 'volume', identity: 'synthetic-volume', declaration: 'data' }]),
            noop: false, consent: Object.freeze({}),
        })
        const recoveredPlan = Object.freeze({
            kind: 'complete', step: { id: 'reclaim' }, actionAuthority: Object.freeze({}), remaining: 1,
            noop: false, digest: '5'.repeat(64), continuation: Object.freeze({}),
        })
        const planReset = vi.fn(async (_input: Parameters<typeof import('./reclaim.js').planReset>[0]) => {
            resetCalls += 1
            return (resetCalls === 1 ? operatorPreview : recoveredPlan) as never
        })
        applicationOwners.reclaim.planReset = planReset
        applicationOwners.reclaim.projectResetActionTargets = () => ({}) as never
        const projectRecovered = vi.fn(() => Object.freeze({}) as never)
        applicationOwners.reclaim.projectRecoveredResetActionTargets = projectRecovered
        const recoveredRequest = persistedDrainRequest(context, failedRecord)
        const request = { ...recoveredRequest, expectedCoordinationRevision: failedRecord.revision }
        const planResetLifecycle = vi.fn(() => ({ kind: 'drain', plan: { diagnostics: [] }, request }) as never)
        applicationOwners.lifecycle.planResetLifecycle = planResetLifecycle
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: {}, drainRequest: request, reclaim: { purpose: 'reset' },
        }) as never
        const recoveredAuthority = Object.freeze({})
        const recover = vi.fn(async () => ({
            kind: 'complete', authority: recoveredAuthority,
            reservation: recoveredReservation,
        }) as never)
        const discard = vi.fn(() => true)
        applicationOwners.claims.recoverDrainReservation = recover
        applicationOwners.claims.discardDrainReservationAuthority = discard
        applicationOwners.claims.reserveDrainAttempt = async () => {
            events.push('attempt')
            return { kind: 'complete', authority: {} } as never
        }
        applicationOwners.reclaim.redeemReclaimAction = async () => {
            events.push('redeem')
            return { step: { id: 'reclaim', executionFence: executionFence('recovered-reset') }, authority: {} } as never
        }
        applicationOwners.reclaim.reconcileReclaimAction = () => {
            events.push('reconcile')
            return { kind: 'complete', continuation: null, authority: {} } as never
        }
        applicationOwners.reclaim.consumeReclaimCompleted = () => ({}) as never
        applicationOwners.claims.prepareDrainOutcomePublication = async () => {
            events.push('publish')
            return { kind: 'complete', value: {} } as never
        }
        applicationOwners.claims.finalizeDrainOutcome = () => true
        const adapters = {
            load: async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance, failedRecord),
            execute: async () => {
                events.push('execute')
                return { kind: 'complete' } as never
            },
        }

        const session = await beginOperatorReset({ configPath }, adapters)
        if (!('decide' in session)) throw new Error('operator reset session was not issued')
        const result = await session.decide('approve')

        expect(result).toMatchObject({ kind: 'complete', result: { change: 'reset' } })
        expect(planResetLifecycle).toHaveBeenCalledWith(expect.objectContaining({
            operationGeneration: '3'.repeat(64), runtimeStopValidForMs: 31_000, reclaimValidForMs: 47_000,
        }))
        expect(planReset).toHaveBeenNthCalledWith(2, expect.objectContaining({
            confirmationDigest: recoveredRequest.planDigest,
            recoveryAuthority: recoveredAuthority,
            operatorApproval: operatorPreview,
        }))
        expect(planReset.mock.calls[1]?.[0].operatorApproval).toBe(operatorPreview)
        expect(projectRecovered).toHaveBeenCalledOnce()
        expect(projectRecovered).toHaveBeenCalledWith(recoveredPlan)
        expect(recover).toHaveBeenCalledOnce()
        expect(recover).toHaveBeenCalledWith({ namespace: context.namespace, request: recoveredRequest })
        expect(discard).toHaveBeenCalledOnce()
        expect(discard).toHaveBeenCalledWith(recoveredAuthority)
        expect(events).toEqual(['attempt', 'redeem', 'execute', 'reconcile', 'publish'])
    })
})
afterEach(() => {
    vi.restoreAllMocks()
    applicationOwners.lifecycle = {}
    applicationOwners.runtime = {}
    applicationOwners.claims = {}
    applicationOwners.reclaim = {}
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})
afterAll(() => rmSync(gitDirectory, { recursive: true, force: true }))

const { lifecycleContextFixture } = createApplicationFixtureSupport(scratch, gitExecutable)
