import { dirname, join, resolve } from 'node:path'
import { ENVIRONMENT_CODES, errorCause, type EnvironmentDiagnostic, snapshotJson } from '../contract.js'
import type { EvaluatorTool } from '../../schema.js'
import { effectivePolicy, policyWeakening, policyWeakeningDiagnostic, readRecordedPolicy } from '../../autonomy.js'
import type { SkippedStateNamespace } from '../state.js'
import { prepareGeneratedEnvironmentCurrentness } from '../generated-application/check.js'
import { type GeneratedEnvironmentCurrentness } from '../generated-application/shared.js'
import { declaredRuntime, declaresNothingToRun } from '../declaration.js'
import { readinessReport, type ReadinessReport } from '../../readiness.js'
import type { ReleaseFreshness } from '../../freshness.js'
import { proposeGeneratedEnvironmentRepair } from '../../repair.js'
import type { ActiveSurfaceOverride, SurfaceUpgradeFinding } from '../../surfaces/merge.js'
import { SURFACE_FEATURES } from '../../surfaces/contract.js'
import { loadCockpitConfig, evaluatorTools } from '../../config/load.js'
import { projectDoctor, type DoctorCheck, type PreflightEvaluation } from '../observations.js'
import {
    type ComparisonRemoteEvaluation,
    type HealthEvaluation,
    type ObservationCommandAdapters,
    applicationDiagnostic,
    evaluateApplicationHealth,
    healthDiagnostics,
    issueHealthObservationSource,
    prepareHealthObservation,
} from './health.js'
import { ownDataValues } from './shared.js'
import { unreadableStateWarning } from './lifecycle-state.js'

export interface DoctorCommandInput {
    readonly configPath: string
}
export interface DoctorSurfaceOverrideInspectionComplete {
    readonly kind: 'complete'
    readonly activeOverrides: readonly ActiveSurfaceOverride[]
    readonly changedOverrideOriginals: readonly SurfaceUpgradeFinding[]
}

export interface DoctorSurfaceOverrideInspectionUnavailable {
    readonly kind: 'unavailable'
    readonly code: string
    readonly reason: string
}

export interface DoctorSurfaceOverrideInspectionRefusal {
    readonly kind: 'refusal'
    readonly code: string
    readonly reason: string
}

export type DoctorSurfaceOverrideInspection =
    | DoctorSurfaceOverrideInspectionComplete
    | DoctorSurfaceOverrideInspectionUnavailable
    | DoctorSurfaceOverrideInspectionRefusal

export interface DoctorCommandAdapters extends ObservationCommandAdapters {
    readonly inspectSurfaceOverrides?: (configPath: string) => Promise<DoctorSurfaceOverrideInspection>
    readonly discoverReleaseFreshness?: () => Promise<ReleaseFreshness>
    /** Warnings when an agent tool on this machine would skip the generated guard hook. */
    readonly inspectHookTrust?: () => Promise<readonly EnvironmentDiagnostic[]>
    /** A warning when work orders exist but their independent evaluator cannot run on this machine. */
    readonly inspectEvaluator?: (evaluators: readonly EvaluatorTool[]) => Promise<readonly EnvironmentDiagnostic[]>
    /** Warnings about prerequisites the stack checks do not cover: the local install, sibling remotes, committed secrets. */
    readonly inspectReadiness?: () => Promise<readonly EnvironmentDiagnostic[]>
    /** Other cockpits' state namespaces this version skipped, or why the inventory could not be read; read after load has selected this cockpit's state root. */
    readonly readUnreadableState?: () => Promise<
        | Readonly<{ kind: 'complete'; skipped: readonly SkippedStateNamespace[] }>
        | Readonly<{ kind: 'refusal'; diagnostics: readonly EnvironmentDiagnostic[] }>>
}

interface DoctorFreshness {
    // Only whether the generated files are current. The full check result, with every owned path's
    // authority, is what `check --json` prints; embedding it made doctor's report hundreds of KB.
    readonly local: Readonly<{
        kind: GeneratedEnvironmentCurrentness['outcome']['kind']
        status: number
        diagnostics: GeneratedEnvironmentCurrentness['outcome']['diagnostics']
    }>
    readonly changes: GeneratedEnvironmentCurrentness['changes']
    readonly storedProducer: GeneratedEnvironmentCurrentness['storedProducer']
    readonly installedProducer: GeneratedEnvironmentCurrentness['currentProducer']
    readonly release: ReleaseFreshness
    readonly repair?: ReturnType<typeof proposeGeneratedEnvironmentRepair>
}

export interface DoctorDeclaration {
    readonly subject: 'runtime' | 'reset-volumes' | 'seed'
    readonly state: 'declared' | 'not-declared'
    readonly source: string
    readonly reason: string
}

export interface ApplicationDoctorEvaluation {
    readonly verdict: PreflightEvaluation['verdict']
    readonly checks: readonly DoctorCheck[]
    readonly comparisons: readonly ComparisonRemoteEvaluation[]
    readonly surfaceOverrides: DoctorSurfaceOverrideInspection
    readonly freshness: DoctorFreshness
    /** What the configuration declares, read from cockpit.toml alone; empty when it does not load. */
    readonly declarations: readonly DoctorDeclaration[]
    /** The reported diagnostics grouped under the prerequisites cockpit depends on; absent when cockpit.toml does not load. */
    readonly readiness?: ReadinessReport
}

type LoadedDoctorConfig = Awaited<ReturnType<typeof loadCockpitConfig>>

// What reset and up do to product data rests on these declarations; doctor names an absent one
// instead of letting it read as a passed check.
async function doctorDeclarations(loading: Promise<LoadedDoctorConfig>): Promise<readonly DoctorDeclaration[]> {
    const loaded = await loading
    if (loaded.kind !== 'complete') return []
    const environment = loaded.result.config.environment
    const runtime = declaredRuntime(environment) === 'compose'
    const absent = runtime ? 'not declared in cockpit.toml' : 'no runtime environment is declared'
    const row = (subject: DoctorDeclaration['subject'], declared: boolean, source: string, reason: string): DoctorDeclaration =>
        ({ subject, state: declared ? 'declared' as const : 'not-declared' as const, source, reason: declared ? reason : absent })
    return [
        row('runtime', runtime, 'environment.compose_files', runtime ? 'cockpit runs the declared Compose files'
            : 'environment.compose_files is not declared; runtime commands refuse'),
        row('reset-volumes', environment.resettable_volumes.length > 0, 'environment.resettable_volumes',
            'reset may delete and recreate these volumes'),
        row('seed', environment.seed !== undefined, 'environment.seed', 'up runs the seed when a resettable volume is new'),
    ]
}

// The guard denies agent commands that reach these hosts. Two empty lists deny nothing, and that
// looks exactly like a guard that is working, so doctor says so. A declared runtime is the signal
// that hosted environments exist. Both keys
// written as empty lists, as init records an explicit "none", is a decision and is not warned about.
async function doctorGuardHostDiagnostics(loading: Promise<LoadedDoctorConfig>): Promise<readonly EnvironmentDiagnostic[]> {
    const loaded = await loading
    if (loaded.kind !== 'complete') return []
    const { environment, guards } = loaded.result.config
    if (declaredRuntime(environment) === 'none' || loaded.result.guardHostsStated
        || guards.hosted_db_hosts.length > 0 || guards.vendor_endpoint_hosts.length > 0) {
        return []
    }
    return [{
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'GUARD_HOSTS_UNDECLARED' satisfies typeof ENVIRONMENT_CODES.GUARD_HOSTS_UNDECLARED,
        message: 'guards.hosted_db_hosts and guards.vendor_endpoint_hosts are both empty, so the guard denies no agent command by host even though this cockpit declares a runtime',
        target: 'guards',
        fix: 'list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run npx --no cockpit sync --config <your cockpit.toml>; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards]',
    }]
}

// A product with no declared gate gives test-run nothing to run, so no work in it can be graded PASS;
// a docs-only cockpit has no product to test and stays quiet.
async function doctorEvaluatorDiagnostics(loading: Promise<LoadedDoctorConfig>, adapters: DoctorCommandAdapters): Promise<readonly EnvironmentDiagnostic[]> {
    const loaded = await loading
    return loaded.kind === 'complete' && adapters.inspectEvaluator ? adapters.inspectEvaluator(evaluatorTools(loaded.result.config)) : []
}

async function doctorTestingGateDiagnostics(loading: Promise<LoadedDoctorConfig>): Promise<readonly EnvironmentDiagnostic[]> {
    const loaded = await loading
    if (loaded.kind !== 'complete' || loaded.result.config.testing || declaredRuntime(loaded.result.config.environment) === 'none') {
        return []
    }
    return [{
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'TESTING_GATE_UNDECLARED' satisfies typeof ENVIRONMENT_CODES.TESTING_GATE_UNDECLARED,
        message: 'cockpit.toml declares no [testing] gate, so test-run has nothing to run and no work in this product can be graded PASS',
        target: 'testing',
        fix: 'declare the product test commands as [testing] stages with a targeted and a full gate in cockpit.toml, then run npx --no cockpit sync --config <your cockpit.toml>',
    }]
}

// init records answers no person stated under `unconfirmed`. They look exactly like stated values
// in the file, so doctor keeps naming them until a person confirms each and deletes its entry.
async function doctorUnconfirmedDiagnostics(loading: Promise<LoadedDoctorConfig>): Promise<readonly EnvironmentDiagnostic[]> {
    const loaded = await loading
    if (loaded.kind !== 'complete' || !loaded.result.config.unconfirmed) return []
    return [{
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'DECLARATION_UNCONFIRMED' satisfies typeof ENVIRONMENT_CODES.DECLARATION_UNCONFIRMED,
        message: `${loaded.result.config.unconfirmed.join(', ')} in cockpit.toml were chosen by the setup agent or by no one named, not stated by a person, so they may not describe this product`,
        target: 'unconfirmed',
        fix: 'confirm each value with whoever owns the product and correct it in cockpit.toml if it is wrong, delete each confirmed entry from unconfirmed, then run npx --no cockpit sync --config <your cockpit.toml>',
    }]
}

// The same weakening `check` fails on: a policy cockpit.toml sets below the one the last sync recorded
// is not in force, and doctor is where an agent looks first.
async function doctorPolicyDiagnostics(loading: Promise<LoadedDoctorConfig>): Promise<readonly EnvironmentDiagnostic[]> {
    const loaded = await loading
    if (loaded.kind !== 'complete') return []
    const recorded = await readRecordedPolicy(dirname(loaded.result.source.path))
    const weakened = recorded ? policyWeakening(recorded, effectivePolicy(loaded.result.config)) : []
    return weakened.length ? [{ ...policyWeakeningDiagnostic(weakened), severity: 'warning' as const }] : []
}

export type DoctorCommandResult = Readonly<{
    kind: 'complete'
    status: 0
    diagnostics: readonly EnvironmentDiagnostic[]
    result: ApplicationDoctorEvaluation
}> | Readonly<{
    kind: 'refusal'
    status: 2
    diagnostics: readonly EnvironmentDiagnostic[]
    result: ApplicationDoctorEvaluation
}>

const unavailableSurfaceOverrideInspection = Object.freeze({
    kind: 'unavailable' as const,
    code: 'SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE',
    reason: 'authenticated generated surface override inspection is unavailable',
})

async function inspectDoctorSurfaceOverrides(
    configPath: string,
    adapters: DoctorCommandAdapters,
): Promise<DoctorSurfaceOverrideInspection> {
    if (!adapters.inspectSurfaceOverrides) return unavailableSurfaceOverrideInspection
    try {
        const inspection = await adapters.inspectSurfaceOverrides(configPath)
        const captured = snapshotJson(inspection)
        const record = ownDataValues(captured, ['kind'], ['activeOverrides', 'changedOverrideOriginals', 'code', 'reason'])
        const sha256 = /^[a-f0-9]{64}$/
        const activeOverride = (value: unknown): boolean => {
            const row = ownDataValues(value, ['name', 'feature', 'originalSha256', 'recordedSha256', 'overlaySource'])
            return row !== undefined
                && typeof row.name === 'string' && row.name.length > 0
                && typeof row.feature === 'string' && SURFACE_FEATURES.includes(row.feature as never)
                && typeof row.originalSha256 === 'string' && sha256.test(row.originalSha256)
                && typeof row.recordedSha256 === 'string' && sha256.test(row.recordedSha256)
                && typeof row.overlaySource === 'string' && row.overlaySource.length > 0
        }
        const changedOriginal = (value: unknown): boolean => {
            const row = ownDataValues(value, ['code', 'name', 'recordedSha256', 'currentSha256', 'overlaySource'])
            return row !== undefined && row.code === 'OVERRIDDEN_CORE_CHANGED'
                && typeof row.name === 'string' && row.name.length > 0
                && typeof row.recordedSha256 === 'string' && sha256.test(row.recordedSha256)
                && typeof row.currentSha256 === 'string' && sha256.test(row.currentSha256)
                && typeof row.overlaySource === 'string' && row.overlaySource.length > 0
        }
        const complete = record?.kind === 'complete'
            && Reflect.ownKeys(record).length === 3
            && Array.isArray(record.activeOverrides) && record.activeOverrides.every(activeOverride)
            && Array.isArray(record.changedOverrideOriginals) && record.changedOverrideOriginals.every(changedOriginal)
        const unavailableOrRefusal = (record?.kind === 'unavailable' || record?.kind === 'refusal')
            && Reflect.ownKeys(record).length === 3
            && typeof record.code === 'string' && record.code.length > 0
            && typeof record.reason === 'string' && record.reason.length > 0
        if (!complete && !unavailableOrRefusal) {
            return {
                kind: 'refusal',
                code: 'SURFACE_OVERRIDE_INSPECTION_INVALID',
                reason: 'surface override inspection returned invalid evidence',
            }
        }
        return captured as unknown as DoctorSurfaceOverrideInspection
    } catch (error) {
        return { ...unavailableSurfaceOverrideInspection,
            reason: `${unavailableSurfaceOverrideInspection.reason}: ${errorCause(error)}` }
    }
}

function unavailableDoctor(
    code: EnvironmentDiagnostic['code'],
    message: string,
    surfaceOverrides: DoctorSurfaceOverrideInspection,
    freshness: DoctorFreshness,
    declarations: readonly DoctorDeclaration[],
    forwarded?: readonly EnvironmentDiagnostic[],
): DoctorCommandResult {
    return {
        kind: 'complete', status: 0,
        diagnostics: forwarded ?? [applicationDiagnostic(code, message, 'preflight')],
        result: {
            verdict: 'unavailable', checks: [], comparisons: [], surfaceOverrides, freshness, declarations,
        },
    }
}

export async function runDoctor(
    input: DoctorCommandInput,
    adapters: DoctorCommandAdapters,
): Promise<DoctorCommandResult> {
    const config = loadCockpitConfig(input.configPath)
    // Codex hook trust is advice for a Codex user; a cockpit that does not list Codex gets none.
    const hookTrustFindings = async (): Promise<readonly EnvironmentDiagnostic[]> => {
        const loaded = await config
        return loaded.kind === 'complete' && loaded.result.config.surfaces.tools.includes('codexcli')
            ? adapters.inspectHookTrust?.() ?? [] : []
    }
    const [outcome, guardHosts, unconfirmed, policyWeakened, testingGate, hookTrust, evaluator, readinessWarnings, servedSiblings] = await Promise.all([doctorHealth(input, adapters, config),
        doctorGuardHostDiagnostics(config), doctorUnconfirmedDiagnostics(config), doctorPolicyDiagnostics(config), doctorTestingGateDiagnostics(config), hookTrustFindings(),
        doctorEvaluatorDiagnostics(config, adapters), adapters.inspectReadiness?.() ?? [], adapters.inspectServedSiblings?.() ?? []])
    const stateInventory = await adapters.readUnreadableState?.()
    const unreadableState = stateInventory?.kind === 'refusal'
        // An inventory that cannot be read, such as one another command holds locked, is no clean one.
        ? stateInventory.diagnostics.map((diagnostic) => ({ ...diagnostic, severity: 'warning' as const,
            message: `doctor could not read this machine's cockpit state, so it did not check for other cockpits' state this version cannot read: ${diagnostic.message}` }))
        : [unreadableStateWarning(stateInventory?.skipped ?? [])].filter((warning) => warning !== undefined)
    const warnings = [...unconfirmed, ...policyWeakened, ...guardHosts, ...testingGate, ...hookTrust, ...evaluator, ...readinessWarnings, ...servedSiblings, ...unreadableState]
    const reported = warnings.length === 0 ? outcome
        : { ...outcome, diagnostics: [...outcome.diagnostics, ...warnings] }
    // Doctor reports on a configuration; without one there is nothing to report on, and a zero
    // exit would let `doctor && ...` proceed past a missing or unparseable cockpit.toml.
    const loaded = await config
    if (loaded.kind === 'complete') {
        const state = declaresNothingToRun(loaded.result.config.environment) ? 'surfaces-only' as const : 'runtime' as const
        return { ...reported, result: { ...reported.result,
            readiness: readinessReport(state, reported.diagnostics, loaded.result.config.surfaces.tools) } }
    }
    const forwarded = new Set(reported.diagnostics.map(({ code, target }) => `${code}\0${target}`))
    return {
        ...reported, kind: 'refusal', status: 2,
        diagnostics: [...loaded.diagnostics.filter(({ code, target }) => !forwarded.has(`${code}\0${target}`)), ...reported.diagnostics],
    }
}

async function doctorHealth(
    input: DoctorCommandInput,
    adapters: DoctorCommandAdapters,
    config: Promise<LoadedDoctorConfig>,
): Promise<DoctorCommandResult> {
    const surfaceOverrides = inspectDoctorSurfaceOverrides(input.configPath, adapters)
    const declarations = doctorDeclarations(config)
    const freshness = Promise.all([
        prepareGeneratedEnvironmentCurrentness(input),
        adapters.discoverReleaseFreshness?.() ?? Promise.resolve({ kind: 'unknown' as const, reason: 'release discovery is not bound' }),
    ]).then(([currentness, release]): DoctorFreshness => ({
        local: { kind: currentness.outcome.kind, status: currentness.outcome.status, diagnostics: currentness.outcome.diagnostics },
        changes: currentness.changes, storedProducer: currentness.storedProducer,
        installedProducer: currentness.currentProducer, release, repair: proposeGeneratedEnvironmentRepair(currentness),
    }))
    let health: HealthEvaluation
    let doctor: ReturnType<typeof projectDoctor>
    // A producer that refused says why, also when the observation is lost to a throw afterwards.
    let refused: readonly EnvironmentDiagnostic[] | undefined
    try {
        const source = await adapters.load(input, issueHealthObservationSource, (diagnostics) => { refused = diagnostics; return undefined }, 'doctor')
        if (!source) {
            return unavailableDoctor(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'doctor observation source is unavailable',
                await surfaceOverrides,
                await freshness,
                await declarations,
                refused,
            )
        }
        const observed = prepareHealthObservation(input, source)
        if (!observed) {
            return unavailableDoctor(
                ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
                'doctor requires authenticated steady lifecycle evidence',
                await surfaceOverrides,
                await freshness,
                await declarations,
            )
        }
        health = await evaluateApplicationHealth(observed, adapters)
        doctor = projectDoctor(health.preflight)
    } catch (error) {
        return unavailableDoctor(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            `doctor requires authentic observation and lifecycle evidence: ${errorCause(error)}`,
            await surfaceOverrides,
            await freshness,
            await declarations,
            refused,
        )
    }
    return {
        kind: 'complete', status: 0, diagnostics: healthDiagnostics(health),
        result: {
            verdict: health.verdict,
            checks: doctor.checks,
            comparisons: health.comparisons,
            surfaceOverrides: await surfaceOverrides,
            freshness: await freshness,
            declarations: await declarations,
        },
    }
}
