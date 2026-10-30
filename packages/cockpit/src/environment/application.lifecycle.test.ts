import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as generatedCurrentnessOwner from './generated-application.js'
import { executeForegroundProcess, executeProbe } from '../environment-exec/execute.js'
import { resolveExecutable } from './executable.js'
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
    type UpCommandAdapters,
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

function unavailableRuntimeUpAdapters(
    context: LifecycleRunContext,
    withRuntimeReadiness: UpCommandAdapters['withRuntimeReadiness'],
): Pick<UpCommandAdapters, 'withLifecycleStage' | 'withAcquiredPorts' | 'withRuntimeReadiness'> {
    const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({}) })
    return {
        withLifecycleStage: async (_context, use) => use({} as never),
        withAcquiredPorts: async (_context, use) => use({
            retainOnFailure: vi.fn(),
            leaseResult: { kind: 'complete', change: 'unchanged', holderId: context.holderId, recordRevision: 1, lease },
            projection: {
                lease,
                ownership: { change: 'unchanged', holderId: context.holderId, recordRevision: 1,
                    holderCount: 1, holderIds: [context.holderId] },
                entrypoints: [],
            },
        } as never),
        withRuntimeReadiness,
    }
}

describe('lifecycle application contracts', () => {
    it('keeps one foreground session active through exit and surfaces child and sleep failures together', async () => {
        const events: string[] = []
        const stack = `stack:${'1'.repeat(64)}` as StackId
        const outcome = await runSession({
            configPath: '/synthetic/cockpit.toml',
            argv: ['synthetic-agent', '--work'],
            cwd: '/synthetic',
            env: { PATH: '/synthetic/bin', COCKPIT_SESSION_ID: '11111111-1111-4111-8111-111111111111' },
        }, {
            up: async () => {
                events.push('up')
                return { kind: 'complete', status: 0, diagnostics: [], result: { stackId: stack, change: 'started', entrypoints: [] } }
            },
            resolveExecutable: async () => ({ state: 'available', value: {
                canonicalPath: '/synthetic/bin/synthetic-agent', invocationPath: '/synthetic/bin/synthetic-agent',
                sha256: '2'.repeat(64), executionMode: 'verified-path',
            } }),
            executeForeground: async input => {
                events.push('child')
                expect(input.argv).toEqual(['--work'])
                expect(input.env.COCKPIT_SESSION_ID).toBe('11111111-1111-4111-8111-111111111111')
                return { kind: 'complete', exitCode: 7, signal: null, terminationConfirmed: true }
            },
            sleep: async () => {
                events.push('sleep')
                return { kind: 'refusal', status: 2, result: null, diagnostics: [{
                    severity: 'error', code: 'CLAIM_CO_TENANT', message: 'synthetic ownership changed', target: stack,
                }] }
            },
        })

        expect(events).toEqual(['up', 'child', 'sleep'])
        expect(outcome).toMatchObject({
            kind: 'refusal', status: 2, result: null,
            diagnostics: [{ code: 'EXECUTION_STEP_FAILED' }, { code: 'CLAIM_CO_TENANT' }],
        })
    })

    it.each([
        ['a nonzero exit', 'exit 7', 7, { exitCode: 7, signal: null }],
        ['a signal', 'kill -TERM $$', 143, { signal: 'SIGTERM' }],
    ] as const)('ends normally with the supervised command status after %s', async (_case, script, status, child) => {
        const stack = `stack:${'7'.repeat(64)}` as StackId
        const sleep = vi.fn(async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [],
            result: { stackId: stack, change: 'stopped' as const } }))
        const env = { PATH: '/usr/bin:/bin' }
        const outcome = await runSession({
            configPath: '/synthetic/cockpit.toml', argv: ['sh', '-c', script], cwd: tmpdir(), env,
        }, {
            up: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: {
                stackId: stack, change: 'started', entrypoints: [],
            } }),
            resolveExecutable: (name) => resolveExecutable(name, env),
            executeForeground: executeForegroundProcess,
            sleep,
        })

        expect(sleep).toHaveBeenCalledOnce()
        expect(outcome).toMatchObject({ kind: 'complete', status, diagnostics: [],
            result: { child, sleep: { change: 'stopped' } } })
    })

    it('preserves lifecycle ownership when the owned session process group cannot be confirmed stopped', async () => {
        const sleep = vi.fn()
        const stack = `stack:${'3'.repeat(64)}` as StackId
        const outcome = await runSession({
            configPath: '/synthetic/cockpit.toml', argv: ['synthetic-agent'], cwd: '/synthetic', env: { PATH: '/synthetic/bin' },
        }, {
            up: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: {
                stackId: stack, change: 'started', entrypoints: [],
            } }),
            resolveExecutable: async () => ({ state: 'available', value: {
                canonicalPath: '/synthetic/bin/synthetic-agent', invocationPath: '/synthetic/bin/synthetic-agent',
                sha256: '4'.repeat(64), executionMode: 'verified-path',
            } }),
            executeForeground: async () => ({ kind: 'refusal', code: 'EXECUTION_TERMINATION_UNCONFIRMED',
                exitCode: 1, signal: null, started: true, terminationConfirmed: false }),
            sleep,
        })

        expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EXECUTION_TERMINATION_UNCONFIRMED' }] })
        expect(sleep).not.toHaveBeenCalled()
    })

    it('returns the cancellation status only after releasing confirmed session ownership', async () => {
        const stack = `stack:${'5'.repeat(64)}` as StackId
        const sleep = vi.fn(async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [],
            result: { stackId: stack, change: 'stopped' as const } }))
        const outcome = await runSession({
            configPath: '/synthetic/cockpit.toml', argv: ['synthetic-agent'], cwd: '/synthetic', env: { PATH: '/synthetic/bin' },
        }, {
            up: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: {
                stackId: stack, change: 'started', entrypoints: [],
            } }),
            resolveExecutable: async () => ({ state: 'available', value: {
                canonicalPath: '/synthetic/bin/synthetic-agent', invocationPath: '/synthetic/bin/synthetic-agent',
                sha256: '6'.repeat(64), executionMode: 'verified-path',
            } }),
            executeForeground: async () => ({ kind: 'refusal', code: 'EXECUTION_ABORTED',
                exitCode: 130, signal: 'SIGINT', started: true, terminationConfirmed: true }),
            sleep,
        })

        expect(sleep).toHaveBeenCalledOnce()
        expect(outcome).toMatchObject({ kind: 'refusal', status: 130, diagnostics: [{
            code: 'EXECUTION_ABORTED', message: expect.stringContaining('cleanup stopped'),
        }] })

        const controller = new AbortController()
        controller.abort()
        const up = vi.fn()
        const cancelledBeforeUp = await runSession({
            configPath: '/synthetic/cockpit.toml', argv: ['synthetic-agent'], cwd: '/synthetic', env: { PATH: '/synthetic/bin' },
        }, { up, sleep, resolveExecutable: vi.fn(), executeForeground: vi.fn(), signal: controller.signal } as never)
        expect(cancelledBeforeUp).toMatchObject({
            kind: 'refusal', status: 130, diagnostics: [{ code: 'EXECUTION_ABORTED' }],
        })
        expect(up).not.toHaveBeenCalled()
    })

    it('derives row-owned ports and entrypoints from authenticated configuration', async () => {
        const { configPath, context } = await lifecycleContextFixture(derivedRegistrySource())

        expect(context.source.path).toBe(configPath)
        expect(context.ports.bases.WORKER_HOST_PORT).toBe(4250)
        expect(context.entrypointDerivatives).toContainEqual({
            name: 'worker-origin', kind: 'origin', port: 'WORKER_HOST_PORT', path: '/',
        })
    })

    it('restores generated progress only alongside its complete replay identity', async () => {
        const { context } = await lifecycleContextFixture()
        const replay = { sourceSha256: 'a'.repeat(64), generation: 'b'.repeat(64), profiles: ['default'], mounts: ['app:/workspace/app'] }
        const progress = { applied: ['publication', 'dependency:app:install', 'dependency:app:load'], notApplied: ['seeded'], attempted: ['dependency:app:stamp'] }
        const record = { format: 'cockpit-state/v1' as const, kind: 'lifecycle' as const,
            cockpitId: context.cockpitId, subjectId: context.stackId, revision: 0, updatedAt: new Date().toISOString(),
            value: { holderId: context.holderId, workBasisSha256: 'c'.repeat(64), operationGeneration: 'd'.repeat(64),
                completedServices: [], generatedReplay: replay, generatedProgress: progress } }
        expect(decodeLifecycleRecord(record, context)?.value.generatedProgress).toEqual(progress)
        const { generatedReplay, ...withoutReplay } = record.value
        expect(decodeLifecycleRecord({ ...record, value: withoutReplay }, context)).toBeUndefined()
        expect(decodeLifecycleRecord({ ...record, value: { ...record.value,
            generatedProgress: { ...progress, notApplied: ['publication'] } } }, context)).toBeUndefined()
        expect(decodeLifecycleRecord({ ...record, subjectId: `stack:${'e'.repeat(64)}` }, context)).toBeUndefined()
    })

    it('requires genuine generated publication before runtime readiness', async () => {
        const source = readFileSync(new URL('../../../../fixtures/registries/generated-environment.toml', import.meta.url), 'utf8')
        for (const projected of [undefined, { sourceSha256: 'a'.repeat(64), generation: 'b'.repeat(64), profiles: [], mounts: [], inspection: { kind: 'passed', files: [] } }]) {
            const { context } = await lifecycleContextFixture(source)
            const readiness = vi.fn(async () => undefined)
            const result = await runUp({ configPath: context.configPath }, {
                load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
                prepareGeneratedEnvironment: async () => projected,
                completeGeneratedEnvironment: async () => undefined,
                completeGeneratedDependencies: async () => undefined,
                completeGeneratedData: async () => undefined,
                completeGeneratedVendors: async () => undefined,
                withRuntimeReadiness: readiness,
            } as never)
            expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_ENVIRONMENT_UNAVAILABLE' })] })
            expect(readiness).not.toHaveBeenCalled()
            expect(await readState(context.namespace.paths.lifecycle(context.stackId))).toMatchObject({ kind: 'missing' })
            expect(await readState(lifecycleHistoryAddress(context.namespace, context.stackId)!)).toMatchObject({ kind: 'missing' })
        }
    })

    it('acquires ports before generated publication and compensates a newly acquired holder when publication fails', async () => {
        const source = readFileSync(new URL('../../../../fixtures/registries/generated-environment.toml', import.meta.url), 'utf8')
        const { context } = await lifecycleContextFixture(source)
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_HOST_PORT: 4100 }) })
        const leaseResult = Object.freeze({ kind: 'complete' as const, change: 'acquired' as const,
            holderId: context.holderId, recordRevision: 2, lease })
        const projection = Object.freeze({ lease, ownership: Object.freeze({ change: 'acquired' as const,
            holderId: context.holderId, recordRevision: 2, holderCount: 1, holderIds: Object.freeze([context.holderId]) }),
            entrypoints: Object.freeze([]) })
        const events: string[] = []
        const compensate = vi.fn(async () => {
            events.push('compensate')
            return { kind: 'complete' as const, change: 'compensated' as const, recordRevision: 3, remainingHolderIds: [] }
        })
        applicationOwners.ports.compensateAcquiredPortHolder = compensate
        const result = await runUp({ configPath: context.configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withAcquiredPorts: async (
                _context: typeof context,
                use: (ports: { leaseResult: typeof leaseResult; projection: typeof projection; retainOnFailure: () => void }) => Promise<unknown>,
            ) => { events.push('ports'); return use({ leaseResult, projection, retainOnFailure: vi.fn() }) },
            prepareGeneratedEnvironment: async (_context: typeof context, currentPorts: typeof projection) => {
                events.push('publication')
                expect(currentPorts).toBe(projection)
                return undefined
            },
            completeGeneratedEnvironment: async () => undefined,
            completeGeneratedDependencies: async () => undefined,
            completeGeneratedData: async () => undefined,
            completeGeneratedVendors: async () => undefined,
            withRuntimeReadiness: async () => { throw new Error('runtime readiness must not run') },
            execute: vi.fn(),
        } as never)
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({ code: 'GENERATED_ENVIRONMENT_UNAVAILABLE' })] })
        expect(events).toEqual(['ports', 'publication', 'compensate'])
        expect(compensate).toHaveBeenCalledOnce()
    })

    it('reissues exact lifecycle configuration to independent leaf owners', async () => {
        const { context } = await lifecycleContextFixture()
        await runUp({ configPath: context.configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            ...unavailableRuntimeUpAdapters(context, async () => undefined),
        } as never)
        for (let index = 0; index < 2; index += 1) {
            const consumed = await withLifecycleConfiguration(context, async (configuration) => {
                const loaded = consumeLoadedConfigProjection(configuration)
                expect(consumeLoadedConfigProjection(configuration)).toBeUndefined()
                return loaded
            })
            expect(consumed?.source).toEqual(context.source)
            expect(consumed?.config.cockpit.name).toBeTruthy()
        }
    })

    it('invalidates escaped lifecycle configuration after callback success or failure', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const returned = await withLifecycleConfiguration(context, async (configuration) => configuration)
        let retained: LoadedCockpitConfig | undefined
        await expect(withLifecycleConfiguration(context, async (configuration) => {
            retained = configuration
            throw new Error('leaf refused')
        })).rejects.toThrow('leaf refused')
        writeFileSync(configPath, readFileSync(configPath, 'utf8') + '\n# later source revision\n')
        expect(returned).toBeDefined()
        expect(retained).toBeDefined()
        expect(consumeLoadedConfigProjection(returned!)).toBeUndefined()
        expect(consumeLoadedConfigProjection(retained!)).toBeUndefined()
    })

    it('refuses copied lifecycle configuration handles and current source drift', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const use = vi.fn(async (configuration: LoadedCockpitConfig) => consumeLoadedConfigProjection(configuration))
        const getter = vi.fn(() => configPath)
        const copied = { ...context }
        Object.defineProperty(copied, 'configPath', { get: getter })
        expect(await withLifecycleConfiguration(copied, use)).toBeUndefined()
        expect(getter).not.toHaveBeenCalled()
        writeFileSync(configPath, readFileSync(configPath, 'utf8') + '\n# changed source bytes\n')
        expect(await withLifecycleConfiguration(context, use)).toBeUndefined()
        expect(use).not.toHaveBeenCalled()
    })

    it('preserves an unavailable up context as a refusal', async () => {
        const refusal = Object.freeze({
            kind: 'refusal' as const,
            status: 2 as const,
            result: null,
            diagnostics: Object.freeze([{ severity: 'error' as const, code: 'STATE_ROOT_UNAVAILABLE' as const, message: 'unavailable' }]),
        })

        await expect(runUp(
            { configPath: '/synthetic/cockpit.toml' },
            { load: async () => refusal } as never,
        )).resolves.toBe(refusal)
    })

    it('preserves an unavailable sleep context as a refusal', async () => {
        const refusal = Object.freeze({
            kind: 'refusal' as const,
            status: 2 as const,
            result: null,
            diagnostics: Object.freeze([{ severity: 'error' as const, code: 'STATE_ROOT_UNAVAILABLE' as const, message: 'unavailable' }]),
        })

        await expect(runSleep(
            { configPath: '/synthetic/cockpit.toml' },
            { load: async () => refusal } as never,
        )).resolves.toBe(refusal)
    })

    it('accepts an exact loaded configuration once and rejects replay', async () => {
        const value = await unissuedContextFixture()
        const fresh = await loadCockpitConfig(value.configPath)
        if (fresh.kind !== 'complete') throw new Error('fixture configuration did not reload')
        const identity = await runContextInput(value.candidate, fresh.result)
        const issued = await issueLifecycleContext(value.candidate, fresh.result, identity, fresh.result.source.path)
        expect(issued.kind).toBe('complete')
        if (issued.kind !== 'complete') throw new Error('lifecycle context was not issued')
        const load = async () => ({ kind: 'complete' as const, status: 0 as const, diagnostics: [], result: issued.result })
        const unavailableReadiness: UpCommandAdapters['withRuntimeReadiness'] = async () => undefined

        const copied = await runUp(
            { configPath: fresh.result.source.path },
            { load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: { ...issued.result } }),
                ...unavailableRuntimeUpAdapters(issued.result, unavailableReadiness) } as never,
        )
        const swapped = await runSleep(
            { configPath: join(resolve(fresh.result.source.path, '..'), 'other.toml') },
            { load } as never,
        )
        const first = await runUp({ configPath: fresh.result.source.path }, { load,
            ...unavailableRuntimeUpAdapters(issued.result, unavailableReadiness) } as never)
        const replay = await runUp({ configPath: fresh.result.source.path }, { load,
            ...unavailableRuntimeUpAdapters(issued.result, unavailableReadiness) } as never)

        expect(copied).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        expect(swapped).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        expect(first).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID', target: identity.stackId }] })
        expect(replay).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID', target: fresh.result.source.path }] })
    })

    it('warns once about another cockpit namespace it cannot read and names the directory to remove', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const legacy = join(dirname(context.namespace.cockpitRoot), `cockpit:legacy:${'a'.repeat(64)}`)
        mkdirSync(legacy, { recursive: true, mode: 0o700 })

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            ...unavailableRuntimeUpAdapters(context, async () => undefined),
        } as never)

        expect(result.diagnostics.filter(({ target }) => target === legacy)).toEqual([{
            severity: 'warning', code: 'STATE_RECORD_MALFORMED', target: legacy,
            message: expect.stringContaining('invalid cockpit namespace'),
            fix: expect.stringContaining(`rm -rf '${legacy}'`),
        }])
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'LIFECYCLE_EVIDENCE_INVALID' })]) })
    })

    it('refuses before execution when runtime readiness is absent', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const execute = vi.fn()
        const withRuntimeReadiness = vi.fn(async () => undefined)

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            execute,
            ...unavailableRuntimeUpAdapters(context, withRuntimeReadiness),
        } as never)

        expect(withRuntimeReadiness).toHaveBeenCalledOnce()
        expect(execute).not.toHaveBeenCalled()
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
    })

    it('rejects checkout/configuration mismatch and accessor inputs', async () => {
        const first = await unissuedContextFixture()
        const second = await unissuedContextFixture()
        const firstLoaded = await loadCockpitConfig(first.configPath)
        const secondLoaded = await loadCockpitConfig(second.configPath)
        if (firstLoaded.kind !== 'complete' || secondLoaded.kind !== 'complete') throw new Error('fixture configuration did not load')
        const identity = await runContextInput(first.candidate, firstLoaded.result)

        const mismatched = await issueLifecycleContext(first.candidate, secondLoaded.result, identity, secondLoaded.result.source.path)
        const fresh = await loadCockpitConfig(first.configPath)
        if (fresh.kind !== 'complete') throw new Error('fixture configuration did not reload')
        const accessor = await issueLifecycleContext(first.candidate, fresh.result, identity, fresh.result.source.path, (input) => {
            const hostile = { ...input } as Record<string, unknown>
            Object.defineProperty(hostile, 'stackId', { enumerable: true, get: () => input.stackId })
            return hostile as unknown as LifecycleRunContextInput
        })
        const substitutedSource = await loadCockpitConfig(first.configPath)
        if (substitutedSource.kind !== 'complete') throw new Error('fixture configuration did not reload')
        const substituted = await issueLifecycleContext(
            first.candidate,
            substitutedSource.result,
            identity,
            join(resolve(first.configPath, '..'), 'other.toml'),
        )

        expect(mismatched).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        expect(accessor).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        expect(substituted).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
    })

    it('refuses missing persisted progress after lifecycle history was seeded', async () => {
        const { configPath, context } = await lifecycleContextFixture()
        const observedAt = new Date().toISOString()
        expect(await recordLifecycleStarted({ namespace: context.namespace, stackId: context.stackId, holderId: context.holderId, observedAt })).toMatchObject({ kind: 'complete' })
        expect(await recordLifecycleSeeded({ namespace: context.namespace, stackId: context.stackId, holderId: context.holderId, observedAt })).toMatchObject({ kind: 'complete' })
        const planner = vi.fn()
        stubUpPlanner(planner)
        const execute = vi.fn()
        const lease = { stackId: context.stackId, offset: 0, ports: { APP_PORT: 4100 } }
        const ownership = { change: 'unchanged', holderId: context.holderId,
            recordRevision: 2, holderCount: 1, holderIds: [context.holderId] }
        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {} } as never),
            withLifecycleStage: async (_context, use) => {
                const stage = await resolveLifecycleStage({ namespace: context.namespace, stackId: context.stackId, observedAt: new Date().toISOString() })
                if (stage.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
                const projection = projectLifecycleStage({ authority: stage.authority, stackId: context.stackId,
                    cockpitId: context.cockpitId, earliest: Date.parse(stage.authority.observedAt),
                    latest: Date.parse(stage.authority.validThrough), evaluatedAt: Date.now() })
                if (!projection) throw new Error('fixture lifecycle stage projection was refused')
                return use(projection)
            },
            withAcquiredPorts: async (_context, use) => use({
                retainOnFailure: vi.fn(),
                leaseResult: { kind: 'complete', lease, change: 'unchanged', holderId: context.holderId, recordRevision: 2 },
                projection: { lease, ownership, entrypoints: [] },
            } as never),
            execute,
        })
        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_PROGRESS_INVALID' }] })
        expect(planner).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
        expect(await readState(context.namespace.paths.lifecycle(context.stackId))).toMatchObject({ kind: 'missing' })
    })

    it.each([
        ['within budget', 1_250, 30_000, 'complete'],
        ['over budget', 30_001, 30_000, 'refusal'],
    ] as const)('commits empty progress before service work and reports a cold start %s', async (_case, measuredMillis, limitMillis, expectedKind) => {
        const { configPath, context } = await lifecycleContextFixture()
        const containerId = '2'.repeat(64)
        const entrypoints = Object.freeze([{ name: 'app', kind: 'entrypoint' as const, port: 'APP_PORT', value: 'http://127.0.0.1:4100/' }])
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const plan = Object.freeze({
            verb: 'up' as const,
            progress: Object.freeze({ workBasisSha256: '3'.repeat(64), operationGeneration: '1'.repeat(64), completedServices: Object.freeze([]) }),
            steps: Object.freeze([]), resumeBoundary: Object.freeze({ completedStepIds: Object.freeze([]), nextStepId: 'service' }),
            compensation: Object.freeze([]), diagnostics: Object.freeze([]),
        })
        const topology = Object.freeze({ services: Object.freeze([{ id: 'api' }]) })
        const steps = Object.freeze({ start: Object.freeze({ id: 'start' }), status: Object.freeze({ id: 'status' }), identity: Object.freeze({ id: 'identity' }), inspect: Object.freeze({ id: 'inspect' }) })
        const observation = Object.freeze({ service: 'api', containerId })
        const evidence = Object.freeze({ service: 'api', containerId })
        stubUpPlanner(() => ({ kind: 'execute', mode: 'start', plan } as never))
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({ topology, firstIncompleteServiceIndex: 0, portOwnership: {}, drainRequest: null, reclaim: null } as never)
        applicationOwners.runtime.createRuntimeServicePlan = () => ({ kind: 'planned', service: 'api', start: steps.start, status: steps.status, identity: steps.identity } as never)
        const admittedStages: string[] = []
        applicationOwners.runtime.admitRuntimeServiceStageOutcome = ({ stage }) => {
            admittedStages.push(stage)
            return { kind: 'admitted', service: 'api' } as never
        }
        applicationOwners.runtime.createRuntimeServiceHealthPlan = () => ({ kind: 'planned', service: 'api', step: steps.inspect } as never)
        applicationOwners.runtime.admitRuntimeServiceInspectFailure = () => ({ kind: 'unavailable', service: 'api', reason: 'healthy' } as never)
        applicationOwners.runtime.admitRuntimeServiceObservation = () => ({ kind: 'complete', observation } as never)
        applicationOwners.runtime.admitRuntimeServiceHealth = () => ({ kind: 'complete', evidence } as never)
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']
        stubColdStart(context.stackId, measuredMillis, limitMillis)
        const executed: string[] = []
        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology, lifecycle: {} } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({
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
                    entrypoints,
                },
            } as never),
            execute: async (step) => {
                if (step === steps.start) {
                    expect(await readState(context.namespace.paths.lifecycle(context.stackId)))
                        .toMatchObject({ kind: 'complete', value: { value: { completedServices: [] } } })
                }
                executed.push(step.id)
                return {} as never
            },
        })

        expect(result).toMatchObject(expectedKind === 'complete'
            ? { kind: 'complete', result: { change: 'started', entrypoints,
                coldStart: { measuredMillis, limitMillis, headroomMillis: limitMillis - measuredMillis } } }
            : { kind: 'refusal', diagnostics: [{ code: 'MACHINE_COLD_START_EXCEEDED', target: 'api' }] })
        expect(executed).toEqual(['start', 'status', 'identity', 'inspect'])
        expect(admittedStages).toEqual(['start', 'status', 'identity'])
        expect(await readState(context.namespace.paths.lifecycle(context.stackId))).toMatchObject({
            kind: 'complete', value: { value: { holderId: context.holderId, completedServices: [{ service: 'api', containerId }] } },
        })
        // Only a successful first up seeds durable history; a refused cold start remains bootstrap.
        expect(await resolveLifecycleStage({ namespace: context.namespace, stackId: context.stackId, observedAt: new Date().toISOString() }))
            .toMatchObject({ kind: 'complete', authority: { stage: expectedKind === 'complete' ? 'steady' : 'bootstrap' } })
    })

    it.each([
        ['start', ['start']],
        ['status', ['start', 'status']],
        ['identity', ['start', 'status', 'identity']],
    ] as const)('stops startup after unavailable %s admission', async (blockedStage, expectedSteps) => {
        const { configPath, context } = await lifecycleContextFixture()
        const lease = Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) })
        const topology = Object.freeze({ services: Object.freeze([{ id: 'api' }]) })
        stubUpPlanner((input) => ({
            kind: 'execute', mode: 'start',
            plan: { progress: { workBasisSha256: '3'.repeat(64), operationGeneration: input.operationGeneration, completedServices: [] }, diagnostics: [] },
        } as never))
        applicationOwners.lifecycle.consumeLifecycleIssuance = () => ({
            topology, firstIncompleteServiceIndex: 0,
            portOwnership: { holderId: context.holderId }, drainRequest: null, reclaim: null,
        } as never)
        applicationOwners.runtime.resolveRuntimeServiceOrder = () => ['api']
        applicationOwners.runtime.createRuntimeServicePlan = () => ({
            kind: 'planned', service: 'api',
            start: { id: 'start' }, status: { id: 'status' }, identity: { id: 'identity' },
        } as never)
        applicationOwners.runtime.admitRuntimeServiceStageOutcome = ({ stage }) => stage === blockedStage
            ? ({ kind: 'unavailable', service: 'api' } as never)
            : ({ kind: 'admitted', service: 'api' } as never)
        const executed: string[] = []

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology, lifecycle: {} } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({
                retainOnFailure: vi.fn(),
                leaseResult: { kind: 'complete', change: 'unchanged', holderId: context.holderId, recordRevision: 2, lease },
                projection: {
                    lease,
                    ownership: { change: 'unchanged', holderId: context.holderId, recordRevision: 2, holderCount: 1, holderIds: [context.holderId] },
                    entrypoints: [],
                },
            } as never),
            execute: async (step) => {
                executed.push(step.id)
                return {} as never
            },
        })

        expect(result).toMatchObject({ kind: 'refusal' })
        expect(executed).toEqual(expectedSteps)
    })

    it.each(['stack', 'holder'] as const)('rejects an acquired lease paired with another %s', async (mismatch) => {
        const { configPath, context } = await lifecycleContextFixture()
        const otherHolder = `holder:${'f'.repeat(64)}:session`
        const lease = Object.freeze({
            stackId: mismatch === 'stack' ? `stack:${'e'.repeat(64)}` : context.stackId,
            offset: 0,
            ports: Object.freeze({ APP_PORT: 4100 }),
        })
        const leaseResult = Object.freeze({
            kind: 'complete' as const,
            change: 'acquired' as const,
            holderId: mismatch === 'holder' ? otherHolder : context.holderId,
            recordRevision: 2,
            lease,
            observation: 'resolved-listener-evidence-accepted' as const,
        })
        const projection = Object.freeze({
            lease: Object.freeze({ stackId: context.stackId, offset: 0, ports: Object.freeze({ APP_PORT: 4100 }) }),
            ownership: Object.freeze({
                change: 'acquired' as const, holderId: context.holderId, recordRevision: 2,
                holderCount: 1, holderIds: Object.freeze([context.holderId]),
            }),
            entrypoints: Object.freeze([]),
        })
        stubUpPlanner(() => ({
            kind: 'refusal', diagnostics: [{ severity: 'error', code: 'LIFECYCLE_EVIDENCE_INVALID', message: 'invalid' }],
        } as never))
        const compensate = vi.fn(async () => ({ kind: 'complete' as const, change: 'compensated' as const, recordRevision: 3, remainingHolderIds: [] }))
        applicationOwners.ports.compensateAcquiredPortHolder = compensate

        const result = await runUp({ configPath }, {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            withRuntimeReadiness: async (_context, use) => use({ topology: {}, lifecycle: {} } as never),
            withLifecycleStage: async (_context, use) => use({} as never),
            withAcquiredPorts: async (_context, use) => use({ leaseResult, projection, retainOnFailure: vi.fn() } as never),
            execute: vi.fn(),
        })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }] })
        expect(compensate).not.toHaveBeenCalled()
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
