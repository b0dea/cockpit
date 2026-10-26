import {
    ENVIRONMENT_CODES,
    isCanonicalTimestamp,
    snapshotEnvironmentObservation,
    snapshotJson,
    type EnvironmentObservation,
    type JsonSnapshot,
    type ObservationDeclaration,
    type ObservationLifecycleStage,
    type ObservationStageDeclaration,
    type StackId,
} from './contract.js'
import { loadCockpitConfig } from '../config/load.js'
import { isStateObservation } from './state.js'
import { checkoutId, stackId as deriveStackId, type StackVariant } from './identity.js'
import { dirname, normalize } from 'node:path'
import { realpath } from 'node:fs/promises'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type { CockpitId } from './contract.js'
import { observationDeclarations as claimDeclarations } from './claims.js'
import { observationDeclarations as generatedDeclarations } from './generated-stack.js'
import { observationDeclarations as dataDeclarations } from './data-plane.js'
import { observationDeclarations as externalDeclarations } from './external-dependencies.js'
import { observationDeclarations as gitDeclarations } from './git-observation.js'
import { observationDeclarations as hostDeclarations } from './host-observation.js'
import { observationDeclarations as installDeclarations } from './installs.js'
import {
    authenticateLifecycleStageAuthority,
    observationDeclarations as lifecycleStageDeclarations,
    type LifecycleStageAuthority,
} from './lifecycle-stage.js'
import { observationDeclarations as portDeclarations } from './ports.js'
import { observationDeclarations as runtimeDeclarations } from './runtime.js'
import { observationDeclarations as stateDeclarations } from './state.js'
import { observationDeclarations as templateDeclarations } from './templates.js'
import { STRUCTURED_INPUT_ENTRY_LIMIT } from '../schema.js'

export const mechanism = {
    id: 'environment-observation-evaluation',
    module: 'packages/cockpit/src/environment/observations.ts',
    exports: ['resolveObservationPostures', 'refreshObservationPostures', 'evaluatePreflight', 'projectDoctor', 'unavailableProducerObservations', 'validateObservationDeclarations', 'allObservationDeclarations', 'aggregateObservations', 'observationSatisfiesExpectation'],
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

const absentProducerDeclarations = Object.freeze([
    { id: 'directory-grants', owner: 'directory-grants', postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.DIRECTORY_GRANTS_UNAVAILABLE, isIssued: isUnavailableObservation, issuedAt: unavailableObservationIssuedAt },
    { id: 'harness-surfaces', owner: 'harness-surfaces', postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.HARNESS_SURFACE_UNAVAILABLE, isIssued: isUnavailableObservation, issuedAt: unavailableObservationIssuedAt },
    { id: 'mount-materialization', owner: 'mount-materialization', postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.MOUNT_MATERIALIZATION_UNAVAILABLE, isIssued: isUnavailableObservation, issuedAt: unavailableObservationIssuedAt },
    { id: 'registry-authentication', owner: 'registry-authentication', postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.REGISTRY_AUTH_UNAVAILABLE, isIssued: isUnavailableObservation, issuedAt: unavailableObservationIssuedAt },
    { id: 'skill-budget', owner: 'skill-budget', postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.SKILL_BUDGET_UNAVAILABLE, isIssued: isUnavailableObservation, issuedAt: unavailableObservationIssuedAt },
] as const)

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
    } catch {
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
    } catch {
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
    } catch {
        return undefined
    }
}

export const allObservationDeclarations: readonly ObservationDeclaration[] = Object.freeze([
    ...claimDeclarations,
    ...generatedDeclarations,
    ...dataDeclarations,
    ...externalDeclarations,
    ...gitDeclarations,
    ...hostDeclarations,
    ...installDeclarations,
    ...lifecycleStageDeclarations,
    ...portDeclarations,
    ...runtimeDeclarations,
    ...stateDeclarations,
    ...templateDeclarations,
    ...absentProducerDeclarations,
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
if (productionDeclarations.kind !== 'valid') throw new Error(productionDeclarations.reason)
if (productionDeclarations.declarations.some(({ issuedAt }) => typeof issuedAt !== 'function')) {
    throw new Error('production observation declaration lacks issuance authority')
}
const validatedProductionDeclarations = productionDeclarations.declarations
const issuedPreflights = new WeakSet<object>()
const issuedUnavailableObservations = new WeakMap<object, number>()
const issuedPostureAuthorities = new WeakMap<object, CockpitId>()
const postureRefreshWindows = new WeakMap<object, Readonly<{ cockpitId: CockpitId; expiresAt: number }>>()
const POSTURE_AUTHORITY_LIFETIME_MS = 30_000
const PREFLIGHT_OBSERVATION_WINDOW_MS = 300_000
const CONFIGURATION_BYTE_LIMIT = 1_048_576

function currentConfigurationRevision(path: string): string | undefined {
    let descriptor: number | undefined
    try {
        const before = lstatSync(path, { bigint: true })
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(CONFIGURATION_BYTE_LIMIT)) return undefined
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const opened = fstatSync(descriptor, { bigint: true })
        if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino
            || opened.size > BigInt(CONFIGURATION_BYTE_LIMIT)) return undefined
        const hash = createHash('sha256')
        const buffer = Buffer.allocUnsafe(65_536)
        let total = 0
        while (true) {
            const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, CONFIGURATION_BYTE_LIMIT - total + 1), null)
            if (count === 0) break
            total += count
            if (total > CONFIGURATION_BYTE_LIMIT) return undefined
            hash.update(buffer.subarray(0, count))
        }
        const after = fstatSync(descriptor, { bigint: true })
        const named = lstatSync(path, { bigint: true })
        if (!named.isFile() || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino
            || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || named.size !== opened.size
            || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || total !== Number(opened.size)) return undefined
        return hash.digest('hex')
    } catch {
        return undefined
    } finally {
        if (descriptor !== undefined) {
            try { closeSync(descriptor) } catch { /* A failed identity check grants no authority. */ }
        }
    }
}

export interface ResolvedPostureAuthority {
    readonly stackId: StackId
    readonly evaluatedAt: string
    readonly validThrough: string
    readonly revision: string
    readonly source: string
    readonly postures: readonly string[]
    readonly environmentPostures: Readonly<{
        addressing: 'hostname' | 'port' | null
        authentication: 'real' | 'bypassed' | null
    }>
    readonly postureRequirements: readonly Readonly<{
        requirement: string
        addressing?: 'hostname' | 'port'
        authentication?: 'real' | 'bypassed'
    }>[]
}

interface ObservationPostureInput {
    readonly configuration: EnvironmentObservation
    readonly cockpitId: CockpitId
    readonly checkoutPath: string
    readonly variant: StackVariant
}

async function issueObservationPostures(
    input: ObservationPostureInput,
    previous?: ResolvedPostureAuthority,
): Promise<ResolvedPostureAuthority> {
    const descriptor = input && typeof input === 'object'
        ? Object.getOwnPropertyDescriptor(input, 'configuration')
        : undefined
    const configuration = descriptor && 'value' in descriptor ? descriptor.value : undefined
    const owned = snapshotJson({ cockpitId: input.cockpitId, checkoutPath: input.checkoutPath, variant: input.variant })
    const identity = owned && typeof owned === 'object' && !Array.isArray(owned)
        ? owned as Readonly<Record<string, JsonSnapshot>>
        : undefined
    let expectedStackId: StackId
    let canonicalCheckoutPath: string
    try {
        if (!identity || typeof identity.cockpitId !== 'string' || typeof identity.checkoutPath !== 'string'
            || normalize(identity.checkoutPath) !== identity.checkoutPath) throw new Error('invalid identity')
        canonicalCheckoutPath = await realpath(identity.checkoutPath)
        expectedStackId = deriveStackId({
            cockpitId: identity.cockpitId as CockpitId,
            checkoutId: checkoutId({ checkoutPath: canonicalCheckoutPath }),
            variant: identity.variant as unknown as StackVariant,
        })
    } catch { throw new TypeError('resolved posture configuration source is malformed') }
    const issuedAt = Date.now()
    const observedAt = configuration && typeof configuration === 'object'
        && 'observed' in configuration && configuration.observed.state === 'available'
        ? Date.parse(configuration.observed.observedAt)
        : Number.NaN
    if (!isStateObservation(configuration)
        || configuration.code !== ENVIRONMENT_CODES.CONFIG_STALE
        || configuration.observed.state !== 'available'
        || configuration.stackId !== expectedStackId
        || dirname(configuration.source) !== canonicalCheckoutPath
        || observedAt > issuedAt
        || issuedAt - observedAt > 30_000) {
        throw new TypeError('resolved posture configuration source is malformed')
    }
    const loaded = await loadCockpitConfig(configuration.source)
    if (loaded.kind !== 'complete') throw new TypeError('resolved posture configuration source is unavailable')
    if (loaded.result.source.sha256 !== configuration.observed.value) {
        throw new TypeError('resolved posture configuration changed after observation')
    }
    const previousWindow = previous === undefined ? undefined : postureRefreshWindows.get(previous)
    if (previous !== undefined && (!previousWindow || previousWindow.cockpitId !== identity.cockpitId
        || previous.stackId !== configuration.stackId || previous.source !== loaded.result.source.path
        || previous.revision !== loaded.result.source.sha256)) {
        throw new TypeError('resolved posture refresh does not match its initial authority')
    }
    const evaluatedAt = previous?.evaluatedAt ?? configuration.observed.observedAt
    const windowExpiresAt = previousWindow?.expiresAt ?? Date.parse(evaluatedAt) + PREFLIGHT_OBSERVATION_WINDOW_MS
    if (!Number.isSafeInteger(windowExpiresAt) || issuedAt > windowExpiresAt) {
        throw new TypeError('resolved posture refresh window expired')
    }
    const postures = new Set<string>(['environment'])
    if (loaded.result.config.sibling.some(({ toolchain }) => toolchain !== 'none')) postures.add('dependencies')
    const generated = loaded.result.config.environment.generated
    if (generated) {
        postures.add('generated-environment')
        postures.add('data-plane')
        if (generated.vendors.length > 0) postures.add('external-dependencies')
    }
    for (const sibling of loaded.result.config.sibling) {
        if (sibling.mount === 'none') continue
        if (sibling.mount === 'host') postures.add('host')
        else postures.add('mounted')
    }
    const authority = Object.freeze({
        stackId: configuration.stackId,
        evaluatedAt,
        validThrough: new Date(Math.min(issuedAt + POSTURE_AUTHORITY_LIFETIME_MS, windowExpiresAt)).toISOString(),
        revision: loaded.result.source.sha256,
        source: loaded.result.source.path,
        postures: Object.freeze([...postures].sort(compareCodeUnits)),
        environmentPostures: Object.freeze({
            addressing: loaded.result.config.environment.addressing ?? null,
            authentication: loaded.result.config.environment.authentication ?? null,
        }),
        postureRequirements: Object.freeze((loaded.result.config.environment.posture_requirements ?? [])
            .map((requirement) => Object.freeze({ ...requirement }))),
    })
    issuedPostureAuthorities.set(authority, identity.cockpitId as CockpitId)
    postureRefreshWindows.set(authority, Object.freeze({ cockpitId: identity.cockpitId as CockpitId, expiresAt: windowExpiresAt }))
    return authority
}

export async function resolveObservationPostures(input: ObservationPostureInput): Promise<ResolvedPostureAuthority> {
    return issueObservationPostures(input)
}

export async function refreshObservationPostures(input: ObservationPostureInput & {
    readonly previous: ResolvedPostureAuthority
}): Promise<ResolvedPostureAuthority> {
    const descriptor = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'previous') : undefined
    const previous = descriptor && 'value' in descriptor ? descriptor.value as ResolvedPostureAuthority : undefined
    if (!previous) throw new TypeError('resolved posture refresh requires initial authority')
    return issueObservationPostures(input, previous)
}

function isUnavailableObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedUnavailableObservations.has(value)
}

function unavailableObservationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedUnavailableObservations.get(value) : undefined
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

function reasonFor(observation: EnvironmentObservation, verdict: EvaluatedObservation['verdict']): string {
    if (observation.applicability.state === 'not-applicable') return observation.applicability.reason
    if (observation.observed.state !== 'available') return observation.observed.reason
    if (observation.freshness.state !== 'current') return observation.freshness.reason
    return verdict === 'pass' ? 'expectation satisfied' : 'observed value does not satisfy the expectation'
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

export interface PreflightContext {
    /** @deprecated Production declarations are always authoritative. */
    readonly declarations?: readonly ObservationDeclaration[]
    readonly authorities: readonly ResolvedPostureAuthority[]
    readonly stages: readonly LifecycleStageAuthority[]
}

function declaredApplicability(
    declaration: ObservationDeclaration,
    authority: ResolvedPostureAuthority,
    stage: ObservationLifecycleStage,
): EnvironmentObservation['applicability'] {
    const posture = declaration.postures.find((value) => authority.postures.includes(value))
    if (!posture) {
        return { state: 'not-applicable', posture: authority.postures.join('+'), reason: `${declaration.id} does not apply to the resolved posture` }
    }
    const disposition = declaration.stages.find((entry) => entry.stage === stage)!
    return disposition.disposition === 'required'
        ? { state: 'required', posture }
        : { state: 'not-applicable', posture, reason: disposition.reason }
}

function missingObservation(
    declaration: ObservationDeclaration,
    authority: ResolvedPostureAuthority,
    stage: ObservationLifecycleStage,
): EnvironmentObservation {
    return {
        code: declaration.code,
        owner: declaration.owner,
        stackId: authority.stackId,
        source: declaration.id,
        observed: { state: 'unavailable', reason: `${declaration.id} evidence is missing`, observedAt: authority.evaluatedAt },
        expectation: { kind: 'present' },
        applicability: declaredApplicability(declaration, authority, stage),
        freshness: { state: 'missing', reason: `${declaration.id} has no current observation` },
        remedy: `provide a current ${declaration.id} observation`,
    }
}

export function evaluatePreflight(values: readonly EnvironmentObservation[], context: PreflightContext): PreflightEvaluation {
    const observations: EnvironmentObservation[] = []
    const evaluationInstant = Date.now()
    const authorityInputs = boundedDenseArray(context?.authorities)
    const stageInputs = boundedDenseArray(context?.stages)
    const observationInputs = boundedDenseArray(values)
    if (!authorityInputs || authorityInputs.length === 0) throw new TypeError('preflight needs resolved posture authority')
    if (!observationInputs) throw new TypeError('preflight observations must be a bounded dense array')
    const authorities = new Map<StackId, ResolvedPostureAuthority>()
    let windowStart = Number.NEGATIVE_INFINITY
    let windowEnd = Number.POSITIVE_INFINITY
    for (const authorityInput of authorityInputs) {
        const authority = authorityInput as ResolvedPostureAuthority
        const cockpitId = issuedPostureAuthorities.get(authority)
        if (!cockpitId) throw new TypeError('preflight needs resolved posture authority')
        if (authorities.has(authority.stackId)) throw new TypeError('preflight contains duplicate posture authority')
        const currentRevision = currentConfigurationRevision(authority.source)
        if (currentRevision !== authority.revision) throw new TypeError('configuration changed after posture resolution')
        const authorityStart = Date.parse(authority.evaluatedAt)
        const authorityEnd = Date.parse(authority.validThrough)
        if (!Number.isFinite(authorityStart) || !Number.isFinite(authorityEnd) || authorityStart > authorityEnd) throw new TypeError('preflight posture authorities are incoherent')
        if (evaluationInstant > authorityEnd) throw new TypeError('preflight posture authority has expired')
        authorities.set(authority.stackId, authority)
        windowStart = Math.max(windowStart, authorityStart)
        windowEnd = Math.min(windowEnd, authorityEnd)
    }
    if (windowStart > windowEnd) throw new TypeError('preflight posture authorities are incoherent')
    if (!stageInputs || stageInputs.length !== authorityInputs.length) throw new TypeError('preflight needs lifecycle stage authority')
    const stages = new Map<StackId, ObservationLifecycleStage>()
    for (const stageInput of stageInputs) {
        if (isProxy(stageInput) || stageInput === null || typeof stageInput !== 'object') throw new TypeError('preflight needs lifecycle stage authority')
        const stackDescriptor = Object.getOwnPropertyDescriptor(stageInput, 'stackId')
        const stageStackId = stackDescriptor && 'value' in stackDescriptor ? stackDescriptor.value : undefined
        const authority = typeof stageStackId === 'string' ? authorities.get(stageStackId as StackId) : undefined
        if (!authority || stages.has(authority.stackId)) throw new TypeError('preflight needs one matching lifecycle stage authority per stack')
        const stage = authenticateLifecycleStageAuthority(
            stageInput,
            authority.stackId,
            issuedPostureAuthorities.get(authority)!,
            Date.parse(authority.evaluatedAt),
            Date.parse(authority.validThrough),
            evaluationInstant,
        )
        if (!stage) throw new TypeError('preflight needs authentic lifecycle stage authority')
        stages.set(authority.stackId, stage)
    }
    if (stages.size !== authorities.size) throw new TypeError('preflight needs one matching lifecycle stage authority per stack')
    if (authorities.size * validatedProductionDeclarations.length > STRUCTURED_INPUT_ENTRY_LIMIT) {
        throw new TypeError('preflight aggregate exceeds its bounded declaration capacity')
    }
    const suppliedKeys = new Set<string>()
    for (const value of observationInputs) {
        const snapshot = snapshotEnvironmentObservation(value)
        if (snapshot === undefined) throw new TypeError('environment observation is malformed')
        const declaration = validatedProductionDeclarations.find(({ owner, code }) => owner === snapshot.owner && code === snapshot.code)
        if (!declaration) throw new TypeError('environment observation has no declared producer authority')
        if (!declaration.isIssued(value)) throw new TypeError('environment observation is not producer-issued')
        const producerIssuedAt = declaration.issuedAt?.(value)
        if (producerIssuedAt === undefined) throw new TypeError('environment observation lacks producer issuance authority')
        const key = `${snapshot.stackId}\0${snapshot.owner}\0${snapshot.code}`
        if (suppliedKeys.has(key)) throw new TypeError('preflight contains duplicate mechanism evidence')
        suppliedKeys.add(key)
        const authority = authorities.get(snapshot.stackId)
        if (!authority) throw new TypeError('environment observation has no resolved posture authority')
        const applicability = declaredApplicability(declaration, authority, stages.get(authority.stackId)!)
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
        if (!owned) throw new TypeError('environment observation applicability could not be derived')
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
    for (const [declaration, authority] of missing) observations.push(missingObservation(declaration, authority, stages.get(authority.stackId)!))
    const postureChecks = [...authorities.values()].flatMap((authority): EvaluatedObservation[] => {
        const requirements = authority.postureRequirements
        return (['addressing', 'authentication'] as const).map((dimension) => {
            const selected = authority.environmentPostures[dimension]
            const tagged = requirements.filter((requirement) => requirement[dimension] !== undefined)
            const matched = selected !== null && tagged.some((requirement) => requirement[dimension] === selected)
            const exact = matched && tagged.every((requirement) => requirement[dimension] === selected)
            const reason = selected === null
                ? `${dimension} posture is not declared`
                : requirements.length === 0
                    ? 'posture requirement catalog is not declared'
                    : tagged.length === 0
                        ? `${dimension} posture ${selected} is not named by a requirement`
                        : !exact ? `${dimension} requirement tags do not match selected posture ${selected}`
                            : 'declared requirement tags match the selected posture'
            return Object.freeze({
                code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
                owner: 'posture-requirements',
                stackId: authority.stackId,
                source: `${authority.source}:${dimension}`,
                verdict: exact ? 'pass' as const : 'fail' as const,
                reason,
                remedy: `declare ${dimension} and tag every dependent requirement with the same posture`,
                observedAt: authority.evaluatedAt,
                ...(selected === null ? {} : { measured: selected }),
                expected: { kind: 'present' as const },
            })
        })
    })
    const checks = [...observations
        .sort((left, right) => compareCodeUnits(`${left.stackId}\0${left.code}\0${left.owner}\0${left.source}`, `${right.stackId}\0${right.code}\0${right.owner}\0${right.source}`))
        .map(evaluate), ...postureChecks]
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
    if (!issuedPreflights.has(preflight)) throw new TypeError('preflight evaluation is not authentic')
    return Object.freeze({
        verdict: preflight.verdict,
        checks: Object.freeze(preflight.checks.map((check) => Object.freeze({
            ...check,
            evidence: `source=${check.source} observedAt=${check.observedAt} measured=${evidenceValue(check.measured)} expected=${JSON.stringify(check.expected)}`,
        }))),
    })
}

export function unavailableProducerObservations(stackId: StackId, observedAt: string): readonly EnvironmentObservation[] {
    return absentProducerDeclarations.map(({ owner, code, postures }) => {
        const observation = snapshotEnvironmentObservation({
        code,
        owner,
        stackId,
        source: owner,
        observed: { state: 'unavailable', reason: `${owner} evidence is not available`, observedAt },
        expectation: { kind: 'present' },
        applicability: { state: 'required', posture: postures[0] },
        freshness: { state: 'missing', reason: `${owner} has no current observation` },
        remedy: `provide a measured ${owner} observation`,
        })
        if (!observation) throw new TypeError('unavailable producer observation is malformed')
        issuedUnavailableObservations.set(observation, Date.now())
        return observation
    })
}

export function aggregateObservations(groups: readonly (readonly EnvironmentObservation[])[], context: PreflightContext): PreflightEvaluation {
    const groupInputs = boundedDenseArray(groups)
    if (!groupInputs) throw new TypeError('observation groups must be a bounded dense array')
    const values: EnvironmentObservation[] = []
    for (const group of groupInputs) {
        const observations = boundedDenseArray(group)
        if (!observations || values.length + observations.length > STRUCTURED_INPUT_ENTRY_LIMIT) {
            throw new TypeError('observation groups must be a bounded dense array within the shared boundary')
        }
        for (const observation of observations) values.push(observation as EnvironmentObservation)
    }
    return evaluatePreflight(values, context)
}
