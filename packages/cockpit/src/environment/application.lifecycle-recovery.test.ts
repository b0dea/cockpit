import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as generatedCurrentnessOwner from './generated-application.js'
import { executeProbe } from '../environment-exec/execute.js'
import { evaluateGuard } from '../guards/evaluator.js'
import { parseGuardInput } from '../guards/invocation-parser.js'
import { shellPayload } from '../guards/fixtures/invocation-corpus.js'
import { parseOwnershipManifest } from '../surfaces/ownership.js'
import type { ExecutionStep, StackId } from './contract.js'
import { createMachineFloorPlan, collectMachineFloorEvidence, issueMachineFloorAuthority } from './runtime.js'
import { observeHostCapacity } from './host-observation.js'
import { projectMachineFloorConfig } from '../config/load.js'
const executionFence = (id: string) => {
    const attemptId = createHash('sha256').update(`${process.pid}:${id}`).digest('hex')
    const socketRoot = process.platform === 'darwin' ? `/private/tmp/cockpit-exec-${process.getuid?.() ?? 0}` : `/tmp/cockpit-exec-${process.getuid?.() ?? 0}`
    return { attemptId, markerPath: join(tmpdir(), `cockpit-test-${attemptId}.json`), socketPath: join(socketRoot, `${attemptId.slice(0, 24)}.sock`) }
}
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
    executionMode: 'verified-path' as const,
}

function stubUpPlanner(planner: typeof import('./lifecycle.js').planUp): void {
    const inputs = new WeakMap<object, Parameters<typeof import('./lifecycle.js').admitUpProgress>[0]>()
    applicationOwners.lifecycle.admitUpProgress = (input) => {
        const authority = Object.freeze({}) as import('./lifecycle.js').UpPlanningAuthority
        inputs.set(authority, input)
        return { kind: 'admitted', authority }
    }
    applicationOwners.lifecycle.planAdmittedUp = ({ authority, completedServices }) => {
        const input = inputs.get(authority)
        if (!input) throw new Error('fixture up authority was not admitted')
        inputs.delete(authority)
        return planner({ ...input, completedServices })
    }
}

function stubColdStart(stackId: StackId, measuredMillis = 1_250, limitMillis = 30_000): void {
    applicationOwners.runtime.observeRuntimeServiceColdStart = () => ({
        code: 'MACHINE_COLD_START_EXCEEDED', owner: 'runtime-planning', stackId, source: 'api',
        observed: { state: 'available', value: measuredMillis, observedAt: new Date().toISOString() },
        expectation: { kind: 'maximum', value: limitMillis }, applicability: { state: 'required', posture: 'environment' },
        freshness: { state: 'current' }, remedy: 'restore the declared cold-start budget',
    } as never)
}

describe('lifecycle application contracts', () => {
    it('refuses lifecycle transfer when the previous holder reacquires after the port projection', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const previousHolder = `holder:${'f'.repeat(64)}:session` as const
        const now = new Date().toISOString()
        const lifecycleAddress = context.namespace.paths.lifecycle(context.stackId)
        await transactState(context.namespace, lifecycleAddress, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: now,
            value: {
                holderId: previousHolder, workBasisSha256: 'a'.repeat(64),
                operationGeneration: 'b'.repeat(64), completedServices: [],
            },
        }))
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const coordinationAddress = context.namespace.paths.coordination(context.stackId)
        await transactState(context.namespace, coordinationAddress, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'coordination', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: now,
            value: {
                holders: [
                    { holderId: context.holderId, checkoutId: context.checkoutId, claimedAt: now },
                    { holderId: previousHolder, checkoutId: context.checkoutId, claimedAt: now },
                ],
                lease: {
                    offset: lease.offset, ports: lease.ports, released: false,
                    declaration: { step: context.ports.step, count: context.ports.count, bases: { ...context.ports.bases } },
                },
                lastReleasedHolder: null,
                drain: null,
            },
        }))
        stubUpPlanner(() => ({
            kind: 'noop', mode: 'resume',
            plan: {
                progress: { workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64), completedServices: [] },
                diagnostics: [],
            },
        } as never))
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: { services: [{ id: 'api' }] }, firstIncompleteServiceIndex: 1,
            portOwnership: { holderId: context.holderId }, drainRequest: null, reclaim: null,
        } as never)
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: { services: [{ id: 'api' }] }, lifecycle: {} } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({
                retainOnFailure: vi.fn(),
                leaseResult: {
                    kind: 'complete', change: 'unchanged', holderId: context.holderId,
                    recordRevision: 0, lease, observation: 'resolved-listener-evidence-accepted',
                },
                projection: {
                    lease,
                    ownership: {
                        change: 'unchanged', holderId: context.holderId, recordRevision: 0,
                        holderCount: 1, holderIds: [context.holderId],
                    },
                    entrypoints: [],
                },
            } as never),
            execute: vi.fn(),
        })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'CLAIM_CO_TENANT',
            message: `lifecycle progress belongs to another active session; run \`npx --no cockpit up --config ${configPath}\` to resume it or \`npx --no cockpit down --config ${configPath}\` to release it`,
        }] })
        expect(await readState(lifecycleAddress)).toMatchObject({
            kind: 'complete', value: { value: { holderId: previousHolder } },
        })
    })

    it('refuses stale completed progress retained by an active co-tenant after one readiness round', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const previousHolder = `holder:${'f'.repeat(64)}:session` as const
        const lifecycleAddress = context.namespace.paths.lifecycle(context.stackId)
        await transactState(context.namespace, lifecycleAddress, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: new Date().toISOString(),
            value: {
                holderId: previousHolder, workBasisSha256: 'a'.repeat(64),
                operationGeneration: 'b'.repeat(64),
                completedServices: [{ service: 'api', containerId: 'c'.repeat(64) }],
            },
        }))
        const topology = Object.freeze({ services: Object.freeze([{ id: 'api' }]) })
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        applicationOwners.runtime.createRuntimeServiceRevalidationPlan = () => ({
            kind: 'planned', status: { id: 'api:status' }, identity: { id: 'api:identity' },
        } as never)
        applicationOwners.runtime.admitRuntimeServiceRevalidationStatus = () => ({ kind: 'stale' } as never)
        const readinessCounts = { runtime: 0, stage: 0, ports: 0 }
        const executed: string[] = []

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => {
                readinessCounts.runtime += 1
                return use({ topology, lifecycle: {} } as never)
            },
            withLifecycleStage: async (_context, use) => {
                readinessCounts.stage += 1
                return use({} as never)
            },
            withAcquiredPorts: async (_context, use) => {
                readinessCounts.ports += 1
                return use({
                    retainOnFailure: vi.fn(),
                    leaseResult: {
                        kind: 'complete', change: 'unchanged', holderId: context.holderId,
                        recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted',
                    },
                    projection: {
                        lease,
                        ownership: {
                            change: 'unchanged', holderId: context.holderId, recordRevision: 2,
                            holderCount: 2, holderIds: [context.holderId, previousHolder],
                        },
                        entrypoints: [],
                    },
                } as never)
            },
            execute: async (step) => {
                executed.push(step.id)
                return {} as never
            },
        })

        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [{
                code: 'CLAIM_CO_TENANT',
                message: 'completed lifecycle progress belongs to an active holder but its runtime evidence is stale',
                target: context.stackId,
            }],
        })
        expect(readinessCounts).toEqual({ runtime: 1, stage: 1, ports: 1 })
        expect(executed).toEqual(['api:status'])
        expect(await readState(lifecycleAddress)).toMatchObject({
            kind: 'complete', value: { value: { holderId: previousHolder } },
        })
    })

    it('surfaces failure to compensate the holder acquired by this invocation', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const leaseResult = Object.freeze({
            kind: 'complete' as const, change: 'acquired' as const, holderId: context.holderId,
            recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted' as const,
        })
        const projection = Object.freeze({
            lease,
            ownership: Object.freeze({
                change: 'acquired' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        stubUpPlanner(() => ({
            kind: 'refusal', diagnostics: [{ severity: 'error', code: 'LIFECYCLE_EVIDENCE_INVALID', message: 'invalid' }],
        } as never))
        applicationOwners.ports.compensateAcquiredPortHolder = async () => ({
            kind: 'refusal', diagnostics: [{ severity: 'error', code: 'CLAIM_CO_TENANT', message: 'coordination changed', target: context.stackId }],
        })

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {} } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({ leaseResult, projection, retainOnFailure: vi.fn() } as never),
            execute: vi.fn(),
        })

        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: [
                { code: 'LIFECYCLE_EVIDENCE_INVALID' },
                { code: 'CLAIM_CO_TENANT', message: 'coordination changed' },
            ],
        })
    })

    it.each(['', 'holder:anything:session', 'holder:\0:session'])('rejects malformed persisted holder identity %j', async (persistedHolder) => {
        const { configPath, context } = await lifecycleContextFixture()
        const address = context.namespace.paths.lifecycle(context.stackId)
        await transactState(context.namespace, address, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: new Date().toISOString(),
            value: {
                holderId: persistedHolder, workBasisSha256: 'a'.repeat(64),
                operationGeneration: 'b'.repeat(64), completedServices: [],
            },
        }))
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const leaseResult = Object.freeze({
            kind: 'complete' as const, change: 'unchanged' as const, holderId: context.holderId,
            recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted' as const,
        })
        const projection = Object.freeze({
            lease,
            ownership: Object.freeze({
                change: 'unchanged' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {} } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({ leaseResult, projection, retainOnFailure: vi.fn() } as never),
            execute: vi.fn(),
        })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'STATE_RECORD_MALFORMED' }] })
    })

    it('resets changed lifecycle work of a partial startup before revalidating its old containers', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const address = context.namespace.paths.lifecycle(context.stackId)
        await transactState(context.namespace, address, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: new Date().toISOString(),
            value: {
                holderId: context.holderId, workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64),
                completedServices: [{ service: 'api', containerId: 'c'.repeat(64) }],
            },
        }))
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const leaseResult = Object.freeze({
            kind: 'complete' as const, change: 'unchanged' as const, holderId: context.holderId,
            recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted' as const,
        })
        const projection = Object.freeze({
            lease,
            ownership: Object.freeze({
                change: 'unchanged' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        const events: string[] = []
        const plannerInputs: unknown[] = []
        applicationOwners.lifecycle.admitUpProgress = (input) => {
            plannerInputs.push(input)
            if (input.progress !== null) {
                events.push('admission-refusal')
                return { kind: 'refusal', diagnostics: [{ severity: 'error', code: 'LIFECYCLE_PROGRESS_INVALID', message: 'work changed' }] }
            }
            events.push('reset-admission')
            return { kind: 'admitted', authority: Object.freeze({}) as never }
        }
        applicationOwners.lifecycle.planAdmittedUp = ({ completedServices }) => {
            events.push('reset-finalization')
            expect(completedServices).toEqual([])
            return {
                kind: 'execute', mode: 'start',
                plan: {
                    progress: { workBasisSha256: 'd'.repeat(64), operationGeneration: (plannerInputs[1] as { operationGeneration: string }).operationGeneration, completedServices: [] },
                    diagnostics: [],
                },
            } as never
        }
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: { services: [{ id: 'api' }] }, firstIncompleteServiceIndex: 0,
            portOwnership: { holderId: context.holderId }, drainRequest: null, reclaim: null,
        } as never)
        applicationOwners.runtime.createRuntimeServiceRevalidationPlan = () => {
            events.push('revalidate')
            return { kind: 'unavailable' } as never
        }
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']
        applicationOwners.runtime.createRuntimeServicePlan = () => ({
            kind: 'planned', service: 'api',
            start: { id: 'start' }, status: { id: 'status' }, identity: { id: 'identity' },
        } as never)
        applicationOwners.runtime.admitRuntimeServiceStageOutcome = () => ({ kind: 'admitted' } as never)
        applicationOwners.runtime.createRuntimeServiceHealthPlan = () => ({ kind: 'planned', service: 'api', step: { id: 'inspect' } } as never)
        applicationOwners.runtime.admitRuntimeServiceInspectFailure = () => ({ kind: 'unavailable' } as never)
        applicationOwners.runtime.admitRuntimeServiceObservation = () => ({
            kind: 'complete', observation: { service: 'api', containerId: 'e'.repeat(64) },
        } as never)
        applicationOwners.runtime.admitRuntimeServiceHealth = ({ observation }) => ({ kind: 'complete', evidence: observation } as never)
        stubColdStart(context.stackId)

        await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: { services: [{ id: 'db' }, { id: 'api' }] }, lifecycle: {} } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({ leaseResult, projection, retainOnFailure: vi.fn() } as never),
            execute: async (step) => {
                if (step.id === 'start') {
                    events.push('start')
                    expect(await readState(address)).toMatchObject({
                        kind: 'complete',
                        value: {
                            value: {
                                workBasisSha256: 'd'.repeat(64),
                                operationGeneration: (plannerInputs[1] as { operationGeneration: string }).operationGeneration,
                                completedServices: [],
                            },
                        },
                    })
                }
                return {} as never
            },
        })

        expect(events).toEqual(['admission-refusal', 'reset-admission', 'reset-finalization', 'start'])
        expect(plannerInputs).toEqual([
            expect.objectContaining({ progress: { workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64), completedServices: [{ service: 'api', containerId: 'c'.repeat(64) }] } }),
            expect.objectContaining({ progress: null }),
        ])
    })

    // A fully started compose-first stack whose declaration changed was restarted from scratch, which
    // recreated healthy containers and stopped them when their labels no longer matched.
    it('refuses changed work on a fully started compose-first stack and starts nothing', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        await transactState(context.namespace, context.namespace.paths.lifecycle(context.stackId), { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: new Date().toISOString(),
            value: {
                holderId: context.holderId, workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64),
                completedServices: [{ service: 'api', containerId: 'c'.repeat(64) }],
            },
        }))
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const projection = Object.freeze({
            lease, entrypoints: Object.freeze([]),
            ownership: Object.freeze({ change: 'unchanged' as const, holderId: context.holderId, recordRevision: 2, holderCount: 1, holderIds: Object.freeze([context.holderId]) }),
        })
        const leaseResult = Object.freeze({ kind: 'complete' as const, change: 'unchanged' as const, holderId: context.holderId,
            recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted' as const })
        applicationOwners.lifecycle.admitUpProgress = () => ({ kind: 'refusal', diagnostics: [{ severity: 'error', code: 'LIFECYCLE_PROGRESS_INVALID', message: 'work changed' }] })
        const execute = vi.fn(async () => ({}) as never)

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: { services: [{ id: 'api' }] }, lifecycle: {} } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({ leaseResult, projection, retainOnFailure: vi.fn() } as never),
            execute,
        })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_PROGRESS_INVALID',
            message: expect.stringContaining('up does not replace a running stack') }] })
        expect(execute).not.toHaveBeenCalled()
    })

    it('resumes a completed dependency prefix in one readiness round', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const address = context.namespace.paths.lifecycle(context.stackId)
        const completedContainerId = 'c'.repeat(64)
        const observedAt = new Date().toISOString()
        expect(await recordLifecycleStarted({
            namespace: context.namespace,
            stackId: context.stackId,
            holderId: context.holderId,
            observedAt,
        })).toMatchObject({ kind: 'complete' })
        await transactState(context.namespace, address, { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId,
            subjectId: context.stackId, revision: 0, updatedAt: observedAt,
            value: {
                holderId: context.holderId, workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64),
                completedServices: [{ service: 'api', containerId: completedContainerId }],
            },
        }))
        const topology = Object.freeze({ services: Object.freeze([{ id: 'api' }, { id: 'web' }]) })
        let revalidated: unknown
        const events: string[] = []
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        stubUpPlanner((input) => {
            events.push('finalize')
            expect(input.progress).toMatchObject({ completedServices: [{ service: 'api', containerId: completedContainerId }] })
            expect(input.completedServices).toEqual([revalidated])
            expect(input.completedServices[0]).toBe(revalidated)
            return {
                kind: 'execute', mode: 'resume',
                plan: {
                    progress: {
                        workBasisSha256: 'a'.repeat(64),
                        operationGeneration: input.operationGeneration,
                        completedServices: [{ service: 'api', containerId: completedContainerId }],
                    },
                    diagnostics: [],
                },
            } as never
        })
        const admit = applicationOwners.lifecycle.admitUpProgress!
        applicationOwners.lifecycle.admitUpProgress = (input) => { events.push('admit'); return admit(input) }
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology,
            firstIncompleteServiceIndex: 1,
            portOwnership: { holderId: context.holderId }, drainRequest: null, reclaim: null,
        } as never)
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api', 'web']
        applicationOwners.runtime.createRuntimeServiceRevalidationPlan = () => {
            events.push('revalidate')
            return { kind: 'planned', status: { id: 'api:status' }, identity: { id: 'api:identity' } } as never
        }
        applicationOwners.runtime.admitRuntimeServiceRevalidationStatus = () => {
            executed.push('api:status-admitted')
            return { kind: 'admitted' } as never
        }
        applicationOwners.runtime.admitRuntimeServiceRevalidation = () => ({
            kind: 'planned', plan: { kind: 'planned', service: 'api', step: { id: 'api:inspect' } },
        } as never)
        applicationOwners.runtime.createRuntimeServicePlan = ({ service }) => ({
            kind: 'planned', service,
            start: { id: `${service}:start` }, status: { id: `${service}:status` }, identity: { id: `${service}:identity` },
        } as never)
        applicationOwners.runtime.admitRuntimeServiceStageOutcome = () => ({ kind: 'admitted' } as never)
        applicationOwners.runtime.createRuntimeServiceHealthPlan = ({ plan: servicePlan }) => ({
            kind: 'planned', service: servicePlan.service, step: { id: `${servicePlan.service}:inspect` },
        } as never)
        applicationOwners.runtime.admitRuntimeServiceInspectFailure = () => ({ kind: 'unavailable' } as never)
        applicationOwners.runtime.admitRuntimeServiceObservation = ({ plan: healthPlan }) => ({
            kind: 'complete',
            observation: {
                service: healthPlan.service,
                containerId: healthPlan.service === 'api' ? completedContainerId : 'd'.repeat(64),
            },
        } as never)
        applicationOwners.runtime.admitRuntimeServiceHealth = ({ observation }) => {
            if (observation.service === 'api') revalidated = observation
            return { kind: 'complete', evidence: observation } as never
        }
        stubColdStart(context.stackId)
        const executed: string[] = []
        const readinessCounts = { runtime: 0, stage: 0, ports: 0 }

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => { readinessCounts.runtime += 1; return use({ topology, lifecycle: {} } as never) },
            withLifecycleStage: async (_context, use) => { readinessCounts.stage += 1; return use({} as never) },
            withAcquiredPorts: async (_context, use) => { readinessCounts.ports += 1; return use({
                retainOnFailure: vi.fn(),
                leaseResult: {
                    kind: 'complete', change: 'unchanged', holderId: context.holderId, recordRevision: 2,
                    lease, observation: 'resolved-listener-evidence-accepted',
                },
                projection: {
                    lease,
                    ownership: {
                        change: 'unchanged', holderId: context.holderId, recordRevision: 2,
                        holderCount: 1, holderIds: [context.holderId],
                    },
                    entrypoints: [],
                },
            } as never) },
            execute: async (step) => {
                if (step.id === 'web:start') events.push('start')
                executed.push(step.id)
                return {} as never
            },
        })

        expect(events).toEqual(['admit', 'revalidate', 'finalize', 'start'])
        expect(readinessCounts).toEqual({ runtime: 1, stage: 1, ports: 1 })
        expect(result).toMatchObject({ kind: 'complete', result: { change: 'resumed' } })
        expect(executed).toEqual([
            'api:status', 'api:status-admitted', 'api:identity', 'api:inspect',
            'web:start', 'web:status', 'web:identity', 'web:inspect',
        ])
    })

    it.each([1, 2])('admits same-basis generated progress with one machine, stage, port and runtime readiness round for a %i MB floor', async (memoryFloor) => {
        const source = CockpitConfig.parse(parse(readFileSync(new URL('../../../../fixtures/registries/generated-environment.toml', import.meta.url), 'utf8')))
        source.cockpit.siblings_root = '.'
        source.environment.machine = { runtime_memory_mb: memoryFloor, runtime_cpus: 1, free_disk_mb: 1, cold_start_seconds: 30 }
        const { configPath, context } = await lifecycleContextFixture(stringify(source))
        const root = dirname(configPath)
        mkdirSync(join(root, 'fixtures'), { recursive: true })
        mkdirSync(join(root, 'app'), { recursive: true })
        writeFileSync(join(root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
        writeFileSync(join(root, 'app/package-lock.json'), '{}')
        const published = await generatedCurrentnessOwner.syncGeneratedEnvironment({ configPath })
        if (published.kind !== 'complete') throw new Error(JSON.stringify(published))
        const projection = published.result.application
        const progress = { workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64), completedServices: [] }
        await transactState(context.namespace, context.namespace.paths.lifecycle(context.stackId), { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId, subjectId: context.stackId,
            revision: 0, updatedAt: new Date().toISOString(), value: { ...progress, holderId: context.holderId,
                generatedReplay: { runtimeSha256: projection.runtimeSha256, generation: projection.generation, profiles: [...projection.profiles], mounts: [...projection.mounts] } },
        }))
        const executable = (name: string, body: string) => {
            const path = join(root, name)
            writeFileSync(path, body, { mode: 0o700 })
            return { canonicalPath: path, invocationPath: path, sha256: createHash('sha256').update(body).digest('hex'), executionMode: 'verified-path' as const }
        }
        const docker = executable('docker', '#!/bin/sh\nprintf "1048576|1\\n"\n')
        const disk = executable('disk-fixture', '#!/bin/sh\nprintf "2097152\\n"\n')
        const counts = { machine: 0, stage: 0, ports: 0, runtime: 0 }
        const topology = { services: [{ id: 'app' }] }
        const lease = { stackId: context.stackId, offset: 0, ports: { APP_HOST_PORT: 4100 } }
        stubUpPlanner((input) => {
            expect(input.progress).toEqual(progress)
            expect(input.completedServices).toEqual([])
            return { kind: 'execute', mode: 'resume', plan: { progress, diagnostics: [] } } as never
        })
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({ topology, firstIncompleteServiceIndex: 0,
            portOwnership: { holderId: context.holderId }, drainRequest: null, reclaim: null } as never)
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['app']
        applicationOwners.runtime.createRuntimeServicePlan = () => ({ kind: 'unavailable' } as never)
        const unexpectedCompletion = async () => { throw new Error('unavailable service must refuse before generated completion') }
        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            prepareGeneratedEnvironment: async (_context, ports) => {
                expect(counts.ports).toBe(1)
                expect(ports.lease).toEqual(lease)
                return projection
            },
            completeGeneratedEnvironment: unexpectedCompletion,
            completeGeneratedDependencies: unexpectedCompletion,
            completeGeneratedData: unexpectedCompletion,
            completeGeneratedVendors: unexpectedCompletion,
            withMachineFloorReadiness: async (_context, use) => {
                counts.machine += 1
                const loaded = await loadCockpitConfig(configPath)
                if (loaded.kind !== 'complete') throw new Error('machine fixture configuration unavailable')
                const observedAt = new Date().toISOString()
                const checkout = await observeSetupCheckout({ source: loaded.result.source, cockpitName: source.cockpit.name,
                    observedAt, env: {}, gitExecutable })
                const configuration = projectMachineFloorConfig(loaded.result)
                if (!configuration) throw new Error('machine fixture configuration was not issued')
                const binding = await withSetupCheckoutProjection(checkout, { source: loaded.result.source,
                    cockpitName: source.cockpit.name, evaluatedAt: Date.parse(observedAt) },
                    (projection) => issueMachineFloorAuthority({ configuration, checkout: projection }))
                if (!binding) throw new Error('machine fixture authority was not issued')
                const planned = createMachineFloorPlan({ runtimeExecutable: docker, diskExecutable: disk,
                    cwd: root, env: {}, timeoutMs: 10_000, authority: binding.authority })
                if (planned.kind !== 'preview') throw new Error(`machine fixture plan unavailable: ${JSON.stringify(planned)}`)
                const outcomes = [await executeProbe(planned.plan.steps[0]!), await executeProbe(planned.plan.steps[1]!)] as const
                const evidence = collectMachineFloorEvidence(planned.plan, outcomes)
                if (!evidence) throw new Error(`machine fixture evidence was not admitted: ${JSON.stringify(outcomes)}`)
                return use(observeHostCapacity({ evidence }))
            },
            withRuntimeReadiness: async (_context, use) => { counts.runtime += 1; return use({ topology, lifecycle: {} } as never) },
            withLifecycleStage: async (_context, use) => { counts.stage += 1; return use({} as never) },
            withAcquiredPorts: async (_context, use) => {
                counts.ports += 1
                return use({ retainOnFailure: vi.fn(), leaseResult: { kind: 'complete', change: 'unchanged', holderId: context.holderId,
                    recordRevision: 2, lease }, projection: { lease, ownership: { change: 'unchanged', holderId: context.holderId,
                    recordRevision: 2, holderCount: 1, holderIds: [context.holderId] }, entrypoints: [] } } as never)
            },
            execute: async () => { throw new Error('unavailable service plan must not execute') },
        })
        if (memoryFloor > 1) {
            // The runtime reports 1 MiB, so a 2 MB floor stops bring-up before any stage, and says by how much.
            expect(counts).toEqual({ machine: 1, stage: 0, ports: 1, runtime: 0 })
            expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'MACHINE_MEMORY_BELOW_FLOOR',
                message: 'the container runtime has 1 MB of memory, below the 2 MB that environment.machine.runtime_memory_mb declares',
                fix: expect.stringContaining('lower the declared environment.machine floor') }] })
            return
        }
        expect(counts).toEqual({ machine: 1, stage: 1, ports: 2, runtime: 1 })
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: 'LIFECYCLE_EVIDENCE_INVALID', target: 'app', message: 'runtime service did not become healthy' },
            { code: 'LIFECYCLE_EVIDENCE_INVALID', target: 'app', message: 'bounded failure logs are unavailable' },
        ] })
    })

    it.each([
        ['admitted output', { kind: 'complete', records: [{ service: 'api', timestamp: '2026-09-10T08:00:00.000Z', stream: 'stderr', message: 'database unavailable' }] }, 'database unavailable'],
        ['collection failure', { kind: 'unavailable', code: 'EXECUTION_TIMEOUT', service: 'api', records: [] }, 'failure log collection failed'],
    ] as const)('surfaces %s for a failed runtime service', async (_label, logAdmission, expectedMessage) => {
        const { configPath, context } = await lifecycleContextFixture()
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const projection = Object.freeze({
            lease,
            ownership: Object.freeze({
                change: 'unchanged' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        const servicePlan = Object.freeze({ start: Object.freeze({ id: 'start' }) })
        const failureEvidence = Object.freeze({ service: 'api' })
        const logPlan = Object.freeze({ kind: 'planned' as const, step: Object.freeze({ id: 'logs' }) })
        stubUpPlanner((input) => ({
            kind: 'execute', mode: 'start',
            plan: { progress: { workBasisSha256: 'd'.repeat(64), operationGeneration: input.operationGeneration, completedServices: [] }, diagnostics: [] },
        } as never))
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: { services: [{ id: 'api' }] }, firstIncompleteServiceIndex: 0,
            portOwnership: { holderId: context.holderId }, drainRequest: null, reclaim: null,
        } as never)
        applicationOwners.runtime.createRuntimeServicePlan = () => ({ kind: 'planned', ...servicePlan } as never)
        applicationOwners.runtime.admitRuntimeServiceStageOutcome = () => ({ kind: 'failure', evidence: failureEvidence } as never)
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']
        applicationOwners.logs.planFailureLogs = () => logPlan as never
        applicationOwners.logs.admitFailureLogs = () => logAdmission as never

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {} } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({
                retainOnFailure: vi.fn(),
                leaseResult: { kind: 'complete', change: 'unchanged', holderId: context.holderId, recordRevision: 2, lease },
                projection,
            } as never),
            execute: async () => ({}) as never,
        })

        expect(result).toMatchObject({
            kind: 'refusal',
            diagnostics: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(expectedMessage), target: 'api' })]),
        })
    })

    // A failed up left the failing container restart-looping until down, and turned each of its
    // log lines into its own diagnostic.
    it('stops the service a failed up started and reports its logs as one bounded diagnostic', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const projection = Object.freeze({
            lease,
            ownership: Object.freeze({
                change: 'unchanged' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        stubUpPlanner((input) => ({
            kind: 'execute', mode: 'start',
            plan: { progress: { workBasisSha256: 'd'.repeat(64), operationGeneration: input.operationGeneration, completedServices: [] }, diagnostics: [] },
        } as never))
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: { services: [{ id: 'api' }] }, firstIncompleteServiceIndex: 0,
            portOwnership: { holderId: context.holderId }, drainRequest: null, reclaim: null,
        } as never)
        applicationOwners.runtime.createRuntimeServicePlan = () => ({ kind: 'planned', service: 'api',
            start: { id: 'start' }, stop: { id: 'stop' } } as never)
        applicationOwners.runtime.admitRuntimeServiceStageOutcome = () => ({ kind: 'failure', evidence: { service: 'api' } } as never)
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']
        applicationOwners.logs.planFailureLogs = () => ({ kind: 'planned', step: { id: 'logs' } } as never)
        const records = Array.from({ length: 69 }, (_, index) => ({ service: 'api',
            timestamp: '2026-09-10T08:00:00.000Z', stream: 'stderr', message: `record-${index}-${'x'.repeat(index === 68 ? 5_000 : 10)}` }))
        applicationOwners.logs.admitFailureLogs = () => ({ kind: 'complete', records } as never)
        const executed: string[] = []

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {} } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({
                retainOnFailure: vi.fn(),
                leaseResult: { kind: 'complete', change: 'unchanged', holderId: context.holderId, recordRevision: 2, lease },
                projection,
            } as never),
            execute: async (step) => {
                executed.push(step.id)
                return { kind: step.id === 'stop' ? 'complete' : 'refusal' } as never
            },
        })

        expect(executed).toEqual(['start', 'logs', 'stop'])
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [
            { code: 'LIFECYCLE_EVIDENCE_INVALID', target: 'api', message: 'runtime service did not become healthy' },
            { code: 'EXECUTION_STEP_FAILED', target: 'api', message: expect.stringContaining('69 log lines') },
        ] })
        expect(result.diagnostics).toHaveLength(2)
        const excerpt = result.diagnostics[1]!.message
        expect(excerpt).toContain('record-59-')
        expect(excerpt).toContain('record-68-')
        expect(excerpt).not.toContain('record-58-')
        expect(excerpt.length).toBeLessThan(4_096)
        expect(result.diagnostics[1]!.fix).toContain('stopped')
    })

    it('keeps the lease of a partial startup that reached Compose and completes from its durable prefix on the next invocation', async () => {
        const value = await unissuedContextFixture()
        const firstLoaded = await loadCockpitConfig(value.configPath)
        if (firstLoaded.kind !== 'complete') throw new Error('fixture configuration did not load')
        const identity = await runContextInput(value.candidate, firstLoaded.result)
        const firstIssued = await issueLifecycleContext(value.candidate, firstLoaded.result, identity, firstLoaded.result.source.path)
        const secondLoaded = await loadCockpitConfig(value.configPath)
        if (firstIssued.kind !== 'complete' || secondLoaded.kind !== 'complete') throw new Error('first lifecycle context was not issued')
        const secondIssued = await issueLifecycleContext(value.candidate, secondLoaded.result, identity, secondLoaded.result.source.path)
        if (secondIssued.kind !== 'complete') throw new Error('second lifecycle context was not issued')
        const firstContext = firstIssued.result
        const secondContext = secondIssued.result
        const topology = Object.freeze({ services: Object.freeze([{ id: 'api' }]) })
        const lease = Object.freeze({ stackId: firstContext.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const acquired = Object.freeze({
            kind: 'complete' as const, change: 'acquired' as const, holderId: firstContext.holderId,
            recordRevision: 2, lease, observation: 'resolved-listener-evidence-accepted' as const,
        })
        const unchanged = Object.freeze({ ...acquired, change: 'unchanged' as const, recordRevision: 3 })
        const projection = (change: 'acquired' | 'unchanged', recordRevision: number) => Object.freeze({
            lease,
            ownership: Object.freeze({
                change, holderId: firstContext.holderId, recordRevision,
                holderCount: 1, holderIds: Object.freeze([firstContext.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        const workBasisSha256 = 'd'.repeat(64)
        let planning = 0
        stubUpPlanner((input) => {
            planning += 1
            return {
                kind: 'execute', mode: planning === 2 ? 'resume' : 'start',
                plan: {
                    progress: {
                        workBasisSha256,
                        operationGeneration: input.progress?.operationGeneration ?? input.operationGeneration,
                        completedServices: [],
                    },
                    diagnostics: [],
                },
            } as never
        })
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology, firstIncompleteServiceIndex: 0,
            portOwnership: { holderId: firstContext.holderId }, drainRequest: null, reclaim: null,
        } as never)
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']
        applicationOwners.runtime.createRuntimeServicePlan = () => ({
            kind: 'planned', service: 'api',
            start: { id: 'start' }, status: { id: 'status' }, identity: { id: 'identity' },
        } as never)
        let failing = true
        applicationOwners.runtime.admitRuntimeServiceStageOutcome = () => failing
            ? ({ kind: 'failure', evidence: { service: 'api' } } as never)
            : ({ kind: 'admitted' } as never)
        applicationOwners.runtime.createRuntimeServiceHealthPlan = () => ({ kind: 'planned', service: 'api', step: { id: 'inspect' } } as never)
        applicationOwners.runtime.admitRuntimeServiceInspectFailure = () => ({ kind: 'unavailable' } as never)
        applicationOwners.runtime.admitRuntimeServiceObservation = () => ({
            kind: 'complete', observation: { service: 'api', containerId: 'e'.repeat(64) },
        } as never)
        applicationOwners.runtime.admitRuntimeServiceHealth = ({ observation }) => ({ kind: 'complete', evidence: observation } as never)
        stubColdStart(firstContext.stackId)
        applicationOwners.logs.planFailureLogs = () => ({ kind: 'unavailable', code: 'LOG_EVIDENCE_INVALID', service: 'api' } as never)
        const compensate = vi.fn(async ({ leaseResult }) => {
            expect(leaseResult).toBe(acquired)
            return { kind: 'complete' as const, change: 'compensated' as const, recordRevision: 3, remainingHolderIds: [] }
        })
        applicationOwners.ports.compensateAcquiredPortHolder = compensate
        const readiness = async (_context: LifecycleRunContext, use: (value: unknown) => Promise<unknown>) => use({ topology, lifecycle: {} })
        const stage = async (_context: LifecycleRunContext, use: (value: unknown) => Promise<unknown>) => use({})

        const first = await runUp({ configPath: firstContext.configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: firstContext }),
            withRuntimeReadiness: readiness,
            withLifecycleStage: stage,
            withAcquiredPorts: async (_context: never, use: (value: never) => Promise<unknown>) => use({ leaseResult: acquired, projection: projection('acquired', 2), retainOnFailure: vi.fn() } as never),
            execute: async () => ({}) as never,
        } as never)
        failing = false
        const executed: string[] = []
        const second = await runUp({ configPath: secondContext.configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: secondContext }),
            withRuntimeReadiness: readiness,
            withLifecycleStage: stage,
            withAcquiredPorts: async (_context: never, use: (value: never) => Promise<unknown>) => use({ leaseResult: unchanged, projection: projection('unchanged', 3), retainOnFailure: vi.fn() } as never),
            execute: async (step: { id: string }) => {
                executed.push(step.id)
                return {} as never
            },
        } as never)

        expect(first).toMatchObject({
            kind: 'refusal',
            diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'LIFECYCLE_EVIDENCE_INVALID' })]),
        })
        // The failed start may have left containers on the leased ports, so the holder keeps them.
        expect(compensate).not.toHaveBeenCalled()
        expect(second).toMatchObject({ kind: 'complete', result: { change: 'resumed' } })
        expect(executed).toEqual(['start', 'status', 'identity', 'inspect'])
        expect(await readState(secondContext.namespace.paths.lifecycle(secondContext.stackId))).toMatchObject({
            kind: 'complete',
            value: { value: { workBasisSha256, completedServices: [{ service: 'api', containerId: 'e'.repeat(64) }] } },
        })
    })

    it('releases only the calling holder when another holder retains the runtime', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const retained = Object.freeze({ kind: 'complete' as const, holderId: context.holderId, recordRevision: 4, lease })
        const entrypointResult = Object.freeze({ kind: 'complete' as const, values: Object.freeze([]), diagnostics: Object.freeze([]) })
        const projection = Object.freeze({ ownership: Object.freeze({ holderId: context.holderId, holderCount: 2 }), entrypoints: Object.freeze([]) })
        const plan = Object.freeze({ verb: 'sleep' as const })
        applicationOwners.ports.observeRetainedPortFamily = async () => retained
        applicationOwners.ports.deriveEntrypoints = () => entrypointResult
        applicationOwners.ports.projectRetainedPortFamilyResult = async () => projection as never
        applicationOwners.lifecycle.planSleep = () => ({ kind: 'release-only', plan } as never)
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: {}, firstIncompleteServiceIndex: 0,
            portOwnership: { holderId: context.holderId }, drainRequest: null, reclaim: null,
        } as never)
        applicationOwners.ports.releasePortFamily = async () => ({ kind: 'complete', change: 'retained' })
        const execute = vi.fn()

        const result = await runSleep({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {} } as never),
            execute,
        })

        expect(execute).not.toHaveBeenCalled()
        expect(result).toMatchObject({ kind: 'complete', result: { stackId: context.stackId, change: 'retained' } })
    })

    it('stops the final-holder runtime after its drain attempt is durable', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const events: string[] = []
        // A generated stack's resume is admitted only against the replay identity it ran with.
        const generatedReplay = { runtimeSha256: '8'.repeat(64), generation: '9'.repeat(64), profiles: [], mounts: [] }
        await transactState(context.namespace, context.namespace.paths.lifecycle(context.stackId), { ownerId: context.holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: context.cockpitId, subjectId: context.stackId,
            revision: 0, updatedAt: new Date().toISOString(), value: { workBasisSha256: 'a'.repeat(64), operationGeneration: 'b'.repeat(64),
                completedServices: [{ service: 'api', containerId: 'c'.repeat(64) }], holderId: context.holderId, generatedReplay },
        }))
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        applicationOwners.ports.observeRetainedPortFamily = async () => ({
            kind: 'complete', holderId: context.holderId, recordRevision: 4, lease,
        }) as never
        applicationOwners.ports.deriveEntrypoints = () => ({ kind: 'complete', values: [], diagnostics: [] }) as never
        applicationOwners.ports.projectRetainedPortFamilyResult = async () => ({
            lease,
            ownership: { change: 'unchanged', holderId: context.holderId, recordRevision: 4, holderCount: 1, holderIds: [context.holderId] },
            entrypoints: [],
        }) as never
        const request = Object.freeze({
            holderId: context.holderId,
            operationBasis: '6'.repeat(64),
            generation: '7'.repeat(64),
        })
        const plan = Object.freeze({ diagnostics: Object.freeze([]) })
        applicationOwners.lifecycle.planSleep = () => ({ kind: 'drain', request, plan } as never)
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: {}, firstIncompleteServiceIndex: 0, portOwnership: { holderId: context.holderId },
            drainRequest: request, reclaim: null,
        } as never)
        const reservationAuthority = Object.freeze({ reservation: true })
        const attemptAuthority = Object.freeze({ attempt: true })
        const outcomeAuthority = Object.freeze({ outcome: true })
        applicationOwners.claims.reserveDrain = async () => {
            events.push('reserve')
            return { kind: 'complete', authority: reservationAuthority } as never
        }
        applicationOwners.claims.reserveDrainAttempt = async () => {
            events.push('attempt')
            return { kind: 'complete', authority: attemptAuthority } as never
        }
        applicationOwners.runtime.createRuntimeStopPlan = () => ({ kind: 'planned', step: { id: 'stop', executionFence: executionFence('sleep-stop') } }) as never
        applicationOwners.runtime.createRuntimeStopObservationPlan = () => ({ kind: 'planned', step: { id: 'postcheck' } }) as never
        applicationOwners.runtime.admitRuntimeStopped = () => ({ kind: 'complete', authority: {} }) as never
        applicationOwners.runtime.consumeRuntimeStopped = () => outcomeAuthority as never
        applicationOwners.claims.prepareDrainOutcomePublication = async () => {
            expect(await readState(context.namespace.paths.lifecycle(context.stackId))).toMatchObject({
                kind: 'complete',
                value: {
                    value: {
                        holderId: context.holderId,
                        workBasisSha256: request.operationBasis,
                        operationGeneration: request.generation,
                        completedServices: [],
                        generatedReplay,
                    },
                },
            })
            events.push('publish')
            return { kind: 'complete', value: {} } as never
        }
        applicationOwners.claims.finalizeDrainOutcome = () => {
            events.push('finalize')
            return true
        }

        const result = await runSleep({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {} } as never),
            execute: async (step) => {
                events.push(step.id)
                return {} as never
            },
        })

        expect(events).toEqual(['reserve', 'attempt', 'stop', 'postcheck', 'publish', 'finalize'])
        expect(result).toMatchObject({ kind: 'complete', result: { stackId: context.stackId, change: 'stopped' } })
    })

    it('does not finalize an indeterminate drain publication', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        applicationOwners.ports.observeRetainedPortFamily = async () => ({
            kind: 'complete', holderId: context.holderId, recordRevision: 4, lease,
        }) as never
        applicationOwners.ports.deriveEntrypoints = () => ({ kind: 'complete', values: [], diagnostics: [] }) as never
        applicationOwners.ports.projectRetainedPortFamilyResult = async () => ({
            lease,
            ownership: { change: 'unchanged', holderId: context.holderId, recordRevision: 4, holderCount: 1, holderIds: [context.holderId] },
            entrypoints: [],
        }) as never
        const request = Object.freeze({
            holderId: context.holderId, operationBasis: '6'.repeat(64), generation: '7'.repeat(64),
        })
        applicationOwners.lifecycle.planSleep = () => ({ kind: 'drain', request, plan: { diagnostics: [] } } as never)
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: {}, firstIncompleteServiceIndex: 0, portOwnership: { holderId: context.holderId },
            drainRequest: request, reclaim: null,
        } as never)
        applicationOwners.claims.reserveDrain = async () => ({ kind: 'complete', authority: {} }) as never
        applicationOwners.claims.reserveDrainAttempt = async () => ({ kind: 'complete', authority: {} }) as never
        applicationOwners.runtime.createRuntimeStopPlan = () => ({ kind: 'planned', step: { id: 'stop', executionFence: executionFence('sleep-indeterminate') } }) as never
        applicationOwners.runtime.createRuntimeStopObservationPlan = () => ({ kind: 'planned', step: { id: 'postcheck' } }) as never
        applicationOwners.runtime.admitRuntimeStopped = () => ({ kind: 'complete', authority: {} }) as never
        applicationOwners.runtime.consumeRuntimeStopped = () => ({}) as never
        applicationOwners.claims.prepareDrainOutcomePublication = async () => ({
            kind: 'indeterminate', code: 'STATE_DURABILITY_INDETERMINATE',
            message: 'drain publication durability is indeterminate', target: context.stackId,
        }) as never
        const finalize = vi.fn(() => true)
        applicationOwners.claims.finalizeDrainOutcome = finalize

        const result = await runSleep({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {} } as never),
            execute: async () => ({}) as never,
        })

        expect(finalize).not.toHaveBeenCalled()
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'STATE_DURABILITY_INDETERMINATE' }] })
    })

    it('refuses an active persisted sleep attempt before runtime execution', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        applicationOwners.claims.inspectSleepDrainRecovery = async () => ({
            kind: 'refusal', diagnostics: [{ code: 'DRAIN_ATTEMPT_REPAIR_REQUIRED' }],
        }) as never
        const withRuntimeReadiness = vi.fn()

        const result = await runSleep({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness,
            execute: vi.fn(),
        } as never)

        expect(withRuntimeReadiness).not.toHaveBeenCalled()
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'DRAIN_ATTEMPT_REPAIR_REQUIRED' }] })
        expect(result.diagnostics[0]?.message).toContain('will not overlap it with another destructive action')
    })

    it('recovers a failed persisted sleep attempt from its exact reservation', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const events: string[] = []
        const request = Object.freeze({
            purpose: 'sleep' as const, stackId: context.stackId, holderId: context.holderId, requesterId: context.holderId,
            configSha256: '1'.repeat(64), planDigest: '2'.repeat(64), operationBasis: '3'.repeat(64),
            generation: '4'.repeat(64), targetIds: Object.freeze([context.stackId]),
            actions: Object.freeze([{ stage: 'runtime-stop' as const, targetId: context.stackId, validForMs: 60_000 }]),
            expectedCoordinationRevision: 4,
        })
        applicationOwners.claims.inspectSleepDrainRecovery = async () => ({
            kind: 'recoverable', generation: request.generation,
            runtimeStopValidForMs: request.actions[0].validForMs, authority: {},
        }) as never
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        applicationOwners.ports.observeRetainedPortFamily = async () => ({ kind: 'complete', holderId: context.holderId, recordRevision: 7, lease }) as never
        applicationOwners.ports.deriveEntrypoints = () => ({ kind: 'complete', values: [], diagnostics: [] }) as never
        applicationOwners.ports.projectRetainedPortFamilyResult = async () => ({
            lease, ownership: { change: 'unchanged', holderId: context.holderId, recordRevision: 7, holderCount: 1, holderIds: [context.holderId] }, entrypoints: [],
        }) as never
        applicationOwners.lifecycle.planSleep = () => ({
            kind: 'drain', request: { ...request, expectedCoordinationRevision: 7 }, plan: { diagnostics: [] },
        }) as never
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology: {}, firstIncompleteServiceIndex: 0, portOwnership: { holderId: context.holderId },
            drainRequest: request, reclaim: null,
        } as never)
        applicationOwners.claims.recoverSleepDrainReservation = async ({ request: recovered }) => {
            events.push(`recover:${recovered.expectedCoordinationRevision}`)
            return { kind: 'complete', authority: {} } as never
        }
        applicationOwners.claims.reserveDrain = async () => { events.push('reserve'); return {} as never }
        applicationOwners.claims.reserveDrainAttempt = async () => ({ kind: 'complete', authority: {} }) as never
        applicationOwners.runtime.createRuntimeStopPlan = () => ({ kind: 'planned', step: { id: 'stop', executionFence: executionFence('sleep-recovery') } }) as never
        applicationOwners.runtime.createRuntimeStopObservationPlan = () => ({ kind: 'planned', step: { id: 'postcheck' } }) as never
        applicationOwners.runtime.admitRuntimeStopped = () => ({ kind: 'complete', authority: {} }) as never
        applicationOwners.runtime.consumeRuntimeStopped = () => ({}) as never
        applicationOwners.claims.prepareDrainOutcomePublication = async () => ({ kind: 'complete', value: {} }) as never
        applicationOwners.claims.finalizeDrainOutcome = () => true

        const result = await runSleep({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {} } as never),
            execute: async () => ({}) as never,
        })

        expect(events).toEqual(['recover:7'])
        expect(result).toMatchObject({ kind: 'complete', result: { change: 'stopped' } })
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
