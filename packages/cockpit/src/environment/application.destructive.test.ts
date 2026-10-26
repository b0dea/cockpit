import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as generatedCurrentnessOwner from './generated-application.js'
import { executeProbe } from '../environment-exec/execute.js'
import { planAutonomyLaunch } from '../autonomy/launcher.js'
import { evaluateGuard } from '../guards/evaluator.js'
import { parseGuardInput } from '../guards/invocation-parser.js'
import { shellPayload } from '../guards/fixtures/invocation-corpus.js'
import { parseOwnershipManifest } from '../surfaces/ownership.js'
import type { ExecutionStep, StackId } from './contract.js'
import { createMachineFloorPlan, collectMachineFloorEvidence, issueMachineFloorAuthority } from './runtime.js'
import { observeHostCapacity } from './host-observation.js'
import { projectMachineFloorConfig } from '../config/load.js'
type LifecycleOverrides = Partial<Pick<typeof import('./lifecycle.js'), 'admitUpProgress' | 'planAdmittedUp' | 'planSleep' | 'planDown' | 'planResetLifecycle' | 'consumeLifecycleIssuance'>>
type RuntimeOverrides = Partial<Pick<typeof import('./runtime.js'),
    | 'createRuntimeServicePlan' | 'createRuntimeServiceHealthPlan'
    | 'admitRuntimeServiceStageOutcome'
    | 'admitRuntimeServiceInspectFailure' | 'admitRuntimeServiceObservation' | 'admitRuntimeServiceHealth'
    | 'createRuntimeServiceRevalidationPlan' | 'admitRuntimeServiceRevalidationStatus' | 'admitRuntimeServiceRevalidation'
    | 'createRuntimeStopPlan' | 'createRuntimeStopObservationPlan' | 'admitRuntimeStopped'
    | 'consumeRuntimeStopped' | 'admitRuntimeStopFailure' | 'consumeRuntimeStopFailure'
    | 'resolveRuntimeServiceOrder' | 'observeRuntimeServiceColdStart'>>
type LogOverrides = Partial<Pick<typeof import('./logs.js'), 'planFailureLogs' | 'admitFailureLogs' | 'planLogs' | 'collectLogs'>>
type ObservationOverrides = Partial<Pick<typeof import('./observations.js'), 'aggregateObservations' | 'projectDoctor'>>
type GitObservationOverrides = Partial<Pick<typeof import('./git-observation.js'),
    'createGitObservationStep' | 'observeGit' | 'createComparisonRemoteRefStep'
    | 'observeComparisonRemoteRef' | 'observeComparisonRemoteUrl' | 'observeComparisonRemoteRevalidation'>>
type EvidenceOverrides = Partial<Pick<typeof import('./evidence.js'), 'recordEnvironmentBaseline' | 'environmentBaselineConfirmation'>>
type ClaimsOverrides = Partial<Pick<typeof import('./claims.js'),
    'reserveDrain' | 'recoverDrainReservation' | 'inspectSleepDrainRecovery' | 'recoverSleepDrainReservation' | 'reserveDrainAttempt'
    | 'prepareDrainOutcomePublication' | 'finalizeDrainOutcome'>>
type ReclaimOverrides = Partial<Pick<typeof import('./reclaim.js'),
    'planReset' | 'planTeardown' | 'projectResetActionTargets' | 'projectTeardownActionTargets'
    | 'redeemReclaimAction' | 'reconcileReclaimAction' | 'admitReclaimFailure'
    | 'consumeReclaimFailure' | 'consumeReclaimCompleted'>>
type StateOverrides = Partial<Pick<typeof import('./state.js'), 'readState'>>
type RegistryDerivationOverrides = Partial<Pick<typeof import('../registry-derivation.js'), 'deriveRegistry'>>
const applicationOwners = vi.hoisted(() => ({
    lifecycle: {} as LifecycleOverrides,
    runtime: {} as RuntimeOverrides,
    logs: {} as LogOverrides,
    observations: {} as ObservationOverrides,
    gitObservation: {} as GitObservationOverrides,
    evidence: {} as EvidenceOverrides,
    claims: {} as ClaimsOverrides,
    reclaim: {} as ReclaimOverrides,
    state: {} as StateOverrides,
    ports: {} as Partial<Pick<typeof import('./ports.js'),
        'observeRetainedPortFamily' | 'deriveEntrypoints' | 'projectRetainedPortFamilyResult' | 'releasePortFamily'
        | 'compensateAcquiredPortHolder'>>,
    registryDerivation: {} as RegistryDerivationOverrides,
}))
vi.mock('../registry-derivation.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../registry-derivation.js')>()
    return {
        ...actual,
        deriveRegistry: (...args: Parameters<typeof actual.deriveRegistry>) =>
            applicationOwners.registryDerivation.deriveRegistry?.(...args) ?? actual.deriveRegistry(...args),
    }
})
vi.mock('./lifecycle.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./lifecycle.js')>()
    return {
        ...actual,
        admitUpProgress: (...args: Parameters<typeof actual.admitUpProgress>) => applicationOwners.lifecycle.admitUpProgress?.(...args) ?? actual.admitUpProgress(...args),
        planAdmittedUp: (...args: Parameters<typeof actual.planAdmittedUp>) => applicationOwners.lifecycle.planAdmittedUp?.(...args) ?? actual.planAdmittedUp(...args),
        planSleep: (...args: Parameters<typeof actual.planSleep>) => applicationOwners.lifecycle.planSleep?.(...args) ?? actual.planSleep(...args),
        planDown: (...args: Parameters<typeof actual.planDown>) => applicationOwners.lifecycle.planDown?.(...args) ?? actual.planDown(...args),
        planResetLifecycle: (...args: Parameters<typeof actual.planResetLifecycle>) => applicationOwners.lifecycle.planResetLifecycle?.(...args) ?? actual.planResetLifecycle(...args),
        consumeLifecycleIssuance: (...args: Parameters<typeof actual.consumeLifecycleIssuance>) => applicationOwners.lifecycle.consumeLifecycleIssuance?.(...args) ?? actual.consumeLifecycleIssuance(...args),
    }
})
vi.mock('./ports.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./ports.js')>()
    return {
        ...actual,
        observeRetainedPortFamily: (...args: Parameters<typeof actual.observeRetainedPortFamily>) => applicationOwners.ports.observeRetainedPortFamily?.(...args) ?? actual.observeRetainedPortFamily(...args),
        deriveEntrypoints: (...args: Parameters<typeof actual.deriveEntrypoints>) => applicationOwners.ports.deriveEntrypoints?.(...args) ?? actual.deriveEntrypoints(...args),
        projectRetainedPortFamilyResult: (...args: Parameters<typeof actual.projectRetainedPortFamilyResult>) => applicationOwners.ports.projectRetainedPortFamilyResult?.(...args) ?? actual.projectRetainedPortFamilyResult(...args),
        releasePortFamily: (...args: Parameters<typeof actual.releasePortFamily>) => applicationOwners.ports.releasePortFamily?.(...args) ?? actual.releasePortFamily(...args),
        compensateAcquiredPortHolder: (...args: Parameters<typeof actual.compensateAcquiredPortHolder>) => applicationOwners.ports.compensateAcquiredPortHolder?.(...args) ?? actual.compensateAcquiredPortHolder(...args),
    }
})
vi.mock('./runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./runtime.js')>()
    return {
        ...actual,
        createRuntimeServicePlan: (...args: Parameters<typeof actual.createRuntimeServicePlan>) => applicationOwners.runtime.createRuntimeServicePlan?.(...args) ?? actual.createRuntimeServicePlan(...args),
        admitRuntimeServiceStageOutcome: (...args: Parameters<typeof actual.admitRuntimeServiceStageOutcome>) => applicationOwners.runtime.admitRuntimeServiceStageOutcome?.(...args) ?? actual.admitRuntimeServiceStageOutcome(...args),
        createRuntimeServiceHealthPlan: (...args: Parameters<typeof actual.createRuntimeServiceHealthPlan>) => applicationOwners.runtime.createRuntimeServiceHealthPlan?.(...args) ?? actual.createRuntimeServiceHealthPlan(...args),
        admitRuntimeServiceInspectFailure: (...args: Parameters<typeof actual.admitRuntimeServiceInspectFailure>) => applicationOwners.runtime.admitRuntimeServiceInspectFailure?.(...args) ?? actual.admitRuntimeServiceInspectFailure(...args),
        admitRuntimeServiceObservation: (...args: Parameters<typeof actual.admitRuntimeServiceObservation>) => applicationOwners.runtime.admitRuntimeServiceObservation?.(...args) ?? actual.admitRuntimeServiceObservation(...args),
        admitRuntimeServiceHealth: (...args: Parameters<typeof actual.admitRuntimeServiceHealth>) => applicationOwners.runtime.admitRuntimeServiceHealth?.(...args) ?? actual.admitRuntimeServiceHealth(...args),
        createRuntimeServiceRevalidationPlan: (...args: Parameters<typeof actual.createRuntimeServiceRevalidationPlan>) => applicationOwners.runtime.createRuntimeServiceRevalidationPlan?.(...args) ?? actual.createRuntimeServiceRevalidationPlan(...args),
        admitRuntimeServiceRevalidationStatus: (...args: Parameters<typeof actual.admitRuntimeServiceRevalidationStatus>) => applicationOwners.runtime.admitRuntimeServiceRevalidationStatus?.(...args) ?? actual.admitRuntimeServiceRevalidationStatus(...args),
        admitRuntimeServiceRevalidation: (...args: Parameters<typeof actual.admitRuntimeServiceRevalidation>) => applicationOwners.runtime.admitRuntimeServiceRevalidation?.(...args) ?? actual.admitRuntimeServiceRevalidation(...args),
        createRuntimeStopPlan: (...args: Parameters<typeof actual.createRuntimeStopPlan>) => applicationOwners.runtime.createRuntimeStopPlan?.(...args) ?? actual.createRuntimeStopPlan(...args),
        createRuntimeStopObservationPlan: (...args: Parameters<typeof actual.createRuntimeStopObservationPlan>) => applicationOwners.runtime.createRuntimeStopObservationPlan?.(...args) ?? actual.createRuntimeStopObservationPlan(...args),
        admitRuntimeStopped: (...args: Parameters<typeof actual.admitRuntimeStopped>) => applicationOwners.runtime.admitRuntimeStopped?.(...args) ?? actual.admitRuntimeStopped(...args),
        consumeRuntimeStopped: (...args: Parameters<typeof actual.consumeRuntimeStopped>) => applicationOwners.runtime.consumeRuntimeStopped?.(...args) ?? actual.consumeRuntimeStopped(...args),
        admitRuntimeStopFailure: (...args: Parameters<typeof actual.admitRuntimeStopFailure>) => applicationOwners.runtime.admitRuntimeStopFailure?.(...args) ?? actual.admitRuntimeStopFailure(...args),
        consumeRuntimeStopFailure: (...args: Parameters<typeof actual.consumeRuntimeStopFailure>) => applicationOwners.runtime.consumeRuntimeStopFailure?.(...args) ?? actual.consumeRuntimeStopFailure(...args),
        resolveRuntimeServiceOrder: (...args: Parameters<typeof actual.resolveRuntimeServiceOrder>) => applicationOwners.runtime.resolveRuntimeServiceOrder?.(...args) ?? actual.resolveRuntimeServiceOrder(...args),
        observeRuntimeServiceColdStart: (...args: Parameters<typeof actual.observeRuntimeServiceColdStart>) => applicationOwners.runtime.observeRuntimeServiceColdStart?.(...args) ?? actual.observeRuntimeServiceColdStart(...args),
    }
})
vi.mock('./claims.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./claims.js')>()
    return {
        ...actual,
        reserveDrain: (...args: Parameters<typeof actual.reserveDrain>) => applicationOwners.claims.reserveDrain?.(...args) ?? actual.reserveDrain(...args),
        recoverDrainReservation: (...args: Parameters<typeof actual.recoverDrainReservation>) => applicationOwners.claims.recoverDrainReservation?.(...args) ?? actual.recoverDrainReservation(...args),
        inspectSleepDrainRecovery: (...args: Parameters<typeof actual.inspectSleepDrainRecovery>) => applicationOwners.claims.inspectSleepDrainRecovery?.(...args) ?? actual.inspectSleepDrainRecovery(...args),
        recoverSleepDrainReservation: (...args: Parameters<typeof actual.recoverSleepDrainReservation>) => applicationOwners.claims.recoverSleepDrainReservation?.(...args) ?? actual.recoverSleepDrainReservation(...args),
        reserveDrainAttempt: (...args: Parameters<typeof actual.reserveDrainAttempt>) => applicationOwners.claims.reserveDrainAttempt?.(...args) ?? actual.reserveDrainAttempt(...args),
        prepareDrainOutcomePublication: (...args: Parameters<typeof actual.prepareDrainOutcomePublication>) => applicationOwners.claims.prepareDrainOutcomePublication?.(...args) ?? actual.prepareDrainOutcomePublication(...args),
        finalizeDrainOutcome: (...args: Parameters<typeof actual.finalizeDrainOutcome>) => applicationOwners.claims.finalizeDrainOutcome?.(...args) ?? actual.finalizeDrainOutcome(...args),
    }
})
vi.mock('./reclaim.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./reclaim.js')>()
    return {
        ...actual,
        planReset: (...args: Parameters<typeof actual.planReset>) => applicationOwners.reclaim.planReset?.(...args) ?? actual.planReset(...args),
        planTeardown: (...args: Parameters<typeof actual.planTeardown>) => applicationOwners.reclaim.planTeardown?.(...args) ?? actual.planTeardown(...args),
        projectResetActionTargets: (...args: Parameters<typeof actual.projectResetActionTargets>) => applicationOwners.reclaim.projectResetActionTargets?.(...args) ?? actual.projectResetActionTargets(...args),
        projectTeardownActionTargets: (...args: Parameters<typeof actual.projectTeardownActionTargets>) => applicationOwners.reclaim.projectTeardownActionTargets?.(...args) ?? actual.projectTeardownActionTargets(...args),
        redeemReclaimAction: (...args: Parameters<typeof actual.redeemReclaimAction>) => applicationOwners.reclaim.redeemReclaimAction?.(...args) ?? actual.redeemReclaimAction(...args),
        reconcileReclaimAction: (...args: Parameters<typeof actual.reconcileReclaimAction>) => applicationOwners.reclaim.reconcileReclaimAction?.(...args) ?? actual.reconcileReclaimAction(...args),
        admitReclaimFailure: (...args: Parameters<typeof actual.admitReclaimFailure>) => applicationOwners.reclaim.admitReclaimFailure?.(...args) ?? actual.admitReclaimFailure(...args),
        consumeReclaimFailure: (...args: Parameters<typeof actual.consumeReclaimFailure>) => applicationOwners.reclaim.consumeReclaimFailure?.(...args) ?? actual.consumeReclaimFailure(...args),
        consumeReclaimCompleted: (...args: Parameters<typeof actual.consumeReclaimCompleted>) => applicationOwners.reclaim.consumeReclaimCompleted?.(...args) ?? actual.consumeReclaimCompleted(...args),
    }
})
vi.mock('./state.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./state.js')>()
    return {
        ...actual,
        readState: (...args: Parameters<typeof actual.readState>) => applicationOwners.state.readState?.(...args) ?? actual.readState(...args),
    }
})
vi.mock('./logs.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./logs.js')>()
    return {
        ...actual,
        planLogs: (...args: Parameters<typeof actual.planLogs>) => applicationOwners.logs.planLogs?.(...args) ?? actual.planLogs(...args),
        collectLogs: (...args: Parameters<typeof actual.collectLogs>) => applicationOwners.logs.collectLogs?.(...args) ?? actual.collectLogs(...args),
        planFailureLogs: (...args: Parameters<typeof actual.planFailureLogs>) => applicationOwners.logs.planFailureLogs?.(...args) ?? actual.planFailureLogs(...args),
        admitFailureLogs: (...args: Parameters<typeof actual.admitFailureLogs>) => applicationOwners.logs.admitFailureLogs?.(...args) ?? actual.admitFailureLogs(...args),
    }
})
vi.mock('./observations.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./observations.js')>()
    return {
        ...actual,
        aggregateObservations: (...args: Parameters<typeof actual.aggregateObservations>) => applicationOwners.observations.aggregateObservations?.(...args) ?? actual.aggregateObservations(...args),
        projectDoctor: (...args: Parameters<typeof actual.projectDoctor>) => applicationOwners.observations.projectDoctor?.(...args) ?? actual.projectDoctor(...args),
    }
})
vi.mock('./git-observation.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./git-observation.js')>()
    return {
        ...actual,
        createGitObservationStep: (...args: Parameters<typeof actual.createGitObservationStep>) => applicationOwners.gitObservation.createGitObservationStep?.(...args) ?? actual.createGitObservationStep(...args),
        observeGit: (...args: Parameters<typeof actual.observeGit>) => applicationOwners.gitObservation.observeGit?.(...args) ?? actual.observeGit(...args),
        createComparisonRemoteRefStep: (...args: Parameters<typeof actual.createComparisonRemoteRefStep>) => applicationOwners.gitObservation.createComparisonRemoteRefStep?.(...args) ?? actual.createComparisonRemoteRefStep(...args),
        observeComparisonRemoteRef: (...args: Parameters<typeof actual.observeComparisonRemoteRef>) => applicationOwners.gitObservation.observeComparisonRemoteRef?.(...args) ?? actual.observeComparisonRemoteRef(...args),
        observeComparisonRemoteUrl: (...args: Parameters<typeof actual.observeComparisonRemoteUrl>) => applicationOwners.gitObservation.observeComparisonRemoteUrl?.(...args) ?? actual.observeComparisonRemoteUrl(...args),
        observeComparisonRemoteRevalidation: (...args: Parameters<typeof actual.observeComparisonRemoteRevalidation>) => applicationOwners.gitObservation.observeComparisonRemoteRevalidation?.(...args) ?? actual.observeComparisonRemoteRevalidation(...args),
    }
})
vi.mock('./evidence.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./evidence.js')>()
    return {
        ...actual,
        environmentBaselineConfirmation: (...args: Parameters<typeof actual.environmentBaselineConfirmation>) => applicationOwners.evidence.environmentBaselineConfirmation?.(...args) ?? actual.environmentBaselineConfirmation(...args),
        recordEnvironmentBaseline: (...args: Parameters<typeof actual.recordEnvironmentBaseline>) => applicationOwners.evidence.recordEnvironmentBaseline?.(...args) ?? actual.recordEnvironmentBaseline(...args),
    }
})
import { consumeLoadedConfigProjection, loadCockpitConfig, type LoadedCockpitConfig } from '../config/load.js'
import {
    beginOperatorReset,
    issueDestructiveRunContext,
    issueSetupRunContext,
    issueLifecycleRunContext,
    prepareGuardEvaluationPolicy,
    runGuardEvaluationApplication,
    type GuardEvaluationApplicationInput,
    withLifecycleConfiguration,
    decodeLifecycleRecord,
    runDown,
    runSleep,
    runPreflight,
    runDoctor,
    runLogs,
    runBaselineRecord,
    beginOperatorBaselineRecord,
    runReset,
    runSession,
    runSetup as runSetupSequence,
    runUp,
    setupEnvironment,
    type SetupCommandAdapters,
    type LifecycleRunContextInput,
    type LifecycleRunContext,
    type SetupRunContextInput,
    type SetupRunContext,
    type HealthObservationSource,
    type HealthObservationSourceInput,
    type DoctorSurfaceOverrideInspection,
} from './application.js'
import type { SetupObservation, SetupResult } from './setup.js'
import {
    observeSetupCheckout,
    withSetupCheckoutProjection,
} from './setup-observation.js'
import { decodeCoordinationRecord } from './claims.js'
import { lifecycleHistoryAddress, readState, selectStateRoot, transactState } from './state.js'
import { recordLifecycleStarted, recordLifecycleSeeded, resolveLifecycleStage, projectLifecycleStage } from './lifecycle-stage.js'
import type { PreflightContext } from './observations.js'
import { checkoutId, cockpitId, holderId, stackId } from './identity.js'
import type { InstallPolicy, Sibling } from '../schema.js'
import { CockpitConfig } from '../schema.js'
import { GuardCommandArgv } from '../schema.js'
import { renderGuardProjectCommand } from './install-policy.js'
import type { EnvironmentSeedPlan } from './templates.js'
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
    executionMode: 'staged' as const,
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

    it('keeps a declined operator session one-shot and performs no destructive work', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        applicationOwners.reclaim.planReset = async () => Object.freeze({
            kind: 'preview', digest: '2'.repeat(64), coordinationRevision: 8,
            targets: Object.freeze([]), noop: true, consent: Object.freeze({}),
        }) as never
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
        expect(applicationOwners.claims.reserveDrain).toBeUndefined()
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
        expect(calls).toBe(2)
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
        const request = Object.freeze({ planDigest: '3'.repeat(64) })
        const lifecyclePlan = Object.freeze({ diagnostics: Object.freeze([]) })
        applicationOwners.lifecycle.planResetLifecycle = () => ({ kind: 'drain', plan: lifecyclePlan, request }) as never
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: Object.freeze({}), drainRequest: request, reclaim: { purpose: 'reset' },
        }) as never
        applicationOwners.claims.reserveDrain = async () => {
            events.push('reservation')
            return {
                kind: 'complete', authority: Object.freeze({}),
                reservation: Object.freeze({ completedActionCount: 0 }),
            } as never
        }
        applicationOwners.claims.recoverDrainReservation = async () => ({ kind: 'refusal', diagnostics: [] }) as never
        applicationOwners.claims.reserveDrainAttempt = async () => {
            events.push('attempt')
            return { kind: 'complete', authority: Object.freeze({}) } as never
        }
        applicationOwners.runtime.createRuntimeStopPlan = () => ({ kind: 'planned', step: { id: 'runtime-stop' } }) as never
        applicationOwners.runtime.createRuntimeStopObservationPlan = () => ({ kind: 'planned', step: { id: 'runtime-observe' } }) as never
        applicationOwners.runtime.admitRuntimeStopped = () => ({ kind: 'complete', authority: Object.freeze({}) }) as never
        applicationOwners.runtime.consumeRuntimeStopped = () => Object.freeze({}) as never
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
        expect(result).toMatchObject({ kind: 'complete', result: { stackId: context.stackId, change: 'reset' } })
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
            return { step: { id: 'reclaim' }, authority: {} } as never
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
        const recover = vi.fn()
        applicationOwners.claims.recoverDrainReservation = recover
        const execute = vi.fn()

        await expect(runDown({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            observe: async () => resetObservation(instance, failedRecord), execute,
        })).resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'DRAIN_ATTEMPT_REPAIR_REQUIRED' }] })
        expect(recover).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it('uses recovered failed-action authority without trying to recover the same epoch twice', async () => {
        const { configPath, context, instance } = await destructiveFixture()
        const failedRecord = persistFailedDestructiveRecord(context, 'reset')
        expect(decodeCoordinationRecord(failedRecord as never, context.stackId)).toBeDefined()
        const events: string[] = []
        let resetCalls = 0
        applicationOwners.reclaim.planReset = async () => {
            resetCalls += 1
            return resetCalls === 1 ? {
                kind: 'preview', digest: '5'.repeat(64), coordinationRevision: 11,
                targets: [{ kind: 'volume', identity: 'synthetic-volume', declaration: 'data' }],
                noop: false, consent: {},
            } as never : {
                kind: 'complete', step: { id: 'reclaim' }, actionAuthority: {}, remaining: 1,
                noop: false, digest: '5'.repeat(64), continuation: {},
            } as never
        }
        applicationOwners.reclaim.projectResetActionTargets = () => ({}) as never
        const recoveredRequest = persistedDrainRequest(context, failedRecord)
        const request = { ...recoveredRequest, expectedCoordinationRevision: failedRecord.revision }
        const planResetLifecycle = vi.fn(() => ({ kind: 'drain', plan: { diagnostics: [] }, request }) as never)
        applicationOwners.lifecycle.planResetLifecycle = planResetLifecycle
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: {}, drainRequest: request, reclaim: { purpose: 'reset' },
        }) as never
        applicationOwners.claims.reserveDrainAttempt = async () => {
            events.push('attempt')
            return { kind: 'complete', authority: {} } as never
        }
        applicationOwners.reclaim.redeemReclaimAction = async () => {
            events.push('redeem')
            return { step: { id: 'reclaim' }, authority: {} } as never
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
        expect(events).toEqual(['attempt', 'redeem', 'execute', 'reconcile', 'publish'])
    })
})
afterEach(() => {
    vi.restoreAllMocks()
    applicationOwners.lifecycle = {}
    applicationOwners.runtime = {}
    applicationOwners.logs = {}
    applicationOwners.claims = {}
    applicationOwners.reclaim = {}
    applicationOwners.state = {}
    applicationOwners.ports = {}
    applicationOwners.registryDerivation = {}
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})
afterAll(() => rmSync(gitDirectory, { recursive: true, force: true }))

const { fixture, derivedRegistrySource, unissuedContextFixture, authorizeContext, runContextInput, issueContext, lifecycleContextFixture, issueLifecycleContext, issueFromFreshCheckout, available, cloneObservations, fileIdentity, readySeed, baseSibling, tomlValue, sequenceSource, sequenceFixture } = createApplicationFixtureSupport(scratch, gitExecutable)
