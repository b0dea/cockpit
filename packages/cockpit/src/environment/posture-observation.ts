// Owns current configuration posture and lifecycle context authentication for health and browser use.
// Keeps producer declarations and verdict aggregation in observations.ts so browser preparation cannot
// depend on the generated publication it is preparing.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, sep } from 'node:path'
import { isProxy } from 'node:util/types'
import { loadCockpitConfig } from '../config/load.js'
import { STRUCTURED_INPUT_ENTRY_LIMIT, type AddressingPosture, type AuthPosture } from '../schema.js'
import { ENVIRONMENT_CODES, snapshotJson, type CockpitId, type EnvironmentObservation,
    type JsonSnapshot, type ObservationLifecycleStage, type StackId } from './contract.js'
import { checkoutId, stackId as deriveStackId, type StackVariant } from './identity.js'
import { authenticateLifecycleStageAuthority, type LifecycleStageAuthority } from './lifecycle-stage.js'
import { isStateObservation } from './state.js'

export const mechanism = {
    id: 'environment-posture-observation',
    module: 'packages/cockpit/src/environment/posture-observation.ts',
    exports: ['resolveObservationPostures', 'refreshObservationPostures', 'authenticateObservationPostureContext'],
} as const

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
        addressing: AddressingPosture | null
        authentication: AuthPosture | null
    }>
    readonly postureRequirements: readonly Readonly<{
        requirement: string
        addressing?: AddressingPosture
        authentication?: AuthPosture
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
        || observedAt > issuedAt
        || issuedAt - observedAt > 30_000) {
        throw new TypeError('resolved posture configuration source is malformed')
    }
    const configurationRoot = relative(canonicalCheckoutPath, dirname(configuration.source))
    if (configurationRoot === '..' || configurationRoot.startsWith(`..${sep}`) || isAbsolute(configurationRoot)) {
        throw new TypeError('resolved posture configuration source is malformed')
    }
    const loaded = await loadCockpitConfig(configuration.source)
    if (loaded.kind !== 'complete') throw new TypeError('resolved posture configuration source is unavailable')
    if (loaded.result.source.path !== configuration.source || loaded.result.source.sha256 !== configuration.observed.value) {
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
    if (loaded.result.config.environment.machine) postures.add('machine-floor')
    const generated = loaded.result.config.environment.generated
    if (generated || loaded.result.config.environment.compose_files.length > 0) postures.add('running-stack')
    const activeProfiles = generated?.services.flatMap(({ profiles }) => profiles) ?? []
    if (loaded.result.config.sibling.some(({ mount }) => mount === 'always'
        || mount.startsWith('profile:') && activeProfiles.includes(mount.slice(8)))) postures.add('directory-grants')
    if (generated?.services.some(({ image }) => image?.registry_auth_probe !== undefined)) postures.add('registry-authentication')
    if (generated) {
        postures.add('generated-environment')
        if (generated.data) postures.add('data-plane')
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


export interface PreflightContext {
    readonly authorities: readonly ResolvedPostureAuthority[]
    readonly stages: readonly LifecycleStageAuthority[]
}


interface PostureRequirementCheck {
    readonly code: EnvironmentObservation['code']
    readonly owner: string
    readonly stackId: StackId
    readonly source: string
    readonly verdict: 'pass' | 'fail'
    readonly reason: string
    readonly remedy: string
    readonly observedAt: string
    readonly measured?: JsonSnapshot
    readonly expected: EnvironmentObservation['expectation']
}

export function authenticateObservationPostureContext(context: PreflightContext) {
    const evaluationInstant = Date.now()
    const authorityInputs = boundedDenseArray(context?.authorities)
    const stageInputs = boundedDenseArray(context?.stages)
    if (!authorityInputs || authorityInputs.length === 0) throw new TypeError('preflight needs resolved posture authority')
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
    const postureChecks = [...authorities.values()].flatMap((authority): PostureRequirementCheck[] => {
        const requirements = authority.postureRequirements
        return (['addressing', 'authentication'] as const).map((dimension) => {
            const selected = authority.environmentPostures[dimension]
            const tagged = requirements.filter((requirement) => requirement[dimension] !== undefined)
            // A stack with no sign-in has nothing that depends on one, so it needs no tagged requirement.
            const untaggedNone = selected === 'none' && tagged.length === 0 && requirements.length > 0
            const matched = selected !== null && tagged.some((requirement) => requirement[dimension] === selected)
            const exact = untaggedNone || matched && tagged.every((requirement) => requirement[dimension] === selected)
            const reason = selected === null
                ? `${dimension} posture is not declared`
                : requirements.length === 0
                    ? 'posture requirement catalog is not declared'
                    : untaggedNone ? 'no authentication is declared, and no requirement depends on one'
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
    return Object.freeze({ evaluationInstant, authorities, stages,
        checks: Object.freeze(postureChecks) })
}
