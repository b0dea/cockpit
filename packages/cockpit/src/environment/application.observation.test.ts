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
import { RefusalError, type ExecutionStep, type StackId } from './contract.js'
import { createMachineFloorPlan, collectMachineFloorEvidence, issueMachineFloorAuthority } from './runtime.js'
import { observeHostCapacity } from './host-observation.js'
import { projectMachineFloorConfig } from '../config/load.js'
import { cockpitPackageVersion } from '../test-support/package-version.js'
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

describe('observation application runners', () => {
    afterEach(() => {
        applicationOwners.observations = {}
        applicationOwners.gitObservation = {}
        applicationOwners.evidence = {}
        applicationOwners.logs.planLogs = undefined
        applicationOwners.logs.collectLogs = undefined
    })

    const passed = Object.freeze({
        verdict: 'pass' as const,
        revision: '1'.repeat(64),
        checks: Object.freeze([]),
    })
    const context = Object.freeze({
        authorities: Object.freeze([]),
        stages: Object.freeze([{ stage: 'steady' }]),
    }) as never
    const commandInput = Object.freeze({ configPath: '/synthetic/cockpit.toml' })

    it('awaits one canonical currentness and separate release freshness even when doctor health is unavailable', async () => {
        const prepare = vi.spyOn(generatedCurrentnessOwner, 'prepareGeneratedEnvironmentCurrentness')
        const release = vi.fn(async () => ({ kind: 'unknown' as const, reason: 'synthetic registry unavailable' }))
        try {
            const result = await runDoctor(commandInput, { load: async () => undefined, execute: vi.fn(), discoverReleaseFreshness: release })
            expect(prepare).toHaveBeenCalledExactlyOnceWith(commandInput)
            expect(release).toHaveBeenCalledTimes(1)
            expect(result.result).toMatchObject({ verdict: 'unavailable', freshness: {
                local: { kind: 'refusal' }, release: { kind: 'unknown', reason: 'synthetic registry unavailable' },
                installedProducer: { package: '@b0dea/cockpit', version: cockpitPackageVersion, sourceRevision: 'development' },
                repair: { fixes: [], refusal: { kind: 'refusal' } },
            } })
            // The full check envelope lists every owned path; doctor keeps only whether files are current.
            expect(Object.keys(result.result.freshness.local).sort()).toEqual(['diagnostics', 'kind', 'status'])
        } finally { prepare.mockRestore() }
    })

    it('warns that the guard denies no host when a declared runtime leaves both guard host lists empty', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-doctor-guards-')))
        try {
            const doctorFor = async (body: string) => {
                const configPath = join(directory, 'cockpit.toml')
                writeFileSync(configPath, ['[cockpit]', 'name = "synthetic"', 'siblings_root = "."', '',
                    '[[sibling]]', 'slug = "app"', 'dir = "."', 'mount = "none"', 'acquire = "none"', 'var = "APP_DIR"',
                    'purpose = "Synthetic app"', '', '[ports]', 'bases = {}', '', body, ''].join('\n'))
                const result = await runDoctor({ configPath }, { load: async () => undefined, execute: vi.fn() })
                return result.diagnostics.filter(row => row.code === 'GUARD_HOSTS_UNDECLARED')
            }
            const compose = '[environment]\ncompose_files = ["compose.yml"]'
            expect(await doctorFor(compose)).toEqual([expect.objectContaining({ severity: 'warning', target: 'guards',
                message: expect.stringContaining('guards.vendor_endpoint_hosts'), fix: expect.stringContaining('[guards]') })])
            expect(await doctorFor(`[guards]\nhosted_db_hosts = ["db.staging.example.invalid"]\n\n${compose}`)).toEqual([])
            // init writes an explicit "none" as both keys; one key alone still leaves the other kind unanswered.
            expect(await doctorFor(`[guards]\nhosted_db_hosts = []\nvendor_endpoint_hosts = []\n\n${compose}`)).toEqual([])
            expect(await doctorFor(`[guards]\nhosted_db_hosts = []\n\n${compose}`)).toHaveLength(1)
            expect(await doctorFor('')).toEqual([])
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('warns that no work can be graded PASS while a product declares no test gate', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-doctor-testing-')))
        try {
            const doctorFor = async (body: string) => {
                const configPath = join(directory, 'cockpit.toml')
                writeFileSync(configPath, ['[cockpit]', 'name = "synthetic"', 'siblings_root = "."', '',
                    '[[sibling]]', 'slug = "app"', 'dir = "."', 'mount = "none"', 'acquire = "none"', 'var = "APP_DIR"',
                    'purpose = "Synthetic app"', '', '[ports]', 'bases = {}', '', body, ''].join('\n'))
                const result = await runDoctor({ configPath }, { load: async () => undefined, execute: vi.fn() })
                return result.diagnostics.filter(row => row.code === 'TESTING_GATE_UNDECLARED')
            }
            const compose = '[environment]\ncompose_files = ["compose.yml"]'
            expect(await doctorFor(compose)).toEqual([{ severity: 'warning', code: 'TESTING_GATE_UNDECLARED', target: 'testing',
                message: 'cockpit.toml declares no [testing] gate, so test-run has nothing to run and no work in this product can be graded PASS',
                fix: expect.stringContaining('npx --no cockpit sync --config <your cockpit.toml>') }])
            expect(await doctorFor(`${compose}\n\n[testing]\nstages = [{ id = "unit", command = ["make", "test"], requires_stack = false }]\n`
                + 'gates = [{ id = "all", tier = "full", stages = ["unit"], changes = "Any behavior" }]\nnative_hooks = { install = "inspect" }')).toEqual([])
            // A docs-only cockpit has no product to test.
            expect(await doctorFor('')).toEqual([])
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('warns about declarations no person has confirmed until they are removed from unconfirmed', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-doctor-unconfirmed-')))
        try {
            const doctorFor = async (head: string) => {
                const configPath = join(directory, 'cockpit.toml')
                writeFileSync(configPath, [head, '[cockpit]', 'name = "synthetic"', 'siblings_root = "."', '',
                    '[[sibling]]', 'slug = "app"', 'dir = "."', 'mount = "none"', 'acquire = "none"', 'var = "APP_DIR"',
                    'purpose = "Synthetic app"', '', '[ports]', 'bases = {}', ''].join('\n'))
                const result = await runDoctor({ configPath }, { load: async () => undefined, execute: vi.fn() })
                return result.diagnostics.filter(row => row.code === 'DECLARATION_UNCONFIRMED')
            }
            expect(await doctorFor('unconfirmed = ["environment.machine", "guards"]\n')).toEqual([{ severity: 'warning',
                code: 'DECLARATION_UNCONFIRMED', target: 'unconfirmed',
                message: 'environment.machine, guards in cockpit.toml were chosen by the setup agent or by no one named, not stated by a person, so they may not describe this product',
                fix: expect.stringContaining('delete each confirmed entry from unconfirmed, then run npx --no cockpit sync --config') }])
            expect(await doctorFor('')).toEqual([])
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('names every other cockpit state folder it cannot read in one doctor warning with one cleanup command', async () => {
        const cockpits = '/synthetic/state/v1/cockpits'
        const skipped = [{ path: `${cockpits}/one`, reason: 'format is not supported' }, { path: `${cockpits}/two`, reason: 'format is not supported' }]
        const result = await runDoctor({ configPath: '/synthetic/cockpit.toml' }, { load: async () => undefined, execute: vi.fn(),
            readUnreadableState: async () => skipped })
        expect(result.diagnostics.filter(row => row.code === 'STATE_RECORD_MALFORMED')).toEqual([{ severity: 'warning',
            code: 'STATE_RECORD_MALFORMED', target: cockpits,
            message: `2 state folders of other cockpits under ${cockpits} cannot be read by this cockpit version (format is not supported), so their claims and port leases were ignored`,
            fix: `ask the person who owns this machine whether any cockpit still uses them; if none does, stop any stack they started (docker compose ls lists them), then delete them: rm -rf '${cockpits}/one' '${cockpits}/two'` }])
    })

    it.each(['authenticated', 'bootstrap', 'missing', 'throwing'] as const)(
        'starts doctor health loading during surface inspection and awaits both for a %s source',
        async (sourceKind) => {
            const source = await healthSourceFixture(sourceKind === 'bootstrap'
                ? { authorities: [], stages: [{ stage: 'bootstrap' }] } as never : context)
            const inspection = Object.freeze({
                kind: 'complete' as const,
                activeOverrides: Object.freeze([]),
                changedOverrideOriginals: Object.freeze([]),
            })
            let releaseInspection!: (value: DoctorSurfaceOverrideInspection) => void
            const heldInspection = new Promise<DoctorSurfaceOverrideInspection>((resolveInspection) => {
                releaseInspection = resolveInspection
            })
            let releaseLoad!: () => void
            const heldLoad = new Promise<void>((resolveLoad) => { releaseLoad = resolveLoad })
            let loadStarted = false
            let inspectionStarted = false
            let completed = false
            const result = runDoctor(source.input, {
                load: (input, issue) => {
                    loadStarted = true
                    return heldLoad.then(() => {
                        if (sourceKind === 'missing') return undefined
                        if (sourceKind === 'throwing') throw new Error('synthetic health source unavailable')
                        return source.load(input, issue)
                    })
                },
                execute: vi.fn(),
                inspectSurfaceOverrides: () => {
                    inspectionStarted = true
                    return heldInspection
                },
            }).then((value) => {
                completed = true
                return value
            })
            try {
                expect(loadStarted).toBe(true)
                expect(inspectionStarted).toBe(true)
                await Promise.resolve()
                expect(completed).toBe(false)
            } finally {
                releaseInspection(inspection)
                releaseLoad()
                await result
            }
            expect((await result).result.surfaceOverrides).toEqual(inspection)
        },
    )

    it('uses one shared evaluation for blocking preflight and read-only doctor', async () => {
        const evaluation = Object.freeze({
            verdict: 'fail' as const,
            revision: '2'.repeat(64),
            checks: Object.freeze([Object.freeze({
                code: 'GIT_STATE_UNHEALTHY' as const,
                owner: 'git-observation', stackId: `stack:${'3'.repeat(64)}` as never,
                source: 'checkout:working-tree', verdict: 'fail' as const,
                reason: 'working tree differs', remedy: 'repair the working tree',
                observedAt: '2026-09-25T00:00:00.000Z', expected: { kind: 'present' as const },
            })]),
        })
        const aggregate = vi.fn((_groups: readonly (readonly unknown[])[], _context: unknown) => evaluation)
        const projection = Object.freeze({ verdict: evaluation.verdict, checks: Object.freeze([]) })
        const project = vi.fn(() => projection)
        applicationOwners.observations.aggregateObservations = aggregate as never
        applicationOwners.observations.projectDoctor = project as never
        const execute = vi.fn()
        const first = await healthSourceFixture(context)
        const second = await healthSourceFixture(context)
        const load = vi.fn()
            .mockImplementationOnce(first.load)
            .mockImplementationOnce(second.load)

        const preflight = await runPreflight(first.input, { load, execute })
        const doctor = await runDoctor(second.input, { load, execute })

        expect(load).toHaveBeenCalledTimes(2)
        expect(load).toHaveBeenNthCalledWith(1, first.input, expect.any(Function), expect.any(Function), 'preflight')
        expect(load).toHaveBeenNthCalledWith(2, second.input, expect.any(Function), expect.any(Function), 'doctor')
        expect(aggregate).toHaveBeenCalledTimes(4)
        for (const [index, preflight] of [first.preflight, first.preflight, second.preflight, second.preflight].entries()) {
            expect(aggregate.mock.calls[index]?.[0]).toHaveLength(healthProducerNames.length)
            expect(aggregate.mock.calls[index]?.[1]).toBe(preflight)
        }
        expect(preflight).toMatchObject({
            kind: 'blocked', status: 2,
            result: { verdict: 'fail', revision: evaluation.revision },
        })
        expect(preflight.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'GIT_STATE_UNHEALTHY', fix: 'repair the working tree' }),
        ]))
        expect(doctor).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'fail' } })
        expect(project).toHaveBeenCalledWith(evaluation)
        expect(execute).toHaveBeenCalledTimes(2)
    })

    it('projects active surface overrides through the read-only doctor seam', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        applicationOwners.observations.projectDoctor = vi.fn(() => ({ verdict: 'pass', checks: [] })) as never
        const source = await healthSourceFixture(context)
        const activeOverride = Object.freeze({
            name: 'review-rules',
            feature: 'rules' as const,
            originalSha256: '1'.repeat(64),
            recordedSha256: '1'.repeat(64),
            overlaySource: 'cockpit.toml',
        })
        const inspectSurfaceOverrides = vi.fn(async () => Object.freeze({
            kind: 'complete' as const,
            activeOverrides: Object.freeze([activeOverride]),
            changedOverrideOriginals: Object.freeze([]),
        }))

        const result = await runDoctor(source.input, {
            load: source.load,
            execute: vi.fn(),
            inspectSurfaceOverrides,
        })

        expect(inspectSurfaceOverrides).toHaveBeenCalledExactlyOnceWith(source.input.configPath)
        expect(result.result.surfaceOverrides).toEqual({
            kind: 'complete',
            activeOverrides: [activeOverride],
            changedOverrideOriginals: [],
        })
    })

    it('projects changed override originals without collapsing them into active rows', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        applicationOwners.observations.projectDoctor = vi.fn(() => ({ verdict: 'pass', checks: [] })) as never
        const source = await healthSourceFixture(context)
        const changed = Object.freeze({
            code: 'OVERRIDDEN_CORE_CHANGED' as const,
            name: 'review-rules',
            recordedSha256: '1'.repeat(64),
            currentSha256: '2'.repeat(64),
            overlaySource: 'cockpit.toml',
        })

        const result = await runDoctor(source.input, {
            load: source.load,
            execute: vi.fn(),
            inspectSurfaceOverrides: async () => Object.freeze({
                kind: 'complete' as const,
                activeOverrides: Object.freeze([]),
                changedOverrideOriginals: Object.freeze([changed]),
            }),
        })

        expect(result.result.surfaceOverrides).toEqual({
            kind: 'complete',
            activeOverrides: [],
            changedOverrideOriginals: [changed],
        })
    })

    it('names unavailable surface override inspection instead of reporting a valid empty set', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        applicationOwners.observations.projectDoctor = vi.fn(() => ({ verdict: 'pass', checks: [] })) as never
        const source = await healthSourceFixture(context)

        const result = await runDoctor(source.input, {
            load: source.load,
            execute: vi.fn(),
            inspectSurfaceOverrides: async () => Object.freeze({
                kind: 'unavailable' as const,
                code: 'SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE',
                reason: 'authenticated generated projection is unavailable',
            }),
        })

        expect(result.result.surfaceOverrides).toEqual({
            kind: 'unavailable',
            code: 'SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE',
            reason: 'authenticated generated projection is unavailable',
        })
        expect(result.result.surfaceOverrides).not.toHaveProperty('activeOverrides')
    })

    it('keeps bootstrap selection out of the public input and rejects it for doctor', async () => {
        const aggregate = vi.fn(() => passed)
        applicationOwners.observations.aggregateObservations = aggregate as never
        applicationOwners.observations.projectDoctor = vi.fn(() => ({ verdict: 'pass', checks: [] })) as never
        const bootstrapContext = { authorities: [], stages: [{ stage: 'bootstrap' }] } as never
        const preflightSource = await healthSourceFixture(bootstrapContext)
        const doctorSource = await healthSourceFixture(bootstrapContext)

        expect(commandInput).not.toHaveProperty('stage')
        await expect(runPreflight(preflightSource.input, { load: preflightSource.load, execute: vi.fn() }))
            .resolves.toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
        await expect(runDoctor(doctorSource.input, { load: doctorSource.load, execute: vi.fn() }))
            .resolves.toMatchObject({ kind: 'complete', result: { verdict: 'unavailable' } })
        expect(aggregate).not.toHaveBeenCalled()
    })

    it('blocks unauthenticated lifecycle evidence instead of treating its stage label as authority', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => {
            throw new RefusalError('preflight needs authentic lifecycle stage authority')
        }) as never

        const source = await healthSourceFixture(context)
        await expect(runPreflight(source.input, { load: source.load, execute: vi.fn() })).resolves.toMatchObject({
            kind: 'blocked', result: { verdict: 'unavailable' },
            diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }],
        })
    })

    it('reports the refusal a producer recorded instead of the observation window it cost', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => {
            throw new RefusalError('health preflight authority could not preserve its observation window')
        }) as never
        const refusal = Object.freeze({ severity: 'error' as const, code: 'GENERATED_ENVIRONMENT_UNAVAILABLE' as const,
            message: 'the generated files do not match cockpit.toml', target: 'cockpit.toml' })
        let refuse: ((diagnostics: readonly unknown[]) => undefined) | undefined
        const source = await healthSourceFixture(context, () => async () => { refuse?.([refusal]); return [] })
        const load = (input: unknown, issue: never, reject: (diagnostics: readonly unknown[]) => undefined) => {
            refuse = reject
            return source.load(input, issue)
        }
        await expect(runPreflight(source.input, { load, execute: vi.fn() } as never)).resolves.toMatchObject({
            kind: 'blocked', result: { verdict: 'unavailable' }, diagnostics: [refusal],
        })
    })

    it('rejects a preflight context issued for another configuration before producers or execution', async () => {
        const first = await healthSourceFixture(context)
        const producer = vi.fn(async () => [])
        const second = await healthSourceFixture(first.preflight as never, () => producer)
        const execute = vi.fn()

        await expect(runPreflight(second.input, { load: second.load, execute } as never)).resolves.toMatchObject({
            kind: 'blocked', result: { verdict: 'unavailable' },
        })
        expect(producer).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it('routes status, upstream, selected URL, and final revalidation through the sole executor', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        const status = Object.freeze({ id: 'status' })
        const ref = Object.freeze({ kind: 'probe' as const, step: Object.freeze({ id: 'ref' }) })
        const url = Object.freeze({ kind: 'probe' as const, step: Object.freeze({ id: 'url' }), remoteName: 'fork' })
        const revalidate = Object.freeze({ kind: 'probe' as const, step: Object.freeze({ id: 'revalidate' }), remoteName: 'fork' })
        const comparison = Object.freeze({ kind: 'complete' as const, code: 'GIT_COMPARISON_REMOTE_MISMATCH' as const, state: 'mismatch' as const, remoteName: 'fork', reason: 'wrong fork' })
        const git = Object.freeze({ kind: 'complete', observations: Object.freeze([]), evidence: Object.freeze({}) })
        applicationOwners.gitObservation.createGitObservationStep = vi.fn(() => status) as never
        applicationOwners.gitObservation.observeGit = vi.fn(() => git) as never
        applicationOwners.gitObservation.createComparisonRemoteRefStep = vi.fn((input: { git?: unknown }) => input.git ? ref : ({ kind: 'unavailable', code: comparison.code, reason: 'status required' })) as never
        applicationOwners.gitObservation.observeComparisonRemoteRef = vi.fn(() => url) as never
        applicationOwners.gitObservation.observeComparisonRemoteUrl = vi.fn(() => revalidate) as never
        applicationOwners.gitObservation.observeComparisonRemoteRevalidation = vi.fn(() => comparison) as never
        const execute = vi.fn(async (_step: { readonly id: string }) => Object.freeze({}))

        const source = await healthSourceFixture(context)
        const result = await runPreflight(source.input, { load: source.load, execute } as never)

        expect(execute.mock.calls.map(([step]) => step.id)).toEqual(['status', 'ref', 'url', 'revalidate'])
        expect(result).toMatchObject({
            kind: 'blocked', result: { verdict: 'fail', comparisons: [{ sibling: 'api', result: comparison }] },
            diagnostics: [{ code: comparison.code, message: comparison.reason,
                fix: 'in the sibling checkout, run `git status --short --branch` and `git remote -v`; reconcile the selected upstream and declared repository, then rerun the command',
            }],
        })
    })

    it('preserves acquire none without a declared remote as not applicable without Git execution', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        const notApplicable = Object.freeze({
            kind: 'not-applicable' as const,
            code: 'GIT_COMPARISON_REMOTE_MISMATCH' as const,
            reason: 'sibling api has no declared comparison remote',
        })
        applicationOwners.gitObservation.createComparisonRemoteRefStep = vi.fn(() => notApplicable) as never
        applicationOwners.gitObservation.createGitObservationStep = vi.fn(() => { throw new Error('Git must remain unused') }) as never
        const execute = vi.fn()

        const source = await healthSourceFixture(context, undefined, [
            '[cockpit]',
            'name = "synthetic-cockpit"',
            'siblings_root = "."',
            '',
            '[[sibling]]',
            'slug = "api"',
            'dir = "api"',
            'acquire = "none"',
            'mount = "always"',
            'var = "API_DIR"',
            'purpose = "Synthetic API"',
            '',
            '[ports]',
            'bases = { APP_PORT = 4100 }',
            '',
        ].join('\n'))
        const result = await runPreflight(source.input, { load: source.load, execute } as never)

        expect(result).toMatchObject({ kind: 'complete', result: { verdict: 'pass', comparisons: [{ result: notApplicable }] } })
        expect(execute).not.toHaveBeenCalled()
    })

    it('preserves an unavailable comparison result and its safe remedy', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        const unavailable = Object.freeze({
            kind: 'unavailable' as const,
            code: 'GIT_COMPARISON_REMOTE_MISMATCH' as const,
            reason: 'comparison upstream is unavailable for sibling api',
            remoteName: 'fork',
        })
        applicationOwners.gitObservation.createComparisonRemoteRefStep = vi.fn(() => unavailable) as never
        applicationOwners.gitObservation.createGitObservationStep = vi.fn(() => undefined) as never

        const source = await healthSourceFixture(context)
        const result = await runPreflight(source.input, { load: source.load, execute: vi.fn() } as never)

        expect(result).toMatchObject({
            kind: 'blocked', result: { verdict: 'unavailable', comparisons: [{ result: unavailable }] },
            diagnostics: [{ code: unavailable.code, message: unavailable.reason,
                fix: 'in the sibling checkout, run `git status --short --branch` and `git remote -v`; reconcile the selected upstream and declared repository, then rerun the command',
            }],
        })
        expect(JSON.stringify(result)).not.toContain('example.invalid')
    })

    it('names the failed comparison probe and sibling when execution throws', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        applicationOwners.gitObservation.createGitObservationStep = vi.fn(() => Object.freeze({ id: 'status' })) as never
        const source = await healthSourceFixture(context)

        const result = await runPreflight(source.input, {
            load: source.load,
            execute: async () => { throw new Error('private executor detail') },
        } as never)

        expect(result).toMatchObject({
            kind: 'blocked',
            diagnostics: [{
                code: 'GIT_COMPARISON_REMOTE_MISMATCH',
                message: 'Git status probe execution is unavailable for sibling api: Error',
                target: 'api',
            }],
        })
        expect(JSON.stringify(result)).not.toContain('private executor detail')
    })

    it('keeps log planning bounded and requires cancellation for follow mode', async () => {
        const planned = Object.freeze({ kind: 'planned' as const, step: Object.freeze({ id: 'logs' }) })
        const records = Object.freeze([{ message: 'ready', stream: 'stdout' }])
        applicationOwners.logs.planLogs = vi.fn(() => planned) as never
        applicationOwners.logs.collectLogs = vi.fn(async () => ({ kind: 'complete', records })) as never
        const execute = vi.fn()

        const observe = vi.fn(async () => ({ request: logRequestBaseFixture() }))
        const publicInput = {
            configPath: '/synthetic/cockpit.toml', service: 'api', since: '5m', tail: 25, follow: true, json: true,
        } as const
        await expect(runLogs(publicInput, { observe, execute } as never))
            .resolves.toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EVIDENCE_UNAVAILABLE' }] })
        expect(applicationOwners.logs.planLogs).not.toHaveBeenCalled()
        expect(observe).not.toHaveBeenCalled()

        const signal = new AbortController().signal
        const complete = await runLogs(
            publicInput,
            { observe, execute, signal } as never,
        )
        expect(observe).toHaveBeenCalledWith({ configPath: publicInput.configPath, service: publicInput.service })
        expect(applicationOwners.logs.collectLogs).toHaveBeenCalledWith(planned, execute, signal, undefined)
        expect(complete).toMatchObject({ kind: 'complete', result: { json: true, records } })
    })

    it('persists only an explicitly admitted baseline', async () => {
        const baseline = Object.freeze({ artifact: 'environment-baseline' })
        applicationOwners.evidence.recordEnvironmentBaseline = vi.fn(() => ({
            kind: 'complete', status: 0, diagnostics: [], result: baseline,
        })) as never
        const write = vi.fn(async () => undefined)
        const input = Object.freeze({
            configPath: '/synthetic/cockpit.toml', confirmation: 'confirmed', recordedAt: '2026-09-26T00:00:00.000Z',
        })
        const observation = Object.freeze({ snapshot: {}, evidence: {} })
        const observe = vi.fn(async () => observation) as never
        const revalidate = vi.fn(async () => observation) as never

        const result = await runBaselineRecord(input, { observe, revalidate, write } as never)

        expect(observe).toHaveBeenCalledWith({ configPath: input.configPath })
        expect(revalidate).toHaveBeenCalledWith(observation)
        expect(write).toHaveBeenCalledOnce()
        expect(write).toHaveBeenCalledWith(baseline)
        expect(result).toMatchObject({ kind: 'complete', result: baseline })
    })

    it.each([
        ['approve', 1],
        ['decline', 0],
    ] as const)('keeps the exact baseline admission in one operator session for %s', async (decision, writes) => {
        const baseline = Object.freeze({
            artifact: 'environment-baseline', stackId: `stack:${'1'.repeat(64)}`,
            version: 1, recordedAt: '2026-09-26T00:00:00.000Z',
            snapshot: Object.freeze({ stackId: `stack:${'1'.repeat(64)}`, snapshotSha256: '2'.repeat(64) }),
            evidence: Object.freeze({ evidenceSha256: '3'.repeat(64), observedAt: '2026-09-25T23:59:59.000Z' }),
        })
        applicationOwners.evidence.environmentBaselineConfirmation = vi.fn(() => '4'.repeat(64)) as never
        applicationOwners.evidence.recordEnvironmentBaseline = vi.fn(() => ({
            kind: 'complete', status: 0, diagnostics: [], result: baseline,
        })) as never
        const observation = Object.freeze({ snapshot: baseline.snapshot, evidence: baseline.evidence })
        const observe = vi.fn(async () => observation) as never
        const revalidate = vi.fn(async () => observation) as never
        const write = vi.fn(async () => undefined)

        const opened = await beginOperatorBaselineRecord(
            { configPath: '/synthetic/cockpit.toml' }, { observe, revalidate, write } as never,
        )
        if (!('decide' in opened)) throw new Error('operator baseline session was not issued')
        expect(opened.preview).toMatchObject({
            kind: 'preview', result: {
                stackId: baseline.stackId, version: 1, confirmation: '4'.repeat(64),
                snapshotSha256: '2'.repeat(64), evidenceSha256: '3'.repeat(64),
            },
        })
        expect(applicationOwners.evidence.recordEnvironmentBaseline).not.toHaveBeenCalled()
        const result = await opened.decide(decision)
        expect(result.kind).toBe(decision === 'approve' ? 'complete' : 'refusal')
        expect(write).toHaveBeenCalledTimes(writes)
        expect(revalidate).toHaveBeenCalledTimes(writes)
        if (writes) expect(revalidate).toHaveBeenCalledWith(observation)
        if (writes) expect(write).toHaveBeenCalledWith(baseline)
        expect(applicationOwners.evidence.recordEnvironmentBaseline).toHaveBeenCalledTimes(writes)
        if (writes) expect(applicationOwners.evidence.recordEnvironmentBaseline).toHaveBeenCalledWith(expect.objectContaining({
            recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }))
        await expect(opened.decide('approve')).resolves.toMatchObject({ kind: 'refusal' })
        expect(write).toHaveBeenCalledTimes(writes)
        expect(observe).toHaveBeenCalledOnce()
    })

    it('refuses changed baseline evidence after approval without admission or write', async () => {
        applicationOwners.evidence.environmentBaselineConfirmation = vi.fn(() => '4'.repeat(64)) as never
        const record = vi.fn()
        applicationOwners.evidence.recordEnvironmentBaseline = record as never
        const observation = Object.freeze({
            snapshot: Object.freeze({ stackId: `stack:${'1'.repeat(64)}`, snapshotSha256: '2'.repeat(64) }),
            evidence: Object.freeze({ evidenceSha256: '3'.repeat(64), observedAt: '2026-09-25T23:59:59.000Z' }),
        })
        const write = vi.fn()
        const revalidate = vi.fn(async () => { throw new Error('runtime process identity changed') })
        const opened = await beginOperatorBaselineRecord(
            { configPath: '/synthetic/cockpit.toml' },
            { observe: async () => observation, revalidate, write } as never,
        )
        if (!('decide' in opened)) throw new Error('operator baseline session was not issued')
        await expect(opened.decide('approve')).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'EVIDENCE_UNAVAILABLE' }],
        })
        expect(revalidate).toHaveBeenCalledWith(observation)
        expect(record).not.toHaveBeenCalled()
        expect(write).not.toHaveBeenCalled()
    })

    it.each([
        'config source', 'runtime topology', 'runtime cohort', 'previous baseline', 'runtime stability',
    ])('names changed %s in an operator baseline refusal', async (field) => {
        applicationOwners.evidence.environmentBaselineConfirmation = vi.fn(() => '4'.repeat(64)) as never
        const observation = Object.freeze({
            snapshot: Object.freeze({ stackId: `stack:${'1'.repeat(64)}`, snapshotSha256: '2'.repeat(64) }),
            evidence: Object.freeze({ evidenceSha256: '3'.repeat(64), observedAt: '2026-09-25T23:59:59.000Z' }),
        })
        const write = vi.fn()
        const opened = await beginOperatorBaselineRecord(
            { configPath: '/synthetic/cockpit.toml' },
            { observe: async () => observation, revalidate: async () => { throw new RefusalError(`baseline ${field} changed`) }, write } as never,
        )
        if (!('decide' in opened)) throw new Error('operator baseline session was not issued')
        await expect(opened.decide('approve')).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'EVIDENCE_UNAVAILABLE', message: `baseline ${field} changed` }],
        })
        expect(write).not.toHaveBeenCalled()
    })

    it.each([
        ['token-confirmed', (adapters: never) => runBaselineRecord({
            configPath: '/synthetic/cockpit.toml', confirmation: 'confirmed', recordedAt: '2026-09-26T00:00:00.000Z',
        }, adapters)],
        ['operator', (adapters: never) => beginOperatorBaselineRecord({ configPath: '/synthetic/cockpit.toml' }, adapters)],
    ] as const)('names why %s baseline observation failed', async (_entry, record) => {
        const write = vi.fn()
        const observe = async () => { throw new RefusalError('runtime evidence capture is unavailable: synthetic cause') }

        await expect(record({ observe, revalidate: vi.fn(), write } as never)).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{
                code: 'EVIDENCE_UNAVAILABLE', target: 'environment-baseline',
                message: 'baseline evidence observation is unavailable: runtime evidence capture is unavailable: synthetic cause',
            }],
        })
        expect(write).not.toHaveBeenCalled()
    })

    it('does not admit a token-confirmed baseline until the original observation is revalidated', async () => {
        const record = vi.fn()
        applicationOwners.evidence.recordEnvironmentBaseline = record as never
        const observation = Object.freeze({ snapshot: {}, evidence: {} })
        const write = vi.fn()
        const result = await runBaselineRecord({
            configPath: '/synthetic/cockpit.toml', confirmation: 'confirmed', recordedAt: '2026-09-26T00:00:00.000Z',
        }, { observe: async () => observation, revalidate: async () => { throw new RefusalError('baseline previous baseline changed') }, write } as never)
        expect(result).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'EVIDENCE_UNAVAILABLE', message: 'baseline previous baseline changed' }],
        })
        expect(record).not.toHaveBeenCalled()
        expect(write).not.toHaveBeenCalled()
    })

    it('refuses a replacement revalidation result even when it repeats the preview fields', async () => {
        applicationOwners.evidence.environmentBaselineConfirmation = vi.fn(() => '4'.repeat(64)) as never
        const record = vi.fn()
        applicationOwners.evidence.recordEnvironmentBaseline = record as never
        const observation = Object.freeze({
            snapshot: Object.freeze({ stackId: `stack:${'1'.repeat(64)}`, snapshotSha256: '2'.repeat(64) }),
            evidence: Object.freeze({ evidenceSha256: '3'.repeat(64), observedAt: '2026-09-25T23:59:59.000Z' }),
        })
        const write = vi.fn()
        const opened = await beginOperatorBaselineRecord(
            { configPath: '/synthetic/cockpit.toml' },
            { observe: async () => observation, revalidate: async () => ({ ...observation }), write } as never,
        )
        if (!('decide' in opened)) throw new Error('operator baseline session was not issued')
        await expect(opened.decide('approve')).resolves.toMatchObject({ kind: 'refusal' })
        expect(record).not.toHaveBeenCalled()
        expect(write).not.toHaveBeenCalled()
    })

    it('does not write a baseline rejected by the evidence owner', async () => {
        const refusal = Object.freeze({
            kind: 'refusal' as const, status: 2 as const, result: null,
            diagnostics: Object.freeze([{ severity: 'error' as const, code: 'EVIDENCE_UNAVAILABLE' as const, message: 'invalid' }]),
        })
        applicationOwners.evidence.recordEnvironmentBaseline = vi.fn(() => refusal) as never
        const observation = Object.freeze({ snapshot: {}, evidence: {} })
        const observe = vi.fn(async () => observation) as never
        const revalidate = vi.fn(async () => observation) as never
        const write = vi.fn()

        await expect(runBaselineRecord({
            configPath: '/synthetic/cockpit.toml', confirmation: 'rejected', recordedAt: '2026-09-26T00:00:00.000Z',
        }, { observe, revalidate, write })).resolves.toBe(refusal)
        expect(write).not.toHaveBeenCalled()
    })

    it('derives the complete comparison cohort from authenticated configuration', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        const comparison = Object.freeze({
            kind: 'complete' as const, code: 'GIT_COMPARISON_REMOTE_MISMATCH' as const,
            state: 'match' as const, remoteName: 'origin',
        })
        const steps = ['status', 'ref', 'url', 'revalidate'].map((id) => Object.freeze({ id }))
        applicationOwners.gitObservation.createGitObservationStep = vi.fn(() => steps[0]) as never
        applicationOwners.gitObservation.observeGit = vi.fn(() => ({ kind: 'complete', evidence: {}, observations: [] })) as never
        applicationOwners.gitObservation.createComparisonRemoteRefStep = vi.fn((input: { git?: unknown }) => input.git
            ? ({ kind: 'probe', step: steps[1] })
            : ({ kind: 'unavailable', code: comparison.code, reason: 'status required' })) as never
        applicationOwners.gitObservation.observeComparisonRemoteRef = vi.fn(() => ({ kind: 'probe', step: steps[2], remoteName: 'origin' })) as never
        applicationOwners.gitObservation.observeComparisonRemoteUrl = vi.fn(() => ({ kind: 'probe', step: steps[3], remoteName: 'origin' })) as never
        applicationOwners.gitObservation.observeComparisonRemoteRevalidation = vi.fn(() => comparison) as never
        const source = await healthSourceFixture(context)
        const execute = vi.fn(async (_step: { readonly id: string }) => Object.freeze({}))

        const result = await runPreflight(source.input, { load: source.load, execute } as never)

        expect(execute.mock.calls.map(([step]) => step.id)).toEqual(['status', 'ref', 'url', 'revalidate'])
        expect(result).toMatchObject({
            kind: 'complete', result: { comparisons: [{ sibling: 'api', result: comparison }] },
        })
    })

    it('runs the full comparison precursor for every configured sibling and combines nonpass results', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        applicationOwners.gitObservation.createGitObservationStep = vi.fn((input: { sibling: string }) => ({
            id: `${input.sibling}:status`,
        })) as never
        applicationOwners.gitObservation.observeGit = vi.fn(() => ({
            kind: 'complete', evidence: {}, observations: [{ source: 'comparison precursor' }],
        })) as never
        applicationOwners.gitObservation.createComparisonRemoteRefStep = vi.fn((input: { sibling: string; git?: unknown }) => input.git
            ? ({ kind: 'probe', step: { id: `${input.sibling}:ref` } })
            : ({ kind: 'unavailable', code: 'GIT_COMPARISON_REMOTE_MISMATCH', reason: 'status required' })) as never
        applicationOwners.gitObservation.observeComparisonRemoteRef = vi.fn((stage: { step: { id: string } }) => ({
            kind: 'probe', step: { id: stage.step.id.replace(':ref', ':url') }, remoteName: 'origin',
        })) as never
        applicationOwners.gitObservation.observeComparisonRemoteUrl = vi.fn((stage: { step: { id: string } }) => ({
            kind: 'probe', step: { id: stage.step.id.replace(':url', ':revalidate') }, remoteName: 'origin',
        })) as never
        applicationOwners.gitObservation.observeComparisonRemoteRevalidation = vi.fn((stage: { step: { id: string } }) => stage.step.id.startsWith('web:')
            ? ({ kind: 'complete', code: 'GIT_COMPARISON_REMOTE_MISMATCH', state: 'mismatch', remoteName: 'origin', reason: 'wrong web fork' })
            : ({ kind: 'complete', code: 'GIT_COMPARISON_REMOTE_MISMATCH', state: 'match', remoteName: 'origin' })) as never
        const source = await healthSourceFixture(context, undefined, [
            '[cockpit]', 'name = "synthetic-cockpit"', 'siblings_root = "."', '',
            '[[sibling]]', 'slug = "api"', 'dir = "api"', 'remote = "ssh://example.invalid/api.git"',
            'acquire = "auto"', 'mount = "always"', 'var = "API_DIR"', 'purpose = "Synthetic API"', '',
            '[[sibling]]', 'slug = "web"', 'dir = "web"', 'remote = "ssh://example.invalid/web.git"',
            'acquire = "auto"', 'mount = "always"', 'var = "WEB_DIR"', 'purpose = "Synthetic web"', '',
            '[ports]', 'bases = { APP_PORT = 4100 }', '',
        ].join('\n'))
        const execute = vi.fn(async (_step: { readonly id: string }) => Object.freeze({}))

        const result = await runPreflight(source.input, { load: source.load, execute } as never)

        expect(execute.mock.calls.map(([step]) => step.id)).toEqual([
            'api:status', 'api:ref', 'api:url', 'api:revalidate',
            'web:status', 'web:ref', 'web:url', 'web:revalidate',
        ])
        expect(result).toMatchObject({
            kind: 'blocked', result: {
                verdict: 'fail',
                comparisons: [
                    { sibling: 'api', result: { state: 'match' } },
                    { sibling: 'web', result: { state: 'mismatch', reason: 'wrong web fork' } },
                ],
            },
        })
    })

    it('runs every named producer and authenticates the aggregate before comparison execution', async () => {
        const order: string[] = []
        applicationOwners.observations.aggregateObservations = vi.fn(() => {
            order.push('authenticate')
            throw new RefusalError('lifecycle authority is not authentic')
        }) as never
        const source = await healthSourceFixture(context, (name) => async () => {
            order.push(name)
            return []
        })
        const execute = vi.fn()

        const result = await runPreflight(source.input, { load: source.load, execute } as never)

        expect(order).toEqual([
            'claims', 'git', 'host', 'installs', 'lifecycle', 'ports', 'runtime', 'state', 'templates',
            'generated', 'data', 'external', 'envSchema', 'surfaces',
            'authenticate',
        ])
        expect(execute).not.toHaveBeenCalled()
        expect(result).toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
    })

    it('keeps a rejected producer nonpass and names it without exposing its error', async () => {
        applicationOwners.observations.aggregateObservations = vi.fn(() => passed) as never
        const source = await healthSourceFixture(context, (name) => async () => {
            if (name === 'runtime') throw new Error('private runtime detail')
            return []
        })

        const result = await runPreflight(source.input, {
            load: source.load, execute: vi.fn(),
        } as never)

        expect(result).toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
        expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
            code: 'EVIDENCE_UNAVAILABLE', message: 'runtime observation producer failed', target: 'runtime',
        })]))
        expect(JSON.stringify(result)).not.toContain('private runtime detail')
    })

    it.each(['missing', 'extra'] as const)('rejects a %s producer cohort before execution', async (shape) => {
        const source = await healthSourceFixture(context, undefined, undefined, (producers) => {
            const changed = { ...producers } as Record<string, () => Promise<readonly never[]>>
            if (shape === 'missing') delete changed.runtime
            else changed.unknown = async () => []
            return changed
        }, false)
        const execute = vi.fn()

        await expect(runPreflight(source.input, { load: source.load, execute } as never))
            .resolves.toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
        expect(execute).not.toHaveBeenCalled()
    })

    it('constructs logs from public options and one observed runtime identity', async () => {
        const planned = Object.freeze({ kind: 'planned' as const, step: Object.freeze({ id: 'logs' }) })
        const records = Object.freeze([{ message: 'ready', stream: 'stdout' }])
        applicationOwners.logs.planLogs = vi.fn(() => planned) as never
        applicationOwners.logs.collectLogs = vi.fn(async () => ({ kind: 'complete', records })) as never
        const observe = vi.fn(async () => ({ request: logRequestBaseFixture(), restart: undefined }))
        const signal = new AbortController().signal

        const result = await runLogs({
            configPath: '/synthetic/cockpit.toml', service: 'api', since: '5m', tail: 25, follow: true, json: true,
        } as never, { observe, execute: vi.fn(), signal } as never)

        expect(observe).toHaveBeenCalledWith({ configPath: '/synthetic/cockpit.toml', service: 'api' })
        expect(applicationOwners.logs.planLogs).toHaveBeenCalledWith(expect.objectContaining({
            service: 'api', since: '5m', tail: 25, follow: true,
        }), undefined, undefined)
        expect(result).toMatchObject({ kind: 'complete', result: { json: true, records } })
    })

    it.each([
        ['service', 'API'],
        ['service', 'a'.repeat(129)],
        ['since', 'all'],
        ['since', '1'.repeat(65)],
        ['tail', -1],
        ['tail', 1.5],
        ['tail', 100_001],
    ] as const)('rejects invalid public log %s before observing runtime identity', async (field, value) => {
        const observe = vi.fn()
        const input = {
            configPath: '/synthetic/cockpit.toml', service: 'api', since: '5m', tail: 25, follow: false, json: true,
            [field]: value,
        }

        const result = await runLogs(input as never, { observe, execute: vi.fn() } as never)

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EVIDENCE_UNAVAILABLE' }] })
        expect(observe).not.toHaveBeenCalled()
    })

    it('refuses hostile log observation accessors without evaluating them', async () => {
        const request = vi.fn(() => logRequestBaseFixture())
        const restart = vi.fn(() => undefined)
        const observed = Object.defineProperties({}, {
            request: { enumerable: true, get: request },
            restart: { enumerable: true, get: restart },
        })

        const result = await runLogs({
            configPath: '/synthetic/cockpit.toml', service: 'api', since: '5m', tail: 25, follow: false, json: true,
        }, { observe: async () => observed as never, execute: vi.fn() })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EVIDENCE_UNAVAILABLE' }] })
        expect(request).not.toHaveBeenCalled()
        expect(restart).not.toHaveBeenCalled()
    })

    it('observes baseline evidence before the sole confirmed write', async () => {
        const baseline = Object.freeze({ artifact: 'environment-baseline' })
        applicationOwners.evidence.recordEnvironmentBaseline = vi.fn(() => ({
            kind: 'complete', status: 0, diagnostics: [], result: baseline,
        })) as never
        const observation = Object.freeze({ snapshot: {}, evidence: {} })
        const observe = vi.fn(async () => observation) as never
        const revalidate = vi.fn(async () => observation) as never
        const write = vi.fn(async () => undefined)

        const result = await runBaselineRecord({
            configPath: '/synthetic/cockpit.toml', confirmation: 'confirmed', recordedAt: '2026-09-26T00:00:00.000Z',
        } as never, { observe, revalidate, write } as never)

        expect(observe).toHaveBeenCalledWith({ configPath: '/synthetic/cockpit.toml' })
        expect(applicationOwners.evidence.recordEnvironmentBaseline).toHaveBeenCalledWith(expect.objectContaining({
            confirmation: 'confirmed', recordedAt: '2026-09-26T00:00:00.000Z',
        }))
        expect(write).toHaveBeenCalledWith(baseline)
        expect(result).toMatchObject({ kind: 'complete', result: baseline })
    })
})

const healthProducerNames = [
    'claims', 'git', 'host', 'installs', 'lifecycle', 'ports', 'runtime', 'state', 'templates',
    'generated', 'data', 'external', 'envSchema', 'surfaces',
] as const

function logRequestBaseFixture() {
    return Object.freeze({
        runtime: 'docker-compose' as const,
        executable: Object.freeze({}),
        cwd: '/synthetic',
        stackId: `stack:${'1'.repeat(64)}` as never,
        configSha256: '2'.repeat(64),
        batchId: '3'.repeat(64),
        containerId: 'api-1',
        runtimeVersion: '1.0.0',
        composeVersion: '2.0.0',
        projectName: 'synthetic',
        composeFiles: Object.freeze([]),
        services: Object.freeze(['api']),
        service: 'api',
        timeoutMs: 1_000,
        outputLimitBytes: 1_024,
        env: Object.freeze({}),
    })
}

async function healthSourceFixture(
    preflight: never,
    producer: (name: typeof healthProducerNames[number]) => () => Promise<readonly never[]> = () => async () => [],
    configSource?: string,
    transformProducers: (
        producers: Readonly<Record<string, () => Promise<readonly never[]>>>,
    ) => Readonly<Record<string, () => Promise<readonly never[]>>> = (producers) => producers,
    required = true,
) {
    const value = await unissuedContextFixture(configSource)
    const loaded = await loadCockpitConfig(value.configPath)
    if (loaded.kind !== 'complete') throw new Error('health configuration did not load')
    const observed = await observeSetupCheckout({
        source: value.candidate.source,
        cockpitName: loaded.result.config.cockpit.name,
        observedAt: value.candidate.observedAt,
        env: value.candidate.env,
        gitExecutable: value.candidate.gitExecutable,
    })
    const producers = Object.freeze(Object.fromEntries(
        healthProducerNames.map((name) => [name, producer(name)]),
    ))
    const expectedStackId = stackId({
        cockpitId: cockpitId({
            name: loaded.result.config.cockpit.name,
            mainCheckoutPath: value.candidate.mainCheckoutPath,
        }),
        checkoutId: checkoutId({ checkoutPath: value.candidate.mainCheckoutPath }),
        variant: { kind: 'shared' },
    })
    const requested = preflight as unknown as {
        readonly authorities?: readonly unknown[]
        readonly stages?: readonly { readonly stage?: unknown }[]
    }
    const validThrough = new Date(Date.parse(value.candidate.observedAt) + 30_000).toISOString()
    const requestedStage = requested.stages?.[0]?.stage === 'bootstrap' ? 'bootstrap' as const : 'steady' as const
    const boundPreflight: PreflightContext = requested.authorities?.length
        ? preflight
        : Object.freeze({
            authorities: Object.freeze([Object.freeze({
                stackId: expectedStackId,
                evaluatedAt: value.candidate.observedAt,
                validThrough,
                revision: loaded.result.source.sha256,
                source: loaded.result.source.path,
                postures: Object.freeze(['environment']),
                environmentPostures: Object.freeze({ addressing: null, authentication: null }),
                postureRequirements: Object.freeze([]),
            })]),
            stages: Object.freeze([Object.freeze({
                stackId: expectedStackId,
                stage: requestedStage,
                observedAt: value.candidate.observedAt,
                validThrough,
            })]),
        })
    const load = async (_input: unknown, issue: (source: HealthObservationSourceInput) => HealthObservationSource | undefined) => {
        const source = await withSetupCheckoutProjection(observed, {
            source: value.candidate.source,
            cockpitName: loaded.result.config.cockpit.name,
            evaluatedAt: Date.parse(value.candidate.observedAt),
        }, (checkout) => issue({
            checkout,
            configuration: loaded.result,
            preflight: boundPreflight,
            env: Object.freeze({}),
            gitExecutable,
            timeoutMs: 1_000,
            producers: transformProducers(producers),
            refreshPreflight: async (previous: PreflightContext) => previous === boundPreflight ? boundPreflight : undefined,
            stopped: null,
            notices: () => [],
        } as never))
        if (!source && required) throw new Error('health source was not issued')
        return source
    }
    return Object.freeze({ load, preflight: boundPreflight, input: Object.freeze({ configPath: loaded.result.source.path }) })
}
