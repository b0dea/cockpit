import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as generatedCurrentnessOwner from './generated-application.js'
import { synchronizeInstructionPointer } from './instruction-pointer.js'
import { executeProbe } from '../environment-exec/execute.js'
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
import { createApplicationFixtureSupport, type UnissuedSetupContext } from '../../test-support/application-fixture.js'

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

describe('setup application choreography', () => {
    it('derives row-owned siblings and install policies from authenticated configuration', async () => {
        const { loaded, candidate } = await unissuedContextFixture(derivedRegistrySource())

        const context = await authorizeContext(candidate, loaded)

        expect(context.source).toEqual(candidate.source)
        expect(context.siblings).toContainEqual(expect.objectContaining({ slug: 'worker' }))
        expect(context.siblings.find(({ slug }) => slug === 'worker')).not.toHaveProperty('derives')
        expect(context.policyCatalog).toContainEqual(expect.objectContaining({
            volume: 'worker-dependencies', lockfile: 'worker/package-lock.json',
        }))
    })

    it('names an effective registry refusal at setup issuance', async () => {
        const { loaded, candidate } = await unissuedContextFixture(derivedRegistrySource())
        applicationOwners.registryDerivation.deriveRegistry = () => ({
            kind: 'refusal', code: 'REGISTRY_EFFECTIVE_CONFIG_INVALID', message: 'synthetic effective conflict',
        })

        const issued = await issueContext(candidate, loaded)

        expect(issued).toMatchObject({
            kind: 'refusal',
            diagnostics: [{
                code: 'SETUP_PATH_TYPE_INVALID',
                message: expect.stringContaining('REGISTRY_EFFECTIVE_CONFIG_INVALID'),
            }],
        })
    })

    it.each(['complete', 'preview'] as const)(
        'refuses an adapter-owned %s setup result with an extra secret field',
        async (kind) => {
            const { configPath, context, adapters } = await sequenceFixture()
            const result = {
                sibling: 'api', target: resolve(context.siblingsRoot, 'api'), observed: 'repository' as const,
                action: kind === 'preview' ? 'wire-remote' as const : 'report' as const,
                changed: kind === 'preview', privateValue: 'setup-secret-canary',
            }
            adapters.planGit = async () => kind === 'preview'
                ? { kind, status: 0, diagnostics: [], result, plan: { steps: [{ id: 'setup:api:remote-set' }] as never } }
                : { kind, status: 0, diagnostics: [], result }
            const execute = vi.fn(adapters.execute)
            adapters.execute = execute

            const outcome = await runSetupSequence({ configPath }, adapters)

            expect(outcome).toMatchObject({ kind: 'refusal', result: null })
            expect(JSON.stringify(outcome)).not.toContain('setup-secret-canary')
            expect(execute).not.toHaveBeenCalled()
        },
    )

    it('refuses an adapter-owned instruction pointer result that is not bound to the sibling guide', async () => {
        const { configPath, adapters } = await sequenceFixture({ instruction_pointer: true })
        adapters.syncInstructionPointer = async () => ({
            kind: 'unchanged', path: '/synthetic/wrong/AGENTS.md', target: '../wrong/AGENTS.md', privateValue: 'pointer-secret-canary',
        } as never)

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'SETUP_INSTRUCTION_POINTER_INVALID' }))
        expect(JSON.stringify(outcome)).not.toContain('pointer-secret-canary')
    })

    it('reports an approved sibling pointer proposal without granting write authority', async () => {
        const { configPath, context, adapters } = await sequenceFixture({ instruction_pointer: true })
        const siblingRoot = resolve(context.siblingsRoot, 'api')
        const syncInstructionPointer = vi.fn(async () => ({
            kind: 'offered' as const,
            path: resolve(siblingRoot, 'AGENTS.md'),
            target: relative(siblingRoot, resolve(context.mainCheckoutPath, 'AGENTS.md')).split(sep).join('/'),
        }))
        adapters.syncInstructionPointer = syncInstructionPointer

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'complete' })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({
            severity: 'info', code: 'SETUP_INSTRUCTION_POINTER_OFFERED', target: resolve(siblingRoot, 'AGENTS.md'),
        }))
        expect(syncInstructionPointer).toHaveBeenCalledWith(expect.objectContaining({ write: false }))
    })

    it('points sibling guides at the configured cockpit directory inside a Git checkout', async () => {
        const { configPath, context, adapters } = await sequenceFixture({ instruction_pointer: true })
        const cockpitRoot = join(context.mainCheckoutPath, 'control')
        mkdirSync(cockpitRoot)
        const nestedConfig = join(cockpitRoot, 'cockpit.toml')
        const config = CockpitConfig.parse(parse(readFileSync(configPath, 'utf8')))
        config.cockpit.siblings_root = '../repositories'
        writeFileSync(nestedConfig, stringify(config))
        const loaded = await loadCockpitConfig(nestedConfig)
        if (loaded.kind !== 'complete') throw new Error('nested configuration did not load')
        const issued = await issueContext({ ...context, source: loaded.result.source, observedAt: new Date().toISOString() }, loaded.result,
            input => ({ ...input, writeInstructionPointers: true }))
        if (issued.kind !== 'complete') throw new Error('nested setup context was not issued')
        const expectedSiblingsRoot = join(context.mainCheckoutPath, 'repositories')
        expect(issued.result.siblingsRoot).toBe(expectedSiblingsRoot)
        adapters.load = async () => ({ kind: 'complete', status: 0, diagnostics: [], result: issued.result })
        adapters.observeSource = async () => ({ state: 'available', ...issued.result.source })
        adapters.planGit = async ({ context: current, sibling }) => ({
            kind: 'complete', status: 0, diagnostics: [], result: {
                sibling: sibling.slug, target: resolve(current.siblingsRoot, sibling.dir),
                observed: 'repository', action: 'report', changed: false,
            },
        })
        adapters.syncInstructionPointer = synchronizeInstructionPointer
        const siblingRoot = join(expectedSiblingsRoot, 'api')
        mkdirSync(siblingRoot, { recursive: true })

        const outcome = await runSetupSequence({ configPath: nestedConfig }, adapters)

        expect(outcome).toMatchObject({ kind: 'complete' })
        const destination = relative(siblingRoot, join(cockpitRoot, 'AGENTS.md')).split(sep).join('/')
        expect(readFileSync(join(siblingRoot, 'AGENTS.md'), 'utf8')).toContain(`(<${destination}>)`)
    })

    it.each([
        ['complete clone', 'complete', 'absent', 'clone', true],
        ['preview report', 'preview', 'repository', 'report', false],
        ['preview clone of a repository', 'preview', 'repository', 'clone', true],
        ['preview remote mutation for an absent checkout', 'preview', 'absent', 'wire-remote', true],
    ] as const)('refuses a semantically inconsistent %s result', async (_label, kind, observed, action, changed) => {
        const { configPath, context, adapters } = await sequenceFixture()
        const result = {
            sibling: 'api', target: resolve(context.siblingsRoot, 'api'), observed, action, changed,
        }
        adapters.planGit = async () => kind === 'preview'
            ? { kind, status: 0, diagnostics: [], result, plan: { steps: [{ id: 'setup:api:mutation' }] as never } }
            : { kind, status: 0, diagnostics: [], result }
        const execute = vi.fn(adapters.execute)
        adapters.execute = execute

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(execute).not.toHaveBeenCalled()
    })

    it.each([
        ['automatic absent checkout reported as complete', {}, available('absent'), 'complete', 'report'],
        ['symlink reported as complete', {}, { ...available('absent'), value: { kind: 'symlink' } }, 'complete', 'report'],
        ['automatic remote mismatch reported as complete', {}, { ...available('repository'), value: { kind: 'repository', remotes: { origin: 'ssh://example.invalid/other.git' } } }, 'complete', 'report'],
        ['manual matching remote reported as a mutation', { acquire: 'manual' }, available('repository'), 'preview', 'wire-remote'],
        ['missing parent reported as clone-ready', {}, { ...available('absent'), value: { kind: 'absent', missingParent: '/synthetic/missing' } }, 'preview', 'clone'],
    ] as const)('binds setup result semantics to observation: %s', async (_label, siblingChanges, observation, kind, action) => {
        const { configPath, context, adapters } = await sequenceFixture(siblingChanges)
        adapters.observeGit = async () => observation as SetupObservation
        adapters.planGit = async () => {
            if (observation.state !== 'available') throw new Error('fixture observation is unavailable')
            const result = {
                sibling: 'api', target: resolve(context.siblingsRoot, 'api'),
                observed: observation.value.kind, action, changed: action !== 'report',
            }
            return kind === 'preview'
                ? { kind, status: 0, diagnostics: [], result, plan: { steps: [{ id: 'setup:api:mutation' }] as never } }
                : { kind, status: 0, diagnostics: [], result }
        }
        const execute = vi.fn(adapters.execute)
        adapters.execute = execute

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(execute).not.toHaveBeenCalled()
    })

    it('binds a complete postcheck report to the fresh observation', async () => {
        const { configPath, context, adapters } = await sequenceFixture()
        let observations = 0
        adapters.observeGit = async () => {
            observations += 1
            return observations === 1
                ? available('absent')
                : { ...available('repository'), value: { kind: 'repository', remotes: { origin: 'ssh://example.invalid/other.git' } } }
        }
        adapters.planGit = async ({ observation }) => observation.state === 'available' && observation.value.kind === 'absent'
            ? {
                  kind: 'preview', status: 0, diagnostics: [],
                  result: { sibling: 'api', target: resolve(context.siblingsRoot, 'api'), observed: 'absent', action: 'clone', changed: true },
                  plan: { steps: [{ id: 'setup:api:clone' }] as never },
              }
            : {
                  kind: 'complete', status: 0, diagnostics: [],
                  result: { sibling: 'api', target: resolve(context.siblingsRoot, 'api'), observed: 'repository', action: 'report', changed: false },
              }

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'SETUP_POSTCHECK_FAILED' }))
    })

    it.each([
        ['SETUP_PARENT_MISSING', 'automatic checkout parent directory is absent', 'missing-parent'],
        ['SETUP_PATH_TYPE_INVALID', 'repository observation could not be canonicalized', 'api'],
    ] as const)('attributes %s planner refusal to the canonical configuration source', async (code, message, relativeTarget) => {
        const { configPath, context, adapters } = await sequenceFixture()
        const originalTarget = resolve(context.siblingsRoot, relativeTarget)
        adapters.planGit = async () => ({
            kind: 'refusal', status: 2, result: null,
            diagnostics: [{ severity: 'error', code, message, target: originalTarget }],
        })

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toEqual([{
            severity: 'error', code, message: `${message} (${originalTarget})`, target: context.source.path,
        }])
        expect(outcome.diagnostics[0]!.message.split(originalTarget)).toHaveLength(2)
    })

    it('refuses a caller-constructed run context before invoking an owner', async () => {
        const { configPath, context, adapters } = await sequenceFixture()
        const observeGit = vi.fn(adapters.observeGit)
        adapters.load = async () => ({ kind: 'complete', status: 0, diagnostics: [], result: { ...context } })
        adapters.observeGit = observeGit

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(observeGit).not.toHaveBeenCalled()
    })

    it('consumes an issued run context exactly once', async () => {
        const { configPath, adapters } = await sequenceFixture()
        const observeGit = vi.fn(adapters.observeGit)
        adapters.observeGit = observeGit

        expect((await runSetupSequence({ configPath }, adapters)).kind).toBe('complete')
        observeGit.mockClear()
        expect(await runSetupSequence({ configPath }, adapters)).toMatchObject({ kind: 'refusal', result: null })
        expect(observeGit).not.toHaveBeenCalled()
    })

    it.each([
        ['current checkout', (input: SetupRunContextInput) => ({ ...input, currentCheckoutPath: `${input.currentCheckoutPath}-other` })],
        ['main checkout', (input: SetupRunContextInput) => ({ ...input, mainCheckoutPath: `${input.mainCheckoutPath}-other` })],
        ['cockpit identity', (input: SetupRunContextInput) => ({ ...input, cockpitId: `cockpit:other:${'a'.repeat(64)}` as SetupRunContextInput['cockpitId'] })],
        ['checkout identity', (input: SetupRunContextInput) => ({ ...input, checkoutId: `checkout:${'a'.repeat(64)}` as SetupRunContextInput['checkoutId'] })],
        ['state namespace', (input: SetupRunContextInput) => ({ ...input, namespace: {} as SetupRunContextInput['namespace'] })],
        ['shared stack', (input: SetupRunContextInput) => ({ ...input, stackId: `stack:${'a'.repeat(64)}` as SetupRunContextInput['stackId'] })],
        ['session holder', (input: SetupRunContextInput) => ({ ...input, holderId: `holder:${'a'.repeat(64)}:session` as SetupRunContextInput['holderId'] })],
        ['session', (input: SetupRunContextInput) => ({ ...input, sessionId: 'other-session' })],
        ['malformed session', (input: SetupRunContextInput) => ({ ...input, sessionId: '' })],
    ] as const)('refuses mismatched %s authority during issuance', async (_label, change) => {
        const { loaded, candidate } = await unissuedContextFixture()
        const issued = await issueContext(
            candidate,
            loaded,
            (input) => change(input) as SetupRunContextInput,
        )

        expect(issued).toMatchObject({ kind: 'refusal', result: null })
    })

    it('refuses copied configuration authority without exposing caller fields', async () => {
        const { loaded, candidate } = await unissuedContextFixture()
        const issued = await issueContext(candidate, loaded, (input) => ({
            ...input,
            configuration: { ...input.configuration, privateValue: 'config-secret-canary' } as never,
        }))

        expect(issued).toMatchObject({ kind: 'refusal', result: null })
        expect(JSON.stringify(issued)).not.toContain('config-secret-canary')
    })

    it('refuses a forged parsed configuration that was not reconstructed from source bytes', async () => {
        const { loaded, candidate } = await unissuedContextFixture()
        const forged = {
            source: loaded.source,
            config: { ...loaded.config, sibling: [{ ...loaded.config.sibling[0]!, slug: 'forged' }] },
        }
        const issued = await issueContext(candidate, loaded, (input) => ({
            ...input,
            configuration: forged as never,
        }))

        expect(issued).toMatchObject({ kind: 'refusal', result: null })
    })

    it('issues from the hidden source snapshot after the public load result is mutated', async () => {
        const { loaded, candidate } = await unissuedContextFixture()
        const originalSource = { ...candidate.source }
        ;(loaded.source as { path: string }).path = '/synthetic/forged.toml'
        loaded.config.sibling[0]!.dir = 'forged'

        const issued = await issueContext(candidate, loaded)

        expect(issued).toMatchObject({
            kind: 'complete',
            result: { source: originalSource, siblings: [expect.objectContaining({ dir: 'api' })] },
        })
    })

    it('issues from the hidden policy snapshot after a nested public array is mutated', async () => {
        const policy = {
            toolchain: 'node' as const, volume: 'node-modules', lockfile: 'package-lock.json',
            install: ['npm', 'ci'], load_probe: ['npm', 'test'],
        }
        const { loaded, candidate } = await unissuedContextFixture(sequenceSource({ toolchain: 'node' }, [policy], []))
        loaded.config.environment.install_policies[0]!.install[0] = 'forged'

        const issued = await issueContext(candidate, loaded)

        expect(issued).toMatchObject({
            kind: 'complete',
            result: { policyCatalog: [expect.objectContaining({ install: ['npm', 'ci'] })] },
        })
    })

    it('refuses an unreadable issuance input without throwing', () => {
        const input = new Proxy({}, { get: () => { throw new Error('unreadable') } })

        expect(issueSetupRunContext(input as SetupRunContextInput)).toMatchObject({ kind: 'refusal', result: null })
    })

    it('refuses an authenticated namespace issued for another cockpit', async () => {
        const { loaded, candidate } = await unissuedContextFixture()
        const input = await runContextInput(candidate, loaded)
        const stateHome = mkdtempSync(join(tmpdir(), 'cockpit-application-other-state-'))
        scratch.push(stateHome)
        const xdgStateHome = join(stateHome, 'state')
        mkdirSync(xdgStateHome, { recursive: true })
        const selected = await selectStateRoot({
            platform: process.platform === 'darwin' ? 'darwin' : 'linux',
            home: stateHome,
            xdgStateHome,
            checkoutRoot: input.currentCheckoutPath,
            cockpitId: `cockpit:other:${'f'.repeat(64)}` as SetupRunContextInput['cockpitId'],
        })
        if (selected.kind !== 'complete') throw new Error('state namespace was not issued')
        const issued = await issueFromFreshCheckout(
            candidate,
            loaded,
            input,
            (value) => ({ ...value, namespace: selected.value }),
        )

        expect(issued).toMatchObject({ kind: 'refusal', result: null })
    })

    it('refuses final issuance when checkout authority changes after discovery', async () => {
        const { loaded, candidate } = await unissuedContextFixture()
        const input = await runContextInput(candidate, loaded)
        const gitConfig = join(input.currentCheckoutPath, '.git', 'config')
        writeFileSync(gitConfig, '[broken')

        const confirmed = await observeSetupCheckout({
            source: candidate.source,
            cockpitName: loaded.config.cockpit.name,
            observedAt: candidate.observedAt,
            env: candidate.env,
            gitExecutable: candidate.gitExecutable,
        })
        const issued = await withSetupCheckoutProjection(confirmed, {
            source: candidate.source,
            cockpitName: loaded.config.cockpit.name,
            evaluatedAt: Date.parse(candidate.observedAt),
        }, (checkout) => issueSetupRunContext({ ...input, checkout }))

        expect(confirmed.state).toBe('failed')
        expect(issued).toBeUndefined()
    })

    it('ignores an oversized environment value outside the setup allow-list', async () => {
        const irrelevantValue = 'irrelevant-secret-canary'.repeat(65_536)

        const outcome = setupEnvironment({
            HOME: '/tmp/synthetic-home',
            COCKPIT_TEST_IRRELEVANT: irrelevantValue,
        })

        expect(outcome).not.toHaveProperty('COCKPIT_TEST_IRRELEVANT')
        expect(JSON.stringify(outcome)).not.toContain(irrelevantValue)
    })

    it('projects only exact approved uppercase values into the setup child environment', () => {
        const outcome = setupEnvironment({
            PATH: '/synthetic/bin',
            HOME: '/tmp/synthetic-home',
            Path: '/case-preserved-search-only',
            PathExt: '.EXE',
            PATHEXT: undefined,
            COCKPIT_TEST_SECRET: 'secret-canary',
        })

        expect(outcome).toEqual({
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            HOME: '/tmp/synthetic-home',
            PATH: '/synthetic/bin',
        })
        expect(JSON.stringify(outcome)).not.toContain('case-preserved-search-only')
        expect(JSON.stringify(outcome)).not.toContain('secret-canary')
    })

    it('does not read an environment property outside the setup allow-list', async () => {
        const env = { HOME: '/tmp/synthetic-home' } as Record<string, string>
        const readIrrelevant = vi.fn(() => {
            throw new Error('irrelevant-secret-canary')
        })
        Object.defineProperty(env, 'COCKPIT_TEST_UNREADABLE', {
            enumerable: true,
            get: readIrrelevant,
        })

        const outcome = setupEnvironment(env)

        expect(outcome).toEqual(expect.objectContaining({ HOME: '/tmp/synthetic-home' }))
        expect(readIrrelevant).not.toHaveBeenCalled()
        expect(JSON.stringify(outcome)).not.toContain('irrelevant-secret-canary')
    })

    it('refuses an unreadable environment value inside the setup allow-list', () => {
        const env = {} as Record<string, string>
        const readPath = vi.fn(() => {
            throw new Error('relevant-secret-canary')
        })
        Object.defineProperty(env, 'PATH', { enumerable: true, get: readPath })

        expect(setupEnvironment(env)).toBeUndefined()
        expect(readPath).toHaveBeenCalledOnce()
    })

    it.each([7, [], 'x\0hidden'])('refuses an invalid environment value inside the setup allow-list', (value) => {
        expect(setupEnvironment({ PATH: value } as never)).toBeUndefined()
    })

    it('refuses an explicit null environment instead of reading ambient process state', async () => {
        const outcome = setupEnvironment(null as never)

        expect(outcome).toBeUndefined()
    })

    it('retains lifecycle mutation evidence when execution is refused before starting', async () => {
        const { configPath, adapters } = await sequenceFixture()
        adapters.observeGit = cloneObservations()
        adapters.planGit = async ({ sibling, context }) => ({
            kind: 'preview', status: 0, diagnostics: [],
            result: { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'absent', action: 'clone', changed: true },
            plan: { steps: [{ id: 'setup:api:clone' }] as never },
        })
        adapters.recordStarted = async () => ({ kind: 'complete', record: {} as never })
        adapters.execute = async () => ({
            kind: 'refusal', status: 2, diagnostics: [], result: null,
            execution: {
                completedStepIds: [], failedStep: { id: 'setup:api:clone', started: false },
                compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] },
            },
        })

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome.kind).toBe('refusal')
        if (outcome.kind !== 'refusal') throw new Error('expected setup refusal')
        if (!outcome.evidence) throw new Error('expected setup refusal evidence')
        expect(outcome.evidence.execution.mutationMayHaveOccurred).toBe(true)
    })

    it('retains an earlier seed mutation when a later execution is refused before starting', async () => {
        const { configPath, context, adapters } = await sequenceFixture(
            { environment_files: [{ template: '.env.example', instance: '.env' }] },
            [],
            [{ slug: 'web', dir: 'web', var: 'WEB_DIR', environment_files: [] }],
        )
        const apiRoot = resolve(context.siblingsRoot, 'api')
        adapters.observeGit = async ({ sibling }) => available(sibling.slug === 'web' ? 'absent' : 'repository')
        adapters.planGit = async ({ sibling }) => sibling.slug === 'web'
            ? {
                  kind: 'preview', status: 0, diagnostics: [],
                  result: { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'absent', action: 'clone', changed: true },
                  plan: { steps: [{ id: 'setup:web:clone' }] as never },
              }
            : {
                  kind: 'complete', status: 0, diagnostics: [],
                  result: { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'repository', action: 'report', changed: false },
              }
        let seeded = false
        adapters.planSeed = async () => seeded
            ? { kind: 'unchanged', siblingRoot: apiRoot, destination: resolve(apiRoot, '.env') }
            : readySeed(apiRoot)
        adapters.seed = () => {
            seeded = true
            return { kind: 'created', siblingRoot: apiRoot, destination: resolve(apiRoot, '.env') }
        }
        adapters.recordStarted = async () => ({ kind: 'complete', record: {} as never })
        adapters.execute = async () => ({
            kind: 'refusal', status: 2, diagnostics: [], result: null,
            execution: {
                completedStepIds: [], failedStep: { id: 'setup:web:clone', started: false },
                compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] },
            },
        })

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome.kind).toBe('refusal')
        if (outcome.kind !== 'refusal') throw new Error('expected setup refusal')
        if (!outcome.evidence) throw new Error('expected setup refusal evidence')
        expect(outcome.evidence.execution.mutationMayHaveOccurred).toBe(true)
    })

    it('refuses source drift before lifecycle or Git mutation', async () => {
        const { configPath, context, adapters } = await sequenceFixture()
        let changed = false
        const recordStarted = vi.fn(adapters.recordStarted)
        const execute = vi.fn(adapters.execute)
        adapters.observeGit = cloneObservations()
        adapters.planGit = async ({ sibling }) => {
            changed = true
            return {
                kind: 'preview', status: 0, diagnostics: [],
                result: { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'absent', action: 'clone', changed: true },
                plan: { steps: [{ id: 'setup:api:clone' }] as never },
            }
        }
        adapters.observeSource = async () => ({
            state: 'available', ...context.source,
            ...(changed ? { sha256: 'f'.repeat(64) } : {}),
        })
        adapters.recordStarted = recordStarted
        adapters.execute = execute

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(recordStarted).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it('refuses source drift introduced by lifecycle before Git mutation', async () => {
        const { configPath, context, adapters } = await sequenceFixture()
        let changed = false
        const execute = vi.fn(adapters.execute)
        adapters.observeGit = cloneObservations()
        adapters.planGit = async ({ sibling }) => ({
            kind: 'preview', status: 0, diagnostics: [],
            result: { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'absent', action: 'clone', changed: true },
            plan: { steps: [{ id: 'setup:api:clone' }] as never },
        })
        adapters.recordStarted = async () => { changed = true; return { kind: 'complete', record: {} as never } }
        adapters.observeSource = async () => ({
            state: 'available', ...context.source,
            ...(changed ? { sha256: 'f'.repeat(64) } : {}),
        })
        adapters.execute = execute

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(execute).not.toHaveBeenCalled()
        if (outcome.kind !== 'refusal') throw new Error('expected setup refusal')
        if (!outcome.evidence) throw new Error('expected setup refusal evidence')
        expect(outcome.evidence.execution.mutationMayHaveOccurred).toBe(true)
    })

    it('preserves completed execution evidence when repository postcheck refuses', async () => {
        const { configPath, context, adapters } = await sequenceFixture()
        let plans = 0
        adapters.observeGit = cloneObservations()
        adapters.planGit = async ({ sibling }) => {
            plans += 1
            return plans === 1
                ? {
                      kind: 'preview', status: 0, diagnostics: [],
                      result: { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'absent', action: 'clone', changed: true },
                      plan: { steps: [{ id: 'setup:api:clone' }] as never },
                  }
                : {
                      kind: 'refusal', status: 2, result: null,
                      diagnostics: [{ severity: 'error', code: 'SETUP_PATH_TYPE_INVALID', message: 'postcheck unavailable', target: resolve(context.siblingsRoot, sibling.dir) }],
                  }
        }
        adapters.execute = async () => ({
            kind: 'complete', status: 0, diagnostics: [],
            result: { steps: [{ id: 'setup:api:clone', exitCode: 0, signal: null, stdoutBytes: 0, stderrBytes: 0 }] },
        })

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        if (outcome.kind !== 'refusal' || !outcome.evidence) throw new Error('expected refusal evidence')
        expect(outcome.evidence.execution).toMatchObject({
            mutationMayHaveOccurred: true,
            completedStepIds: ['setup:api:clone'],
        })
        expect(outcome.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'SETUP_PATH_TYPE_INVALID' }),
            expect.objectContaining({ code: 'SETUP_POSTCHECK_FAILED' }),
        ]))
    })

    it('refuses when repository postcheck still proposes mutation', async () => {
        const { configPath, context, adapters } = await sequenceFixture()
        adapters.observeGit = cloneObservations()
        adapters.planGit = async ({ sibling }) => ({
            kind: 'preview', status: 0, diagnostics: [],
            result: { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'absent', action: 'clone', changed: true },
            plan: { steps: [{ id: 'setup:api:clone' }] as never },
        })
        adapters.execute = async () => ({
            kind: 'complete', status: 0, diagnostics: [],
            result: { steps: [{ id: 'setup:api:clone', exitCode: 0, signal: null, stdoutBytes: 0, stderrBytes: 0 }] },
        })

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'SETUP_POSTCHECK_FAILED' }))
        if (outcome.kind !== 'refusal' || !outcome.evidence) throw new Error('expected refusal evidence')
        expect(outcome.evidence.execution).toMatchObject({
            mutationMayHaveOccurred: true,
            completedStepIds: ['setup:api:clone'],
        })
    })

    it('preserves executor evidence and checks source after a started failure', async () => {
        const { configPath, context, adapters } = await sequenceFixture()
        let changed = false
        adapters.observeGit = cloneObservations()
        adapters.planGit = async ({ sibling }) => ({
            kind: 'preview', status: 0, diagnostics: [],
            result: { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'absent', action: 'clone', changed: true },
            plan: { steps: [{ id: 'setup:api:clone' }] as never },
        })
        adapters.execute = async () => {
            changed = true
            return {
                kind: 'refusal', status: 2, result: null,
                diagnostics: [
                    { severity: 'error', code: 'EXECUTION_STEP_FAILED', message: 'step failed', target: 'setup:api:clone' },
                    { severity: 'error', code: 'EXECUTION_COMPENSATION_STEP_FAILED', message: 'undo failed', target: 'undo:api' },
                ],
                execution: {
                    completedStepIds: ['setup:other:clone'],
                    failedStep: { id: 'setup:api:clone', started: true },
                    compensation: { attemptedStepIds: ['undo:api'], completedStepIds: [], failed: [{ id: 'undo:api', code: 'EXECUTION_STEP_FAILED' }] },
                },
            }
        }
        adapters.observeSource = async () => ({
            state: 'available', ...context.source,
            ...(changed ? { sha256: 'f'.repeat(64) } : {}),
        })

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        if (outcome.kind !== 'refusal' || !outcome.evidence) throw new Error('expected refusal evidence')
        expect(outcome.evidence.execution).toEqual({
            mutationMayHaveOccurred: true,
            completedStepIds: ['setup:other:clone'],
            failedStep: { id: 'setup:api:clone', started: true },
            compensation: { attemptedStepIds: ['undo:api'], completedStepIds: [], failed: [{ id: 'undo:api', code: 'EXECUTION_STEP_FAILED' }] },
        })
        expect(outcome.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'EXECUTION_STEP_FAILED', target: 'setup:api:clone' }),
            expect.objectContaining({ code: 'EXECUTION_COMPENSATION_STEP_FAILED', target: 'undo:api' }),
            expect.objectContaining({ code: 'CONFIG_CHANGED_DURING_EXECUTION' }),
        ]))
    })

    it('does not claim mutation when lifecycle is unchanged and a failed step never started', async () => {
        const { configPath, context, adapters } = await sequenceFixture()
        adapters.observeGit = cloneObservations()
        adapters.planGit = async ({ sibling }) => ({
            kind: 'preview', status: 0, diagnostics: [],
            result: { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'absent', action: 'clone', changed: true },
            plan: { steps: [{ id: 'setup:api:clone' }] as never },
        })
        adapters.execute = async () => ({
            kind: 'refusal', status: 2, diagnostics: [], result: null,
            execution: {
                completedStepIds: [], failedStep: { id: 'setup:api:clone', started: false },
                compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] },
            },
        })

        const outcome = await runSetupSequence({ configPath }, adapters)

        if (outcome.kind !== 'refusal' || !outcome.evidence) throw new Error('expected refusal evidence')
        expect(outcome.evidence.execution).toMatchObject({
            mutationMayHaveOccurred: false,
            failedStep: { id: 'setup:api:clone', started: false },
        })
    })

    it.each([
        ['canonical path', { path: '/synthetic/other.toml' }],
        ['byte length', { byteLength: 129 }],
        ['digest', { sha256: 'b'.repeat(64) }],
        ['availability', null],
    ])('compares post-execution source %s independently', async (_field, changedSource) => {
        const { configPath, context, adapters } = await sequenceFixture()
        let executed = false
        let plans = 0
        adapters.observeGit = cloneObservations()
        adapters.planGit = async ({ sibling }) => {
            plans += 1
            const result = plans === 1
                ? { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'absent' as const, action: 'clone' as const, changed: true }
                : { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'repository' as const, action: 'report' as const, changed: false }
            return plans === 1
                ? { kind: 'preview', status: 0, diagnostics: [], result, plan: { steps: [{ id: 'setup:api:clone' }] as never } }
                : { kind: 'complete', status: 0, diagnostics: [], result }
        }
        adapters.execute = async () => {
            executed = true
            return { kind: 'complete', status: 0, diagnostics: [], result: { steps: [{ id: 'setup:api:clone', exitCode: 0, signal: null, stdoutBytes: 0, stderrBytes: 0 }] } }
        }
        adapters.observeSource = async () => executed && changedSource === null
            ? { state: 'unavailable', path: context.source.path, code: 'CONFIG_NOT_FOUND' }
            : { state: 'available', ...context.source, ...(executed ? changedSource : {}) }

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_CHANGED_DURING_EXECUTION' }))
        if (outcome.kind !== 'refusal' || !outcome.evidence) throw new Error('expected refusal evidence')
        expect(outcome.evidence.source.after).toMatchObject(changedSource === null
            ? { state: 'unavailable', path: context.source.path }
            : { state: 'available', ...changedSource })
    })

    it('deduplicates a stable diagnostic returned before and after execution', async () => {
        const { configPath, context, adapters } = await sequenceFixture()
        const diagnostic = {
            severity: 'warning' as const,
            code: 'SETUP_MANUAL_MISSING' as const,
            message: 'manual checkout is absent',
            target: resolve(context.siblingsRoot, 'api'),
        }
        let plans = 0
        adapters.observeGit = cloneObservations()
        adapters.planGit = async ({ sibling }) => {
            plans += 1
            const result = plans === 1
                ? { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'absent' as const, action: 'clone' as const, changed: true }
                : { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: 'repository' as const, action: 'report' as const, changed: false }
            return plans === 1
                ? { kind: 'preview', status: 0, diagnostics: [diagnostic], result, plan: { steps: [{ id: 'setup:api:clone' }] as never } }
                : { kind: 'complete', status: 0, diagnostics: [diagnostic], result }
        }
        adapters.execute = async () => ({
            kind: 'complete', status: 0, diagnostics: [],
            result: { steps: [{ id: 'setup:api:clone', exitCode: 0, signal: null, stdoutBytes: 0, stderrBytes: 0 }] },
        })

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome.kind).toBe('complete')
        expect(outcome.diagnostics).toEqual([diagnostic])
    })

    it('refuses source drift before environment-file mutation', async () => {
        const { configPath, context, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        let changed = false
        const seed = vi.fn(adapters.seed)
        adapters.planSeed = async () => {
            changed = true
            return readySeed(resolve(context.siblingsRoot, 'api'))
        }
        adapters.observeSource = async () => ({
            state: 'available', ...context.source,
            ...(changed ? { sha256: 'f'.repeat(64) } : {}),
        })
        adapters.seed = seed

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(seed).not.toHaveBeenCalled()
    })

    it.each([
        ['missing declaration result', (_root: string) => ({ kind: 'none' })],
        ['escaped ready root', (root: string) => ({ ...readySeed(root), siblingRoot: '/tmp/other', canonicalRoot: '/tmp/other', source: '/tmp/other/.env.example', destination: '/tmp/other/.env' })],
        ['extra ready field', (root: string) => ({ ...readySeed(root), privateValue: 'seed-secret-canary' })],
        ['malformed ready identity', (root: string) => ({ ...readySeed(root), sourceIdentity: { ...fileIdentity, privateValue: 'seed-secret-canary' } })],
        ['another owner refusal', (root: string) => ({ kind: 'refusal', code: 'TEMPLATE_NOT_TRACKED', path: resolve(root, '.env.example') })],
    ] as const)('refuses an unauthenticated environment seed plan: %s', async (_label, plan) => {
        const { configPath, context, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        const seed = vi.fn(adapters.seed)
        const recordStarted = vi.fn(adapters.recordStarted)
        adapters.planSeed = async () => plan(resolve(context.siblingsRoot, 'api')) as never
        adapters.seed = seed
        adapters.recordStarted = recordStarted

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(seed).not.toHaveBeenCalled()
        expect(recordStarted).not.toHaveBeenCalled()
        expect(JSON.stringify(outcome)).not.toContain('seed-secret-canary')
    })

    it('refuses an unauthenticated seed refusal without exposing adapter fields', async () => {
        const { configPath, context, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        adapters.planSeed = async () => ({
            kind: 'refusal', code: 'TEMPLATE_NOT_FOUND', path: '/tmp/other', privateValue: 'seed-secret-canary',
        } as never)

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(JSON.stringify(outcome)).not.toContain('seed-secret-canary')
    })

    it('rechecks ignore authority after an asynchronous unchanged seed plan', async () => {
        const { configPath, context, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        const siblingRoot = resolve(context.siblingsRoot, 'api')
        let authorizations = 0
        adapters.planSeed = async () => ({
            kind: 'unchanged', siblingRoot, destination: resolve(siblingRoot, '.env'),
        })
        adapters.withIgnore = async (_input, use) => {
            authorizations += 1
            return authorizations === 1
                ? use()
                : { kind: 'refusal', code: 'INSTANCE_NOT_IGNORED', path: '.env' }
        }

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({
            code: 'INSTANCE_NOT_IGNORED', target: '.env',
        }))
        expect(authorizations).toBe(2)
    })

    it('refuses invalid ignore authority before lifecycle or structural planning', async () => {
        const { configPath, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        const recordStarted = vi.fn(adapters.recordStarted)
        const planSeed = vi.fn(adapters.planSeed)
        adapters.recordStarted = recordStarted
        adapters.planSeed = planSeed
        adapters.withIgnore = async () => ({
            kind: 'refusal', code: 'INSTANCE_NOT_IGNORED', path: '.env',
        })

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'INSTANCE_NOT_IGNORED' }))
        expect(planSeed).not.toHaveBeenCalled()
        expect(recordStarted).not.toHaveBeenCalled()
    })

    it.each([
        ['an escaped path', { kind: 'refusal', code: 'INSTANCE_NOT_IGNORED', path: '../other.env' }],
        ['an extra field', { kind: 'refusal', code: 'INSTANCE_NOT_IGNORED', path: '.env', privateValue: 'ignore-secret-canary' }],
    ] as const)('bounds ignore authority with %s', async (_label, authority) => {
        const { configPath, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        adapters.withIgnore = async () => authority as never

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({
            code: 'SETUP_PATH_TYPE_INVALID',
            message: 'environment ignore evidence is unavailable',
        }))
        expect(JSON.stringify(outcome)).not.toContain('ignore-secret-canary')
    })

    it('does not invoke an ignore refusal accessor', async () => {
        const { configPath, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        const readCode = vi.fn(() => { throw new Error('ignore-secret-canary') })
        const authority = { kind: 'refusal', path: '.env' }
        Object.defineProperty(authority, 'code', { enumerable: true, get: readCode })
        adapters.withIgnore = async () => authority as never

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(readCode).not.toHaveBeenCalled()
        expect(JSON.stringify(outcome)).not.toContain('ignore-secret-canary')
    })

    it('does not invoke an environment seed plan accessor', async () => {
        const { configPath, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        const readSource = vi.fn(() => { throw new Error('seed-secret-canary') })
        const plan = { kind: 'ready' }
        Object.defineProperty(plan, 'source', { enumerable: true, get: readSource })
        adapters.planSeed = async () => plan as never

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(readSource).not.toHaveBeenCalled()
        expect(JSON.stringify(outcome)).not.toContain('seed-secret-canary')
    })

    it('does not invoke an environment seed result accessor', async () => {
        const { configPath, context, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        const siblingRoot = resolve(context.siblingsRoot, 'api')
        const readDestination = vi.fn(() => { throw new Error('seed-secret-canary') })
        const seeded = { kind: 'created', siblingRoot }
        Object.defineProperty(seeded, 'destination', { enumerable: true, get: readDestination })
        adapters.planSeed = async () => readySeed(siblingRoot)
        adapters.seed = () => seeded as never

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(readDestination).not.toHaveBeenCalled()
        expect(JSON.stringify(outcome)).not.toContain('seed-secret-canary')
        if (outcome.kind !== 'refusal' || !outcome.evidence) throw new Error('expected refusal evidence')
        expect(outcome.evidence.execution.mutationMayHaveOccurred).toBe(true)
    })

    it('refuses ignore drift during asynchronous planning at the fresh copy authorization', async () => {
        const { configPath, context, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        let authorizations = 0
        adapters.withIgnore = async (_input, use) => {
            authorizations += 1
            return authorizations === 1
                ? use()
                : { kind: 'refusal', code: 'TEMPLATE_IGNORED', path: '.env.example' }
        }
        adapters.planSeed = async () => readySeed(resolve(context.siblingsRoot, 'api'))
        const seed = vi.fn(adapters.seed)
        adapters.seed = seed

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'TEMPLATE_IGNORED' }))
        expect(seed).not.toHaveBeenCalled()
        expect(authorizations).toBe(2)
    })

    it('requires fresh ignore authority for the postcheck after a successful copy', async () => {
        const { configPath, context, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        const siblingRoot = resolve(context.siblingsRoot, 'api')
        const destination = resolve(siblingRoot, '.env')
        let authorizations = 0
        let copied = false
        adapters.withIgnore = async (_input, use) => {
            authorizations += 1
            return authorizations < 3
                ? use()
                : { kind: 'refusal', code: 'INSTANCE_NOT_IGNORED', path: '.env' }
        }
        adapters.planSeed = async ({ sibling }) => copied
            ? { kind: 'unchanged', siblingRoot, destination }
            : readySeed(siblingRoot)
        adapters.seed = () => {
            copied = true
            return { kind: 'created', siblingRoot, destination }
        }

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({
            code: 'INSTANCE_NOT_IGNORED', target: '.env',
        }))
        expect(authorizations).toBe(3)
    })

    it('names unavailable final ignore authority after a successful copy', async () => {
        const { configPath, context, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        const siblingRoot = resolve(context.siblingsRoot, 'api')
        let authorizations = 0
        let copied = false
        adapters.withIgnore = async (_input, use) => {
            authorizations += 1
            return authorizations < 3 ? use() : undefined
        }
        adapters.planSeed = async () => copied
            ? { kind: 'unchanged', siblingRoot, destination: resolve(siblingRoot, '.env') }
            : readySeed(siblingRoot)
        adapters.seed = () => {
            copied = true
            return { kind: 'created', siblingRoot, destination: resolve(siblingRoot, '.env') }
        }

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({
            code: 'SETUP_PATH_TYPE_INVALID',
            message: 'environment ignore evidence is unavailable',
            target: siblingRoot,
        }))
        expect(authorizations).toBe(3)
    })

    it('refuses source drift before a report-only success', async () => {
        const { configPath, context, adapters } = await sequenceFixture()
        adapters.observeSource = async () => ({ state: 'available', ...context.source, sha256: 'f'.repeat(64) })

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_CHANGED_DURING_EXECUTION' }))
    })

    it('reports environment-file outcomes without exposing their contents', async () => {
        const { configPath, context, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        const siblingRoot = resolve(context.siblingsRoot, 'api')
        const destination = resolve(siblingRoot, '.env')
        let planned = false
        adapters.planSeed = async ({ sibling }) => planned
            ? { kind: 'unchanged', siblingRoot, destination }
            : readySeed(siblingRoot)
        adapters.seed = (plan) => {
            planned = true
            return { kind: 'created', siblingRoot, destination }
        }

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome.result).toMatchObject({
            environmentFiles: [{ kind: 'created', siblingRoot, destination }],
        })
    })

    it.each(['unchanged', 'created'] as const)(
        'refuses an adapter-owned %s seed report with an extra secret field',
        async (kind) => {
            const { configPath, context, adapters } = await sequenceFixture({
                environment_files: [{ template: '.env.example', instance: '.env' }],
            })
            const siblingRoot = resolve(context.siblingsRoot, 'api')
            const destination = resolve(siblingRoot, '.env')
            let copied = false
            adapters.planSeed = async () => kind === 'unchanged' || copied
                ? { kind: 'unchanged', siblingRoot, destination, privateValue: 'seed-secret-canary' } as never
                : readySeed(siblingRoot)
            adapters.seed = () => {
                copied = true
                return { kind: 'created', siblingRoot, destination, privateValue: 'seed-secret-canary' } as never
            }

            const outcome = await runSetupSequence({ configPath }, adapters)

            expect(outcome).toMatchObject({ kind: 'refusal', result: null })
            expect(JSON.stringify(outcome)).not.toContain('seed-secret-canary')
        },
    )

    it.each([
        ['extra fields', (root: string) => ({
            kind: 'refusal', code: 'TEMPLATE_NOT_FOUND', path: resolve(root, '.env.example'),
            privateValue: 'seed-secret-canary',
        })],
        ['another owner code', (root: string) => ({
            kind: 'refusal', code: 'TEMPLATE_NOT_TRACKED', path: resolve(root, '.env.example'),
        })],
    ] as const)('refuses an adapter-owned seed refusal with %s', async (_label, refusal) => {
        const { configPath, context, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        const siblingRoot = resolve(context.siblingsRoot, 'api')
        adapters.planSeed = async () => readySeed(siblingRoot)
        adapters.seed = () => refusal(siblingRoot) as never

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(JSON.stringify(outcome)).not.toContain('seed-secret-canary')
    })

    it('omits install policies when no policy applies', async () => {
        const { configPath, adapters } = await sequenceFixture()

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome.kind).toBe('complete')
        expect(outcome.result).not.toHaveProperty('installPolicies')
    })

    it('issues fresh timestamps for operation authorities after a long repository operation', async () => {
        vi.useFakeTimers()
        const checkoutTime = new Date('2026-09-10T08:00:00.000Z')
        const operationTime = new Date('2026-09-10T08:01:01.000Z')
        vi.setSystemTime(checkoutTime)
        try {
            const policy = {
                toolchain: 'node' as const,
                volume: 'node-modules',
                lockfile: 'package-lock.json',
                install: ['npm', 'ci'],
                load_probe: ['npm', 'test'],
            }
            const { configPath, context, adapters } = await sequenceFixture({
                toolchain: 'node',
                environment_files: [{ template: '.env.example', instance: '.env' }],
            }, [policy])
            const siblingRoot = resolve(context.siblingsRoot, 'api')
            const destination = resolve(siblingRoot, '.env')
            let seeded = false
            let planned = false
            const lifecycleTimes: string[] = []
            const ignoreTimes: string[] = []
            const policyObservationTimes: string[] = []
            const policyProjectionTimes: string[] = []
            const observedAt = vi.fn(() => new Date().toISOString())
            adapters.observedAt = observedAt

            adapters.planGit = async (input) => {
                const result = {
                    sibling: input.sibling.slug,
                    target: siblingRoot,
                    observed: 'repository' as const,
                    action: 'report' as const,
                    changed: false,
                }
                if (!planned) {
                    planned = true
                    vi.setSystemTime(operationTime)
                }
                return { kind: 'complete', status: 0, diagnostics: [], result }
            }
            adapters.recordStarted = async ({ observedAt }) => {
                lifecycleTimes.push(observedAt)
                return { kind: 'complete', record: {} as never }
            }
            adapters.withIgnore = async ({ observedAt }, use) => {
                ignoreTimes.push(observedAt)
                return use()
            }
            adapters.planSeed = async () => seeded
                ? { kind: 'unchanged', siblingRoot, destination }
                : readySeed(siblingRoot)
            adapters.seed = () => {
                seeded = true
                return { kind: 'created', siblingRoot, destination }
            }
            adapters.observePolicy = async ({ observedAt }) => {
                policyObservationTimes.push(observedAt)
                vi.setSystemTime(new Date(operationTime.getTime() + 1_000))
                return { state: 'available' } as never
            }
            adapters.withPolicy = async (_observation, { observedAt }, use) => {
                policyProjectionTimes.push(observedAt)
                return use({} as never)
            }
            adapters.resolvePolicy = ({ siblingIndex, sibling, checkoutRoot, checkoutId }) => ({
                kind: 'complete',
                bindings: [{
                    source: context.source,
                    siblingIndex,
                    diagnostics: { catalogIndex: 0 },
                    siblingSlug: sibling.slug,
                    checkoutRoot,
                    checkoutId,
                    policy,
                }],
            })

            const outcome = await runSetupSequence({ configPath }, adapters)

            expect(outcome.kind).toBe('complete')
            expect(context).not.toHaveProperty('observedAt')
            expect(lifecycleTimes).toEqual([operationTime.toISOString()])
            expect(ignoreTimes).toEqual(Array(3).fill(operationTime.toISOString()))
            expect(policyObservationTimes).toEqual([operationTime.toISOString()])
            expect(policyProjectionTimes).toEqual(policyObservationTimes)
            expect(observedAt).toHaveBeenCalledTimes(5)
        } finally {
            vi.useRealTimers()
        }
    })

    it.each([
        ['malformed', (): string => 'not-a-timestamp'],
        ['unreadable', (): string => { throw new Error('clock failed') }],
    ] as const)('refuses %s operation time before invoking an authority owner', async (_label, clock) => {
        const { configPath, context, adapters } = await sequenceFixture({
            environment_files: [{ template: '.env.example', instance: '.env' }],
        })
        const withIgnore = vi.fn()
        adapters.observedAt = clock
        adapters.withIgnore = async (_input, use) => {
            withIgnore()
            return use()
        }

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual({
            severity: 'error',
            code: 'SETUP_PATH_TYPE_INVALID',
            message: 'setup operation timestamp is unavailable',
            target: context.source.path,
        })
        expect(withIgnore).not.toHaveBeenCalled()
    })

    it.each([
        ['zero bindings', (binding: Record<string, unknown>) => []],
        ['multiple bindings', (binding: Record<string, unknown>) => [binding, binding]],
        ['source', (binding: Record<string, unknown>) => [{ ...binding, source: { ...(binding.source as object), sha256: 'f'.repeat(64) } }]],
        ['sibling index', (binding: Record<string, unknown>) => [{ ...binding, siblingIndex: 1 }]],
        ['sibling slug', (binding: Record<string, unknown>) => [{ ...binding, siblingSlug: 'other' }]],
        ['checkout root', (binding: Record<string, unknown>) => [{ ...binding, checkoutRoot: '/synthetic/other' }]],
        ['checkout identity', (binding: Record<string, unknown>) => [{ ...binding, checkoutId: `checkout:${'f'.repeat(64)}` }]],
        ['catalog index', (binding: Record<string, unknown>) => [{ ...binding, diagnostics: { catalogIndex: 1 } }]],
        ['policy', (binding: Record<string, unknown>) => [{ ...binding, policy: { ...(binding.policy as object), toolchain: 'python' } }]],
        ['top-level field', (binding: Record<string, unknown>) => [{ ...binding, privateValue: 'policy-secret-canary' }]],
        ['source field', (binding: Record<string, unknown>) => [{ ...binding, source: { ...(binding.source as object), privateValue: 'policy-secret-canary' } }]],
        ['diagnostic field', (binding: Record<string, unknown>) => [{ ...binding, diagnostics: { catalogIndex: 0, privateValue: 'policy-secret-canary' } }]],
    ] as const)('refuses a complete policy result with mismatched %s', async (_label, alter) => {
        const policy = {
            toolchain: 'node' as const,
            volume: 'node-modules',
            lockfile: 'package-lock.json',
            install: ['npm', 'ci'],
            load_probe: ['npm', 'test'],
        }
        const { configPath, context, adapters } = await sequenceFixture({ toolchain: 'node' }, [policy])
        adapters.resolvePolicy = ({ siblingIndex, sibling, checkoutRoot, checkoutId }) => {
            const binding = {
                source: context.source,
                siblingIndex,
                diagnostics: { catalogIndex: 0 },
                siblingSlug: sibling.slug,
                checkoutRoot,
                checkoutId,
                policy,
            }
            return { kind: 'complete', bindings: alter(binding) } as never
        }

        const outcome = await runSetupSequence({ configPath }, adapters)

        expect(outcome).toMatchObject({ kind: 'refusal', result: null })
        expect(outcome.diagnostics).toContainEqual(expect.objectContaining({
            code: 'INSTALL_POLICY_OBSERVATION_UNAVAILABLE',
        }))
        expect(JSON.stringify(outcome)).not.toContain('policy-secret-canary')
    })

    it('keeps the complete sequence adjacent for each sibling', async () => {
        const policy = { toolchain: 'node' as const, lockfile: 'package-lock.json', install: ['npm', 'ci'], load_probe: ['npm', 'test'], volume: 'node_modules' }
        const source = sequenceSource(
            { toolchain: 'node', environment_files: [{ template: '.env.example', instance: '.env' }] },
            [policy],
            [{ slug: 'web', dir: 'web', var: 'WEB_DIR', toolchain: 'node', environment_files: [{ template: '.env.example', instance: '.env' }] }],
        )
        const { configPath, loaded, candidate } = await unissuedContextFixture(source)
        const context = await authorizeContext(candidate, loaded)
        const events: string[] = []
        const observations = new Map<string, number>()
        const seeds = new Set<string>()
        const sequence: SetupCommandAdapters = {
            load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
            observedAt: () => new Date().toISOString(),
            observeGit: async ({ sibling }) => {
                events.push(`observe:${sibling.slug}`)
                const count = observations.get(sibling.slug) ?? 0
                observations.set(sibling.slug, count + 1)
                return available(count === 0 ? 'absent' : 'repository')
            },
            planGit: async ({ sibling, observation }) => {
                events.push(`plan:${sibling.slug}`)
                const repository = observation.state === 'available' && observation.value.kind === 'repository'
                const result = { sibling: sibling.slug, target: resolve(context.siblingsRoot, sibling.dir), observed: repository ? 'repository' as const : 'absent' as const, action: repository ? 'report' as const : 'clone' as const, changed: !repository }
                return repository
                    ? { kind: 'complete', status: 0, diagnostics: [], result }
                    : { kind: 'preview', status: 0, diagnostics: [], result, plan: { steps: [{ id: `setup:${sibling.slug}:clone` }] as never } }
            },
            execute: async (plan) => {
                const id = plan.steps[0]!.id
                events.push(`execute:${id.split(':')[1]}`)
                return { kind: 'complete', status: 0, diagnostics: [], result: { steps: [{ id, exitCode: 0, signal: null, stdoutBytes: 0, stderrBytes: 0 }] } }
            },
            observeSource: async () => ({ state: 'available', ...context.source }),
            recordStarted: async () => { events.push('started'); return { kind: 'complete', record: {} as never } },
            withIgnore: async ({ sibling }, use) => { events.push(`ignore:${sibling.slug}`); return use() },
            planSeed: async ({ sibling }) => { const siblingRoot = resolve(context.siblingsRoot, sibling.dir); const destination = resolve(siblingRoot, '.env'); events.push(`seed-plan:${sibling.slug}`); return seeds.has(sibling.slug) ? { kind: 'unchanged', siblingRoot, destination } : readySeed(siblingRoot) },
            seed: (plan) => { const siblingRoot = plan.kind === 'ready' ? plan.siblingRoot : ''; const slug = siblingRoot.split('/').at(-1) ?? ''; const destination = resolve(siblingRoot, '.env'); events.push(`seed:${slug}`); seeds.add(slug); return { kind: 'created', siblingRoot, destination } },
            observePolicy: async ({ sibling }) => { events.push(`policy-observe:${sibling.slug}`); return { state: 'available' } as never },
            withPolicy: async (_observation, { sibling }, use) => { events.push(`policy-resolve:${sibling.slug}`); return use({} as never) },
            resolvePolicy: ({ siblingIndex, sibling, checkoutRoot, checkoutId }) => ({ kind: 'complete', bindings: [{ source: context.source, siblingIndex, diagnostics: { catalogIndex: 0 }, siblingSlug: sibling.slug, checkoutRoot, checkoutId, policy: context.policyCatalog[0]! }] }),
        }

        const outcome = await runSetupSequence({ configPath }, sequence)

        expect(outcome.kind).toBe('complete')
        expect(events).toEqual([
            'observe:api', 'plan:api', 'started', 'execute:api', 'observe:api', 'plan:api',
            'ignore:api', 'seed-plan:api', 'ignore:api', 'seed:api', 'seed-plan:api', 'ignore:api', 'policy-observe:api', 'policy-resolve:api',
            'observe:web', 'plan:web', 'execute:web', 'observe:web', 'plan:web',
            'ignore:web', 'seed-plan:web', 'ignore:web', 'seed:web', 'seed-plan:web', 'ignore:web', 'policy-observe:web', 'policy-resolve:web',
        ])
    })

    describe('cold retry', () => {
        let configPath: string
        let candidate: UnissuedSetupContext
        let firstContext: SetupRunContext
        let policy: InstallPolicy

        beforeEach(async () => {
            policy = {
                toolchain: 'node', volume: 'node-modules', lockfile: 'package-lock.json',
                install: ['npm', 'ci'], load_probe: ['npm', 'test'],
            }
            const fixture = await unissuedContextFixture(sequenceSource({
                toolchain: 'node',
                environment_files: [{ template: '.env.example', instance: '.env' }],
            }, [policy], [{
                slug: 'web', dir: 'web', var: 'WEB_DIR', toolchain: 'node',
                environment_files: [{ template: '.env.example', instance: '.env' }],
            }]))
            configPath = fixture.configPath
            candidate = fixture.candidate
            const issued = await issueContext({ ...candidate, observedAt: new Date().toISOString() }, fixture.loaded)
            if (issued.kind !== 'complete') throw new Error('first setup context was not issued')
            firstContext = issued.result
            const webRoot = resolve(candidate.siblingsRoot, 'web')
            mkdirSync(webRoot)
            writeFileSync(resolve(webRoot, '.env'), 'READY=true\n')
        })

        it('re-observes every sibling and idempotent stage from filesystem state on retry', async () => {
            const events: string[] = []
            let context = firstContext
            const sequence: SetupCommandAdapters = {
                load: async () => ({ kind: 'complete', status: 0, diagnostics: [], result: context }),
                observedAt: () => new Date().toISOString(),
                observeGit: async ({ sibling }) => {
                    events.push(`observe:${sibling.slug}`)
                    return available(existsSync(resolve(candidate.siblingsRoot, sibling.dir)) ? 'repository' : 'absent')
                },
                planGit: async ({ sibling, observation }) => {
                    events.push(`plan:${sibling.slug}`)
                    const repository = observation.state === 'available' && observation.value.kind === 'repository'
                    const result = { sibling: sibling.slug, target: resolve(candidate.siblingsRoot, sibling.dir), observed: repository ? 'repository' as const : 'absent' as const, action: repository ? 'report' as const : 'clone' as const, changed: !repository }
                    return repository
                        ? { kind: 'complete', status: 0, diagnostics: [], result }
                        : { kind: 'preview', status: 0, diagnostics: [], result, plan: { steps: [{ id: `setup:${sibling.slug}:clone` }] as never } }
                },
                execute: async () => ({ kind: 'refusal', status: 2, diagnostics: [{ severity: 'error', code: 'EXECUTION_STEP_FAILED', message: 'failed' }], result: null, execution: { completedStepIds: [], failedStep: { id: 'setup:api:clone', started: true }, compensation: { attemptedStepIds: [], completedStepIds: [], failed: [] } } }),
                observeSource: async () => ({ state: 'available', ...candidate.source }),
                recordStarted: async () => ({ kind: 'unchanged', record: {} as never }),
                withIgnore: async ({ sibling }, use) => { events.push(`ignore:${sibling.slug}`); return use() },
                planSeed: async ({ sibling }) => {
                    events.push(`seed-plan:${sibling.slug}`)
                    const siblingRoot = resolve(candidate.siblingsRoot, sibling.dir)
                    return existsSync(resolve(siblingRoot, '.env'))
                        ? { kind: 'unchanged', siblingRoot, destination: resolve(siblingRoot, '.env') }
                        : readySeed(siblingRoot)
                },
                seed: vi.fn(() => { throw new Error('an existing instance must not be seeded again') }),
                observePolicy: async ({ sibling }) => { events.push(`policy-observe:${sibling.slug}`); return { state: 'available' } as never },
                withPolicy: async (_observation, { sibling }, use) => { events.push(`policy-resolve:${sibling.slug}`); return use({} as never) },
                resolvePolicy: ({ siblingIndex, sibling, checkoutRoot, checkoutId }) => ({
                    kind: 'complete', bindings: [{ source: context.source, siblingIndex, diagnostics: { catalogIndex: 0 }, siblingSlug: sibling.slug, checkoutRoot, checkoutId, policy }],
                }),
            }

            const first = await runSetupSequence({ configPath }, sequence)
            expect(first.kind).toBe('refusal')
            expect(first).not.toHaveProperty('completedSiblings')
            expect(first).not.toHaveProperty('checkpoint')

            const apiRoot = resolve(candidate.siblingsRoot, 'api')
            mkdirSync(apiRoot)
            writeFileSync(resolve(apiRoot, '.env'), 'READY=true\n')
            const reloaded = await loadCockpitConfig(configPath)
            if (reloaded.kind === 'refusal') throw new Error('fixture configuration did not reload')
            const retry = await issueContext({ ...candidate, observedAt: new Date().toISOString() }, reloaded.result)
            if (retry.kind !== 'complete') throw new Error('retry setup context was not issued')
            context = retry.result
            events.push('retry')

            const second = await runSetupSequence({ configPath }, sequence)

            expect(second.kind).toBe('complete')
            expect(sequence.seed).not.toHaveBeenCalled()
            expect(events).toEqual([
                'observe:api', 'plan:api',
                'retry',
                'observe:api', 'plan:api', 'ignore:api', 'seed-plan:api', 'ignore:api', 'policy-observe:api', 'policy-resolve:api',
                'observe:web', 'plan:web', 'ignore:web', 'seed-plan:web', 'ignore:web', 'policy-observe:web', 'policy-resolve:web',
            ])
        })
    })

})
