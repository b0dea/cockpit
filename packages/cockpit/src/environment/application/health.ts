import { dirname, resolve } from 'node:path'
import type { ExecuteProbeOutcome } from '../../environment-exec/execute.js'
import {
    RefusalError,
    ENVIRONMENT_CODES,
    errorCause,
    isCanonicalTimestamp,
    type CheckoutId,
    type EnvironmentDiagnostic,
    type EnvironmentObservation,
    type ExecutionStep,
    type StackId,
} from '../contract.js'
import { resolveLocalRemote } from '../setup.js'
import { resolvedGitExecutable, type ResolvedExecutable } from '../executable.js'
import { declaresNothingToRun } from '../declaration.js'
import { checkoutId as deriveCheckoutId, stackId as deriveStackId } from '../identity.js'
import { consumeSetupCheckoutProjection, type SetupCheckoutProjection } from '../setup-observation.js'
import { loadCockpitConfig, type LoadedConfigProjection } from '../../config/load.js'
import {
    aggregateObservations,
    stoppedStackApplicability,
    type EvaluatedObservation,
    type PreflightContext,
    type PreflightEvaluation,
} from '../observations.js'
import { ENV_SCHEMA_OVERRIDE_NAME_LIMIT, envSchemaOverrides, envSchemaToolMissing, VARLOCK_INSTALL_URL } from '../env-schema-observation.js'
import { SURFACE_OBSERVATION_CODES } from '../generated-application/surface-observation.js'
import {
    createComparisonRemoteRefStep,
    createGitObservationStep,
    observeComparisonRemoteRef,
    observeComparisonRemoteRevalidation,
    observeComparisonRemoteUrl,
    observeGit,
    type ComparisonRemoteResult,
} from '../git-observation.js'
import type { CapturedRuntimeEvidence, EnvironmentSnapshot } from '../evidence.js'
import { type ReadinessRefusal, consumeEffectiveConfiguration } from './lifecycle-context.js'
import { confinedPath, exactEnvironment, sameSource } from './shared.js'

interface ComparisonRemoteInput {
    readonly executable: ResolvedExecutable
    readonly checkoutRoot: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly stackId: StackId
    readonly checkoutId: CheckoutId
    readonly source: string
    readonly sibling: string
    readonly acquire: 'auto' | 'manual' | 'none'
    readonly declaredRemote?: string
}

export interface HealthObservationProducers {
    readonly surfaces: () => Promise<readonly EnvironmentObservation[]>
    readonly envSchema: () => Promise<readonly EnvironmentObservation[]>
    readonly claims: () => Promise<readonly EnvironmentObservation[]>
    readonly git: () => Promise<readonly EnvironmentObservation[]>
    readonly host: () => Promise<readonly EnvironmentObservation[]>
    readonly lifecycle: () => Promise<readonly EnvironmentObservation[]>
    readonly ports: () => Promise<readonly EnvironmentObservation[]>
    readonly runtime: () => Promise<readonly EnvironmentObservation[]>
    readonly state: () => Promise<readonly EnvironmentObservation[]>
    readonly siblings: () => Promise<readonly EnvironmentObservation[]>
    readonly templates: () => Promise<readonly EnvironmentObservation[]>
}

export type LoadedCockpitConfigResult = Extract<Awaited<ReturnType<typeof loadCockpitConfig>>, { readonly kind: 'complete' }>

export interface HealthObservationSourceInput {
    readonly checkout: SetupCheckoutProjection
    readonly configuration: LoadedConfigProjection
    readonly preflight: PreflightContext
    readonly env: Readonly<Record<string, string>>
    readonly gitExecutable: ResolvedExecutable
    readonly timeoutMs: number
    readonly producers: HealthObservationProducers
    readonly refreshPreflight: (previous: PreflightContext) => Promise<PreflightContext | undefined>
    /** Why no stack runs to observe (never brought up, asleep, or no runtime declared); null while one runs. */
    readonly stopped: EnvironmentDiagnostic | null
    /** Refusals the producers met that explain missing evidence, read once evaluation has finished. */
    readonly notices: () => readonly EnvironmentDiagnostic[]
}

export interface HealthObservationSource {
    readonly kind: 'health-observation-source'
}

export interface ObservationCommandAdapters {
    readonly load: (
        input: { readonly configPath: string },
        issue: (source: HealthObservationSourceInput) => HealthObservationSource | undefined,
        refuse?: ReadinessRefusal<undefined>,
        // Doctor also reports on a cockpit that declares no runtime; preflight, a gate, refuses it.
        purpose?: 'doctor' | 'preflight',
    ) => Promise<HealthObservationSource | undefined>
    readonly execute: (
        step: ExecutionStep,
        options: { readonly signal?: AbortSignal },
    ) => Promise<ExecuteProbeOutcome>
    /**
     * Which checkout serves each sibling, what a worktree lacks, and whether the running stack is stale.
     * Reads cockpit.toml again unless handed the loaded configuration or called after `load`.
     */
    readonly inspectServedSiblings?: (loaded?: LoadedCockpitConfigResult) => Promise<readonly EnvironmentDiagnostic[]>
}

export interface PreflightCommandInput {
    readonly configPath: string
}

export interface PreflightCommandAdapters extends ObservationCommandAdapters {}

export interface ComparisonRemoteEvaluation {
    readonly sibling: string
    readonly result: ComparisonRemoteResult
}

interface ApplicationPreflightEvaluation {
    readonly verdict: PreflightEvaluation['verdict']
    readonly revision: string
    readonly checks: readonly EvaluatedObservation[]
    readonly comparisons: readonly ComparisonRemoteEvaluation[]
}

type PreflightCommandResult =
    | Readonly<{
        kind: 'complete'
        status: 0
        diagnostics: readonly EnvironmentDiagnostic[]
        result: ApplicationPreflightEvaluation
    }>
    | Readonly<{
        kind: 'blocked'
        status: 2
        diagnostics: readonly EnvironmentDiagnostic[]
        result: ApplicationPreflightEvaluation
    }>

/** The resolved intent and the measured runtime of the running stack, which a product gate reads. */
export interface RuntimeEvidenceObservation {
    readonly snapshot: EnvironmentSnapshot
    readonly evidence: CapturedRuntimeEvidence
}

/**
 * A producer that cannot observe because another command's refusal stands in the way. Its diagnostics
 * are that command's own, with their fixes, so they replace the producer's "evidence unavailable" and
 * the rows that depend on it; any other thrown error stays unexposed.
 */
export class ObservationProducerRefusal extends RefusalError {
    constructor(message: string, readonly diagnostics: readonly EnvironmentDiagnostic[]) { super(message) }
}

export interface HealthEvaluation {
    readonly preflight: PreflightEvaluation
    readonly comparisons: readonly ComparisonRemoteEvaluation[]
    readonly producerFailures: readonly typeof healthProducerNames[number][]
    /** The diagnostics of producers that failed on a refusal; their dependent evidence rows are left out of the report. */
    readonly producerRefusals: readonly EnvironmentDiagnostic[]
    readonly verdict: PreflightEvaluation['verdict']
    readonly stopped: EnvironmentDiagnostic | null
    readonly notices: readonly EnvironmentDiagnostic[]
}

interface PreparedHealthObservation {
    readonly configPath: string
    readonly preflight: PreflightContext
    readonly comparisons: readonly ComparisonRemoteInput[]
    readonly producers: HealthObservationProducers
    readonly refreshPreflight: (previous: PreflightContext) => Promise<PreflightContext | undefined>
    readonly expectedPreflight: Readonly<{ stackId: StackId; source: string; revision: string; stage: 'bootstrap' | 'steady' }>
    readonly stopped: EnvironmentDiagnostic | null
    readonly notices: () => readonly EnvironmentDiagnostic[]
    readonly unobservable: ReadonlyMap<string, string>
}

const issuedHealthObservationSources = new WeakMap<object, PreparedHealthObservation>()

const healthProducerNames = Object.freeze([
    'claims', 'git', 'host', 'lifecycle', 'ports', 'runtime', 'state', 'templates', 'envSchema', 'siblings', 'surfaces',
] as const)

export function applicationDiagnostic(
    code: EnvironmentDiagnostic['code'],
    message: string,
    target: string,
    fix?: string,
): EnvironmentDiagnostic {
    return { severity: 'error', code, message, target, ...(fix === undefined ? {} : { fix }) }
}

function comparisonVerdict(result: ComparisonRemoteResult): PreflightEvaluation['verdict'] {
    if (result.kind === 'complete') return result.state === 'mismatch' ? 'fail' : 'pass'
    return result.kind === 'unavailable' ? 'unavailable' : 'pass'
}

function combinedVerdict(
    preflight: PreflightEvaluation['verdict'],
    comparisons: readonly ComparisonRemoteEvaluation[],
): PreflightEvaluation['verdict'] {
    const verdicts = [preflight, ...comparisons.map(({ result }) => comparisonVerdict(result))]
    return verdicts.includes('fail') ? 'fail' : verdicts.includes('unavailable') ? 'unavailable' : 'pass'
}

function stageMatches(context: PreflightContext, expected: 'steady' | 'bootstrap'): boolean {
    try {
        return Array.isArray(context.stages) && context.stages.every((authority) => authority.stage === expected)
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return false
    }
}

function exactHealthProducers(value: unknown): HealthObservationProducers | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Reflect.ownKeys(descriptors).length !== healthProducerNames.length) return undefined
        const producers: Partial<Record<typeof healthProducerNames[number], () => Promise<readonly EnvironmentObservation[]>>> = {}
        for (const name of healthProducerNames) {
            const descriptor = descriptors[name]
            if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return undefined
            producers[name] = descriptor.value as () => Promise<readonly EnvironmentObservation[]>
        }
        return producers as HealthObservationProducers
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

function singleDataElement(value: unknown): unknown {
    try {
        if (!Array.isArray(value)) return undefined
        const keys = Reflect.ownKeys(value)
        const element = Object.getOwnPropertyDescriptor(value, '0')
        const length = Object.getOwnPropertyDescriptor(value, 'length')
        if (keys.length !== 2 || !keys.includes('0') || !keys.includes('length')
            || !element || !('value' in element) || !length || !('value' in length) || length.value !== 1) return undefined
        return element.value
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

function exactDataObject(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Reflect.ownKeys(descriptors).length !== keys.length) return undefined
        const captured: Record<string, unknown> = {}
        for (const key of keys) {
            const descriptor = descriptors[key]
            if (!descriptor || !('value' in descriptor)) return undefined
            captured[key] = descriptor.value
        }
        return captured
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

function boundPreflightContext(
    value: unknown,
    expected: { readonly stackId: StackId; readonly source: string; readonly revision: string; readonly stage: 'bootstrap' | 'steady' },
): PreflightContext | undefined {
    const context = exactDataObject(value, ['authorities', 'stages'])
    const authority = exactDataObject(singleDataElement(context?.authorities), [
        'stackId', 'evaluatedAt', 'validThrough', 'revision', 'source', 'postures', 'environmentPostures', 'postureRequirements',
    ])
    const stage = exactDataObject(singleDataElement(context?.stages), [
        'stackId', 'stage', 'observedAt', 'validThrough',
    ])
    if (!context || !authority || !stage
        || authority.stackId !== expected.stackId || stage.stackId !== expected.stackId
        || authority.source !== expected.source || authority.revision !== expected.revision
        || stage.stage !== expected.stage
        || typeof authority.evaluatedAt !== 'string' || !isCanonicalTimestamp(authority.evaluatedAt)
        || typeof authority.validThrough !== 'string' || !isCanonicalTimestamp(authority.validThrough)
        || typeof stage.observedAt !== 'string' || !isCanonicalTimestamp(stage.observedAt)
        || typeof stage.validThrough !== 'string' || !isCanonicalTimestamp(stage.validThrough)
        || Date.parse(authority.evaluatedAt) > Date.parse(authority.validThrough)
        || Date.parse(stage.observedAt) < Date.parse(authority.evaluatedAt)
        || Date.parse(stage.observedAt) > Date.parse(authority.validThrough)
        || Date.parse(authority.evaluatedAt) > Date.parse(stage.validThrough)) return undefined
    return value as PreflightContext
}

export function issueHealthObservationSource(
    rawSource: HealthObservationSourceInput,
): HealthObservationSource | undefined {
    try {
        if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(rawSource)
        const keys = ['checkout', 'configuration', 'preflight', 'env', 'gitExecutable', 'timeoutMs', 'producers', 'refreshPreflight',
            'stopped', 'notices'] as const
        if (Reflect.ownKeys(descriptors).length !== keys.length
            || keys.some((key) => !descriptors[key] || !('value' in descriptors[key]!))) return undefined
        const checkout = consumeSetupCheckoutProjection(descriptors.checkout!.value as SetupCheckoutProjection)
        const loaded = consumeEffectiveConfiguration(descriptors.configuration!.value as LoadedConfigProjection)
        const rawPreflight = descriptors.preflight!.value
        const env = exactEnvironment(descriptors.env!.value)
        const executable = resolvedGitExecutable(descriptors.gitExecutable!.value as ResolvedExecutable)
        const timeoutMs = descriptors.timeoutMs!.value
        const producers = exactHealthProducers(descriptors.producers!.value)
        const refreshPreflight = descriptors.refreshPreflight!.value
        const stopped = descriptors.stopped!.value as EnvironmentDiagnostic | null
        const notices = descriptors.notices!.value
        if (!checkout || loaded.kind !== 'complete' || !env || !executable || !producers
            || typeof refreshPreflight !== 'function' || typeof notices !== 'function'
            || stopped !== null && (typeof stopped !== 'object' || typeof stopped.code !== 'string' || typeof stopped.message !== 'string')
            || !sameSource(checkout.source, loaded.source) || checkout.cockpitName !== loaded.config.cockpit.name
            || typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
        ) return undefined
        const resolvedTimeoutMs = timeoutMs as number
        const stack = deriveStackId({
            cockpitId: checkout.cockpitId,
            checkoutId: checkout.checkoutId,
            variant: { kind: 'shared' },
        })
        // Only a stack that has run and still runs is observed in the steady stage; otherwise the
        // rows that need no running stack are, and the reason none runs travels with them.
        const stage = stopped === null || stageMatches(rawPreflight as PreflightContext, 'steady') ? 'steady' as const : 'bootstrap' as const
        const runtimeDeclared = !declaresNothingToRun(loaded.config.environment)
        const expectedPreflight = { stackId: stack, source: loaded.source.path, revision: loaded.source.sha256, stage }
        const preflight = boundPreflightContext(rawPreflight, expectedPreflight)
        if (!preflight) return undefined
        const siblingsRoot = resolve(dirname(loaded.source.path), loaded.config.cockpit.siblings_root)
        const comparisons = loaded.config.sibling.map((sibling) => {
            const declared = sibling.remote === undefined ? undefined : resolveLocalRemote(sibling.remote, siblingsRoot)
            if (declared?.kind === 'unresolvable') {
                throw new RefusalError(`sibling ${sibling.slug}: cannot resolve declared local remote ${JSON.stringify(declared.declared)} (${declared.errno})`)
            }
            const checkoutRoot = resolve(siblingsRoot, sibling.dir)
            if (!confinedPath(siblingsRoot, checkoutRoot)) throw new RefusalError('sibling checkout escapes its configured root')
            return {
                executable,
                checkoutRoot,
                env,
                timeoutMs: resolvedTimeoutMs,
                stackId: stack,
                checkoutId: deriveCheckoutId({ checkoutPath: checkoutRoot }),
                source: `${loaded.source.path}:${sibling.slug}`,
                sibling: sibling.slug,
                acquire: sibling.acquire,
                ...(declared === undefined ? {} : { declaredRemote: declared.remote }),
            }
        })
        const prepared = {
            configPath: loaded.source.path,
            preflight,
            comparisons,
            producers,
            refreshPreflight: refreshPreflight as (previous: PreflightContext) => Promise<PreflightContext | undefined>,
            expectedPreflight,
            stopped: stopped === null ? null : { ...stopped },
            notices: notices as () => readonly EnvironmentDiagnostic[],
            unobservable: stopped === null ? new Map<string, string>() : stoppedStackApplicability({ runtimeDeclared }),
        }
        const source = { kind: 'health-observation-source' as const }
        issuedHealthObservationSources.set(source, prepared)
        return source
    } catch (error) {
        throw new RefusalError(
            `health observation source could not be issued: ${errorCause(error)}`,
            { cause: error },
        )
    }
}

export function prepareHealthObservation(
    input: { readonly configPath: string },
    source: HealthObservationSource,
): PreparedHealthObservation | undefined {
    try {
        if (!source || typeof source !== 'object') return undefined
        const prepared = issuedHealthObservationSources.get(source)
        issuedHealthObservationSources.delete(source)
        return prepared && typeof input.configPath === 'string' && resolve(input.configPath) === prepared.configPath
            && stageMatches(prepared.preflight, prepared.expectedPreflight.stage)
            ? prepared
            : undefined
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

async function executeObservationStep(
    adapters: ObservationCommandAdapters,
    step: ExecutionStep,
): Promise<Readonly<{ kind: 'complete'; outcome: ExecuteProbeOutcome }> | Readonly<{ kind: 'unavailable'; cause: string }>> {
    try {
        return { kind: 'complete', outcome: await adapters.execute(step, {}) }
    } catch (error) {
        return { kind: 'unavailable', cause: errorCause(error) }
    }
}

function comparisonProbeUnavailable(input: ComparisonRemoteInput, probe: string, cause?: string): ComparisonRemoteResult {
    return {
        kind: 'unavailable',
        code: ENVIRONMENT_CODES.GIT_COMPARISON_REMOTE_MISMATCH,
        reason: `${probe} execution is unavailable for sibling ${input.sibling}${cause === undefined ? '' : `: ${cause}`}`,
    }
}

async function observeComparisonRemote(
    input: ComparisonRemoteInput,
    adapters: ObservationCommandAdapters,
): Promise<ComparisonRemoteResult> {
    const applicability = createComparisonRemoteRefStep(input)
    if (applicability.kind === 'not-applicable') return applicability
    const statusStep = createGitObservationStep(input)
    if (!statusStep) return comparisonProbeUnavailable(input, 'Git status probe planning')
    const statusExecution = await executeObservationStep(adapters, statusStep)
    if (statusExecution.kind === 'unavailable') return comparisonProbeUnavailable(input, 'Git status probe', statusExecution.cause)
    const git = observeGit(statusStep, statusExecution.outcome, input)
    const ref = createComparisonRemoteRefStep({ ...input, git })
    if (ref.kind !== 'probe') return ref
    const refExecution = await executeObservationStep(adapters, ref.step)
    if (refExecution.kind === 'unavailable') return comparisonProbeUnavailable(input, 'comparison upstream probe', refExecution.cause)
    const url = observeComparisonRemoteRef(ref, refExecution.outcome)
    if (url.kind !== 'probe') return url
    const urlExecution = await executeObservationStep(adapters, url.step)
    if (urlExecution.kind === 'unavailable') return comparisonProbeUnavailable(input, 'comparison remote URL probe', urlExecution.cause)
    const revalidation = observeComparisonRemoteUrl(url, urlExecution.outcome)
    if (revalidation.kind !== 'probe') return revalidation
    const revalidationExecution = await executeObservationStep(adapters, revalidation.step)
    if (revalidationExecution.kind === 'unavailable') {
        return comparisonProbeUnavailable(input, 'comparison upstream revalidation probe', revalidationExecution.cause)
    }
    return observeComparisonRemoteRevalidation(revalidation, revalidationExecution.outcome)
}

export async function evaluateApplicationHealth(
    input: PreparedHealthObservation,
    adapters: ObservationCommandAdapters,
): Promise<HealthEvaluation> {
    const produced = await Promise.allSettled(healthProducerNames.map((name) => input.producers[name]()))
    const producerFailures = healthProducerNames.filter((_, index) => produced[index]?.status === 'rejected')
    const producerRefusals = produced.flatMap((result) =>
        result.status === 'rejected' && result.reason instanceof ObservationProducerRefusal ? result.reason.diagnostics : [])
    const observations = produced.map((result) => result.status === 'fulfilled'
        ? result.value
        : [] as readonly EnvironmentObservation[])
    // Reject unauthenticated observations before comparison probes cross the process boundary.
    const initial = boundPreflightContext(await input.refreshPreflight(input.preflight), input.expectedPreflight)
    if (!initial || initial.authorities[0]?.evaluatedAt !== input.preflight.authorities[0]?.evaluatedAt) {
        throw new RefusalError('health preflight authority could not preserve its observation window')
    }
    aggregateObservations(observations, initial, input.unobservable)
    const comparisons: ComparisonRemoteEvaluation[] = []
    for (const comparisonInput of input.comparisons) {
        const result = await observeComparisonRemote(comparisonInput, adapters)
        comparisons.push({ sibling: comparisonInput.sibling, result })
    }
    const refreshed = boundPreflightContext(await input.refreshPreflight(initial), input.expectedPreflight)
    if (!refreshed || refreshed.authorities[0]?.evaluatedAt !== input.preflight.authorities[0]?.evaluatedAt) {
        throw new RefusalError('health preflight authority could not preserve its observation window')
    }
    const preflight = aggregateObservations(observations, refreshed, input.unobservable)
    const frozenComparisons = comparisons
    const observedVerdict = combinedVerdict(preflight.verdict, frozenComparisons)
    // Rows a running stack would answer were not observed, so passing the rest never passes health.
    const incomplete = producerFailures.length > 0 || input.stopped !== null
    return {
        preflight,
        comparisons: frozenComparisons,
        producerFailures,
        producerRefusals,
        verdict: incomplete && observedVerdict === 'pass' ? 'unavailable' : observedVerdict,
        stopped: input.stopped,
        notices: [...input.notices()],
    }
}

export function healthDiagnostics(health: HealthEvaluation): readonly EnvironmentDiagnostic[] {
    // Rows a refused producer would have answered only repeat that refusal as missing evidence.
    const dependent = new Set<string>(health.producerRefusals.length > 0 ? SURFACE_OBSERVATION_CODES : [])
    const checks = health.preflight.checks
        .filter(({ verdict }) => verdict === 'fail' || verdict === 'unavailable')
        .filter(({ code }) => !dependent.has(code))
        .map(({ code, reason, source, remedy }) => applicationDiagnostic(code, reason, source, remedy))
    const comparisons = health.comparisons.flatMap(({ sibling, result }) => {
        if ((result.kind === 'complete' && result.state === 'match') || result.kind === 'not-applicable') return []
        return [applicationDiagnostic(
            result.code,
            result.reason,
            sibling,
            'in the sibling checkout, run `git status --short --branch` and `git remote -v`; reconcile the selected upstream and declared repository, then rerun the command',
        )]
    })
    const producerFailures = health.producerFailures.filter((producer) => producer !== 'surfaces' || health.producerRefusals.length === 0).map((producer) => applicationDiagnostic(
        ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
        `${producer} observation producer failed`,
        producer,
        `restore the ${producer} observation producer`,
    ))
    // Varlock is optional for cockpit, so a sibling that adopted it but cannot be checked here warns
    // instead of failing the row.
    const advisories = health.preflight.checks.flatMap((check) => envSchemaToolMissing(check).map((sibling): EnvironmentDiagnostic => ({
        severity: 'warning',
        code: ENVIRONMENT_CODES.ENV_SCHEMA_TOOL_MISSING,
        message: `${sibling} has an .env.schema but varlock is not installed, so its env schema was not checked`,
        target: sibling,
        fix: `install Varlock (${VARLOCK_INSTALL_URL}) and put it on PATH`,
    })))
    const overridden = health.preflight.checks.flatMap((check) => envSchemaOverrides(check).map(({ schema, keys }): EnvironmentDiagnostic => ({
        severity: 'warning',
        code: ENVIRONMENT_CODES.ENV_SCHEMA_OVERRIDDEN,
        message: `${schema}: ${keys.join(', ')}${keys.length >= ENV_SCHEMA_OVERRIDE_NAME_LIMIT ? ', ...' : ''} came from the shell that ran this command, so the schema's own sources were not checked for them`,
        target: schema,
        fix: 'unset those variables in the shell, then rerun this command to check the schema\'s own sources',
    })))
    return [...health.stopped === null ? [] : [health.stopped], ...health.notices,
        ...health.producerRefusals, ...checks, ...advisories, ...overridden, ...producerFailures, ...comparisons]
}

function unavailablePreflight(message: string, forwarded?: readonly EnvironmentDiagnostic[]): PreflightCommandResult {
    return {
        kind: 'blocked', status: 2,
        diagnostics: forwarded ?? [applicationDiagnostic(
            ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            message,
            'preflight',
        )],
        result: {
            verdict: 'unavailable', revision: '', checks: [], comparisons: [],
        },
    }
}

export async function runPreflight(
    input: PreflightCommandInput,
    adapters: PreflightCommandAdapters,
): Promise<PreflightCommandResult> {
    let health: HealthEvaluation
    let refused: readonly EnvironmentDiagnostic[] | undefined
    let servedFindings: Promise<readonly EnvironmentDiagnostic[]> = Promise.resolve([])
    try {
        const source = await adapters.load(input, issueHealthObservationSource, (diagnostics) => { refused = diagnostics; return undefined }, 'preflight')
        if (!source) return unavailablePreflight('preflight observation source is unavailable', refused)
        const observed = prepareHealthObservation(input, source)
        if (!observed) return unavailablePreflight('preflight requires authenticated steady lifecycle evidence')
        // Reports only and catches its own errors, so it runs beside the health evaluation.
        servedFindings = adapters.inspectServedSiblings?.() ?? Promise.resolve([])
        health = await evaluateApplicationHealth(observed, adapters)
    } catch (error) {
        // A producer that refused (a configuration edited since `up`, for one) says why; its refusal
        // outranks the lost observation window that refusal caused.
        return unavailablePreflight(`preflight requires authentic observation and lifecycle evidence: ${errorCause(error)}`, refused)
    }
    const result = {
        verdict: health.verdict,
        revision: health.preflight.revision,
        checks: health.preflight.checks,
        comparisons: health.comparisons,
    }
    // A stopped stack never passes the gate, whatever the rows observable without it say.
    const passed = health.verdict === 'pass' && health.stopped === null
    // Warnings only: a stale stack still answers, and whether a changed lockfile matters is the product's call.
    const served = await servedFindings
    return {
        kind: passed ? 'complete' : 'blocked',
        status: passed ? 0 : 2,
        diagnostics: [...healthDiagnostics(health), ...served],
        result,
    } as PreflightCommandResult
}
