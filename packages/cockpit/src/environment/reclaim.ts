import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { admitLocalDockerEndpoint } from './docker-endpoint.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { authenticatedExecutionOutcome } from '../environment-exec/execute.js'
import {
    decodeCoordinationRecord,
    consumeFailedReclaimRecovery,
    inspectDrainAttemptAuthority,
    inspectDrainExecutionFence,
    inspectFailedReclaimRecovery,
    matchReclaimDrainContinuation,
    openReclaimDrainExecution,
    settleReclaimDrainFailure,
    settleReclaimDrainSuccess,
    type DrainAttemptAuthority,
    type DrainAttemptFailure,
    type DrainReservationAuthority,
    type ReclaimDrainExecutionAuthority,
    type DrainOutcomeAuthority,
    type DrainReservation,
    type FailedReclaimRecovery,
    type DrainTargetCommitment,
    type ReclaimCompleted,
} from './claims.js'
import {
    hasErrorCode,
    tryParseJson,
    RefusalError,
    ENVIRONMENT_CODES,
    errorCause,
    filesystemObjectIdentity,
    isCanonicalTimestamp,
    isFilesystemObjectIdentity,
    sameFilesystemObject,
    snapshotExecutionStep,
    snapshotJson,
    type CockpitId,
    type EnvironmentCode,
    type EnvironmentDiagnostic,
    type ExecutionStep,
    type FilesystemAncestorIdentity,
    type FilesystemCheck,
    type StackId,
} from './contract.js'
import type { ResolvedExecutable } from './executable.js'
import { resolvedDockerExecutable, resolvedExecutable } from './executable.js'
import { readState, type StateAddress, type StateRecord } from './state.js'

export const mechanism = {
    id: 'environment-reclamation',
    module: 'packages/cockpit/src/environment/reclaim.ts',
    exports: [
        'classifyReclaim', 'createDockerSelectionSteps', 'admitDockerSelection',
        'createReclaimDiscoverySteps', 'admitReclaimDiscovery',
        'createImageInspectionSteps', 'admitImageInspections', 'createVolumeInspectionSteps',
        'admitVolumeInspections', 'createNetworkInspectionSteps', 'admitNetworkInspections',
        'combineReclaimDiscoveries', 'inspectionOverflow',
        'planReset', 'planTeardown', 'projectResetActionTargets', 'projectRecoveredResetActionTargets', 'projectTeardownActionTargets', 'keptTeardownResources', 'consumeReclaimTargetProjection', 'redeemAbsentReclaimAction', 'reconcileAbsentReclaimAction', 'redeemReclaimAction', 'redeemTeardownAction', 'reconcileReclaimAction', 'admitReclaimFailure', 'consumeReclaimFailure', 'consumeReclaimCompleted',
    ],
} as const

const STACK_ID = /^stack:[a-f0-9]{64}$/
const COCKPIT_ID = /^cockpit:[a-z0-9][a-z0-9-]*:[a-f0-9]{64}$/
const SHA256 = /^[a-f0-9]{64}$/
const BUILD_CACHE_ID = /^[a-z0-9]{25}$/
const RESOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,255}$/
const DOCKER_SELECTOR = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const REQUIRED_LABELS = Object.freeze({
    stack: 'dev.b0dea.cockpit.stack-id',
    config: 'dev.b0dea.cockpit.config-sha256',
    owner: 'dev.b0dea.cockpit.owner-id',
})
// Compose labels every volume it creates with its project and the volume's key in the Compose
// file. `resettable_volumes` names that key, and Docker's volume name differs per checkout.
const COMPOSE_LABELS = Object.freeze({
    project: 'com.docker.compose.project',
    volume: 'com.docker.compose.volume',
})
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]*$/
const MAX_RESOURCES = 4_096
const OUTPUT_LIMIT = 1_048_576
// Inspections are chunked so a stack with many resources still needs few Docker clients. The chunk
// is sized from the per-call output cap: every printed object is held to a fixed budget, and a
// chunk's cap is its object count times that budget.
const INSPECTION_OBJECT_BUDGET = 16_384
const INSPECTION_CHUNK = Math.min(64, Math.floor(OUTPUT_LIMIT / INSPECTION_OBJECT_BUDGET))
// [executable, --host, endpoint, <type>, inspect, --format, <format>, ...ids]
const INSPECTION_ARGV_PREFIX = 7
const admittedDiscoveries = new WeakSet<object>()
const discoveryAuthorities = new WeakMap<object, DiscoveryAuthority>()
const consumedDiscoveryReceipts = new Set<string>()
const previewDiscoveryReceipts = new Map<string, readonly string[]>()
const resetContinuations = new WeakMap<object, ResetContinuationAuthority>()
const consumedContinuations = new WeakSet<object>()
const consentAuthorities = new WeakMap<object, { readonly digest: string; readonly receipts: readonly string[]; readonly issuedAt: string }>()
const consumedConsents = new WeakSet<object>()
const teardownContinuations = new WeakMap<object, TeardownContinuationAuthority>()
const consumedTeardownContinuations = new WeakSet<object>()
const consumedExecutionReceipts = new WeakSet<object>()
// A reconciliation discovery that proved one action of a continuing drain, kept for that drain's
// next plan. It started after the action finished, so it is as fresh as a second discovery would
// be; re-listing the whole daemon between every action is what made `down` take minutes.
const reconciledContinuationDiscoveries = new WeakMap<object, DiscoveryAuthority>()
const pendingResetActions = new WeakMap<object, PendingResetAction>()
const pendingTeardownActions = new WeakMap<object, PendingTeardownAction>()
const consumedPendingTeardownActions = new WeakSet<object>()
const pendingReclaimExecutions = new WeakMap<object, PendingReclaimExecution>()
const pendingAbsentReclaimActions = new WeakMap<object, PendingAbsentReclaimAction>()
const absentReclaimExecutions = new WeakMap<object, {
    readonly pending: PendingAbsentReclaimAction
    readonly reservation: DrainReservation
    readonly attempt: NonNullable<DrainReservation['attempt']>
    readonly execution: ReclaimDrainExecutionAuthority
}>()
const issuedReclaimCompleted = new WeakMap<object, DrainOutcomeAuthority>()
const issuedReclaimFailures = new WeakMap<object, DrainOutcomeAuthority>()
const issuedResetPreviews = new WeakMap<object, ReclaimTargetEnvelope>()
const issuedResetRecoveryPlans = new WeakMap<object, ReclaimTargetEnvelope>()
const issuedTeardownPlans = new WeakMap<object, ReclaimTargetEnvelope>()
const issuedTargetProjections = new WeakMap<object, ReclaimTargetEnvelope>()
const selectionProbePlans = new WeakMap<object, DockerSelectionProbePlan>()
const consumedSelectionProbePlans = new WeakSet<object>()
const selectionAuthorities = new WeakMap<object, DockerSelectionAuthority>()
const consumedSelectionAuthorities = new WeakSet<object>()
const plannedDiscoverySteps = new WeakMap<object, { readonly authority: DockerSelectionAuthority; readonly kind: Exclude<ReclaimResourceKind, 'cache'> }>()
const consumedPlannedDiscoverySteps = new WeakSet<object>()
const DAEMON_ENV = /^(?:DOCKER|BUILDX|CONTAINER|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)(?:_|$)/i
const SAFE_ENV = new Set(['PATH', 'TMPDIR', 'LANG', 'LC_ALL'])

interface DiscoveryAuthority {
    readonly stackId: StackId
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly receipts: readonly string[]
    readonly kinds: readonly ReclaimResourceKind[]
    readonly selection: DockerSelection
    readonly selectionAuthority: object
    readonly startedAt: string
    readonly finishedAt: string
    readonly imagesInspected: boolean
    readonly volumesInspected: boolean
    readonly networksInspected: boolean
}

interface DockerSelection {
    readonly context: string
    readonly endpoint: string
}

interface DockerSelectionProbePlan {
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly context: string
    readonly steps: readonly ExecutionStep[]
    readonly host?: string
}

interface DockerSelectionAuthority {
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly selection: DockerSelection
    readonly receipts: readonly string[]
    readonly startedAt: string
    readonly finishedAt: string
}

interface ResetContinuationAuthority {
    readonly consentDigest: string
    readonly completedTargetId: string
    readonly issuedAt: string
    readonly runtimeDigest: string
    readonly targetIds: readonly string[]
    readonly removedTargetIds: readonly string[]
    readonly targetIdentities: readonly ReclaimTargetIdentity[]
}

interface TeardownContinuationAuthority {
    readonly discoveryDigest: string
    readonly completedTargetId: string
    readonly issuedAt: string
    readonly runtimeDigest: string
    readonly targetIds: readonly string[]
    readonly removedTargetIds: readonly string[]
    readonly targetIdentities: readonly ReclaimTargetIdentity[]
}

interface PendingTeardownAction {
    readonly step: ExecutionStep
    readonly target: ClassifiedReclaimResource
    readonly cache: DependencyCacheAuthority | undefined
    readonly coordinationRecord: StateRecord
    readonly planDigest: string
    readonly continuation: object
    readonly targetIds: readonly string[]
    readonly removedTargetIds: readonly string[]
    readonly targetIdentities: readonly ReclaimTargetIdentity[]
}

interface PendingResetAction {
    readonly step: ExecutionStep
    readonly target: ResetTargetAuthority
    readonly coordinationRecord: StateRecord
    readonly planDigest: string
    readonly continuation: object
    readonly targetIds: readonly string[]
    readonly removedTargetIds: readonly string[]
    readonly targetIdentities: readonly ReclaimTargetIdentity[]
}

interface PendingReclaimExecution {
    readonly step: ExecutionStep
    readonly targetId: string
    readonly reservation: DrainReservation
    readonly continuation: object
    readonly targetIds: readonly string[]
    readonly removedTargetIds: readonly string[]
    readonly attempt: NonNullable<DrainReservation['attempt']>
    readonly execution: ReclaimDrainExecutionAuthority
    readonly targetIdentities: readonly ReclaimTargetIdentity[]
}

interface PendingAbsentReclaimAction {
    readonly purpose: 'down' | 'reset'
    readonly stackId: StackId
    readonly configSha256: string
    readonly coordinationRecord: StateRecord
    readonly planDigest: string
    readonly runtime: DiscoveryAuthority
    readonly continuation: object
    readonly targetId: string
    readonly targetIds: readonly string[]
    readonly removedTargetIds: readonly string[]
    readonly targetIdentities: readonly ReclaimTargetIdentity[]
    readonly remainingTargets: (discovery: ReclaimDiscoverySnapshot) => Promise<readonly string[] | undefined>
}

function issueAbsentReclaimAction(input: Omit<PendingAbsentReclaimAction, 'continuation'>, runtimeDigest: string): object {
    const continuation = Object.freeze({})
    const common = Object.freeze({ completedTargetId: input.targetId, issuedAt: new Date().toISOString(), runtimeDigest,
        targetIds: input.targetIds, removedTargetIds: input.removedTargetIds, targetIdentities: input.targetIdentities })
    if (input.purpose === 'down') teardownContinuations.set(continuation, { ...common, discoveryDigest: input.planDigest })
    else resetContinuations.set(continuation, { ...common, consentDigest: input.planDigest })
    const authority = Object.freeze({})
    pendingAbsentReclaimActions.set(authority, Object.freeze({ ...input, continuation }))
    return authority
}

type ReclaimTargetIdentity = ResetVolumeTargetIdentity | TeardownRuntimeTargetIdentity | PathTargetIdentity

interface ResetVolumeTargetIdentity {
    readonly medium: 'runtime'
    readonly scope: 'reset-volume'
    readonly targetId: string
    readonly kind: 'volume'
    readonly declaration: string
    readonly runtimeId: string
    readonly name: string
    readonly labels: Readonly<Record<string, string>>
    readonly generation: string
}

interface TeardownRuntimeTargetIdentity {
    readonly medium: 'runtime'
    readonly scope: 'teardown-runtime'
    readonly targetId: string
    readonly kind: Exclude<ReclaimResourceKind, 'cache'>
    readonly runtimeId: string
    readonly name: string
    readonly labels: Readonly<Record<string, string>>
    readonly referenced: boolean
    readonly dataBearing: boolean | null
    readonly generation: string | null
}

interface PathTargetIdentity {
    readonly medium: 'path'
    readonly targetId: string
    readonly kind: 'host-path' | 'cache'
    readonly declaration: string
    readonly root: string
    readonly path: string
    readonly type: 'directory' | 'file'
    readonly dev: number
    readonly ino: number
    readonly birthtimeNs: string
    readonly ancestors: readonly FilesystemAncestorIdentity[]
}

export type ReclaimResourceKind = 'container' | 'network' | 'volume' | 'image' | 'build-cache' | 'cache'
export type OwnershipEvidence = 'current' | 'stale-config' | 'foreign' | 'unknown' | 'malformed' | 'partial' | 'unlabelled'
export type Reversibility = 'runtime' | 'regenerable-cache' | 'data-bearing'
export type ReclaimAction = 'teardown' | 'reclaim' | 'reset-required' | 'report-only'

export interface ReclaimResource {
    readonly id: string
    readonly name: string
    readonly kind: ReclaimResourceKind
    readonly labels: Readonly<Record<string, string>>
    readonly referenced: boolean
    readonly bytes: number | null
    readonly dataBearing?: boolean
    readonly generation?: string
}

export interface ReclaimDiscoverySnapshot {
    readonly observedAt: string
    readonly producer: 'runtime-resource-discovery'
    readonly resources: readonly ReclaimResource[]
}

export interface ClassifiedReclaimResource extends ReclaimResource {
    readonly ownership: OwnershipEvidence
    readonly reversibility: Reversibility
    readonly action: ReclaimAction
    readonly evidence: readonly string[]
    readonly reason: string
    readonly suggestion?: { readonly command: string; readonly risk: string }
}

export interface ClassifyReclaimInput {
    readonly stackId: StackId
    readonly cockpitId: CockpitId
    readonly configSha256: string
    readonly coordinationRecord: StateRecord | null
    readonly declaredCacheIds: readonly string[]
    readonly discovery: ReclaimDiscoverySnapshot
}

export type ReclaimResult =
    | { readonly kind: 'complete'; readonly noop: boolean; readonly resources: readonly ClassifiedReclaimResource[] }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

function diagnostic(code: EnvironmentCode, message: string, target: string, fix?: string): EnvironmentDiagnostic {
    return Object.freeze({ severity: 'error', code, message, target, ...(fix ? { fix } : {}) })
}

function refuse(code: EnvironmentCode, message: string, target: string, fix?: string): ReclaimResult {
    return Object.freeze({ kind: 'refusal', diagnostics: Object.freeze([diagnostic(code, message, target, fix)]) })
}

function exactKeys(value: object, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const expected = [...keys].sort()
    return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function lexical(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function snapshotResource(value: unknown): ReclaimResource | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const candidate = value as Partial<ReclaimResource>
    const keys = [
        'id', 'name', 'kind', 'labels', 'referenced', 'bytes',
        ...(candidate.dataBearing === undefined ? [] : ['dataBearing']),
        ...(candidate.generation === undefined ? [] : ['generation']),
    ]
    if (!exactKeys(value, keys)
        || typeof candidate.id !== 'string' || !RESOURCE_ID.test(candidate.id)
        || typeof candidate.name !== 'string' || candidate.name.length === 0 || candidate.name.length > 512 || candidate.name.includes('\0')
        || !['container', 'network', 'volume', 'image', 'build-cache', 'cache'].includes(candidate.kind as string)
        || candidate.labels === null || typeof candidate.labels !== 'object' || Array.isArray(candidate.labels)
        || Object.keys(candidate.labels).length > 64
        || Object.entries(candidate.labels).some(([key, item]) => key.length === 0 || key.length > 256 || key.includes('\0')
            || typeof item !== 'string' || item.length > 512 || item.includes('\0'))
        || typeof candidate.referenced !== 'boolean'
        || candidate.bytes !== null && (!Number.isSafeInteger(candidate.bytes) || (candidate.bytes as number) < 0)
        || candidate.dataBearing !== undefined && typeof candidate.dataBearing !== 'boolean'
        || candidate.generation !== undefined && (candidate.kind !== 'volume' || typeof candidate.generation !== 'string'
            || candidate.generation.length === 0 || candidate.generation.length > 128 || candidate.generation.includes('\0'))) return undefined
    return Object.freeze({
        id: candidate.id,
        name: candidate.name,
        kind: candidate.kind as ReclaimResourceKind,
        labels: Object.freeze({ ...candidate.labels }),
        referenced: candidate.referenced,
        bytes: candidate.bytes as number | null,
        ...(candidate.dataBearing === undefined ? {} : { dataBearing: candidate.dataBearing }),
        ...(candidate.generation === undefined ? {} : { generation: candidate.generation }),
    })
}

function snapshotClassificationInput(value: unknown): {
    stackId: StackId
    cockpitId: CockpitId
    configSha256: string
    coordinationRecord: StateRecord | null
    declaredCacheIds: readonly string[]
    discovery: ReclaimDiscoverySnapshot
} | undefined {
    const snapshot = snapshotJson(value)
    if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || !exactKeys(snapshot, ['stackId', 'cockpitId', 'configSha256', 'coordinationRecord', 'declaredCacheIds', 'discovery'])) return undefined
    const input = snapshot as Record<string, unknown>
    if (typeof input.stackId !== 'string' || !STACK_ID.test(input.stackId)
        || typeof input.cockpitId !== 'string' || !COCKPIT_ID.test(input.cockpitId)
        || typeof input.configSha256 !== 'string' || !SHA256.test(input.configSha256)
        || !Array.isArray(input.declaredCacheIds) || input.declaredCacheIds.length > MAX_RESOURCES
        || input.declaredCacheIds.some((id) => typeof id !== 'string' || !(BUILD_CACHE_ID.test(id) || SHA256.test(id)))
        || new Set(input.declaredCacheIds).size !== input.declaredCacheIds.length
        || input.discovery === null || typeof input.discovery !== 'object' || Array.isArray(input.discovery)
        || !exactKeys(input.discovery, ['observedAt', 'producer', 'resources'])) return undefined
    const discovery = input.discovery as Record<string, unknown>
    if (typeof discovery.observedAt !== 'string' || !isCanonicalTimestamp(discovery.observedAt)
        || discovery.producer !== 'runtime-resource-discovery'
        || !Array.isArray(discovery.resources) || discovery.resources.length > MAX_RESOURCES) return undefined
    const resources = discovery.resources.map(snapshotResource)
    if (resources.some((item) => item === undefined)) return undefined
    const ids = resources.map((item) => item!.id)
    if (new Set(ids).size !== ids.length) return undefined
    const coordinationRecord = input.coordinationRecord
    if (coordinationRecord !== null) {
        if (typeof coordinationRecord !== 'object' || Array.isArray(coordinationRecord)) return undefined
        const record = coordinationRecord as Record<string, unknown>
        if (!exactKeys(record, ['format', 'kind', 'cockpitId', 'subjectId', 'revision', 'updatedAt', 'value'])
            || record.format !== 'cockpit-state/v1' || record.kind !== 'coordination'
            || record.cockpitId !== input.cockpitId || record.subjectId !== input.stackId
            || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
            || typeof record.updatedAt !== 'string' || !isCanonicalTimestamp(record.updatedAt)) return undefined
    }
    return Object.freeze({
        stackId: input.stackId as StackId,
        cockpitId: input.cockpitId as CockpitId,
        configSha256: input.configSha256,
        coordinationRecord: coordinationRecord as StateRecord | null,
        declaredCacheIds: Object.freeze([...input.declaredCacheIds]) as readonly string[],
        discovery: Object.freeze({
            observedAt: discovery.observedAt,
            producer: 'runtime-resource-discovery' as const,
            resources: Object.freeze(resources as ReclaimResource[]),
        }),
    })
}

function labelOwnership(
    resource: ReclaimResource,
    input: ReturnType<typeof snapshotClassificationInput> & object,
    positiveState: boolean,
): { ownership: OwnershipEvidence; evidence: readonly string[]; reason: string } {
    const present = Object.values(REQUIRED_LABELS).filter((name) => Object.hasOwn(resource.labels, name))
    const exactCache = input.declaredCacheIds.includes(resource.id) && resource.name === resource.id
        && (resource.kind === 'build-cache' && BUILD_CACHE_ID.test(resource.id) || resource.kind === 'cache' && SHA256.test(resource.id))
    if (present.length === 0) {
        return exactCache
            ? { ownership: 'unknown', evidence: ['exact declared cache identity; ownership labels absent'], reason: 'the exact declared cache has no current ownership evidence' }
            : { ownership: 'unlabelled', evidence: ['all required ownership labels absent'], reason: 'the resource carries no ownership labels' }
    }
    if (present.length !== Object.keys(REQUIRED_LABELS).length) {
        return { ownership: 'partial', evidence: [`${present.length} of 3 required ownership labels present`], reason: 'partial labels cannot establish ownership' }
    }
    const stack = resource.labels[REQUIRED_LABELS.stack]!
    const config = resource.labels[REQUIRED_LABELS.config]!
    const owner = resource.labels[REQUIRED_LABELS.owner]!
    if (!STACK_ID.test(stack) || !SHA256.test(config) || !COCKPIT_ID.test(owner)) {
        return { ownership: 'malformed', evidence: ['required label values failed their closed grammar'], reason: 'malformed labels cannot establish ownership' }
    }
    if (stack !== input.stackId || owner !== input.cockpitId) {
        return { ownership: 'foreign', evidence: [`stack=${stack}`, `owner=${owner}`], reason: 'the labels identify another stack or cockpit' }
    }
    if (!positiveState) {
        return { ownership: 'unknown', evidence: ['exact labels matched; coordinated state evidence absent'], reason: 'labels alone do not grant ownership' }
    }
    if (config !== input.configSha256) {
        return { ownership: 'stale-config', evidence: [`config=${config}`, `current=${input.configSha256}`], reason: 'this stack started the resource under an earlier configuration' }
    }
    return { ownership: 'current', evidence: ['exact stack, owner, and configuration labels matched coordinated state'], reason: 'positive labels and state identify the current stack' }
}

function reversibility(resource: ReclaimResource, declaredCacheIds: readonly string[]): Reversibility {
    if (declaredCacheIds.includes(resource.id) && resource.name === resource.id
        && (resource.kind === 'build-cache' && BUILD_CACHE_ID.test(resource.id) || resource.kind === 'cache' && SHA256.test(resource.id))) return 'regenerable-cache'
    if (resource.dataBearing === true || resource.kind === 'volume') return 'data-bearing'
    return 'runtime'
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`
}

function suggestion(resource: ReclaimResource, ownership: OwnershipEvidence): { command: string; risk: string } | undefined {
    if (resource.kind === 'build-cache' || resource.kind === 'cache') return undefined
    const noun = resource.kind === 'image' ? 'image' : resource.kind
    return Object.freeze({
        command: `docker ${noun} rm -- ${shellQuote(resource.id)}`,
        risk: `${ownership} ${resource.kind} is not owned for automatic removal; verify its consumers before running this exact command`,
    })
}

export function classifyReclaim(rawInput: ClassifyReclaimInput): ReclaimResult {
    const input = snapshotClassificationInput(rawInput)
    if (input === undefined) return refuse(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reclaim discovery input is malformed or exceeds its bounds', 'reclaim-discovery')
    const decoded = input.coordinationRecord === null ? undefined : decodeCoordinationRecord(input.coordinationRecord, input.stackId)
    if (input.coordinationRecord !== null && (decoded === undefined || input.coordinationRecord.cockpitId !== input.cockpitId)) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination evidence does not match the requested stack and cockpit', input.stackId)
    }
    const positiveState = decoded !== undefined
    const resources = input.discovery.resources.map((resource): ClassifiedReclaimResource => {
        const evidence = labelOwnership(resource, input, positiveState)
        const reverse = reversibility(resource, input.declaredCacheIds)
        const exactUnknownCache = (resource.kind === 'build-cache' || resource.kind === 'cache') && evidence.ownership === 'unknown'
            && reverse === 'regenerable-cache' && !resource.referenced
        // The stack and owner labels are the stack's stable identity; the configuration label only
        // records which cockpit.toml started the resource. Keeping a container or network an earlier
        // configuration started made `down` after an edited cockpit.toml report the stack removed
        // while it stayed. Its data stays out of teardown's reach: only a declared `reset` removes it.
        const action: ReclaimAction = resource.referenced ? 'report-only' : evidence.ownership === 'current'
            ? reverse === 'data-bearing' ? 'reset-required'
                : reverse === 'regenerable-cache' ? 'reclaim' : 'teardown'
            : evidence.ownership === 'stale-config' && reverse === 'runtime' ? 'teardown'
            : exactUnknownCache ? 'reclaim' : 'report-only'
        return Object.freeze({
            ...resource,
            ownership: evidence.ownership,
            reversibility: reverse,
            action,
            evidence: Object.freeze([...evidence.evidence]),
            reason: evidence.reason,
            ...(action === 'report-only' ? { suggestion: suggestion(resource, evidence.ownership) } : {}),
        })
    }).sort((left, right) => lexical(left.id, right.id))
    return Object.freeze({ kind: 'complete', noop: resources.length === 0, resources: Object.freeze(resources) })
}

export interface KeptTeardownResource {
    readonly kind: ReclaimResourceKind
    readonly id: string
    readonly name: string
    readonly reason: string
}

/**
 * The resources a finished `down` leaves behind although this stack's labels and coordinated state
 * show they are its own, each with the reason teardown may not remove it. Volumes are left out:
 * `down` keeps data by design, and only `reset` deletes it.
 */
export function keptTeardownResources(input: ClassifyReclaimInput): readonly KeptTeardownResource[] | undefined {
    const classified = classifyReclaim(reclaimInput(input))
    if (classified.kind !== 'complete') return undefined
    return Object.freeze(classified.resources
        .filter(({ kind, ownership, action }) => kind !== 'volume' && action === 'report-only'
            && (ownership === 'current' || ownership === 'stale-config'))
        .map(({ kind, id, name, referenced, reason }) => Object.freeze({
            kind, id, name,
            reason: !referenced ? reason
                : kind === 'network' ? 'a container outside this stack is still attached to it'
                    : kind === 'image' ? 'it is tagged under more than one name, so another name may still need it'
                        : 'something outside this stack still uses it',
        })))
}

export interface ReclaimDiscoveryPlanInput {
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly stackId: StackId
    readonly cockpitId: CockpitId
    readonly timeoutMs: number
    readonly selectionAuthority: object
}

function safeEnvironment(value: unknown): Readonly<Record<string, string>> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const entries = Object.entries(value)
    if (entries.some(([key, item]) => !key || key.includes('\0') || key.includes('=') || DAEMON_ENV.test(key)
        || typeof item !== 'string' || item.includes('\0'))) return undefined
    return Object.freeze(Object.fromEntries(entries.filter(([key]) => SAFE_ENV.has(key)).sort(([a], [b]) => lexical(a, b))))
}

export interface DockerSelectionProbeInput {
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly context: string
    /** A local DOCKER_HOST, selected through Docker's `default` context, which reports it exactly. */
    readonly host?: string
}

const contextSelectionFormat = '{"context":{{json .Name}},"endpoint":{{json .Endpoints.docker.Host}}}'

export function createDockerSelectionSteps(rawInput: DockerSelectionProbeInput): readonly ExecutionStep[] | undefined {
    const captured = captureDataInput(rawInput)?.value
    if (captured === null || typeof captured !== 'object' || Array.isArray(captured)) return undefined
    const input = captured as unknown as DockerSelectionProbeInput
    const executable = resolvedDockerExecutable(input.executable)
    const env = safeEnvironment(input.env)
    const host = input.host
    if (executable === undefined || env === undefined || !DOCKER_SELECTOR.test(input.context)
        || host !== undefined && (admitLocalDockerEndpoint(host) === undefined || input.context !== 'default')
        || !validExecutionInput(executable, input.cwd, input.env, input.timeoutMs)) return undefined
    // Only the selection reads DOCKER_HOST; discovery and actions address the admitted endpoint
    // with --host, so the rest of the plan keeps a daemon-free environment.
    const selectionEnv = host === undefined ? env : Object.freeze({ ...env, DOCKER_HOST: host })
    const steps = Object.freeze([
        exactStep('runtime:select:context', [executable.canonicalPath, 'context', 'inspect', input.context, '--format', contextSelectionFormat],
            executable, input.cwd, selectionEnv, input.timeoutMs, [], { selectionKind: 'context' }),
    ])
    if (steps.some((step) => step === undefined)) return undefined
    const complete = steps as readonly ExecutionStep[]
    selectionProbePlans.set(complete, Object.freeze({
        executable, cwd: input.cwd, env,
        context: input.context, steps: complete,
        ...(host === undefined ? {} : { host }),
    }))
    return complete
}

function selectionRow(bytes: Buffer): Record<string, unknown> | undefined {
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) return undefined
    try {
        const parsed: unknown = JSON.parse(text.trim())
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    } catch {
        // Unparseable docker output is unproven; the caller refuses the discovery.
        return undefined
    }
}

export function admitDockerSelection(
    steps: readonly ExecutionStep[],
    evidence: readonly { readonly step: ExecutionStep; readonly outcome: ExecuteProbeOutcome }[],
): object | undefined {
    try {
        const plan = selectionProbePlans.get(steps)
        if (plan === undefined || consumedSelectionProbePlans.has(steps) || evidence.length !== 1) return undefined
        const receipts: string[] = []
        let startedAt = ''
        let finishedAt = ''
        const rows: Record<string, unknown>[] = []
        for (let index = 0; index < plan.steps.length; index += 1) {
            const expected = plan.steps[index]!
            const item = evidence[index]!
            if (item.step !== expected) return undefined
            const admitted = authenticatedExecutionOutcome(item.outcome, expected)
            if (admitted === undefined || admitted.kind !== 'complete' || admitted.stderr.byteLength !== 0) return undefined
            const row = selectionRow(admitted.stdout)
            if (row === undefined) return undefined
            rows.push(row)
            startedAt = startedAt === '' || lexical(admitted.receipt.startedAt, startedAt) < 0 ? admitted.receipt.startedAt : startedAt
            finishedAt = lexical(admitted.receipt.finishedAt, finishedAt) > 0 ? admitted.receipt.finishedAt : finishedAt
            receipts.push(digestValue({ step: expected.id, receipt: admitted.receipt, stdout: createHash('sha256').update(admitted.stdout).digest('hex') }))
        }
        const [context] = rows
        if (context === undefined || !exactKeys(context, ['context', 'endpoint'])
            || context.context !== plan.context
            || typeof context.endpoint !== 'string' || admitLocalDockerEndpoint(context.endpoint) === undefined
            || plan.host !== undefined && context.endpoint !== plan.host
            || !isCanonicalTimestamp(startedAt) || !isCanonicalTimestamp(finishedAt)
            || Date.parse(finishedAt) < Date.parse(startedAt) || Date.parse(finishedAt) - Date.parse(startedAt) > 30_000) return undefined
        const token = Object.freeze({ kind: 'docker-selection' })
        selectionAuthorities.set(token, Object.freeze({
            executable: plan.executable, cwd: plan.cwd, env: plan.env,
            selection: Object.freeze({ context: plan.context, endpoint: context.endpoint }),
            receipts: Object.freeze(receipts.sort(lexical)), startedAt, finishedAt,
        }))
        consumedSelectionProbePlans.add(steps)
        return token
    } catch {
        // Any failure leaves the authority unminted; the caller refuses a missing authority.
        return undefined
    }
}

// Ownership is label-based: a resource without this stack's label is never removed, so listing the
// rest of a shared daemon only cost time. Listing and inspecting every container, image and volume
// on a daemon with a hundred unrelated containers made each `down` observation take seconds, and
// `container ls --size` alone ran past the step timeout. Volumes stay unfiltered because a reset
// refuses when a declared volume name belongs to something this stack does not own, and an
// unlabelled volume of that name would otherwise be invisible; their inspection is still scoped.
function runtimeCommand(kind: Exclude<ReclaimResourceKind, 'cache'>, selection: DockerSelection, stackId: string): readonly string[] {
    if (kind === 'build-cache') return ['--host', selection.endpoint, 'builder', 'du', '--format', 'json']
    const prefix = ['--host', selection.endpoint]
    const owned = ['--filter', `label=${REQUIRED_LABELS.stack}=${stackId}`]
    const command = kind === 'container' ? ['container', 'ls', '--all', '--no-trunc', ...owned]
        : kind === 'volume' ? ['volume', 'ls'] : kind === 'image' ? ['image', 'ls', '--all', '--no-trunc', ...owned] : [kind, 'ls', '--no-trunc', ...owned]
    return [...prefix, ...command, '--format', discoveryFormat(kind)]
}

function discoveryFormat(kind: Exclude<ReclaimResourceKind, 'build-cache'>): string {
    const id = kind === 'volume' ? '{{json .Name}}' : '{{json .ID}}'
    const name = kind === 'container' ? '{{json .Names}}' : kind === 'image' ? '{{json .Repository}}' : '{{json .Name}}'
    const label = (key: string) => `{{json (.Label "${key}")}}`
    // Without `--size` a container prints a misleading "0B (virtual ...)", so its size is unmeasured.
    const bytes = kind === 'network' || kind === 'container' ? 'null' : '{{json .Size}}'
    const labels = kind === 'image' ? '{}' : `{${listedLabels(kind).map((key) => `"${key}":${label(key)}`).join(',')}}`
    return `{"id":${id},"name":${name},"labels":${labels},"referenced":false,"bytes":${bytes}}`
}

function listedLabels(kind?: ReclaimResourceKind): readonly string[] {
    return [...Object.values(REQUIRED_LABELS), ...kind === 'volume' ? Object.values(COMPOSE_LABELS) : []]
}

function dockerLabels(value: unknown, kind?: ReclaimResourceKind): Readonly<Record<string, string>> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const labels: Record<string, string> = {}
    const allowed = new Set<string>(listedLabels(kind))
    if (Object.keys(value).some((key) => !allowed.has(key))) return undefined
    for (const [key, labelValue] of Object.entries(value)) {
        if (typeof labelValue !== 'string' || labelValue.length > 512 || labelValue.includes('\0')) return undefined
        if (labelValue !== '') labels[key] = labelValue
    }
    return Object.freeze(labels)
}

function dockerBytes(value: unknown, allowVirtualSize = false): number | null | undefined {
    if (value === undefined || value === null || value === '' || value === 'N/A') return null
    if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number
    if (typeof value !== 'string') return undefined
    if (/^\d+$/.test(value)) {
        const bytes = Number(value)
        return Number.isSafeInteger(bytes) ? bytes : undefined
    }
    const match = /^(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)(?: \(virtual \d+(?:\.\d+)?\s*(?:B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)\))?$/.exec(value)
    if (!allowVirtualSize && value.includes('(virtual ')) return undefined
    if (!match) return undefined
    const powers: Record<string, number> = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }
    // Docker prints rounded decimal sizes ("1.029GB"), and scaling the decimal is inexact in floating
    // point (1028999999.9999999), so round to whole bytes; the printed value is already approximate.
    const bytes = Math.round(Number(match[1]) * powers[match[2]!]!)
    return Number.isSafeInteger(bytes) ? bytes : undefined
}

function dockerResource(value: unknown, kind: Exclude<ReclaimResourceKind, 'cache'>): ReclaimResource | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const row = value as Record<string, unknown>
    if (kind === 'build-cache') {
        const id = row.ID
        const reclaimable = row.Reclaimable
        const bytes = dockerBytes(row.Size)
        return typeof id === 'string' && (reclaimable === true || reclaimable === false || reclaimable === 'true' || reclaimable === 'false')
            && bytes !== undefined
            ? snapshotResource({ id, name: id, kind, labels: {}, referenced: reclaimable === false || reclaimable === 'false', bytes })
            : undefined
    }
    if (!exactKeys(row, ['id', 'name', 'labels', 'referenced', 'bytes'])) return undefined
    const id = row.id
    const name = row.name
    const labels = kind === 'image'
        ? row.labels !== null && typeof row.labels === 'object' && !Array.isArray(row.labels) && exactKeys(row.labels, []) ? Object.freeze({}) : undefined
        : dockerLabels(row.labels, kind)
    const bytes = dockerBytes(row.bytes, kind === 'container')
    const referenced = kind === 'image' ? typeof row.referenced === 'boolean' ? row.referenced : undefined : row.referenced
    return typeof id === 'string' && typeof name === 'string' && labels !== undefined && bytes !== undefined && typeof referenced === 'boolean'
        ? snapshotResource({
            id, name, kind, labels, referenced, bytes,
            ...(kind === 'volume' ? { dataBearing: true } : {}),
        })
        : undefined
}

function inspectionSteps(
    authority: DiscoveryAuthority,
    type: 'image' | 'volume' | 'network' | 'container',
    format: string,
    ids: readonly string[],
    labels: Readonly<Record<string, string>>,
): readonly (ExecutionStep | undefined)[] {
    const steps: (ExecutionStep | undefined)[] = []
    for (let start = 0; start < ids.length; start += INSPECTION_CHUNK) {
        const chunk = ids.slice(start, start + INSPECTION_CHUNK)
        steps.push(exactStep(
            `runtime:inspect:${labels.resourceKind}:${digestValue(chunk).slice(0, 16)}`,
            [authority.executable.canonicalPath, '--host', authority.selection.endpoint, type, 'inspect', '--format', format, ...chunk],
            authority.executable, authority.cwd, authority.env, 30_000, [],
            { ...labels, resourceCount: String(chunk.length) }, [], chunk.length * INSPECTION_OBJECT_BUDGET,
        ))
    }
    return steps
}

function inspectedIds(step: ExecutionStep): readonly string[] {
    return step.argv.slice(INSPECTION_ARGV_PREFIX)
}

/** One parsed row per inspected id, in argument order; any missing, extra or oversized row fails the chunk. */
function inspectionRows(stdout: Buffer, ids: readonly string[]): readonly Record<string, unknown>[] | undefined {
    const text = stdout.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(stdout)) return undefined
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
    if (lines.length !== ids.length) return undefined
    const rows: Record<string, unknown>[] = []
    for (const line of lines) {
        if (Buffer.byteLength(line) > INSPECTION_OBJECT_BUDGET) return undefined
        // Unparseable docker output is unproven; the caller refuses the discovery.
        const row = tryParseJson(line)
        if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
        rows.push(row as Record<string, unknown>)
    }
    return rows
}

/**
 * Name an inspection chunk that the per-object budget cannot hold, so the operator learns which
 * resources to look at instead of a generic unobservable precondition.
 */
export function inspectionOverflow(step: ExecutionStep, outcome: ExecuteProbeOutcome): string | undefined {
    if (!step.id.startsWith('runtime:inspect:')) return undefined
    const ids = inspectedIds(step)
    const oversized = outcome.kind === 'refusal' && outcome.code === ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT
        || outcome.kind === 'complete' && outcome.stdout.toString('utf8').split('\n').some((line) => Buffer.byteLength(line) > INSPECTION_OBJECT_BUDGET)
    if (!oversized) return undefined
    return `docker ${step.argv[3]} inspect printed more than ${INSPECTION_OBJECT_BUDGET} bytes for one of ${ids.length} resources `
        + `(${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', ...' : ''}); inspect them and remove or relabel the oversized one`
}

function imageInspectionFormat(): string {
    const label = (key: string) => `{{json (or (index . "${key}") "")}}`
    return `{"id":{{json .Id}},"labels":{{with (index .Config "Labels")}}{"${REQUIRED_LABELS.stack}":${label(REQUIRED_LABELS.stack)},"${REQUIRED_LABELS.config}":${label(REQUIRED_LABELS.config)},"${REQUIRED_LABELS.owner}":${label(REQUIRED_LABELS.owner)}}{{else}}{}{{end}}}`
}

export function createImageInspectionSteps(discovery: ReclaimDiscoverySnapshot): readonly ExecutionStep[] | undefined {
    const authority = discoveryAuthorities.get(discovery)
    if (!admittedDiscoveries.has(discovery) || authority === undefined || authority.kinds.length !== 1 || authority.kinds[0] !== 'image') return undefined
    const images = discovery.resources.filter(({ kind }) => kind === 'image').map(({ id }) => id)
    const steps = inspectionSteps(authority, 'image', imageInspectionFormat(), images, {
        resourceKind: 'image-inspection', dockerContext: authority.selection.context, dockerEndpoint: authority.selection.endpoint,
    })
    return steps.every((step) => step !== undefined) ? Object.freeze(steps as ExecutionStep[]) : undefined
}

export function admitImageInspections(
    discovery: ReclaimDiscoverySnapshot,
    evidence: readonly { readonly step: ExecutionStep; readonly outcome: ExecuteProbeOutcome }[],
): ReclaimDiscoverySnapshot | undefined {
    try {
        const authority = discoveryAuthorities.get(discovery)
        const steps = createImageInspectionSteps(discovery)
        if (authority === undefined || steps === undefined || !Array.isArray(evidence) || evidence.length !== steps.length) return undefined
        const labels = new Map<string, Readonly<Record<string, string>>>()
        const receipts = [...authority.receipts]
        let finishedAt = authority.finishedAt
        for (let index = 0; index < steps.length; index += 1) {
            const expected = steps[index]!
            const item = evidence[index]!
            if (digestValue(item.step) !== digestValue(expected)) return undefined
            const admitted = authenticatedExecutionOutcome(item.outcome, expected)
            if (admitted === undefined || admitted.kind !== 'complete' || admitted.stderr.byteLength !== 0) return undefined
            const ids = inspectedIds(expected)
            const rows = inspectionRows(admitted.stdout, ids)
            if (rows === undefined) return undefined
            for (const [position, record] of rows.entries()) {
                const resourceId = ids[position]!
                const observedLabels = exactKeys(record, ['id', 'labels']) ? dockerLabels(record.labels) : undefined
                if (record.id !== resourceId || observedLabels === undefined || labels.has(resourceId)) return undefined
                labels.set(resourceId, observedLabels)
            }
            finishedAt = lexical(finishedAt, admitted.receipt.finishedAt) < 0 ? admitted.receipt.finishedAt : finishedAt
            receipts.push(digestValue({ step: expected.id, receipt: admitted.receipt, stdout: createHash('sha256').update(admitted.stdout).digest('hex') }))
        }
        const snapshot = Object.freeze({
            observedAt: finishedAt, producer: 'runtime-resource-discovery' as const,
            resources: Object.freeze(discovery.resources.map((resource) => snapshotResource({ ...resource, labels: labels.get(resource.id) ?? resource.labels })!)),
        })
        admittedDiscoveries.add(snapshot)
        discoveryAuthorities.set(snapshot, Object.freeze({
            ...authority, receipts: Object.freeze(receipts.sort(lexical)), finishedAt, imagesInspected: true,
        }))
        return snapshot
    } catch {
        // Any failure leaves the authority unminted; the caller refuses a missing authority.
        return undefined
    }
}

export function createVolumeInspectionSteps(discovery: ReclaimDiscoverySnapshot): readonly ExecutionStep[] | undefined {
    const authority = discoveryAuthorities.get(discovery)
    if (!admittedDiscoveries.has(discovery) || authority === undefined || authority.kinds.length !== 1 || authority.kinds[0] !== 'volume') return undefined
    // Only a volume this stack labels can become a target, so only its generation is read.
    const owned = discovery.resources.filter(({ labels }) => labels[REQUIRED_LABELS.stack] === authority.stackId)
    const steps = inspectionSteps(authority, 'volume',
        `{"name":{{json .Name}},"generation":{{with .Labels}}{{json (or (index . "dev.b0dea.cockpit.generation-id") "")}}{{else}}""{{end}}}`,
        owned.map(({ id }) => id), { resourceKind: 'volume-inspection' })
    return steps.every((step) => step !== undefined) ? Object.freeze(steps as ExecutionStep[]) : undefined
}

export function admitVolumeInspections(
    discovery: ReclaimDiscoverySnapshot,
    evidence: readonly { readonly step: ExecutionStep; readonly outcome: ExecuteProbeOutcome }[],
): ReclaimDiscoverySnapshot | undefined {
    try {
        const authority = discoveryAuthorities.get(discovery)
        const steps = createVolumeInspectionSteps(discovery)
        if (authority === undefined || steps === undefined || evidence.length !== steps.length) return undefined
        const generations = new Map<string, string>()
        const receipts = [...authority.receipts]
        let finishedAt = authority.finishedAt
        for (let index = 0; index < steps.length; index += 1) {
            const expected = steps[index]!
            const item = evidence[index]!
            if (digestValue(item.step) !== digestValue(expected)) return undefined
            const admitted = authenticatedExecutionOutcome(item.outcome, expected)
            if (admitted === undefined || admitted.kind !== 'complete' || admitted.stderr.byteLength !== 0) return undefined
            const ids = inspectedIds(expected)
            const rows = inspectionRows(admitted.stdout, ids)
            if (rows === undefined) return undefined
            for (const [position, record] of rows.entries()) {
                if (!exactKeys(record, ['name', 'generation'])) return undefined
                const { name, generation } = record
                if (name !== ids[position] || typeof generation !== 'string'
                    || generation.length > 128 || generation.includes('\0') || generations.has(name)) return undefined
                if (generation !== '' && !SHA256.test(generation)) return undefined
                generations.set(name, generation)
            }
            finishedAt = lexical(finishedAt, admitted.receipt.finishedAt) < 0 ? admitted.receipt.finishedAt : finishedAt
            receipts.push(digestValue({ step: expected.id, receipt: admitted.receipt, stdout: createHash('sha256').update(admitted.stdout).digest('hex') }))
        }
        const snapshot = Object.freeze({
            observedAt: finishedAt, producer: 'runtime-resource-discovery' as const,
            resources: Object.freeze(discovery.resources.map((resource) => {
                const generation = generations.get(resource.id)
                return snapshotResource({ ...resource, ...(generation === undefined || generation === '' ? {} : { generation }) })!
            })),
        })
        admittedDiscoveries.add(snapshot)
        discoveryAuthorities.set(snapshot, Object.freeze({
            ...authority, receipts: Object.freeze(receipts.sort(lexical)), finishedAt, volumesInspected: true,
        }))
        return snapshot
    } catch {
        // Any failure leaves the authority unminted; the caller refuses a missing authority.
        return undefined
    }
}

// Members are the attached endpoint ids, so a network can be told apart from the containers that
// hold it; container ids are hex, so the space-separated list is a safe JSON string.
function networkInspectionFormat(): string {
    return '{"id":{{json .Id}},"members":"{{range $member, $endpoint := .Containers}}{{$member}} {{end}}"}'
}

// A container that carries the network's exact ownership triple belongs to the same stack, so the
// teardown that may remove the network removes that container first (containers sort before
// networks). Counting such containers as references left every stack's own network behind after
// `down`. Any other holder, or one discovery did not see, still keeps the network.
function sameStackHolder(network: ReclaimResource, container: ReclaimResource | undefined): boolean {
    return container !== undefined && Object.values(REQUIRED_LABELS).every((name) =>
        typeof network.labels[name] === 'string' && network.labels[name] === container.labels[name])
}

// Discovery lists only this stack's containers, so a foreign container that holds one of its
// networks is found by asking Docker for every container attached to that network by name. The
// name, not the id, is the filter because a created but never started container records its
// networks without an id, and the filter by id misses it.
function networkHolderFormat(): string {
    return '{"id":{{json .ID}},"networks":{{json .Networks}}}'
}

const NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

function networkHolderSteps(authority: DiscoveryAuthority, names: readonly string[], labels: Readonly<Record<string, string>>): readonly (ExecutionStep | undefined)[] {
    const steps: (ExecutionStep | undefined)[] = []
    for (let start = 0; start < names.length; start += INSPECTION_CHUNK) {
        const chunk = names.slice(start, start + INSPECTION_CHUNK)
        steps.push(exactStep(
            `runtime:network-holders:${digestValue(chunk).slice(0, 16)}`,
            [authority.executable.canonicalPath, '--host', authority.selection.endpoint, 'container', 'ls', '--all', '--no-trunc',
                ...chunk.flatMap((name) => ['--filter', `network=${name}`]), '--format', networkHolderFormat()],
            authority.executable, authority.cwd, authority.env, 30_000, [], { ...labels, networkCount: String(chunk.length) }, [], OUTPUT_LIMIT,
        ))
    }
    return steps
}

function matchingDiscoveryAuthorities(left: DiscoveryAuthority, right: DiscoveryAuthority): boolean {
    return left.selectionAuthority === right.selectionAuthority
        && JSON.stringify([left.stackId, left.executable, left.cwd, left.env, left.selection])
            === JSON.stringify([right.stackId, right.executable, right.cwd, right.env, right.selection])
}

function holderRows(stdout: Buffer): readonly { readonly id: string; readonly networks: readonly string[] }[] | undefined {
    const text = stdout.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(stdout)) return undefined
    const rows: { id: string; networks: string[] }[] = []
    for (const line of text.split('\n')) {
        if (line.length === 0) continue
        // Unparseable docker output is unproven; the caller refuses the discovery.
        const row = tryParseJson(line)
        if (row === null || typeof row !== 'object' || Array.isArray(row) || !exactKeys(row, ['id', 'networks'])) return undefined
        const { id, networks } = row as Record<string, unknown>
        if (typeof id !== 'string' || !RESOURCE_ID.test(id) || typeof networks !== 'string') return undefined
        const names = networks.split(',').filter(Boolean)
        if (names.length > MAX_RESOURCES || names.some((name) => !NETWORK_NAME.test(name))) return undefined
        rows.push({ id, networks: names })
    }
    return rows.length > MAX_RESOURCES || new Set(rows.map(({ id }) => id)).size !== rows.length ? undefined : rows
}

export function createNetworkInspectionSteps(
    discovery: ReclaimDiscoverySnapshot,
    containers: ReclaimDiscoverySnapshot,
): readonly ExecutionStep[] | undefined {
    const authority = discoveryAuthorities.get(discovery)
    const containerAuthority = discoveryAuthorities.get(containers)
    if (!admittedDiscoveries.has(discovery) || !admittedDiscoveries.has(containers)
        || authority === undefined || containerAuthority === undefined
        || authority.kinds.length !== 1 || authority.kinds[0] !== 'network'
        || containerAuthority.kinds.length !== 1 || containerAuthority.kinds[0] !== 'container'
        || !matchingDiscoveryAuthorities(authority, containerAuthority)) return undefined
    const selection = { dockerContext: authority.selection.context, dockerEndpoint: authority.selection.endpoint }
    const networkSteps = inspectionSteps(authority, 'network', networkInspectionFormat(),
        discovery.resources.map(({ id }) => id), { resourceKind: 'network-inspection', ...selection })
    const names = [...new Set(discovery.resources.map(({ name }) => name))].sort(lexical)
    if (names.some((name) => !NETWORK_NAME.test(name))) return undefined
    const containerSteps = networkHolderSteps(authority, names, { resourceKind: 'network-holder-listing', ...selection })
    const steps = [...networkSteps, ...containerSteps]
    return steps.every((step) => step !== undefined) ? Object.freeze(steps as ExecutionStep[]) : undefined
}

export function admitNetworkInspections(
    discovery: ReclaimDiscoverySnapshot,
    containers: ReclaimDiscoverySnapshot,
    evidence: readonly { readonly step: ExecutionStep; readonly outcome: ExecuteProbeOutcome }[],
): ReclaimDiscoverySnapshot | undefined {
    try {
        const authority = discoveryAuthorities.get(discovery)
        const containerAuthority = discoveryAuthorities.get(containers)
        const steps = createNetworkInspectionSteps(discovery, containers)
        if (authority === undefined || containerAuthority === undefined || steps === undefined
            || !Array.isArray(evidence) || evidence.length !== steps.length) return undefined
        const containersById = new Map(containers.resources.map((container) => [container.id, container]))
        const holders = new Map<string, Set<string>>()
        const inspectedNetworks = new Set<string>()
        const hold = (networkId: string, containerId: string) => {
            holders.set(networkId, (holders.get(networkId) ?? new Set()).add(containerId))
        }
        const receipts = [...authority.receipts, ...containerAuthority.receipts]
        let finishedAt = lexical(authority.finishedAt, containerAuthority.finishedAt) < 0
            ? containerAuthority.finishedAt : authority.finishedAt
        for (let index = 0; index < steps.length; index += 1) {
            const expected = steps[index]!
            const item = evidence[index]!
            if (digestValue(item.step) !== digestValue(expected)) return undefined
            const admitted = authenticatedExecutionOutcome(item.outcome, expected)
            if (admitted === undefined || admitted.kind !== 'complete' || admitted.stderr.byteLength !== 0) return undefined
            if (expected.labels.resourceKind === 'network-inspection') {
                const ids = inspectedIds(expected)
                const rows = inspectionRows(admitted.stdout, ids)
                if (rows === undefined) return undefined
                for (const [position, record] of rows.entries()) {
                    const resourceId = ids[position]!
                    if (!exactKeys(record, ['id', 'members']) || record.id !== resourceId
                        || typeof record.members !== 'string' || inspectedNetworks.has(resourceId)) return undefined
                    const members = record.members.split(' ').filter(Boolean)
                    if (members.length > MAX_RESOURCES || members.some((member) => !RESOURCE_ID.test(member))) return undefined
                    inspectedNetworks.add(resourceId)
                    for (const member of members) hold(resourceId, member)
                }
            } else {
                if (expected.labels.resourceKind !== 'network-holder-listing') return undefined
                const rows = holderRows(admitted.stdout)
                if (rows === undefined) return undefined
                for (const row of rows) {
                    // A created but never started container (as an interrupted Compose recreate leaves
                    // its replacement) still names its networks, so it holds every discovered network
                    // of that name; refusing the whole discovery left `down` unable to remove the
                    // stack that `up` had started.
                    for (const name of row.networks) {
                        for (const network of discovery.resources) if (network.name === name) hold(network.id, row.id)
                    }
                }
            }
            finishedAt = lexical(finishedAt, admitted.receipt.finishedAt) < 0 ? admitted.receipt.finishedAt : finishedAt
            receipts.push(digestValue({ step: expected.id, receipt: admitted.receipt, stdout: createHash('sha256').update(admitted.stdout).digest('hex') }))
        }
        const snapshot = Object.freeze({
            observedAt: finishedAt, producer: 'runtime-resource-discovery' as const,
            resources: Object.freeze(discovery.resources.map((resource) => snapshotResource({
                ...resource, referenced: [...holders.get(resource.id) ?? []].some((holder) => !sameStackHolder(resource, containersById.get(holder))),
            })!)),
        })
        admittedDiscoveries.add(snapshot)
        discoveryAuthorities.set(snapshot, Object.freeze({
            ...authority, receipts: Object.freeze(receipts.sort(lexical)), finishedAt, networksInspected: true,
        }))
        return snapshot
    } catch {
        // Any failure leaves the authority unminted; the caller refuses a missing authority.
        return undefined
    }
}

export function createReclaimDiscoverySteps(rawInput: ReclaimDiscoveryPlanInput): readonly ExecutionStep[] | undefined {
    const capturedInput = captureDataInput(rawInput)
    const captured = capturedInput?.value
    if (captured === null || typeof captured !== 'object' || Array.isArray(captured)) return undefined
    const input = captured as unknown as ReclaimDiscoveryPlanInput
    const rawAuthority = capturedInput!.opaque.selectionAuthority
    const executable = resolvedDockerExecutable(input.executable)
    const env = safeEnvironment(input.env)
    const authority = rawAuthority !== null && typeof rawAuthority === 'object'
        ? selectionAuthorities.get(rawAuthority) : undefined
    const selection = authority?.selection
    if (executable === undefined || !STACK_ID.test(input.stackId) || !COCKPIT_ID.test(input.cockpitId)
        || env === undefined || selection === undefined || authority === undefined
        || rawAuthority === null || typeof rawAuthority !== 'object' || consumedSelectionAuthorities.has(rawAuthority)
        || Object.hasOwn(captured, 'dockerContext') || Object.hasOwn(captured, 'dockerEndpoint') || Object.hasOwn(captured, 'buildxBuilder')
        || JSON.stringify([executable, input.cwd, env]) !== JSON.stringify([authority.executable, authority.cwd, authority.env])
        || !isAbsolute(input.cwd) || normalize(input.cwd) !== input.cwd
        || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000) return undefined
    const steps = (['container', 'network', 'volume', 'image', 'build-cache'] as const).map((kind) => {
        const argv = [executable.canonicalPath, ...runtimeCommand(kind, selection, input.stackId)] as [string, ...string[]]
        return snapshotExecutionStep({
            id: `runtime:discover:${kind}`,
            argv,
            argv0: executable.invocationPath,
            cwd: input.cwd,
            env,
            timeoutMs: input.timeoutMs,
            stdoutLimitBytes: OUTPUT_LIMIT,
            stderrLimitBytes: 65_536,
            paths: [],
            ports: [],
            labels: {
                stackId: input.stackId, cockpitId: input.cockpitId, resourceKind: kind,
                dockerContext: selection.context, dockerEndpoint: selection.endpoint,
            },
            expected: [],
            consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: executable.executionMode }],
            filesystemChecks: [],
            compensation: [],
        })
    })
    if (steps.some((step) => step === undefined)) return undefined
    consumedSelectionAuthorities.add(rawAuthority)
    for (let index = 0; index < steps.length; index += 1) plannedDiscoverySteps.set(steps[index]!, Object.freeze({ authority, kind: (['container', 'network', 'volume', 'image', 'build-cache'] as const)[index]! }))
    return Object.freeze(steps as ExecutionStep[])
}

export function admitReclaimDiscovery(
    step: ExecutionStep,
    outcome: ExecuteProbeOutcome,
    kind: Exclude<ReclaimResourceKind, 'cache'>,
    currentSelectionAuthority: object,
): ReclaimDiscoverySnapshot | undefined {
    try {
        const planned = plannedDiscoverySteps.get(step)
        if (planned === undefined || planned.kind !== kind || consumedPlannedDiscoverySteps.has(step)) return undefined
        const currentSelection = currentSelectionAuthority !== null && typeof currentSelectionAuthority === 'object'
            ? selectionAuthorities.get(currentSelectionAuthority) : undefined
        const executable = resolvedDockerExecutable({
            canonicalPath: step.argv[0], invocationPath: step.argv0,
            sha256: step.consumedFiles[0]?.sha256, executionMode: step.consumedFiles[0]?.executionMode,
        })
        const env = safeEnvironment(step.env)
        const selection = planned.authority.selection
        if (currentSelection === undefined || step.id !== `runtime:discover:${kind}` || step.labels.resourceKind !== kind
            || step.labels.stackId === undefined || !STACK_ID.test(step.labels.stackId)
            || step.labels.cockpitId === undefined || !COCKPIT_ID.test(step.labels.cockpitId)
            || executable === undefined || env === undefined || selection === undefined
            || JSON.stringify([currentSelection.executable, currentSelection.cwd, currentSelection.env, currentSelection.selection])
                !== JSON.stringify([planned.authority.executable, planned.authority.cwd, planned.authority.env, planned.authority.selection])
            || JSON.stringify(step.argv.slice(1)) !== JSON.stringify(runtimeCommand(kind, selection, step.labels.stackId))) return undefined
        const admitted = authenticatedExecutionOutcome(outcome, step)
        if (admitted === undefined || admitted.kind !== 'complete' || admitted.stderr.byteLength !== 0
            || Date.parse(currentSelection.startedAt) < Date.parse(admitted.receipt.finishedAt)
            || Date.parse(currentSelection.finishedAt) - Date.parse(admitted.receipt.finishedAt) > 30_000
            || Date.now() < Date.parse(currentSelection.finishedAt) || Date.now() - Date.parse(currentSelection.finishedAt) > 30_000) return undefined
        const text = admitted.stdout.toString('utf8')
        if (!Buffer.from(text, 'utf8').equals(admitted.stdout)) return undefined
        const resources: ReclaimResource[] = []
        for (const line of text.split('\n')) {
            if (line.length === 0) continue
            // Unparseable docker output is unproven; the caller refuses the discovery.
            const parsed = tryParseJson(line)
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
            const owned = dockerResource(parsed, kind)
            if (owned === undefined) return undefined
            // An image prints one row per tag. The one tag Compose gives an image it builds is this
            // stack's own name for it, so that image is removable; a second tag means some other name
            // was given to it, and that name may still be needed. Treating any tag as a reference
            // kept every image the stack built. A container still using an image keeps it by
            // Docker's own refusal to remove it.
            const duplicate = resources.find(({ id }) => id === owned.id)
            if (duplicate !== undefined && kind === 'image') {
                if (duplicate.bytes !== owned.bytes) return undefined
                resources.splice(resources.indexOf(duplicate), 1, Object.freeze({ ...duplicate, referenced: true, name: [duplicate.name, owned.name].sort(lexical)[0]! }))
                continue
            }
            resources.push(owned)
        }
        if (resources.length > MAX_RESOURCES || new Set(resources.map(({ id }) => id)).size !== resources.length) return undefined
        const snapshot = Object.freeze({ observedAt: admitted.receipt.finishedAt, producer: 'runtime-resource-discovery' as const, resources: Object.freeze(resources.sort((a, b) => lexical(a.id, b.id))) })
        admittedDiscoveries.add(snapshot)
        discoveryAuthorities.set(snapshot, Object.freeze({
            stackId: step.labels.stackId as StackId, executable, cwd: step.cwd, env, selection,
            selectionAuthority: currentSelectionAuthority,
            kinds: Object.freeze([kind]), startedAt: admitted.receipt.startedAt, finishedAt: admitted.receipt.finishedAt,
            imagesInspected: kind !== 'image',
            volumesInspected: kind !== 'volume',
            networksInspected: kind !== 'network',
            receipts: Object.freeze([...planned.authority.receipts, ...currentSelection.receipts, digestValue({
                step: step.id, executable, cwd: step.cwd, env,
                startedAt: admitted.receipt.startedAt, finishedAt: admitted.receipt.finishedAt,
                stdout: createHash('sha256').update(admitted.stdout).digest('hex'),
            })].sort(lexical)),
        }))
        consumedPlannedDiscoverySteps.add(step)
        return snapshot
    } catch {
        // Any failure leaves the authority unminted; the caller refuses a missing authority.
        return undefined
    }
}

export function combineReclaimDiscoveries(snapshots: readonly ReclaimDiscoverySnapshot[]): ReclaimDiscoverySnapshot | undefined {
    try {
        if (!Array.isArray(snapshots) || snapshots.length !== 5
            || snapshots.some((snapshot) => !admittedDiscoveries.has(snapshot) || discoveryAuthorities.get(snapshot) === undefined)) return undefined
        const resources = snapshots.flatMap(({ resources }) => resources).sort((left, right) => lexical(left.id, right.id))
        if (resources.length > MAX_RESOURCES || new Set(resources.map(({ id }) => id)).size !== resources.length) return undefined
        const authorities = snapshots.map((snapshot) => discoveryAuthorities.get(snapshot)!)
        const first = authorities[0]!
        const kinds = authorities.flatMap(({ kinds }) => kinds).sort(lexical)
        const expectedKinds = ['build-cache', 'container', 'image', 'network', 'volume']
        if (JSON.stringify(kinds) !== JSON.stringify(expectedKinds)
            || authorities.some(({ kinds: authorityKinds, imagesInspected }) => authorityKinds[0] === 'image' && !imagesInspected)
            || authorities.some(({ kinds: authorityKinds, volumesInspected }) => authorityKinds[0] === 'volume' && !volumesInspected)
            || authorities.some(({ kinds: authorityKinds, networksInspected }) => authorityKinds[0] === 'network' && !networksInspected)
            || authorities.some(({ selectionAuthority }) => selectionAuthority !== first.selectionAuthority)
            || authorities.some((item) => JSON.stringify([item.stackId, item.executable, item.cwd, item.env, item.selection])
                !== JSON.stringify([first.stackId, first.executable, first.cwd, first.env, first.selection]))) return undefined
        const startedAt = authorities.map(({ startedAt }) => startedAt).sort(lexical)[0]!
        const finishedAt = authorities.map(({ finishedAt }) => finishedAt).sort(lexical).at(-1)!
        if (Date.parse(finishedAt) - Date.parse(startedAt) > 30_000) return undefined
        const combined = Object.freeze({ observedAt: finishedAt, producer: 'runtime-resource-discovery' as const, resources: Object.freeze(resources) })
        admittedDiscoveries.add(combined)
        discoveryAuthorities.set(combined, Object.freeze({
            stackId: first.stackId, executable: first.executable, cwd: first.cwd, env: first.env, selection: first.selection,
            selectionAuthority: first.selectionAuthority,
            kinds: Object.freeze(kinds), startedAt, finishedAt,
            imagesInspected: true,
            volumesInspected: true,
            networksInspected: true,
            receipts: Object.freeze([...new Set(authorities.flatMap(({ receipts }) => receipts))].sort(lexical)),
        }))
        consumedSelectionAuthorities.add(first.selectionAuthority)
        return combined
    } catch {
        // Any failure leaves the authority unminted; the caller refuses a missing authority.
        return undefined
    }
}

export interface ResetTargetInput {
    readonly kind: 'container' | 'volume' | 'host-path'
    readonly identity: string
    readonly declaration: string
    readonly labels?: Readonly<Record<string, string>>
}

interface HostPathDeclaration {
    readonly root: string
    readonly path: string
    readonly declaration: string
}

interface HostPathEvidence {
    readonly state: 'present' | 'absent'
    readonly type?: 'directory' | 'file'
    readonly dev?: number
    readonly ino?: number
    readonly birthtimeNs?: string
    readonly mode?: number
    readonly size?: number
    readonly mtimeMs?: number
    readonly ancestors?: readonly FilesystemAncestorIdentity[]
}

export interface DependencyCacheDeclaration {
    readonly cacheId: string
    readonly root: string
    readonly path: string
}

interface DependencyCacheAuthority extends DependencyCacheDeclaration {
    readonly evidence: HostPathEvidence
}

type ResetTargetAuthority =
    | Omit<ResetTargetInput, 'kind'> & {
          readonly kind: 'host-path'
          readonly root: string
          readonly evidence: HostPathEvidence
      }
    | Omit<ResetTargetInput, 'kind'> & {
          readonly kind: 'volume'
          readonly evidence: { readonly resourceId: string; readonly bytes: number | null; readonly generation: string }
      }
    | Omit<ResetTargetInput, 'kind'> & {
          readonly kind: 'container'
          readonly evidence: { readonly resource: ReclaimResource }
      }

export interface PlanResetInput extends ClassifyReclaimInput {
    readonly expectedCoordinationRevision: number
    readonly requesterHolderId: string | null
    /** Compose volume keys, matched within `composeProject`; Docker's volume name is not one. */
    readonly resettableVolumes: readonly string[]
    readonly composeProject: string
    readonly generatedHostPaths: readonly HostPathDeclaration[]
    readonly runtimeExecutable: ResolvedExecutable
    readonly pathExecutable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly selectionAuthority?: object
    readonly confirmationDigest?: string
    readonly consent?: object
    readonly coordinationAddress?: StateAddress
    readonly continuation?: object
    readonly recoveryAuthority?: DrainReservationAuthority
    readonly operatorApproval?: ResetPreview
}

export interface ResetPreview {
    readonly kind: 'preview'
    readonly digest: string
    readonly coordinationRevision: number
    readonly targets: readonly ResetTargetInput[]
    readonly noop: boolean
    readonly consent: object
}

export type ResetPlanResult =
    | {
          readonly kind: 'complete'
          readonly step: ExecutionStep | null
          readonly actionAuthority: object | null
          readonly remaining: number
          readonly noop: boolean
          readonly digest: string
          readonly continuation: object | null
      }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

export interface PlanTeardownInput extends ClassifyReclaimInput {
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly selectionAuthority?: object
    readonly dependencyCaches?: readonly DependencyCacheDeclaration[]
    readonly pathExecutable?: ResolvedExecutable
    readonly expectedDiscoveryDigest?: string
    readonly consent?: object
    readonly continuation?: object
    readonly coordinationAddress?: StateAddress
    readonly recoveryAuthority?: DrainReservationAuthority
}

export type TeardownPlanResult =
    | {
          readonly kind: 'complete'
          readonly steps: readonly ExecutionStep[]
          readonly actionAuthority: object | null
          readonly remaining: number
          readonly noop: boolean
          readonly discoveryDigest: string
          readonly byteAccounting: {
              readonly observed: ByteClasses
              readonly reclaimable: ByteClasses
              readonly action: { readonly resourceId: string; readonly observedBytes: number | null } | null
              readonly actuallyReclaimed: number | null
          }
          readonly consent: object | null
          readonly continuation: object | null
      }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

function refusal(code: EnvironmentCode, message: string, target: string, fix?: string): { kind: 'refusal'; diagnostics: readonly EnvironmentDiagnostic[] } {
    return Object.freeze({ kind: 'refusal', diagnostics: Object.freeze([diagnostic(code, message, target, fix)]) })
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue)
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => lexical(left, right))
            .map(([key, item]) => [key, canonicalValue(item)]))
    }
    return value
}

function captureDataInput(raw: unknown): { readonly value: unknown; readonly opaque: Readonly<Record<string, unknown>> } | undefined {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(raw)
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')
        || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) return undefined
    const data = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
    return { value: snapshotJson(data), opaque: Object.freeze({ ...data }) }
}

function digestValue(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex')
}

function validExecutionInput(executable: unknown, cwd: unknown, env: unknown, timeoutMs: unknown): executable is ResolvedExecutable {
    const safeEnv = safeEnvironment(env)
    return resolvedExecutable(executable) !== undefined
        && typeof cwd === 'string' && isAbsolute(cwd) && normalize(cwd) === cwd && !cwd.includes('\0')
        && safeEnv !== undefined
        && Number.isSafeInteger(timeoutMs) && (timeoutMs as number) > 0 && (timeoutMs as number) <= 30_000
}

async function removalExecutable(value: unknown): Promise<ResolvedExecutable | undefined> {
    const executable = resolvedExecutable(value)
    if (executable === undefined || executable.invocationPath !== '/bin/rm' || executable.executionMode !== 'verified-path') return undefined
    const canonical = await realpath('/bin/rm')
    const bytes = await readFile(canonical)
    return canonical === executable.canonicalPath
        && createHash('sha256').update(bytes).digest('hex') === executable.sha256 ? executable : undefined
}

// A discovery lists only one stack's resources, so a discovery of another stack would make this
// one look empty: every planned target absent and every removal confirmed. It must name this stack.
function sameRuntimeAuthority(
    discovery: ReclaimDiscoverySnapshot,
    stackId: StackId,
    executable: ResolvedExecutable,
    cwd: string,
    env: Readonly<Record<string, string>>,
    selection: DockerSelection,
    currentSelection?: DockerSelectionAuthority,
    continuation?: unknown,
): DiscoveryAuthority | undefined {
    const authority = discoveryAuthorities.get(discovery)
    const reconciled = continuation !== null && typeof continuation === 'object'
        && authority !== undefined && reconciledContinuationDiscoveries.get(continuation) === authority
    const safeEnv = safeEnvironment(env)
    return authority !== undefined && safeEnv !== undefined && authority.stackId === stackId
        && JSON.stringify([authority.executable, authority.cwd, authority.env, authority.selection]) === JSON.stringify([executable, cwd, safeEnv, selection])
        && (currentSelection === undefined || JSON.stringify([currentSelection.executable, currentSelection.cwd, currentSelection.env, currentSelection.selection])
            === JSON.stringify([executable, cwd, safeEnv, selection])
            && Date.parse(currentSelection.startedAt) >= Date.parse(authority.finishedAt)
            && Date.now() >= Date.parse(currentSelection.finishedAt) && Date.now() - Date.parse(currentSelection.finishedAt) <= 30_000)
        && (reconciled || authority.receipts.every((receipt) => !consumedDiscoveryReceipts.has(receipt)))
        ? authority : undefined
}

function consumeAuthority(authority: DiscoveryAuthority): void {
    for (const receipt of authority.receipts) consumedDiscoveryReceipts.add(receipt)
}

function followsPreview(digest: string, authority: DiscoveryAuthority): boolean {
    const previewReceipts = previewDiscoveryReceipts.get(digest)
    return previewReceipts !== undefined && authority.receipts.every((receipt) => !previewReceipts.includes(receipt))
}

function recordPreview(digest: string, authority: DiscoveryAuthority): void {
    previewDiscoveryReceipts.set(digest, Object.freeze([
        ...new Set([...(previewDiscoveryReceipts.get(digest) ?? []), ...authority.receipts]),
    ].sort(lexical)))
}

function issueConsent(digest: string, authority: DiscoveryAuthority | undefined): object {
    const consent = Object.freeze({ kind: 'reclaim-consent', digest })
    if (authority !== undefined) consentAuthorities.set(consent, Object.freeze({
        digest, receipts: authority.receipts, issuedAt: new Date().toISOString(),
    }))
    return consent
}

function consumeConsent(raw: unknown, digest: string, authority: DiscoveryAuthority): boolean {
    if (raw === null || typeof raw !== 'object' || consumedConsents.has(raw)) return false
    const consent = consentAuthorities.get(raw)
    if (consent === undefined || consent.digest !== digest
        || authority.receipts.some((receipt) => consent.receipts.includes(receipt))
        || Date.parse(authority.startedAt) <= Date.parse(consent.issuedAt)) return false
    consumedConsents.add(raw)
    return true
}

function exactStep(
    id: string,
    argv: readonly [string, ...string[]],
    executable: ResolvedExecutable,
    cwd: string,
    env: Readonly<Record<string, string>>,
    timeoutMs: number,
    paths: readonly string[],
    labels: Readonly<Record<string, string>>,
    filesystemChecks: ExecutionStep['filesystemChecks'] = [],
    stdoutLimitBytes = 65_536,
): ExecutionStep | undefined {
    return snapshotExecutionStep({
        id,
        argv,
        argv0: executable.invocationPath,
        cwd,
        env,
        timeoutMs,
        stdoutLimitBytes,
        stderrLimitBytes: 65_536,
        paths,
        ports: [],
        labels,
        expected: [],
        consumedFiles: [{
            path: executable.canonicalPath,
            sha256: executable.sha256,
            maxBytes: 536_870_912,
            argvIndexes: [0],
            executable: true,
            executionMode: executable.executionMode,
        }],
        filesystemChecks,
        compensation: [],
    })
}

async function inspectHostPath(declaration: HostPathDeclaration): Promise<HostPathEvidence | undefined> {
    if (!declaration || typeof declaration.root !== 'string' || typeof declaration.path !== 'string'
        || typeof declaration.declaration !== 'string' || declaration.declaration.length === 0 || declaration.declaration.includes('\0')
        || !isAbsolute(declaration.root) || normalize(declaration.root) !== declaration.root
        || !isAbsolute(declaration.path) || normalize(declaration.path) !== declaration.path) return undefined
    const relation = relative(declaration.root, declaration.path)
    if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return undefined
    try {
        const rootStatus = await lstat(declaration.root, { bigint: true })
        if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() || await realpath(declaration.root) !== declaration.root) return undefined
        const ancestors: FilesystemAncestorIdentity[] = [Object.freeze({
            path: declaration.root, ...filesystemObjectIdentity(rootStatus),
        })]
        let cursor = declaration.root
        const parts = relation.split(sep)
        for (let index = 0; index < parts.length; index += 1) {
            cursor = resolve(cursor, parts[index]!)
            try {
                const status = await lstat(cursor, { bigint: true })
                if (status.isSymbolicLink()) return undefined
                if (index < parts.length - 1 && !status.isDirectory()) return undefined
                if (index === parts.length - 1) {
                    if (await realpath(cursor) !== cursor) return undefined
                    return Object.freeze({
                        state: 'present', type: status.isDirectory() ? 'directory' : status.isFile() ? 'file' : undefined,
                        ...filesystemObjectIdentity(status), mode: Number(status.mode),
                        size: Number(status.size), mtimeMs: Number(status.mtimeNs) / 1_000_000, ancestors: Object.freeze(ancestors),
                    })
                }
                ancestors.push(Object.freeze({ path: cursor, ...filesystemObjectIdentity(status) }))
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) return undefined
                return Object.freeze({ state: 'absent' })
            }
        }
    } catch {
        // A declared path that cannot be identified is refused by the caller as an unidentified target.
        return undefined
    }
    return undefined
}

async function dependencyCacheAuthorities(
    declarations: readonly DependencyCacheDeclaration[] | undefined,
): Promise<readonly DependencyCacheAuthority[] | undefined> {
    if (declarations === undefined) return Object.freeze([])
    if (!Array.isArray(declarations) || declarations.length > MAX_RESOURCES) return undefined
    const authorities: DependencyCacheAuthority[] = []
    for (const declaration of declarations) {
        if (declaration === null || typeof declaration !== 'object' || !exactKeys(declaration, ['cacheId', 'root', 'path'])
            || typeof declaration.cacheId !== 'string' || !SHA256.test(declaration.cacheId)
            || typeof declaration.root !== 'string' || typeof declaration.path !== 'string'
            || resolve(declaration.root, declaration.cacheId) !== declaration.path) return undefined
        const evidence = await inspectHostPath({ ...declaration, declaration: declaration.cacheId })
        if (evidence === undefined || evidence.state === 'present' && evidence.type !== 'directory') return undefined
        authorities.push(Object.freeze({ ...declaration, evidence }))
    }
    if (new Set(authorities.map(({ cacheId }) => cacheId)).size !== authorities.length
        || new Set(authorities.map(({ path }) => path)).size !== authorities.length) return undefined
    return Object.freeze(authorities.sort((left, right) => lexical(left.cacheId, right.cacheId)))
}

function safeTarget(value: ResetTargetAuthority): ResetTargetInput {
    return Object.freeze({
        kind: value.kind,
        identity: value.identity,
        declaration: value.declaration,
        ...(value.labels === undefined ? {} : { labels: Object.freeze({ ...value.labels }) }),
    })
}

function reclaimInput(input: ClassifyReclaimInput): ClassifyReclaimInput {
    return {
        stackId: input.stackId,
        cockpitId: input.cockpitId,
        configSha256: input.configSha256,
        coordinationRecord: input.coordinationRecord,
        declaredCacheIds: input.declaredCacheIds,
        discovery: input.discovery,
    }
}

async function resetAuthorities(input: PlanResetInput): Promise<ResetTargetAuthority[] | undefined> {
    if (!Array.isArray(input.resettableVolumes) || !Array.isArray(input.generatedHostPaths)
        || input.resettableVolumes.length + input.generatedHostPaths.length > MAX_RESOURCES
        || input.resettableVolumes.some((name) => typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/.test(name))
        || new Set(input.resettableVolumes).size !== input.resettableVolumes.length
        || typeof input.composeProject !== 'string' || !COMPOSE_PROJECT.test(input.composeProject)) return undefined
    const classified = classifyReclaim(reclaimInput(input))
    if (classified.kind !== 'complete') return undefined
    const targets: ResetTargetAuthority[] = []
    for (const key of input.resettableVolumes) {
        // A volume carrying Compose's default name for this key without its labels is one Compose
        // would adopt for the stack, so it counts as a match and refuses below instead of hiding.
        const matches = classified.resources.filter((resource) => resource.kind === 'volume'
            && (resource.labels[COMPOSE_LABELS.project] === input.composeProject && resource.labels[COMPOSE_LABELS.volume] === key
                || resource.name === `${input.composeProject}_${key}`))
        // Configuration validation and the ownership render refuse a key no volume declares, so
        // no match here is a volume not created yet or already removed.
        if (matches.length === 0) continue
        if (matches.length !== 1) return undefined
        const match = matches[0]!
        // The stack and owner labels identify the stack; the configuration label only records
        // which cockpit.toml created the volume. Compose keeps a volume across configuration
        // edits and `up` goes on using it, so admitting only the current configuration left every
        // data volume un-resettable after the first edit. The preview still commits the exact
        // volume id, labels and generation, so a volume replaced before the action is refused.
        if (match.ownership !== 'current' && match.ownership !== 'stale-config' || match.referenced
            || match.reversibility !== 'data-bearing' || typeof match.generation !== 'string') return undefined
        targets.push(Object.freeze({
            kind: 'volume', identity: match.name, declaration: key, labels: Object.freeze({ ...match.labels }),
            evidence: Object.freeze({ resourceId: match.id, bytes: match.bytes, generation: match.generation }),
        }))
    }
    // Docker refuses to remove a volume a container still references, stopped or not, and the
    // runtime stop leaves the stack's containers in place. So a reset that removes volumes first
    // removes the containers the same ownership evidence names as this stack's own; containers
    // sort before volumes, so they are removed first. Without them every approved reset failed
    // with "volume is in use".
    if (targets.length > 0) {
        for (const match of classified.resources) {
            if (match.kind !== 'container' || match.ownership !== 'current' && match.ownership !== 'stale-config'
                || match.action !== 'teardown') continue
            const { ownership: _ownership, reversibility: _reversibility, action: _action, evidence: _evidence, reason: _reason, suggestion: _suggestion, ...resource } = match
            targets.push(Object.freeze({
                kind: 'container', identity: match.id, declaration: match.name, labels: Object.freeze({ ...match.labels }),
                evidence: Object.freeze({ resource: Object.freeze(resource) }),
            }))
        }
    }
    const hostIdentities = new Set<string>()
    for (const declaration of input.generatedHostPaths) {
        const evidence = await inspectHostPath(declaration)
        if (evidence === undefined || evidence.state === 'present' && evidence.type === undefined || hostIdentities.has(declaration.path)) return undefined
        hostIdentities.add(declaration.path)
        targets.push(Object.freeze({
            kind: 'host-path', identity: declaration.path, declaration: declaration.declaration,
            root: declaration.root, evidence,
        }))
    }
    return targets.sort((left, right) => lexical(left.kind, right.kind) || lexical(left.identity, right.identity))
}

function coordinationForDestruction(input: Pick<PlanResetInput, 'coordinationRecord' | 'stackId' | 'cockpitId' | 'expectedCoordinationRevision' | 'requesterHolderId'>):
    | { revision: number }
    | { refusal: { kind: 'refusal'; diagnostics: readonly EnvironmentDiagnostic[] } } {
    const record = input.coordinationRecord
    if (record === null || record.cockpitId !== input.cockpitId || record.revision !== input.expectedCoordinationRevision) {
        return { refusal: refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'coordination revision does not match the destructive request', input.stackId) }
    }
    const coordination = decodeCoordinationRecord(record, input.stackId)
    if (coordination === undefined) return { refusal: refusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination evidence is malformed', input.stackId) }
    const otherHolders = coordination.holders.filter(({ holderId }) => holderId !== input.requesterHolderId)
    if (otherHolders.length > 0 || input.requesterHolderId !== null && !coordination.holders.some(({ holderId }) => holderId === input.requesterHolderId)) {
        return { refusal: refusal(ENVIRONMENT_CODES.RESET_CO_TENANT, 'reset requires an exact requester claim and zero co-tenants', input.stackId) }
    }
    return { revision: record.revision }
}

function coordinationIsFresh(record: StateRecord, observedAt: string): boolean {
    const observed = Date.parse(observedAt)
    const now = Date.now()
    return Number.isFinite(Date.parse(record.updatedAt)) && Number.isFinite(observed)
        && now >= observed && now - observed <= 30_000
}

function coordinationWorkBasis(record: StateRecord, stackId: StackId): unknown | undefined {
    const value = decodeCoordinationRecord(record, stackId)
    return value === undefined ? undefined : Object.freeze({
        holders: value.holders,
        lease: value.lease,
        lastReleasedHolder: value.lastReleasedHolder,
    })
}

async function rereadCoordination(
    address: StateAddress | undefined,
    expected: StateRecord,
    observedAt: string,
): Promise<StateRecord | undefined> {
    if (address === undefined || !coordinationIsFresh(expected, observedAt)) return undefined
    const result = await readState(address)
    if (result.kind !== 'complete' || !coordinationIsFresh(result.value, observedAt)
        || digestValue(result.value) !== digestValue(expected)) return undefined
    return result.value
}

export async function planReset(rawInput: PlanResetInput): Promise<ResetPreview | ResetPlanResult> {
    try {
        const capturedInput = captureDataInput(rawInput)
        const captured = capturedInput?.value
        if (captured === undefined || captured === null || typeof captured !== 'object' || Array.isArray(captured)) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset input is malformed or exceeds its bounds', 'reset')
        }
        const input = captured as unknown as PlanResetInput
        const discovery = capturedInput!.opaque.discovery as ReclaimDiscoverySnapshot
        const consent = capturedInput!.opaque.consent
        const continuation = capturedInput!.opaque.continuation
        const recoveryAuthority = capturedInput!.opaque.recoveryAuthority as DrainReservationAuthority | undefined
        const currentSelectionToken = capturedInput!.opaque.selectionAuthority
        const coordinationAddress = capturedInput!.opaque.coordinationAddress as StateAddress | undefined
        const runtimeExecutable = resolvedDockerExecutable(input.runtimeExecutable)
        const pathExecutable = await removalExecutable(input.pathExecutable)
        const env = safeEnvironment(input.env)
        const discoveryAuthority = discoveryAuthorities.get(discovery)
        const currentSelection = currentSelectionToken !== null && typeof currentSelectionToken === 'object'
            ? selectionAuthorities.get(currentSelectionToken) : undefined
        const selection = currentSelection?.selection ?? discoveryAuthority?.selection
        if (runtimeExecutable === undefined || pathExecutable === undefined
            || env === undefined || selection === undefined || discoveryAuthority === undefined
            || Object.hasOwn(captured, 'dockerContext') || Object.hasOwn(captured, 'dockerEndpoint') || Object.hasOwn(captured, 'buildxBuilder')
            || !validExecutionInput(runtimeExecutable, input.cwd, input.env, input.timeoutMs)
            || !validExecutionInput(pathExecutable, input.cwd, input.env, input.timeoutMs)) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset execution authority is malformed', 'reset')
        }
        const coordination = coordinationForDestruction(input)
        if ('refusal' in coordination) return coordination.refusal
        const coldPlanningAuthority = continuation === undefined && consent === undefined && recoveryAuthority !== undefined
            ? inspectFailedReclaimRecovery({ authority: recoveryAuthority, record: input.coordinationRecord! }) : undefined
        const coldPlanningRecovery = coldPlanningAuthority === undefined
            ? undefined : consumeFailedReclaimRecovery(coldPlanningAuthority)
        const operatorApproval = capturedInput!.opaque.operatorApproval
        if ((recoveryAuthority !== undefined) !== (operatorApproval !== undefined)
            || operatorApproval !== undefined && coldPlanningRecovery === undefined) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
                'cold reset recovery requires an authenticated approval of the remaining targets', 'reset-confirmation')
        }
        const coldPlanningIdentities = coldPlanningRecovery === undefined
            ? undefined : committedTargetIdentities(coldPlanningRecovery)
        const observedAuthorities = await resetAuthorities(input)
        if (observedAuthorities === undefined) return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reset targets do not match current declarations and ownership evidence', 'reset-targets')
        const continued = continuation === undefined ? undefined : resetContinuations.get(continuation as object)
        if (continuation !== undefined && (continued === undefined || typeof continuation !== 'object' || continuation === null || consumedContinuations.has(continuation))) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset continuation receipt is invalid or already consumed', 'reset-continuation')
        }
        let authorities = observedAuthorities
        let continuedAfterFailure = false
        if (continued !== undefined) {
            const continuedAuthority = discoveryAuthorities.get(discovery)
            const match = matchReclaimDrainContinuation({
                continuation: continuation as object, record: input.coordinationRecord!,
            })
            if (match === 'unmatched') {
                return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset continuation no longer matches the remaining consented target set', 'reset-continuation')
            }
            continuedAfterFailure = match === 'failed'
            const completedTargetIds = new Set(continuedAfterFailure
                ? continued.removedTargetIds
                : [...continued.removedTargetIds, continued.completedTargetId])
            const remainingNow = continuedAfterFailure ? observedAuthorities
                : observedAuthorities.filter(({ kind, identity }) => `${kind}:${identity}` !== continued.completedTargetId)
            const remainingTargetIds = continued.targetIds.filter((targetId) => !completedTargetIds.has(targetId))
            const remainingIdentities = resetTargetIdentities(remainingTargetIds, remainingNow)
            const completedRemainAbsent = continued.targetIdentities
                .filter(({ targetId }) => completedTargetIds.has(targetId))
                .every((identity) => targetIsAbsent(identity, discovery.resources))
            // The discovery that reconciled this continuation's last action predates only the
            // publication of that same outcome, which changes no runtime state.
            const reconciled = continuedAuthority !== undefined
                && reconciledContinuationDiscoveries.get(continuation as object) === continuedAuthority
            if (continuedAuthority === undefined || Date.parse(continuedAuthority.startedAt) <= Date.parse(continued.issuedAt)
                || !reconciled && Date.parse(continuedAuthority.startedAt) <= Date.parse(input.coordinationRecord!.updatedAt)
                || !completedRemainAbsent || remainingIdentities === undefined
                || !sameTargetProjections(remainingIdentities, continued.targetIdentities, remainingTargetIds)) {
                return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset continuation no longer matches the remaining consented target set', 'reset-continuation')
            }
            authorities = remainingNow
        }
        const digestTargetIds = Object.freeze(authorities
            .filter((candidate) => candidate.kind !== 'host-path' || candidate.evidence.state === 'present')
            .map(({ kind, identity }) => `${kind}:${identity}`).sort(lexical))
        const digestIdentities = coldPlanningIdentities ?? resetTargetIdentities(digestTargetIds, authorities)
        const coldCurrentIdentity = coldPlanningIdentities?.find(({ targetId }) => targetId === coldPlanningRecovery?.current.targetId)
        const coldCurrentAbsent = coldCurrentIdentity !== undefined && targetIsAbsent(coldCurrentIdentity, discovery.resources)
        if (coldCurrentAbsent && (coldCurrentIdentity.medium === 'path'
            ? !input.generatedHostPaths.some(declaration => declaration.root === coldCurrentIdentity.root
                && declaration.path === coldCurrentIdentity.path && declaration.declaration === coldCurrentIdentity.declaration)
            : coldCurrentIdentity.scope === 'reset-volume' && !input.resettableVolumes.includes(coldCurrentIdentity.declaration))) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
                'interrupted reset target is no longer declared', 'reset-targets')
        }
        const digest = continued?.consentDigest ?? digestValue({
            format: 'cockpit-reset-preview/v1', stackId: input.stackId, cockpitId: input.cockpitId,
            configSha256: input.configSha256,
            coordination: coordinationWorkBasis(input.coordinationRecord!, input.stackId),
            targets: digestIdentities,
            runtime: { executable: runtimeExecutable, pathExecutable, cwd: input.cwd, env, selection, timeoutMs: input.timeoutMs },
        })
        const runtimeDigest = digestValue({ executable: runtimeExecutable, pathExecutable, cwd: input.cwd, env, selection, timeoutMs: input.timeoutMs })
        if (continued !== undefined && continued.runtimeDigest !== runtimeDigest) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset continuation does not match the original runtime authority', 'reset-continuation')
        }
        const publicTargets = Object.freeze(authorities.map(safeTarget))
        if (input.confirmationDigest === undefined) {
            const previewAuthority = discoveryAuthorities.get(discovery)
            if (previewAuthority !== undefined) recordPreview(digest, previewAuthority)
            const preview = Object.freeze({
                kind: 'preview', digest, coordinationRevision: coordination.revision,
                targets: publicTargets, noop: authorities.length === 0 && !coldCurrentAbsent,
                consent: issueConsent(digest, previewAuthority),
            })
            const actionable = authorities.filter((candidate) => candidate.kind !== 'host-path' || candidate.evidence.state === 'present')
            const targetIds = Object.freeze(actionable.map(({ kind, identity }) => `${kind}:${identity}`).sort(lexical))
            const identities = coldPlanningIdentities ?? resetTargetIdentities(targetIds, actionable)
            if (identities === undefined) {
                return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reset target identities could not be committed exactly', 'reset-targets')
            }
            issuedResetPreviews.set(preview, reclaimTargetEnvelope(
                'reset', input.stackId, input.configSha256, digest, targetCommitments(identities),
            ))
            return preview
        }
        if (!SHA256.test(input.confirmationDigest) || input.confirmationDigest !== digest) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset consent does not match the fresh complete preview', 'reset-confirmation')
        }
        const currentCoordination = input.coordinationRecord === null ? undefined
            : await rereadCoordination(coordinationAddress, input.coordinationRecord, input.discovery.observedAt)
        if (currentCoordination === undefined) {
            return refusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'reset requires fresh coordination evidence read at the destructive boundary', input.stackId)
        }
        const boundaryCoordination = coordinationForDestruction({ ...input, coordinationRecord: currentCoordination })
        if ('refusal' in boundaryCoordination) return boundaryCoordination.refusal
        const coldRecovery = coldPlanningRecovery
        const coldIdentities = coldRecovery === undefined ? undefined : committedTargetIdentities(coldRecovery)
        const coldReclaimTargetIds = coldRecovery === undefined ? undefined
            : [...coldRecovery.completed, coldRecovery.current, ...coldRecovery.pending].map(({ targetId }) => targetId)
        const coldCompletedTargetIds = coldRecovery?.completed.map(({ targetId }) => targetId)
        const coldRemainingTargetIds = coldRecovery === undefined ? undefined
            : (coldCurrentAbsent ? coldRecovery.pending : [coldRecovery.current, ...coldRecovery.pending]).map(({ targetId }) => targetId)
        const coldObservedIdentities = coldRemainingTargetIds === undefined ? undefined
            : resetTargetIdentities(coldRemainingTargetIds, authorities)
        const coldTargetsMatch = coldRecovery !== undefined && coldIdentities !== undefined
            && coldRecovery.purpose === 'reset' && coldRecovery.stackId === input.stackId
            && coldRecovery.configSha256 === input.configSha256 && coldRecovery.planDigest === input.confirmationDigest
            && (coldCurrentAbsent || coldRecovery.current.targetId === coldRemainingTargetIds?.[0])
            && sameStrings(digestTargetIds, coldRemainingTargetIds!)
            && coldCompletedTargetIds!.every((targetId) => coldIdentities
                .filter((identity) => identity.targetId === targetId)
                .every((identity) => targetIsAbsent(identity, discovery.resources)))
            && coldObservedIdentities !== undefined
            && sameTargetProjections(coldObservedIdentities, coldIdentities, coldRemainingTargetIds!)
        const authority = sameRuntimeAuthority(discovery, input.stackId, runtimeExecutable, input.cwd, env, selection, currentSelection, continuation)
        const followsPersistedFailure = coldTargetsMatch
            && Date.parse(authority?.startedAt ?? '') > Date.parse(coldRecovery!.freshAfter)
        const approval = operatorApproval !== null && typeof operatorApproval === 'object'
            ? issuedResetPreviews.get(operatorApproval) : undefined
        if (operatorApproval !== undefined && (!coldTargetsMatch || !approval
            || approval.purpose !== 'reset' || approval.stackId !== input.stackId || approval.configSha256 !== input.configSha256
            || digestValue(approval.commitments) !== digestValue(targetCommitments(coldIdentities!
                .filter(({ targetId }) => coldRemainingTargetIds!.includes(targetId)))))) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
                'approved reset preview does not match the exact remaining persisted targets', 'reset-confirmation')
        }
        if (!admittedDiscoveries.has(discovery) || authority === undefined
            || continued === undefined && !(coldTargetsMatch ? followsPersistedFailure : followsPreview(digest, authority))
            || currentSelection === undefined || currentSelectionToken === null || typeof currentSelectionToken !== 'object'
            || consumedSelectionAuthorities.has(currentSelectionToken)
            || continued === undefined && !coldTargetsMatch && !consumeConsent(consent, digest, authority)) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reset requires a fresh authenticated runtime discovery', 'reset-discovery')
        }
        if (operatorApproval !== undefined) issuedResetPreviews.delete(operatorApproval as object)
        if (coldTargetsMatch && coldCurrentAbsent) {
            consumeAuthority(authority)
            consumedSelectionAuthorities.add(currentSelectionToken as object)
            const actionAuthority = issueAbsentReclaimAction({
                purpose: 'reset', stackId: input.stackId, configSha256: input.configSha256,
                coordinationRecord: currentCoordination, planDigest: digest, runtime: authority,
                targetId: coldRecovery!.current.targetId, targetIds: coldReclaimTargetIds!,
                removedTargetIds: coldCompletedTargetIds!, targetIdentities: coldIdentities!,
                remainingTargets: async next => {
                    const current = await resetAuthorities({ ...input, discovery: next })
                    return current?.filter(candidate => candidate.kind !== 'host-path' || candidate.evidence.state === 'present')
                        .map(({ kind, identity }) => `${kind}:${identity}`).sort(lexical)
                },
            }, runtimeDigest)
            const result = Object.freeze({ kind: 'complete' as const, step: null, actionAuthority, remaining: digestTargetIds.length,
                noop: false, digest, continuation: null })
            issuedResetRecoveryPlans.set(result, reclaimTargetEnvelope('reset', input.stackId, input.configSha256,
                digest, targetCommitments(coldIdentities!)))
            return result
        }
        // Revalidation narrows cooperative races; portable process APIs cannot bind a daemon object or pathname descriptor through its final removal syscall.
        const actionable = authorities.filter((candidate) => candidate.kind !== 'host-path' || candidate.evidence.state === 'present')
        const target = actionable[0]
        if (target === undefined) return Object.freeze({ kind: 'complete', step: null, actionAuthority: null, remaining: 0, noop: true, digest, continuation: null })
        const step = target.kind === 'host-path'
            ? exactStep(
                `reset:host-path:${digestValue(target.identity).slice(0, 16)}`,
                [pathExecutable.canonicalPath, '-rf', '--', target.identity],
                pathExecutable, input.cwd, env, input.timeoutMs, [target.identity],
                { stackId: input.stackId, configSha256: input.configSha256, resetKind: target.kind },
                [{ path: target.identity, expected: target.evidence.type! }],
            )
            : target.kind === 'container' ? exactStep(
                `reset:container:${digestValue(target.identity).slice(0, 16)}`,
                [runtimeExecutable.canonicalPath, '--host', selection.endpoint, 'container', 'rm', '--force', '--', target.identity],
                runtimeExecutable, input.cwd, env, input.timeoutMs, [],
                { stackId: input.stackId, configSha256: input.configSha256, resetKind: target.kind, container: target.declaration },
            )
            : exactStep(
                `reset:volume:${digestValue(target.identity).slice(0, 16)}`,
                [runtimeExecutable.canonicalPath, '--host', selection.endpoint, 'volume', 'rm', '--', (target.evidence as { resourceId: string }).resourceId],
                runtimeExecutable, input.cwd, env, input.timeoutMs, [],
                { stackId: input.stackId, configSha256: input.configSha256, resetKind: target.kind, volume: target.identity },
            )
        if (step === undefined) return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'exact reset action could not cross the execution boundary', target.identity)
        const actionAuthority = Object.freeze({ kind: 'reset-action-authority' })
        consumeAuthority(authority)
        consumedSelectionAuthorities.add(currentSelectionToken as object)
        if (continuation !== undefined) {
            consumedContinuations.add(continuation as object)
            reconciledContinuationDiscoveries.delete(continuation as object)
        }
        const receipt = Object.freeze({ kind: 'reset-continuation', digest: digestValue([digest, target.kind, target.identity]) })
        const targetIds = continued?.targetIds ?? coldReclaimTargetIds ?? Object.freeze(actionable.map(({ kind, identity }) => `${kind}:${identity}`).sort(lexical))
        const removedTargetIds = coldTargetsMatch ? Object.freeze(coldCompletedTargetIds!) : continued === undefined
            ? Object.freeze([] as string[])
            : continuedAfterFailure ? continued.removedTargetIds
                : Object.freeze([...continued.removedTargetIds, continued.completedTargetId].sort(lexical))
        const targetIdentities = continued?.targetIdentities ?? (coldTargetsMatch ? coldIdentities : resetTargetIdentities(targetIds, actionable))
        if (targetIdentities === undefined) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reset target identities could not be retained exactly', 'reset-targets')
        }
        resetContinuations.set(receipt, Object.freeze({
            consentDigest: digest, completedTargetId: `${target.kind}:${target.identity}`,
            issuedAt: new Date().toISOString(), runtimeDigest,
            targetIds, removedTargetIds, targetIdentities,
        }))
        pendingResetActions.set(actionAuthority, Object.freeze({
            step, target, coordinationRecord: currentCoordination, continuation: receipt,
            planDigest: digest, targetIds, removedTargetIds, targetIdentities,
        }))
        const result = Object.freeze({ kind: 'complete' as const, step: null, actionAuthority,
            remaining: actionable.length - 1, noop: false, digest, continuation: null })
        if (coldTargetsMatch) issuedResetRecoveryPlans.set(result, reclaimTargetEnvelope('reset', input.stackId,
            input.configSha256, digest, targetCommitments(coldIdentities!)))
        return result
    } catch (error) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, `reset input could not be inspected safely: ${errorCause(error)}`, 'reset')
    }
}

type ByteClasses = Readonly<Record<'orphans' | 'images' | 'buildCache' | 'staleNetworks', number | null>>

function sumBytes(resources: readonly ReclaimResource[]): number | null | undefined {
    if (resources.some(({ bytes }) => bytes === null)) return null
    let total = 0
    for (const resource of resources) {
        total += resource.bytes ?? 0
        if (!Number.isSafeInteger(total)) return undefined
    }
    return total
}

function teardownStep(
    resource: ClassifiedReclaimResource,
    input: PlanTeardownInput,
    selection: DockerSelection,
    caches: readonly DependencyCacheAuthority[],
    pathExecutable: ResolvedExecutable | undefined,
): ExecutionStep | undefined {
    if (resource.kind === 'cache') {
        const cache = caches.find(({ cacheId, evidence }) => cacheId === resource.id && evidence.state === 'present')
        if (cache === undefined || pathExecutable === undefined) return undefined
        return exactStep(
            `teardown:cache:${digestValue(resource.id).slice(0, 16)}`,
            [pathExecutable.canonicalPath, '-rf', '--', cache.path],
            pathExecutable, input.cwd, input.env, input.timeoutMs, [cache.path],
            { stackId: input.stackId, configSha256: input.configSha256, resourceKind: resource.kind, resourceId: resource.id },
            [{ path: cache.path, expected: 'directory' }],
        )
    }
    const command = resource.kind === 'container'
        ? ['container', 'rm', '--force', '--', resource.id]
        : resource.kind === 'network'
            ? ['network', 'rm', '--', resource.id]
            : resource.kind === 'image'
                ? ['image', 'rm', '--', resource.id]
                : resource.kind === 'build-cache'
                    ? ['buildx', 'prune', '--filter', `id=${resource.id}`, '--force']
                    : undefined
    if (command === undefined) return undefined
    const selected = ['--host', selection.endpoint, ...(resource.kind === 'build-cache' ? ['builder', ...command.slice(1)] : command)]
    return exactStep(
        `teardown:${resource.kind}:${digestValue(resource.id).slice(0, 16)}`,
        [input.executable.canonicalPath, ...selected],
        input.executable, input.cwd, input.env, input.timeoutMs, [],
        { stackId: input.stackId, configSha256: input.configSha256, resourceKind: resource.kind, resourceId: resource.id },
    )
}

function actionableReclaimResources(resources: readonly ClassifiedReclaimResource[]): ClassifiedReclaimResource[] {
    return resources.filter((resource) => resource.action === 'teardown'
        || resource.action === 'reclaim' && (resource.kind === 'build-cache' || resource.kind === 'cache'))
        .sort((left, right) => lexical(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`))
}

export async function planTeardown(rawInput: PlanTeardownInput): Promise<TeardownPlanResult> {
    try {
        const capturedInput = captureDataInput(rawInput)
        const captured = capturedInput?.value
        if (captured === undefined || captured === null || typeof captured !== 'object' || Array.isArray(captured)) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown input is malformed or exceeds its bounds', 'teardown')
        }
        const input = captured as unknown as PlanTeardownInput
        const discovery = capturedInput!.opaque.discovery as ReclaimDiscoverySnapshot
        const consent = capturedInput!.opaque.consent
        const inputContinuation = capturedInput!.opaque.continuation
        const recoveryAuthority = capturedInput!.opaque.recoveryAuthority as DrainReservationAuthority | undefined
        const currentSelectionToken = capturedInput!.opaque.selectionAuthority
        const coordinationAddress = capturedInput!.opaque.coordinationAddress as StateAddress | undefined
        const executable = resolvedDockerExecutable(input.executable)
        const env = safeEnvironment(input.env)
        const discoveryAuthority = discoveryAuthorities.get(discovery)
        const currentSelection = currentSelectionToken !== null && typeof currentSelectionToken === 'object'
            ? selectionAuthorities.get(currentSelectionToken) : undefined
        const selection = currentSelection?.selection ?? discoveryAuthority?.selection
        const caches = await dependencyCacheAuthorities(input.dependencyCaches)
        const pathExecutable = input.dependencyCaches !== undefined && input.dependencyCaches.length > 0
            ? await removalExecutable(input.pathExecutable) : undefined
        if (executable === undefined || selection === undefined || discoveryAuthority === undefined
            || Object.hasOwn(captured, 'dockerContext') || Object.hasOwn(captured, 'dockerEndpoint') || Object.hasOwn(captured, 'buildxBuilder')
            || !validExecutionInput(executable, input.cwd, input.env, input.timeoutMs)) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown execution authority is malformed', 'teardown')
        }
        if (caches === undefined || input.dependencyCaches !== undefined && input.dependencyCaches.length > 0 && pathExecutable === undefined) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'dependency-cache reclaim authority is malformed or unconfined', 'teardown-cache')
        }
        if (input.coordinationRecord === null || input.coordinationRecord.cockpitId !== input.cockpitId) {
            return refusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'teardown requires current coordinated state evidence', input.stackId)
        }
        const coordination = decodeCoordinationRecord(input.coordinationRecord, input.stackId)
        if (coordination === undefined) return refusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'teardown coordination evidence is malformed', input.stackId)
        if (coordination.holders.length > 1 || coordination.holders.length === 1 && (coordination.lease === null || coordination.lease.released)) {
            return refusal(ENVIRONMENT_CODES.RESET_CO_TENANT, 'teardown requires no more than one retained holder with its lease', input.stackId)
        }
        const cacheResources = caches.filter(({ evidence }) => evidence.state === 'present').map(({ cacheId }) => Object.freeze({
            id: cacheId, name: cacheId, kind: 'cache' as const, labels: Object.freeze({}), referenced: false, bytes: null,
        }))
        const observedDiscovery = Object.freeze({
            ...input.discovery,
            resources: Object.freeze([...input.discovery.resources, ...cacheResources]),
        })
        const classified = classifyReclaim({ ...reclaimInput(input), discovery: observedDiscovery })
        if (classified.kind !== 'complete') return classified
        const coldAuthority = inputContinuation === undefined && consent === undefined && recoveryAuthority !== undefined
            ? inspectFailedReclaimRecovery({ authority: recoveryAuthority, record: input.coordinationRecord }) : undefined
        const coldRecovery = coldAuthority === undefined ? undefined : consumeFailedReclaimRecovery(coldAuthority)
        const coldIdentities = coldRecovery === undefined ? undefined : committedTargetIdentities(coldRecovery)
        const continued = inputContinuation === undefined ? undefined : teardownContinuations.get(inputContinuation as object)
        if (inputContinuation !== undefined
            && (continued === undefined || typeof inputContinuation !== 'object' || inputContinuation === null || consumedTeardownContinuations.has(inputContinuation))) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown continuation receipt is invalid or already consumed', 'teardown-continuation')
        }
        let continuedAfterFailure = false
        if (continued !== undefined) {
            const continuedAuthority = discoveryAuthorities.get(discovery)
            const match = matchReclaimDrainContinuation({
                continuation: inputContinuation as object, record: input.coordinationRecord!,
            })
            if (match === 'unmatched') {
                return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown continuation no longer matches the remaining consented resources', 'teardown-continuation')
            }
            continuedAfterFailure = match === 'failed'
            const completedTargetIds = new Set(continuedAfterFailure
                ? continued.removedTargetIds
                : [...continued.removedTargetIds, continued.completedTargetId])
            const remainingActionable = actionableReclaimResources(classified.resources)
            const remainingCaches = caches.filter(({ evidence }) => evidence.state === 'present')
            const remainingTargetIds = continued.targetIds.filter((targetId) => !completedTargetIds.has(targetId))
            const remainingIdentities = teardownTargetIdentities(remainingTargetIds, remainingActionable, remainingCaches)
            const completedRemainAbsent = continued.targetIdentities
                .filter(({ targetId }) => completedTargetIds.has(targetId))
                .every((identity) => targetIsAbsent(identity, discovery.resources))
            const reconciled = continuedAuthority !== undefined
                && reconciledContinuationDiscoveries.get(inputContinuation as object) === continuedAuthority
            if (continuedAuthority === undefined || Date.parse(continuedAuthority.startedAt) <= Date.parse(continued.issuedAt)
                || !reconciled && Date.parse(continuedAuthority.startedAt) <= Date.parse(input.coordinationRecord!.updatedAt)
                || !completedRemainAbsent || remainingIdentities === undefined
                || !sameTargetProjections(remainingIdentities, continued.targetIdentities, remainingTargetIds)) {
                return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown continuation no longer matches the remaining consented resources', 'teardown-continuation')
            }
        }
        const actionable = actionableReclaimResources(classified.resources)
        const freshTargetIds = Object.freeze(actionable.map(({ kind, id }) => `${kind}:${id}`).sort(lexical))
        const freshTargetIdentities = teardownTargetIdentities(freshTargetIds, actionable, caches)
        if (freshTargetIdentities === undefined) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown target identities could not be committed exactly', 'teardown-targets')
        }
        const discoveryDigest = continued?.discoveryDigest ?? digestValue({
            format: 'cockpit-teardown-discovery/v1', stackId: input.stackId, cockpitId: input.cockpitId,
            configSha256: input.configSha256,
            coordination: coordinationWorkBasis(input.coordinationRecord, input.stackId),
            targets: coldIdentities ?? freshTargetIdentities,
            runtime: { executable, pathExecutable, cwd: input.cwd, env, selection, timeoutMs: input.timeoutMs },
        })
        const runtimeDigest = digestValue({ executable, pathExecutable, cwd: input.cwd, env, selection, timeoutMs: input.timeoutMs })
        if (continued !== undefined && continued.runtimeDigest !== runtimeDigest) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown continuation does not match the original runtime authority', 'teardown-continuation')
        }
        const previewAuthority = discoveryAuthorities.get(discovery)
        if (input.expectedDiscoveryDigest === undefined && previewAuthority !== undefined) recordPreview(discoveryDigest, previewAuthority)
        if (input.expectedDiscoveryDigest !== undefined && input.expectedDiscoveryDigest !== discoveryDigest) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'fresh teardown discovery differs from the accepted snapshot', input.stackId)
        }
        let currentCoordination = input.coordinationRecord
        if (input.expectedDiscoveryDigest !== undefined) {
            const current = await rereadCoordination(coordinationAddress, input.coordinationRecord, input.discovery.observedAt)
            const decodedCurrent = current === undefined ? undefined : decodeCoordinationRecord(current, input.stackId)
            if (decodedCurrent === undefined || decodedCurrent.holders.length > 1
                || decodedCurrent.holders.length === 1 && (decodedCurrent.lease === null || decodedCurrent.lease.released)) {
                return refusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'teardown requires fresh retained drain coordination evidence read at the destructive boundary', input.stackId)
            }
            currentCoordination = current!
        }
        const first = actionable[0]
        const authority = sameRuntimeAuthority(discovery, input.stackId, executable, input.cwd, input.env, selection, currentSelection, inputContinuation)
        const coldReclaimTargetIds = coldRecovery === undefined ? undefined
            : [...coldRecovery.completed, coldRecovery.current, ...coldRecovery.pending].map(({ targetId }) => targetId)
        const coldCompletedTargetIds = coldRecovery?.completed.map(({ targetId }) => targetId)
        const coldCurrentIdentity = coldIdentities?.find(({ targetId }) => targetId === coldRecovery?.current.targetId)
        const coldCurrentAbsent = coldCurrentIdentity !== undefined && targetIsAbsent(coldCurrentIdentity, discovery.resources)
        const coldRemainingTargetIds = coldRecovery === undefined ? undefined
            : (coldCurrentAbsent ? coldRecovery.pending : [coldRecovery.current, ...coldRecovery.pending]).map(({ targetId }) => targetId)
        const coldObservedIdentities = coldRemainingTargetIds === undefined ? undefined
            : teardownTargetIdentities(coldRemainingTargetIds, actionable, caches)
        const coldTargetsMatch = coldRecovery !== undefined && coldIdentities !== undefined
            && coldRecovery.purpose === 'down' && coldRecovery.stackId === input.stackId
            && coldRecovery.configSha256 === input.configSha256
            && coldRecovery.planDigest === discoveryDigest
            && (input.expectedDiscoveryDigest === undefined || coldRecovery.planDigest === input.expectedDiscoveryDigest)
            && (coldCurrentAbsent || coldRecovery.current.targetId === coldRemainingTargetIds?.[0])
            && sameStrings(freshTargetIds, coldRemainingTargetIds!)
            && coldCompletedTargetIds!.every((targetId) => coldIdentities
                .filter((identity) => identity.targetId === targetId)
                .every((identity) => targetIsAbsent(identity, discovery.resources)))
            && coldObservedIdentities !== undefined
            && sameTargetProjections(coldObservedIdentities, coldIdentities, coldRemainingTargetIds!)
        const followsPersistedFailure = coldTargetsMatch
            && Date.parse(authority?.startedAt ?? '') > Date.parse(coldRecovery!.freshAfter)
        if ((first !== undefined || coldCurrentAbsent) && input.expectedDiscoveryDigest !== undefined
            && (!admittedDiscoveries.has(discovery) || authority === undefined
                || currentSelection === undefined || currentSelectionToken === null || typeof currentSelectionToken !== 'object'
                || consumedSelectionAuthorities.has(currentSelectionToken)
                || continued === undefined && !(coldTargetsMatch ? followsPersistedFailure : followsPreview(discoveryDigest, authority))
                || continued === undefined && !coldTargetsMatch && !consumeConsent(consent, discoveryDigest, authority))) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown requires a fresh authenticated runtime discovery', 'teardown-discovery')
        }
        const absent = coldTargetsMatch && coldCurrentAbsent && input.expectedDiscoveryDigest !== undefined
        const step = absent || first === undefined || input.expectedDiscoveryDigest === undefined
            ? undefined : teardownStep(first, { ...input, executable, env: env! }, selection, caches, pathExecutable)
        if (!absent && first !== undefined && input.expectedDiscoveryDigest !== undefined && step === undefined) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'exact teardown action could not cross the execution boundary', first.id)
        }
        const raw = observedDiscovery.resources
        const observed = Object.freeze({
            orphans: sumBytes(raw.filter(({ kind }) => kind === 'container')),
            images: sumBytes(raw.filter(({ kind }) => kind === 'image')),
            buildCache: sumBytes(raw.filter(({ kind }) => kind === 'build-cache' || kind === 'cache')),
            staleNetworks: sumBytes(classified.resources.filter(({ kind, ownership }) => kind === 'network' && ownership === 'stale-config')),
        })
        const reclaimable = Object.freeze({
            orphans: sumBytes(actionable.filter(({ kind }) => kind === 'container')),
            images: sumBytes(actionable.filter(({ kind }) => kind === 'image')),
            buildCache: sumBytes(actionable.filter(({ kind }) => kind === 'build-cache' || kind === 'cache')),
            staleNetworks: sumBytes(actionable.filter(({ kind, ownership }) => kind === 'network' && ownership === 'stale-config')),
        })
        if ([...Object.values(observed), ...Object.values(reclaimable)].some((value) => value === undefined)) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reclaim byte accounting exceeds the safe integer range', 'teardown-accounting')
        }
        if (step !== undefined || absent) {
            consumeAuthority(authority!)
            consumedSelectionAuthorities.add(currentSelectionToken as object)
            if (inputContinuation !== undefined) {
                consumedTeardownContinuations.add(inputContinuation as object)
                reconciledContinuationDiscoveries.delete(inputContinuation as object)
            }
        }
        const actionAuthority = absent ? issueAbsentReclaimAction({
            purpose: 'down', stackId: input.stackId, configSha256: input.configSha256,
            coordinationRecord: currentCoordination!, planDigest: discoveryDigest, runtime: authority!,
            targetId: coldRecovery!.current.targetId, targetIds: coldReclaimTargetIds!,
            removedTargetIds: coldCompletedTargetIds!, targetIdentities: coldIdentities!,
            remainingTargets: async next => {
                const nextCaches = await dependencyCacheAuthorities(input.dependencyCaches)
                if (!nextCaches) return undefined
                const cacheRows = nextCaches.filter(({ evidence }) => evidence.state === 'present').map(({ cacheId }) => ({
                    id: cacheId, name: cacheId, kind: 'cache' as const, labels: {}, referenced: false, bytes: null,
                }))
                const classified = classifyReclaim({ ...reclaimInput(input), discovery: { ...next, resources: [...next.resources, ...cacheRows] } })
                return classified.kind === 'complete' ? actionableReclaimResources(classified.resources)
                    .map(({ kind, id }) => `${kind}:${id}`).sort(lexical) : undefined
            },
        }, runtimeDigest) : step === undefined || first === undefined ? null : Object.freeze({ kind: 'teardown-action-authority' })
        const continuation = step === undefined || first === undefined ? null
            : Object.freeze({ kind: 'teardown-continuation', digest: digestValue([discoveryDigest, first.kind, first.id]) })
        const targetIds = continued?.targetIds ?? coldReclaimTargetIds ?? freshTargetIds
        const removedTargetIds = coldTargetsMatch ? Object.freeze(coldCompletedTargetIds!) : continued === undefined
            ? Object.freeze([] as string[])
            : continuedAfterFailure ? continued.removedTargetIds
                : Object.freeze([...continued.removedTargetIds, continued.completedTargetId])
        const targetIdentities = continued?.targetIdentities ?? (coldTargetsMatch ? coldIdentities : freshTargetIdentities)
        if (targetIdentities === undefined) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown target identities could not be retained exactly', 'teardown-targets')
        }
        if (continuation !== null) teardownContinuations.set(continuation, Object.freeze({
            discoveryDigest, completedTargetId: `${first.kind}:${first.id}`,
            issuedAt: new Date().toISOString(), runtimeDigest,
            targetIds, removedTargetIds, targetIdentities,
        }))
        if (actionAuthority !== null && continuation !== null) pendingTeardownActions.set(actionAuthority, Object.freeze({
            step: step!, target: first!,
            cache: first!.kind === 'cache' ? caches.find(({ cacheId }) => cacheId === first!.id) : undefined,
            coordinationRecord: currentCoordination!, planDigest: discoveryDigest, continuation,
            targetIds, removedTargetIds, targetIdentities,
        }))
        const result = Object.freeze({
            kind: 'complete', steps: Object.freeze([]), actionAuthority,
            remaining: step === undefined ? actionable.length : actionable.length - 1,
            noop: actionable.length === 0 && !absent, discoveryDigest,
            byteAccounting: Object.freeze({
                observed: observed as ByteClasses, reclaimable: reclaimable as ByteClasses,
                action: first === undefined || step === undefined ? null : Object.freeze({ resourceId: first.id, observedBytes: first.bytes }),
                actuallyReclaimed: null,
            }),
            consent: input.expectedDiscoveryDigest === undefined ? issueConsent(discoveryDigest, previewAuthority) : null,
            continuation: null,
        })
        issuedTeardownPlans.set(result, reclaimTargetEnvelope(
            'down', input.stackId, input.configSha256, discoveryDigest, targetCommitments(coldTargetsMatch ? coldIdentities! : targetIdentities),
        ))
        return result
    } catch (error) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, `teardown input could not be inspected safely: ${errorCause(error)}`, 'teardown')
    }
}

declare const reclaimTargetProjectionBrand: unique symbol
export interface ReclaimTargetProjection {
    readonly [reclaimTargetProjectionBrand]: true
}

export interface ReclaimTargetCommitment extends DrainTargetCommitment {
    readonly targetId: string
}

export interface ReclaimTargetEnvelope {
    readonly purpose: 'reset' | 'down'
    readonly stackId: StackId
    readonly configSha256: string
    readonly planDigest: string
    readonly commitments: readonly ReclaimTargetCommitment[]
}

function targetCommitment(identity: ReclaimTargetIdentity): ReclaimTargetCommitment {
    const body = JSON.stringify(canonicalValue(identity))
    return Object.freeze({
        format: 'cockpit-reclaim-target/v1', targetId: identity.targetId,
        sha256: createHash('sha256').update(body).digest('hex'), body,
    })
}

function targetCommitments(identities: readonly ReclaimTargetIdentity[]): readonly ReclaimTargetCommitment[] {
    return Object.freeze(identities.map(targetCommitment))
}

function reclaimTargetEnvelope(
    purpose: ReclaimTargetEnvelope['purpose'],
    stackId: StackId,
    configSha256: string,
    planDigest: string,
    commitments: readonly ReclaimTargetCommitment[],
): ReclaimTargetEnvelope {
    return Object.freeze({
        purpose, stackId, configSha256, planDigest,
        commitments: Object.freeze(commitments.map((commitment) => Object.freeze({ ...commitment }))),
    })
}

function snapshotCommittedTargetIdentity(value: unknown): ReclaimTargetIdentity | undefined {
    const parsed = snapshotJson(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const candidate = parsed as Record<string, unknown>
    const validLabels = (labels: unknown): labels is Record<string, string> => labels !== null && typeof labels === 'object'
        && !Array.isArray(labels) && Object.keys(labels).length <= 64
        && Object.entries(labels).every(([key, item]) => key.length > 0 && key.length <= 256 && !key.includes('\0')
            && typeof item === 'string' && item.length <= 512 && !item.includes('\0'))
    if (typeof candidate.targetId !== 'string' || candidate.targetId.length === 0
        || Buffer.byteLength(candidate.targetId, 'utf8') > 512) return undefined
    if (candidate.medium === 'runtime' && candidate.scope === 'reset-volume') {
        if (!exactKeys(candidate, ['medium', 'scope', 'targetId', 'kind', 'declaration', 'runtimeId', 'name', 'labels', 'generation'])
            || candidate.kind !== 'volume' || typeof candidate.declaration !== 'string'
            || typeof candidate.runtimeId !== 'string' || typeof candidate.name !== 'string'
            || typeof candidate.generation !== 'string' || !validLabels(candidate.labels)
            || candidate.targetId !== `volume:${candidate.name}`
            || digestValue(canonicalLabels(candidate.labels as Record<string, string>)) !== digestValue(candidate.labels)) return undefined
        return Object.freeze(candidate) as unknown as ResetVolumeTargetIdentity
    }
    if (candidate.medium === 'runtime' && candidate.scope === 'teardown-runtime') {
        if (!exactKeys(candidate, ['medium', 'scope', 'targetId', 'kind', 'runtimeId', 'name', 'labels', 'referenced', 'dataBearing', 'generation'])
            || !['container', 'network', 'volume', 'image', 'build-cache'].includes(candidate.kind as string)
            || typeof candidate.runtimeId !== 'string' || typeof candidate.name !== 'string'
            || !validLabels(candidate.labels)
            || typeof candidate.referenced !== 'boolean'
            || candidate.dataBearing !== null && typeof candidate.dataBearing !== 'boolean'
            || candidate.generation !== null && typeof candidate.generation !== 'string'
            || candidate.targetId !== `${candidate.kind}:${candidate.runtimeId}`
            || digestValue(canonicalLabels(candidate.labels as Record<string, string>)) !== digestValue(candidate.labels)) return undefined
        return Object.freeze(candidate) as unknown as TeardownRuntimeTargetIdentity
    }
    if (candidate.medium === 'path') {
        const ancestors = candidate.ancestors
        if (!exactKeys(candidate, ['medium', 'targetId', 'kind', 'declaration', 'root', 'path', 'type', 'dev', 'ino', 'birthtimeNs', 'ancestors'])
            || candidate.kind !== 'cache' && candidate.kind !== 'host-path'
            || typeof candidate.declaration !== 'string' || typeof candidate.root !== 'string' || typeof candidate.path !== 'string'
            || !isAbsolute(candidate.root) || normalize(candidate.root) !== candidate.root
            || !isAbsolute(candidate.path) || normalize(candidate.path) !== candidate.path
            || relative(candidate.root, candidate.path) === '' || relative(candidate.root, candidate.path) === '..'
            || relative(candidate.root, candidate.path).startsWith(`..${sep}`) || isAbsolute(relative(candidate.root, candidate.path))
            || candidate.type !== 'directory' && candidate.type !== 'file'
            || !isFilesystemObjectIdentity(candidate)
            || !Array.isArray(ancestors) || ancestors.length < 1 || ancestors.length > 64
            || new Set(ancestors.map((ancestor) => ancestor !== null && typeof ancestor === 'object'
                ? (ancestor as Record<string, unknown>).path : undefined)).size !== ancestors.length
            || ancestors.some((ancestor, index) => ancestor === null || typeof ancestor !== 'object' || Array.isArray(ancestor)
                || !exactKeys(ancestor, ['path', 'dev', 'ino', 'birthtimeNs'])
                || typeof ancestor.path !== 'string' || !isAbsolute(ancestor.path) || normalize(ancestor.path) !== ancestor.path
                || !isFilesystemObjectIdentity(ancestor as Record<string, unknown>)
                || (index === 0 ? ancestor.path !== candidate.root : dirname(ancestor.path) !== (ancestors[index - 1] as { path: string }).path))
            || dirname(candidate.path) !== (ancestors.at(-1) as { path: string }).path) return undefined
        return Object.freeze(candidate) as unknown as PathTargetIdentity
    }
    return undefined
}

function committedTargetIdentities(recovery: FailedReclaimRecovery): readonly ReclaimTargetIdentity[] | undefined {
    try {
        const targets = [...recovery.completed, recovery.current, ...recovery.pending]
        const identities = targets.map((target) => {
            const commitment = target.targetCommitment
            if (!commitment || createHash('sha256').update(commitment.body).digest('hex') !== commitment.sha256) throw new RefusalError('invalid commitment')
            const parsed = snapshotCommittedTargetIdentity(JSON.parse(commitment.body))
            if (!parsed || parsed.targetId !== target.targetId
                || commitment.body !== JSON.stringify(canonicalValue(parsed))) throw new RefusalError('invalid identity')
            return parsed
        })
        return identities.length === targets.length ? Object.freeze(identities) : undefined
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

function issueTargetProjection(envelope: ReclaimTargetEnvelope): ReclaimTargetProjection {
    const projection = Object.freeze({}) as ReclaimTargetProjection
    issuedTargetProjections.set(projection, envelope)
    return projection
}

export function projectResetActionTargets(preview: ResetPreview): ReclaimTargetProjection | undefined {
    const envelope = preview && typeof preview === 'object' ? issuedResetPreviews.get(preview) : undefined
    return envelope === undefined ? undefined : issueTargetProjection(envelope)
}

export function projectRecoveredResetActionTargets(plan: ResetPlanResult): ReclaimTargetProjection | undefined {
    const envelope = plan && typeof plan === 'object' ? issuedResetRecoveryPlans.get(plan) : undefined
    return envelope === undefined ? undefined : issueTargetProjection(envelope)
}

export function projectTeardownActionTargets(plan: TeardownPlanResult): ReclaimTargetProjection | undefined {
    const envelope = plan && typeof plan === 'object' ? issuedTeardownPlans.get(plan) : undefined
    return envelope === undefined ? undefined : issueTargetProjection(envelope)
}

export function consumeReclaimTargetProjection(projection: ReclaimTargetProjection): ReclaimTargetEnvelope | undefined {
    if (!projection || typeof projection !== 'object') return undefined
    const envelope = issuedTargetProjections.get(projection)
    if (envelope === undefined) return undefined
    issuedTargetProjections.delete(projection)
    return envelope
}

function canonicalLabels(labels: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    const required = new Set<string>(Object.values(REQUIRED_LABELS))
    return Object.freeze(Object.fromEntries(Object.entries(labels)
        .filter(([key]) => required.has(key))
        .sort(([left], [right]) => lexical(left, right))))
}

function teardownRuntimeTargetIdentity(targetId: string, resource: ReclaimResource): TeardownRuntimeTargetIdentity | undefined {
    if (resource.kind === 'cache') return undefined
    return Object.freeze({
        medium: 'runtime', scope: 'teardown-runtime', targetId, kind: resource.kind,
        runtimeId: resource.id, name: resource.name, labels: canonicalLabels(resource.labels),
        referenced: resource.referenced, dataBearing: resource.dataBearing ?? null,
        generation: resource.generation ?? null,
    })
}

function pathTargetIdentity(
    targetId: string,
    kind: PathTargetIdentity['kind'],
    declaration: string,
    root: string,
    path: string,
    evidence: HostPathEvidence,
): PathTargetIdentity | undefined {
    if (evidence.state !== 'present' || evidence.type === undefined || evidence.dev === undefined || evidence.ino === undefined
        || evidence.birthtimeNs === undefined || evidence.ancestors === undefined) return undefined
    return Object.freeze({
        medium: 'path', targetId, kind, declaration, root, path, type: evidence.type,
        dev: evidence.dev, ino: evidence.ino, birthtimeNs: evidence.birthtimeNs,
        ancestors: Object.freeze(evidence.ancestors.map((ancestor) => Object.freeze({ ...ancestor }))),
    })
}

async function identityBoundFilesystemCheck(expected: PathTargetIdentity): Promise<FilesystemCheck | undefined> {
    const relation = relative(expected.root, expected.path)
    if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return undefined
    const parts = relation.split(sep)
    const ancestorPaths = [expected.root]
    let cursor = expected.root
    for (const segment of parts.slice(0, -1)) {
        cursor = resolve(cursor, segment)
        ancestorPaths.push(cursor)
    }
    try {
        if (ancestorPaths.length !== expected.ancestors.length) return undefined
        const ancestors: FilesystemAncestorIdentity[] = []
        for (const [index, path] of ancestorPaths.entries()) {
            const committed = expected.ancestors[index]
            if (committed === undefined || committed.path !== path) return undefined
            const status = await lstat(path, { bigint: true })
            if (!status.isDirectory() || status.isSymbolicLink() || await realpath(path) !== path
                || !sameFilesystemObject(status, committed)) return undefined
            ancestors.push(Object.freeze({ path, ...filesystemObjectIdentity(status) }))
        }
        const target = await lstat(expected.path, { bigint: true })
        const type = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : undefined
        if (target.isSymbolicLink() || type !== expected.type || !sameFilesystemObject(target, expected)) return undefined
        return Object.freeze({
            path: expected.path,
            expected: expected.type,
            identity: Object.freeze({ ...filesystemObjectIdentity(target), ancestors: Object.freeze(ancestors) }),
        })
    } catch {
        // A target that cannot be re-identified no longer matches; the caller refuses it.
        return undefined
    }
}

function resetTargetIdentities(
    targetIds: readonly string[],
    targets: readonly ResetTargetAuthority[],
): readonly ReclaimTargetIdentity[] | undefined {
    const identities = targets.flatMap((target): ReclaimTargetIdentity[] => {
        const targetId = `${target.kind}:${target.identity}`
        if (!targetIds.includes(targetId)) return []
        if (target.kind === 'host-path') {
            const identity = pathTargetIdentity(
                targetId, 'host-path', target.declaration, target.root, target.identity,
                target.evidence,
            )
            return identity === undefined ? [] : [identity]
        }
        // A container is committed with the identity teardown commits for it, so recovery reads
        // one runtime identity shape whichever verb removed it.
        if (target.kind === 'container') {
            const identity = teardownRuntimeTargetIdentity(targetId, target.evidence.resource)
            return identity === undefined ? [] : [identity]
        }
        const evidence = target.evidence
        return [Object.freeze({
            medium: 'runtime' as const, scope: 'reset-volume' as const,
            targetId, kind: 'volume' as const, declaration: target.declaration,
            runtimeId: evidence.resourceId, name: target.identity,
            labels: canonicalLabels(target.labels ?? Object.freeze({})), generation: evidence.generation,
        })]
    }).sort((left, right) => lexical(left.targetId, right.targetId))
    return identities.length === targetIds.length
        && sameStrings(identities.map(({ targetId }) => targetId), targetIds)
        ? Object.freeze(identities) : undefined
}

function teardownTargetIdentities(
    targetIds: readonly string[],
    resources: readonly ClassifiedReclaimResource[],
    caches: readonly DependencyCacheAuthority[],
): readonly ReclaimTargetIdentity[] | undefined {
    const identities = resources.flatMap((resource): ReclaimTargetIdentity[] => {
        const targetId = `${resource.kind}:${resource.id}`
        if (!targetIds.includes(targetId)) return []
        if (resource.kind === 'cache') {
            const cache = caches.find(({ cacheId }) => cacheId === resource.id)
            if (cache === undefined) return []
            const identity = pathTargetIdentity(targetId, 'cache', cache.cacheId, cache.root, cache.path, cache.evidence)
            return identity === undefined ? [] : [identity]
        }
        const identity = teardownRuntimeTargetIdentity(targetId, resource)
        return identity === undefined ? [] : [identity]
    }).sort((left, right) => lexical(left.targetId, right.targetId))
    return identities.length === targetIds.length
        && sameStrings(identities.map(({ targetId }) => targetId), targetIds)
        ? Object.freeze(identities) : undefined
}

export async function redeemReclaimAction(input: {
    readonly actionAuthority: object
    readonly attempt: DrainAttemptAuthority
}): Promise<{ readonly step: ExecutionStep; readonly authority: object } | undefined> {
    let actionAuthority: object | undefined
    let attemptAuthority: DrainAttemptAuthority | undefined
    try {
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 2 || !('value' in descriptors.actionAuthority!) || !('value' in descriptors.attempt!)) return undefined
        actionAuthority = descriptors.actionAuthority!.value as object
        attemptAuthority = descriptors.attempt!.value as DrainAttemptAuthority
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
    if (!actionAuthority || typeof actionAuthority !== 'object' || !attemptAuthority || typeof attemptAuthority !== 'object') return undefined
    const reset = pendingResetActions.get(actionAuthority)
    const teardown = pendingTeardownActions.get(actionAuthority)
    const pending = reset ?? teardown
    if (!pending) return undefined
    const candidate = inspectDrainAttemptAuthority(attemptAuthority)
    if (!candidate || candidate.attempt.status !== 'active' || candidate.attempt.currentStage !== 'reclaim') return undefined
    const targetId = reset ? `${reset.target.kind}:${reset.target.identity}` : `${teardown!.target.kind}:${teardown!.target.id}`
    const reclaimTargets = candidate.reservation.actions.filter(({ stage }) => stage === 'reclaim').map(({ targetId: id }) => id)
    const action = candidate.reservation.actions[candidate.attempt.actionIndex]
    if (candidate.reservation.purpose !== (reset ? 'reset' : 'down')
        || candidate.reservation.stackId !== pending.step.labels.stackId
        || candidate.reservation.configSha256 !== pending.step.labels.configSha256
        || candidate.reservation.planDigest !== pending.planDigest
        || candidate.attempt.reservationId !== candidate.reservation.reservationId
        || candidate.attempt.purpose !== candidate.reservation.purpose
        || candidate.attempt.generation !== candidate.reservation.generation
        || candidate.attempt.actionIndex !== pending.removedTargetIds.length + 1
        || action?.stage !== 'reclaim' || action.targetId !== targetId
        || candidate.attempt.currentTarget !== targetId
        || !sameStrings(reclaimTargets, pending.targetIds)) return undefined
    const pathIdentity = pending.targetIdentities.find((identity): identity is PathTargetIdentity =>
        identity.targetId === targetId && identity.medium === 'path')
    const identityCheck = pathIdentity === undefined ? undefined : await identityBoundFilesystemCheck(pathIdentity)
    if (pathIdentity !== undefined && identityCheck === undefined) return undefined
    const validThroughMs = Date.parse(candidate.attempt.validThrough)
    const remainingMs = validThroughMs - Date.now()
    if (!Number.isSafeInteger(validThroughMs) || remainingMs < 1) return undefined
    const step = snapshotExecutionStep({
        ...pending.step,
        timeoutMs: Math.min(pending.step.timeoutMs, remainingMs),
        spawnNotAfter: candidate.attempt.validThrough,
        filesystemChecks: identityCheck === undefined ? pending.step.filesystemChecks : [identityCheck],
    })
    if (step === undefined) return undefined
    const targetIdentities = pending.targetIdentities
    const resetContinuation = reset ? resetContinuations.get(pending.continuation) : undefined
    const teardownContinuation = teardown ? teardownContinuations.get(pending.continuation) : undefined
    if (reset && resetContinuation === undefined || teardown && teardownContinuation === undefined) return undefined
    const execution = openReclaimDrainExecution({
        authority: attemptAuthority, candidate,
        planningRecord: pending.coordinationRecord, continuation: pending.continuation,
    })
    if (!execution) return undefined
    const fence = inspectDrainExecutionFence(execution)
    const fencedStep = fence && snapshotExecutionStep({ ...step, executionFence: fence })
    if (!fencedStep) return undefined
    pendingResetActions.delete(actionAuthority)
    pendingTeardownActions.delete(actionAuthority)
    consumedPendingTeardownActions.add(actionAuthority)
    const authority = Object.freeze({})
    pendingReclaimExecutions.set(authority, Object.freeze({
        step: fencedStep, targetId,
        reservation: candidate.reservation, attempt: candidate.attempt, execution, continuation: pending.continuation,
        targetIds: pending.targetIds, removedTargetIds: pending.removedTargetIds,
        targetIdentities,
    }))
    return Object.freeze({ step: fencedStep, authority })
}

export const redeemTeardownAction = redeemReclaimAction

export function redeemAbsentReclaimAction(input: {
    readonly actionAuthority: object
    readonly attempt: DrainAttemptAuthority
}): { readonly authority: object } | undefined {
    try {
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 2 || !('value' in descriptors.actionAuthority!)
            || !('value' in descriptors.attempt!)) return undefined
        const actionAuthority = descriptors.actionAuthority!.value as object
        const attemptAuthority = descriptors.attempt!.value as DrainAttemptAuthority
        const pending = pendingAbsentReclaimActions.get(actionAuthority)
        const candidate = inspectDrainAttemptAuthority(attemptAuthority)
        if (!pending || !candidate || candidate.attempt.status !== 'active'
            || candidate.attempt.currentStage !== 'reclaim'
            || candidate.reservation.purpose !== pending.purpose
            || candidate.reservation.stackId !== pending.stackId
            || candidate.reservation.configSha256 !== pending.configSha256
            || candidate.reservation.planDigest !== pending.planDigest
            || candidate.attempt.currentTarget !== pending.targetId
            || candidate.attempt.actionIndex !== pending.removedTargetIds.length + 1
            || !sameStrings(candidate.reservation.actions.filter(({ stage }) => stage === 'reclaim')
                .map(({ targetId }) => targetId), pending.targetIds)) return undefined
        const execution = openReclaimDrainExecution({ authority: attemptAuthority, candidate,
            planningRecord: pending.coordinationRecord, continuation: pending.continuation })
        if (!execution) return undefined
        pendingAbsentReclaimActions.delete(actionAuthority)
        const authority = Object.freeze({})
        absentReclaimExecutions.set(authority, { pending, execution,
            reservation: candidate.reservation, attempt: candidate.attempt })
        return Object.freeze({ authority })
    } catch {
        // Any failure leaves the authority unminted; the caller refuses a missing authority.
        return undefined
    }
}

export async function reconcileAbsentReclaimAction(input: {
    readonly authority: object
    readonly discovery: ReclaimDiscoverySnapshot
}): Promise<ReconcileTeardownActionResult> {
    try {
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 2 || !('value' in descriptors.authority!)
            || !('value' in descriptors.discovery!)) throw new RefusalError('invalid input')
        const authority = descriptors.authority!.value as object
        const discovery = descriptors.discovery!.value as ReclaimDiscoverySnapshot
        const issued = absentReclaimExecutions.get(authority)
        if (!issued) throw new RefusalError('unissued absence action')
        absentReclaimExecutions.delete(authority)
        const { pending, reservation, attempt, execution } = issued
        const observed = sameRuntimeAuthority(discovery, pending.runtime.stackId, pending.runtime.executable,
            pending.runtime.cwd, pending.runtime.env, pending.runtime.selection)
        if (!observed || !admittedDiscoveries.has(discovery)) throw new RefusalError('unissued absence discovery')
        const remainder = reservation.actions.slice(attempt.actionIndex + 1)
            .filter(({ stage }) => stage === 'reclaim').map(({ targetId }) => targetId)
        const completed = new Set([...pending.removedTargetIds, pending.targetId])
        const remaining = await pending.remainingTargets(discovery)
        if (Date.parse(observed.startedAt) <= Date.parse(pending.runtime.finishedAt)
            || Date.parse(observed.startedAt) < Date.parse(attempt.committedAt)
            || Date.parse(observed.startedAt) > Date.parse(observed.finishedAt)
            || Date.parse(observed.finishedAt) > Date.parse(attempt.validThrough)
            || Date.parse(observed.finishedAt) > Date.now()
            || !remaining || !sameStrings(remaining, remainder)
            || !sameStrings([...completed, ...remainder].sort(lexical), pending.targetIds)
            || !pending.targetIdentities.every(identity => completed.has(identity.targetId)
                ? targetIsAbsent(identity, discovery.resources)
                : remainder.includes(identity.targetId) && sameTargetIdentity(identity, discovery.resources))) {
            throw new RefusalError('fresh absence evidence does not match the reserved target set')
        }
        consumeAuthority(observed)
        const settled = settleReclaimDrainSuccess({ authority: execution,
            fact: reclaimCompletionFact(reservation, attempt, observed.finishedAt, remainder) })
        if (!settled) throw new RefusalError('absence completion authority is unavailable')
        if (remainder.length > 0) reconciledContinuationDiscoveries.set(pending.continuation, observed)
        const resultAuthority = Object.freeze({})
        issuedReclaimCompleted.set(resultAuthority, settled)
        return Object.freeze({ kind: 'complete', continuation: remainder.length === 0 ? null : pending.continuation,
            authority: resultAuthority })
    } catch (error) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH,
            `fresh discovery did not prove the exact interrupted removal and remaining target set: ${errorCause(error)}`, 'reclaim-reconciliation')
    }
}

export type ReconcileTeardownActionResult =
    | { readonly kind: 'complete'; readonly continuation: object | null; readonly authority: object | null }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
}

function samePathTargetIdentity(expected: PathTargetIdentity): boolean {
    try {
        for (const ancestor of expected.ancestors) {
            const current = lstatSync(ancestor.path, { bigint: true })
            if (!current.isDirectory() || current.isSymbolicLink() || !sameFilesystemObject(current, ancestor)) return false
        }
        const current = lstatSync(expected.path, { bigint: true })
        const type = current.isDirectory() ? 'directory' : current.isFile() ? 'file' : undefined
        return type === expected.type && sameFilesystemObject(current, expected)
    } catch {
        // A path that cannot be re-identified no longer matches the recorded identity.
        return false
    }
}

function pathIsAbsent(path: string): boolean {
    try { lstatSync(path); return false } catch (error) { return hasErrorCode(error, 'ENOENT') }
}

function selectedRuntimeResources(
    identity: ResetVolumeTargetIdentity | TeardownRuntimeTargetIdentity,
    resources: readonly ReclaimResource[],
): readonly ReclaimResource[] {
    return resources.filter((resource) => resource.kind === identity.kind
        && (identity.scope === 'teardown-runtime' ? resource.id === identity.runtimeId : resource.name === identity.name))
}

function sameTargetIdentity(identity: ReclaimTargetIdentity, resources: readonly ReclaimResource[]): boolean {
    if (identity.medium === 'path') return samePathTargetIdentity(identity)
    const observed = selectedRuntimeResources(identity, resources)
    if (observed.length !== 1) return false
    const [resource] = observed
    const common = resource!.id === identity.runtimeId
        && resource!.name === identity.name
        && digestValue(canonicalLabels(resource!.labels)) === digestValue(identity.labels)
        && (resource!.generation ?? null) === identity.generation
    return identity.scope === 'reset-volume' ? common
        : common && resource!.referenced === identity.referenced
            && (resource!.dataBearing ?? null) === identity.dataBearing
}

function sameTargetProjections(
    observed: readonly ReclaimTargetIdentity[],
    original: readonly ReclaimTargetIdentity[],
    targetIds: readonly string[],
): boolean {
    if (observed.length !== targetIds.length) return false
    return targetIds.every((targetId) => {
        const current = observed.filter((identity) => identity.targetId === targetId)
        const retained = original.filter((identity) => identity.targetId === targetId)
        return current.length === 1 && retained.length === 1 && digestValue(current[0]) === digestValue(retained[0])
    })
}

function targetIsAbsent(identity: ReclaimTargetIdentity, resources: readonly ReclaimResource[]): boolean {
    if (identity.medium === 'path') return pathIsAbsent(identity.path)
    return identity.scope === 'reset-volume'
        ? resources.every((resource) => resource.id !== identity.runtimeId
            && (resource.kind !== 'volume' || resource.name !== identity.name))
        : resources.every((resource) => resource.id !== identity.runtimeId
            && (resource.kind !== identity.kind || resource.name !== identity.name))
}

export function admitReclaimFailure(input: {
    readonly authority: object
    readonly outcome: ExecuteProbeOutcome
}): { readonly kind: 'complete'; readonly authority: object; readonly continuation: object } | { readonly kind: 'unavailable'; readonly reason: string } {
    try {
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 2 || !('value' in descriptors.authority!) || !('value' in descriptors.outcome!)) {
            return Object.freeze({ kind: 'unavailable', reason: 'reclaim failure evidence is unavailable' })
        }
        const executionAuthority = descriptors.authority!.value as object
        if (!executionAuthority || typeof executionAuthority !== 'object') {
            return Object.freeze({ kind: 'unavailable', reason: 'reclaim failure evidence is unavailable' })
        }
        const pending = pendingReclaimExecutions.get(executionAuthority)
        const suppliedOutcome = descriptors.outcome!.value as ExecuteProbeOutcome
        const outcome = pending ? authenticatedExecutionOutcome(suppliedOutcome, pending.step) : undefined
        if (pending) pendingReclaimExecutions.delete(executionAuthority)
        if (!pending || !outcome || outcome.kind !== 'refusal' || outcome.receipt !== undefined
            || outcome.execution.started || outcome.execution.signal !== null || outcome.execution.exitCode === 0) {
            return Object.freeze({ kind: 'unavailable', reason: 'reclaim failure evidence is unavailable' })
        }
        const reset = resetContinuations.get(pending.continuation)
        const teardown = teardownContinuations.get(pending.continuation)
        if (reset === undefined && teardown === undefined) {
            return Object.freeze({ kind: 'unavailable', reason: 'reclaim failure evidence is unavailable' })
        }
        const failedAt = new Date().toISOString()
        const fact = Object.freeze({ ...pending.attempt, failedAt }) satisfies DrainAttemptFailure
        const settled = settleReclaimDrainFailure({ authority: pending.execution, fact })
        if (!settled) return Object.freeze({ kind: 'unavailable', reason: 'reclaim failure evidence is unavailable' })
        const authority = Object.freeze({})
        issuedReclaimFailures.set(authority, settled)
        return Object.freeze({ kind: 'complete', authority, continuation: pending.continuation })
    } catch (error) {
        return Object.freeze({ kind: 'unavailable', reason: `reclaim failure evidence is unavailable: ${errorCause(error)}` })
    }
}

export function consumeReclaimFailure(authority: object): DrainOutcomeAuthority | undefined {
    if (!authority || typeof authority !== 'object') return undefined
    const fact = issuedReclaimFailures.get(authority)
    if (!fact) return undefined
    issuedReclaimFailures.delete(authority)
    return fact
}

function reclaimCompletionFact(
    reservation: DrainReservation,
    attempt: NonNullable<DrainReservation['attempt']>,
    observedAt: string,
    remainingTargetIds: readonly string[],
): ReclaimCompleted {
    return Object.freeze({
        purpose: reservation.purpose,
        stackId: reservation.stackId,
        configSha256: reservation.configSha256,
        planDigest: reservation.planDigest,
        operationBasis: reservation.operationBasis,
        coordinationRevision: reservation.coordinationRevision,
        reservationId: reservation.reservationId,
        reservedAt: reservation.reservedAt,
        generation: reservation.generation,
        attemptId: attempt.attemptId,
        attemptRevision: attempt.committedRevision,
        attemptCommittedAt: attempt.committedAt,
        validThrough: attempt.validThrough,
        actionIndex: attempt.actionIndex,
        currentTarget: attempt.currentTarget,
        currentStage: attempt.currentStage,
        observedAt: observedAt,
        remainingTargetIds: Object.freeze([...remainingTargetIds]),
    }) satisfies ReclaimCompleted
}

export function reconcileReclaimAction(input: {
    readonly authority: object
    readonly outcome: ExecuteProbeOutcome
    readonly discovery: ReclaimDiscoverySnapshot
}): ReconcileTeardownActionResult {
    let authority: object | undefined
    let outcomeInput: ExecuteProbeOutcome | undefined
    let discovery: ReclaimDiscoverySnapshot | undefined
    try {
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 3 || !('value' in descriptors.authority!)
            || !('value' in descriptors.outcome!) || !('value' in descriptors.discovery!)) throw new RefusalError('invalid input')
        authority = descriptors.authority!.value as object
        outcomeInput = descriptors.outcome!.value as ExecuteProbeOutcome
        discovery = descriptors.discovery!.value as ReclaimDiscoverySnapshot
    } catch (error) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, `reclaim reconciliation input is malformed: ${errorCause(error)}`, 'reclaim-reconciliation')
    }
    if (authority === null || typeof authority !== 'object') {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reclaim reconciliation authority is missing or stale', 'reclaim-reconciliation')
    }
    const pending = pendingReclaimExecutions.get(authority)
    const discoveryAuthority = discovery !== null && typeof discovery === 'object' ? discoveryAuthorities.get(discovery) : undefined
    if (!pending || !discoveryAuthority || !admittedDiscoveries.has(discovery)
        || discoveryAuthority.stackId !== pending.reservation.stackId) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reclaim reconciliation authority is missing or stale', 'reclaim-reconciliation')
    }
    pendingReclaimExecutions.delete(authority)
    const outcome = authenticatedExecutionOutcome(outcomeInput!, pending.step)
    const expectedRemainder = pending.reservation.actions.slice(pending.attempt.actionIndex + 1)
        .filter(({ stage }) => stage === 'reclaim').map(({ targetId }) => targetId)
    const completedIds = new Set([...pending.removedTargetIds, pending.targetId])
    const expectedRemainderIds = new Set(expectedRemainder)
    const remainingEvidenceMatches = pending.targetIdentities.length === pending.targetIds.length
        && pending.targetIdentities.every((identity) => completedIds.has(identity.targetId)
            ? targetIsAbsent(identity, discovery!.resources)
            : expectedRemainderIds.has(identity.targetId) && sameTargetIdentity(identity, discovery!.resources))
    if (!outcome || outcome.kind !== 'complete' || outcome.stderr.byteLength !== 0 || !outcome.receipt
        || consumedExecutionReceipts.has(outcome.receipt)
        || Date.parse(outcome.receipt.startedAt) < Date.parse(pending.attempt.committedAt)
        || Date.parse(outcome.receipt.startedAt) > Date.parse(outcome.receipt.finishedAt)
        || Date.parse(outcome.receipt.finishedAt) > Date.parse(pending.attempt.validThrough)
        || Date.parse(outcome.receipt.finishedAt) > Date.parse(discoveryAuthority.startedAt)
        || Date.parse(discoveryAuthority.startedAt) > Date.parse(discoveryAuthority.finishedAt)
        || Date.parse(discoveryAuthority.finishedAt) > Date.parse(pending.attempt.validThrough)
        || Date.parse(discoveryAuthority.finishedAt) > Date.now()
        || !sameStrings([...completedIds, ...expectedRemainder].sort(lexical), pending.targetIds)
        || !remainingEvidenceMatches) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'fresh discovery did not prove the exact reserved removal set', 'reclaim-reconciliation')
    }
    consumedExecutionReceipts.add(outcome.receipt)
    consumeAuthority(discoveryAuthority)
    const fact = reclaimCompletionFact(pending.reservation, pending.attempt, discoveryAuthority.finishedAt, expectedRemainder)
    const settled = settleReclaimDrainSuccess({ authority: pending.execution, fact })
    if (!settled) return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reclaim completion authority is unavailable', 'reclaim-reconciliation')
    if (expectedRemainder.length > 0) reconciledContinuationDiscoveries.set(pending.continuation, discoveryAuthority)
    const resultAuthority = Object.freeze({})
    issuedReclaimCompleted.set(resultAuthority, settled)
    return Object.freeze({
        kind: 'complete', continuation: expectedRemainder.length === 0 ? null : pending.continuation, authority: resultAuthority,
    })
}

export function consumeReclaimCompleted(authority: object): DrainOutcomeAuthority | undefined {
    if (!authority || typeof authority !== 'object') return undefined
    const fact = issuedReclaimCompleted.get(authority)
    if (!fact) return undefined
    issuedReclaimCompleted.delete(authority)
    return fact
}
