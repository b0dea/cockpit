import {
    RefusalError,
    ENVIRONMENT_CODES,
    isCanonicalTimestamp,
    snapshotEnvironmentObservation,
    type EnvironmentObservation,
    type JsonSnapshot,
    type ObservationDeclaration,
    type ObservationLifecycleStage,
    type ObservationStageDeclaration,
    type StackId,
} from './contract.js'
import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import { observationDeclarations as claimDeclarations } from './claims.js'
import { observationDeclarations as generatedDeclarations, registryAuthenticationObservationDeclarations } from './generated-stack.js'
import { surfaceObservationDeclarations } from './generated-application.js'
import { observationDeclarations as dataDeclarations } from './data-plane.js'
import { observationDeclarations as envSchemaDeclarations } from './env-schema-observation.js'
import { observationDeclarations as externalDeclarations } from './external-dependencies.js'
import { observationDeclarations as gitDeclarations } from './git-observation.js'
import { observationDeclarations as hostDeclarations } from './host-observation.js'
import { observationDeclarations as installDeclarations } from './installs.js'
import { observationDeclarations as lifecycleStageDeclarations } from './lifecycle-stage.js'
import { observationDeclarations as runtimeDeclarations, runtimeHealthObservationDeclarations } from './runtime.js'
import { observationDeclarations as stateDeclarations } from './state.js'
import { observationDeclarations as templateDeclarations } from './templates.js'
import { STRUCTURED_INPUT_ENTRY_LIMIT } from '../schema.js'
import {
    authenticateObservationPostureContext,
    POSTURE_REQUIREMENT_OWNER,
    type PreflightContext,
    type ResolvedPostureAuthority,
} from './posture-observation.js'

export { resolveObservationPostures, refreshObservationPostures } from './posture-observation.js'
export type { PreflightContext, ResolvedPostureAuthority } from './posture-observation.js'

export const mechanism = {
    id: 'environment-observation-evaluation',
    module: 'packages/cockpit/src/environment/observations.ts',
    exports: ['resolveObservationPostures', 'refreshObservationPostures', 'projectDoctor', 'validateObservationDeclarations', 'allObservationDeclarations', 'aggregateObservations', 'observationSatisfiesExpectation', 'stoppedStackApplicability'],
} as const

export interface EvaluatedObservation {
    readonly code: EnvironmentObservation['code']
    readonly owner: string
    readonly stackId: StackId
    readonly source: string
    readonly verdict: 'pass' | 'fail' | 'unavailable' | 'not-applicable'
    readonly reason: string
    readonly remedy: string
    readonly observedAt: string
    readonly measured?: JsonSnapshot
    readonly expected: EnvironmentObservation['expectation']
}

export interface PreflightEvaluation {
    readonly verdict: 'pass' | 'fail' | 'unavailable'
    readonly revision: string
    readonly checks: readonly EvaluatedObservation[]
}

export interface DoctorCheck extends EvaluatedObservation {
    readonly evidence: string
}

export interface DoctorProjection {
    readonly verdict: PreflightEvaluation['verdict']
    readonly checks: readonly DoctorCheck[]
}

const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function boundedDenseArray(value: unknown): readonly unknown[] | undefined {
    try {
        if (isProxy(value)) return undefined
        if (!Array.isArray(value)) return undefined
        const length = Object.getOwnPropertyDescriptor(value, 'length')
        const count = length && 'value' in length ? length.value : undefined
        if (typeof count !== 'number' || !Number.isSafeInteger(count)
            || count < 0 || count > STRUCTURED_INPUT_ENTRY_LIMIT) return undefined
        const keys = Reflect.ownKeys(value)
        if (keys.length !== count + 1) return undefined
        const items: unknown[] = []
        for (let index = 0; index < count; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
            if (!descriptor || !('value' in descriptor)) return undefined
            items.push(descriptor.value)
        }
        return Object.freeze(items)
    } catch { // A throwing accessor or proxy trap makes the input malformed; the caller refuses it.
        return undefined
    }
}

function stageDeclarationSnapshot(value: unknown): ObservationStageDeclaration | undefined {
    try {
        if (isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const stage = descriptors.stage && 'value' in descriptors.stage ? descriptors.stage.value : undefined
        const disposition = descriptors.disposition && 'value' in descriptors.disposition ? descriptors.disposition.value : undefined
        const reason = descriptors.reason && 'value' in descriptors.reason ? descriptors.reason.value : undefined
        const keys = Reflect.ownKeys(descriptors)
        if ((stage !== 'bootstrap' && stage !== 'steady') || (disposition !== 'required' && disposition !== 'not-applicable')) return undefined
        if (disposition === 'required') {
            return keys.length === 2 && reason === undefined
                ? Object.freeze({ stage, disposition })
                : undefined
        }
        return keys.length === 3 && typeof reason === 'string' && reason.length > 0 && !reason.includes('\0')
            && Buffer.byteLength(reason, 'utf8') <= 1_024
            ? Object.freeze({ stage, disposition, reason })
            : undefined
    } catch { // A throwing accessor or proxy trap makes the input malformed; the caller refuses it.
        return undefined
    }
}

function declarationSnapshot(value: unknown): ObservationDeclaration | undefined {
    try {
        if (isProxy(value)) return undefined
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const required = ['id', 'owner', 'postures', 'stages', 'code', 'isIssued'] as const
        const allowed = new Set<PropertyKey>([...required, 'issuedAt'])
        const keys = Reflect.ownKeys(descriptors)
        if (keys.some((key) => !allowed.has(key)) || required.some((key) => !('value' in (descriptors[key] ?? {})))) {
            return undefined
        }
        const postures = boundedDenseArray(descriptors.postures!.value)
        const stageInputs = boundedDenseArray(descriptors.stages!.value)
        if (!postures || !stageInputs) return undefined
        const stages = stageInputs.map(stageDeclarationSnapshot)
        if (stages.some((stage) => stage === undefined)) return undefined
        const issuedAtDescriptor = descriptors.issuedAt
        if (issuedAtDescriptor && !('value' in issuedAtDescriptor)) return undefined
        return Object.freeze({
            id: descriptors.id!.value as string,
            owner: descriptors.owner!.value as string,
            postures: Object.freeze(postures as string[]),
            stages: Object.freeze(stages as ObservationStageDeclaration[]),
            code: descriptors.code!.value as EnvironmentObservation['code'],
            isIssued: descriptors.isIssued!.value as ObservationDeclaration['isIssued'],
            ...(issuedAtDescriptor ? { issuedAt: issuedAtDescriptor.value as ObservationDeclaration['issuedAt'] } : {}),
        })
    } catch { // A throwing accessor or proxy trap makes the input malformed; the caller refuses it.
        return undefined
    }
}

export const allObservationDeclarations: readonly ObservationDeclaration[] = Object.freeze([
    ...claimDeclarations,
    ...generatedDeclarations,
    ...dataDeclarations,
    ...envSchemaDeclarations,
    ...externalDeclarations,
    ...gitDeclarations,
    ...hostDeclarations,
    ...installDeclarations,
    ...lifecycleStageDeclarations,
    ...runtimeDeclarations,
    ...stateDeclarations,
    ...templateDeclarations,
    ...surfaceObservationDeclarations,
    ...registryAuthenticationObservationDeclarations,
    ...runtimeHealthObservationDeclarations,
])

export function validateObservationDeclarations(
    declarations: readonly ObservationDeclaration[],
    requiredPostures: readonly string[] = [],
): { readonly kind: 'valid'; readonly declarations: readonly ObservationDeclaration[] }
    | { readonly kind: 'invalid'; readonly reason: string } {
    const declarationInputs = boundedDenseArray(declarations)
    const postureInputs = boundedDenseArray(requiredPostures)
    if (!declarationInputs || !postureInputs || postureInputs.some((posture) => typeof posture !== 'string')) {
        return { kind: 'invalid', reason: 'observation declaration collection is malformed' }
    }
    const byId = new Set<string>()
    const byCode = new Set<EnvironmentObservation['code']>()
    const owned: ObservationDeclaration[] = []
    for (let declarationIndex = 0; declarationIndex < declarationInputs.length; declarationIndex += 1) {
        const declaration = declarationSnapshot(declarationInputs[declarationIndex])
        if (!declaration) return { kind: 'invalid', reason: 'observation declaration is malformed' }
        if (typeof declaration.id !== 'string' || typeof declaration.owner !== 'string'
            || !/^[a-z][a-z0-9-]*$/.test(declaration.id) || !/^[a-z][a-z0-9-]*$/.test(declaration.owner)
            || !Object.values(ENVIRONMENT_CODES).includes(declaration.code)
            || typeof declaration.isIssued !== 'function'
            || (declaration.issuedAt !== undefined && typeof declaration.issuedAt !== 'function')
            || declaration.postures.length === 0
            || declaration.postures.some((posture) => typeof posture !== 'string' || !/^[a-z][a-z0-9-]*$/.test(posture))
            || new Set(declaration.postures).size !== declaration.postures.length
            || declaration.stages.length === 0) {
            return { kind: 'invalid', reason: 'observation declaration is malformed' }
        }
        for (const stage of ['bootstrap', 'steady'] as const) {
            const count = declaration.stages.filter((entry) => entry.stage === stage).length
            if (count === 0) return { kind: 'invalid', reason: `${declaration.id} does not declare lifecycle stage ${stage}` }
            if (count > 1) return { kind: 'invalid', reason: `${declaration.id} declares lifecycle stage ${stage} more than once` }
        }
        if (declaration.stages.length !== 2) return { kind: 'invalid', reason: 'observation declaration is malformed' }
        if (byId.has(declaration.id)) return { kind: 'invalid', reason: `duplicate observation declaration: ${declaration.id}` }
        byId.add(declaration.id)
        if (byCode.has(declaration.code)) return { kind: 'invalid', reason: `duplicate observation code: ${declaration.code}` }
        byCode.add(declaration.code)
        for (let postureIndex = 0; postureIndex < postureInputs.length; postureIndex += 1) {
            const posture = postureInputs[postureIndex] as string
            if (!declaration.postures.includes(posture)) {
                return { kind: 'invalid', reason: `${declaration.id} does not declare posture ${posture}` }
            }
        }
        owned.push(declaration)
    }
    return { kind: 'valid', declarations: Object.freeze(owned.sort((left, right) => compareCodeUnits(left.id, right.id))) }
}

const productionDeclarations = validateObservationDeclarations(allObservationDeclarations)
if (productionDeclarations.kind !== 'valid') throw new RefusalError(productionDeclarations.reason)
if (productionDeclarations.declarations.some(({ issuedAt }) => typeof issuedAt !== 'function')) {
    throw new RefusalError('production observation declaration lacks issuance authority')
}
const validatedProductionDeclarations = productionDeclarations.declarations
const issuedPreflights = new WeakSet<object>()

// Rows whose evidence exists only while the stack's services run. Before the first `up`, and while
// the stack sleeps, doctor and preflight still evaluate every other row; these are reported as not
// applicable with the reason, because reporting them as missing evidence hid the rows that can fail
// before bring-up behind an "unavailable" verdict.
const RUNNING_STACK_ROWS = Object.freeze([
    'running-checkout', 'runtime-availability', 'mount-posture', 'runtime-mount-materialization', 'runtime-port-family',
    'generated-environment', 'registry-authentication', 'data-mode', 'external-dependencies', 'dependency-install',
])
// Rows and posture checks that describe a runtime; a cockpit that declares none has nothing for them to measure.
const RUNTIME_ROWS = Object.freeze(['runtime-measurement', POSTURE_REQUIREMENT_OWNER])
for (const id of [...RUNNING_STACK_ROWS, ...RUNTIME_ROWS]) {
    if (id !== POSTURE_REQUIREMENT_OWNER && !validatedProductionDeclarations.some((declaration) => declaration.id === id)) {
        throw new RefusalError(`stopped-stack applicability names an undeclared observation: ${id}`)
    }
}

/**
 * Which rows cannot be observed when no stack runs, and why. The key is a declaration id, or the
 * posture-requirement owner for the posture checks.
 */
export function stoppedStackApplicability(input: { readonly runtimeDeclared: boolean }): ReadonlyMap<string, string> {
    const rows = new Map<string, string>(RUNNING_STACK_ROWS.map((id) =>
        [id, `${id} is observed only while the stack runs; run up, then rerun this command to check it`]))
    if (!input.runtimeDeclared) {
        for (const id of [...RUNNING_STACK_ROWS, ...RUNTIME_ROWS]) rows.set(id, 'this cockpit declares no runtime, so there is nothing for it to measure')
    }
    return rows
}
function jsonEqual(left: JsonSnapshot, right: JsonSnapshot): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

function hasObservedPresence(value: JsonSnapshot): boolean {
    if (value === null || value === '') return false
    if (Array.isArray(value)) return value.length > 0
    return typeof value !== 'object' || Object.keys(value).length > 0
}

export function observationSatisfiesExpectation(observation: EnvironmentObservation): boolean {
    if (observation.observed.state !== 'available') return false
    const measured = observation.observed.value
    const expectation = observation.expectation
    if (expectation.kind === 'present') return hasObservedPresence(measured)
    if (expectation.kind === 'equal') return jsonEqual(measured, expectation.value)
    if (expectation.kind === 'one-of') return expectation.values.some((value) => jsonEqual(measured, value))
    return typeof measured === 'number' && Number.isSafeInteger(measured)
        && (expectation.kind === 'minimum' ? measured >= expectation.value : measured <= expectation.value)
}

function boundedJson(value: JsonSnapshot): string {
    const text = JSON.stringify(value)
    return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

// The diagnostic message is this reason, so a bare "does not satisfy" left a human to dig the
// measured value (such as a dirty-file count) out of the JSON result before acting on it.
function mismatchDetail(measured: JsonSnapshot, expectation: EnvironmentObservation['expectation']): string | undefined {
    if (expectation.kind === 'minimum') return `measured ${boundedJson(measured)} (expected at least ${expectation.value})`
    if (expectation.kind === 'maximum') return `measured ${boundedJson(measured)} (expected at most ${expectation.value})`
    if (expectation.kind !== 'equal') return undefined
    const expected = expectation.value
    const isRecord = (value: JsonSnapshot): value is Readonly<Record<string, JsonSnapshot>> =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
    if (!isRecord(measured) || !isRecord(expected)) return `measured ${boundedJson(measured)} (expected ${boundedJson(expected)})`
    const fields = [...new Set([...Object.keys(expected), ...Object.keys(measured)])]
        .filter((key) => !jsonEqual(measured[key] ?? null, expected[key] ?? null))
    if (fields.length === 0) return undefined
    const shown = fields.slice(0, 8).map((key) =>
        `${key} is ${boundedJson(measured[key] ?? null)} (expected ${boundedJson(expected[key] ?? null)})`)
    return fields.length > shown.length ? `${shown.join(', ')}, and ${fields.length - shown.length} more` : shown.join(', ')
}

function reasonFor(observation: EnvironmentObservation, verdict: EvaluatedObservation['verdict']): string {
    if (observation.applicability.state === 'not-applicable') return observation.applicability.reason
    if (observation.observed.state !== 'available') return observation.observed.reason
    if (observation.freshness.state !== 'current') return observation.freshness.reason
    if (verdict === 'pass') return 'expectation satisfied'
    const detail = mismatchDetail(observation.observed.value, observation.expectation)
    return detail ? `observed value does not satisfy the expectation: ${detail}` : 'observed value does not satisfy the expectation'
}

function evaluate(observation: EnvironmentObservation): EvaluatedObservation {
    let verdict: EvaluatedObservation['verdict']
    if (observation.applicability.state === 'not-applicable') verdict = 'not-applicable'
    else if (observation.observed.state === 'unavailable') verdict = 'unavailable'
    else if (observation.freshness.state !== 'current') verdict = 'fail'
    else if (observation.observed.state === 'failed') verdict = 'fail'
    else verdict = observationSatisfiesExpectation(observation) ? 'pass' : 'fail'
    return Object.freeze({
        code: observation.code,
        owner: observation.owner,
        stackId: observation.stackId,
        source: observation.source,
        verdict,
        reason: reasonFor(observation, verdict),
        remedy: observation.remedy,
        observedAt: observation.observed.observedAt,
        ...(observation.observed.state === 'available' ? { measured: observation.observed.value } : {}),
        expected: observation.expectation,
    })
}

function declaredApplicability(
    declaration: ObservationDeclaration,
    authority: ResolvedPostureAuthority,
    stage: ObservationLifecycleStage,
    unobservable: ReadonlyMap<string, string>,
): EnvironmentObservation['applicability'] {
    const posture = declaration.postures.find((value) => authority.postures.includes(value))
    if (!posture) {
        return { state: 'not-applicable', posture: authority.postures.join('+'), reason: `${declaration.id} does not apply to the resolved posture` }
    }
    const disposition = declaration.stages.find((entry) => entry.stage === stage)!
    if (disposition.disposition !== 'required') return { state: 'not-applicable', posture, reason: disposition.reason }
    const reason = unobservable.get(declaration.id)
    return reason === undefined ? { state: 'required', posture } : { state: 'not-applicable', posture, reason }
}

function missingObservation(
    declaration: ObservationDeclaration,
    authority: ResolvedPostureAuthority,
    stage: ObservationLifecycleStage,
    unobservable: ReadonlyMap<string, string>,
): EnvironmentObservation {
    return {
        code: declaration.code,
        owner: declaration.owner,
        stackId: authority.stackId,
        source: declaration.id,
        observed: { state: 'unavailable', reason: `${declaration.id} evidence is missing`, observedAt: authority.evaluatedAt },
        expectation: { kind: 'present' },
        applicability: declaredApplicability(declaration, authority, stage, unobservable),
        freshness: { state: 'missing', reason: `${declaration.id} has no current observation` },
        remedy: `provide a current ${declaration.id} observation`,
    }
}

/**
 * `unobservable` comes from {@link stoppedStackApplicability}: rows no producer can observe in the
 * stack's current state, reported as not applicable with its reason instead of as missing.
 */
function evaluatePreflight(
    values: readonly EnvironmentObservation[],
    context: PreflightContext,
    unobservable: ReadonlyMap<string, string> = new Map(),
): PreflightEvaluation {
    const observations: EnvironmentObservation[] = []
    const observationInputs = boundedDenseArray(values)
    if (!observationInputs) throw new RefusalError('preflight observations must be a bounded dense array')
    const { evaluationInstant, authorities, stages, checks: postureChecks } = authenticateObservationPostureContext(context)
    if (authorities.size * validatedProductionDeclarations.length > STRUCTURED_INPUT_ENTRY_LIMIT) {
        throw new RefusalError('preflight aggregate exceeds its bounded declaration capacity')
    }
    const suppliedKeys = new Set<string>()
    for (const value of observationInputs) {
        const snapshot = snapshotEnvironmentObservation(value)
        if (snapshot === undefined) throw new RefusalError('environment observation is malformed')
        const declaration = validatedProductionDeclarations.find(({ owner, code }) => owner === snapshot.owner && code === snapshot.code)
        if (!declaration) throw new RefusalError('environment observation has no declared producer authority')
        if (!declaration.isIssued(value)) throw new RefusalError('environment observation is not producer-issued')
        const producerIssuedAt = declaration.issuedAt?.(value)
        if (producerIssuedAt === undefined) throw new RefusalError('environment observation lacks producer issuance authority')
        const key = `${snapshot.stackId}\0${snapshot.owner}\0${snapshot.code}`
        if (suppliedKeys.has(key)) throw new RefusalError('preflight contains duplicate mechanism evidence')
        suppliedKeys.add(key)
        const authority = authorities.get(snapshot.stackId)
        if (!authority) throw new RefusalError('environment observation has no resolved posture authority')
        const applicability = declaredApplicability(declaration, authority, stages.get(authority.stackId)!, unobservable)
        const observedTime = Date.parse(snapshot.observed.observedAt)
        const freshness = observedTime < Date.parse(authority.evaluatedAt)
            || observedTime > Date.parse(authority.validThrough)
            || observedTime > evaluationInstant
            || observedTime > producerIssuedAt
            ? { state: 'stale' as const, reason: 'observation timestamp does not match the evaluation boundary' }
            : snapshot.freshness.state === 'current' ? { state: 'current' as const } : snapshot.freshness
        const expectation = snapshot.code === ENVIRONMENT_CODES.CONFIG_STALE
            ? { kind: 'equal' as const, value: authority.revision }
            : snapshot.expectation
        const owned = snapshotEnvironmentObservation({ ...snapshot, applicability, freshness, expectation })
        if (!owned) throw new RefusalError('environment observation applicability could not be derived')
        observations.push(owned)
    }
    const stackIds = [...authorities.keys()].sort(compareCodeUnits)
    const missing: Array<readonly [ObservationDeclaration, ResolvedPostureAuthority]> = []
    for (const stackId of stackIds) {
        const authority = authorities.get(stackId)!
        for (const declaration of validatedProductionDeclarations) {
            const key = `${stackId}\0${declaration.owner}\0${declaration.code}`
            if (!suppliedKeys.has(key)) missing.push([declaration, authority])
        }
    }
    for (const [declaration, authority] of missing) observations.push(missingObservation(declaration, authority, stages.get(authority.stackId)!, unobservable))
    const postureReason = unobservable.get(POSTURE_REQUIREMENT_OWNER)
    const checks = [...observations
        .sort((left, right) => compareCodeUnits(`${left.stackId}\0${left.code}\0${left.owner}\0${left.source}`, `${right.stackId}\0${right.code}\0${right.owner}\0${right.source}`))
        .map(evaluate), ...postureReason === undefined ? postureChecks
        : postureChecks.map((check) => Object.freeze({ ...check, verdict: 'not-applicable' as const, reason: postureReason }))]
        .sort((left, right) => compareCodeUnits(`${left.stackId}\0${left.code}\0${left.owner}\0${left.source}`, `${right.stackId}\0${right.code}\0${right.owner}\0${right.source}`))
    const verdict = stackIds.length === 0 && checks.length === 0 ? 'unavailable'
        : checks.some((check) => check.verdict === 'fail')
        ? 'fail'
        : checks.some((check) => check.verdict === 'unavailable') ? 'unavailable' : 'pass'
    const revisionEntries = [...authorities.values()]
        .map((authority) => `${authority.stackId}\0${authority.revision}`)
        .sort(compareCodeUnits)
    const distinctRevisions = new Set([...authorities.values()].map((authority) => authority.revision))
    const revision = distinctRevisions.size === 1
        ? [...distinctRevisions][0]!
        : createHash('sha256').update(revisionEntries.join('\0')).digest('hex')
    const result = Object.freeze({ verdict, revision, checks: Object.freeze(checks) })
    issuedPreflights.add(result)
    return result
}

function evidenceValue(value: JsonSnapshot | undefined): string {
    return value === undefined ? 'unavailable' : JSON.stringify(value)
}

export function projectDoctor(preflight: PreflightEvaluation): DoctorProjection {
    if (!issuedPreflights.has(preflight)) throw new RefusalError('preflight evaluation is not authentic')
    return Object.freeze({
        verdict: preflight.verdict,
        checks: Object.freeze(preflight.checks.map((check) => Object.freeze({
            ...check,
            evidence: `source=${check.source} observedAt=${check.observedAt} measured=${evidenceValue(check.measured)} expected=${JSON.stringify(check.expected)}`,
        }))),
    })
}

export function aggregateObservations(
    groups: readonly (readonly EnvironmentObservation[])[],
    context: PreflightContext,
    unobservable?: ReadonlyMap<string, string>,
): PreflightEvaluation {
    const groupInputs = boundedDenseArray(groups)
    if (!groupInputs) throw new RefusalError('observation groups must be a bounded dense array')
    const values: EnvironmentObservation[] = []
    for (const group of groupInputs) {
        const observations = boundedDenseArray(group)
        if (!observations || values.length + observations.length > STRUCTURED_INPUT_ENTRY_LIMIT) {
            throw new RefusalError('observation groups must be a bounded dense array within the shared boundary')
        }
        for (const observation of observations) values.push(observation as EnvironmentObservation)
    }
    return evaluatePreflight(values, context, unobservable)
}
