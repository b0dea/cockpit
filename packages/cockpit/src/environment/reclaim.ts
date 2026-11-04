import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { admitLocalDockerEndpoint } from './docker-endpoint.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import {
    decodeCoordinationRecord,
    inspectFailedReclaimRecovery,
    matchReclaimDrainContinuation,
    reclaimDrainStep,
    type DrainOutcome,
    type DrainReservation,
    type ReclaimDrainStep,
    type ReservedDrainAttempt,
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
    type ExecutionFence,
    type ExecutionReceipt,
    type ExecutionStep,
    type FilesystemAncestorIdentity,
    type FilesystemCheck,
    type StackId,
} from './contract.js'
import type { ResolvedExecutable } from './executable.js'
import { resolvedDockerExecutable, resolvedExecutable } from './executable.js'
import { readState, type StateAddress, type StateRecord } from './state.js'
import { exactKeys } from '../exact-keys.js'

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
const DAEMON_ENV = /^(?:DOCKER|BUILDX|CONTAINER|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)(?:_|$)/i
const SAFE_ENV = new Set(['PATH', 'TMPDIR', 'LANG', 'LC_ALL'])
// A discovery may legitimately contain thousands of resources. Each inspection launches a Docker
// client, so one shared bound covers every resource kind rather than letting each kind
// independently saturate the daemon.
const MAX_CONCURRENT_INSPECTIONS = 4
const DISCOVERY_KINDS = ['container', 'network', 'volume', 'image', 'build-cache'] as const

type Executor = (step: ExecutionStep) => Promise<ExecuteProbeOutcome>

export interface DockerSelection {
    readonly context: string
    readonly endpoint: string
}

/** One complete discovery of a stack's runtime resources, as `discoverReclaim` observed it. */
export interface ReclaimDiscovery extends ReclaimDiscoverySnapshot {
    readonly startedAt: string
    readonly stackId: StackId
    readonly selection: DockerSelection
}

/** What a person or the planner itself approved: the digest, and the discovery it was read from. */
export interface ReclaimConsent {
    readonly digest: string
    readonly observedAt: string
}

/**
 * The remaining committed target set of a drain after one action, carried from that action's plan
 * to the next. `drain` is the attempt the action ran under, which the next plan matches against
 * the record its outcome published; null until the action runs.
 */
export interface ReclaimContinuation {
    readonly purpose: 'down' | 'reset'
    readonly digest: string
    readonly completedTargetId: string
    readonly runtimeDigest: string
    readonly targetIds: readonly string[]
    readonly removedTargetIds: readonly string[]
    readonly targetIdentities: readonly ReclaimTargetIdentity[]
    /** A discovery that plans the next action must start no earlier than this. */
    readonly freshAfter: string
    readonly drain: ReclaimDrainStep | null
}

/** The one removal a plan permits, executed only by `executeReclaimAction` under a reserved attempt. */
export interface PlannedReclaimAction {
    readonly stackId: StackId
    readonly configSha256: string
    /** Null when the interrupted target is already absent and only its removal is recorded. */
    readonly step: ExecutionStep | null
    readonly coordinationRecord: StateRecord
    readonly continuation: ReclaimContinuation
    readonly observedAt: string
    /** For an absent target: the actionable target ids a later discovery still shows. */
    readonly remainingTargets?: (discovery: ReclaimDiscovery) => Promise<readonly string[] | undefined>
}

export type ReclaimTargetIdentity = ResetVolumeTargetIdentity | TeardownRuntimeTargetIdentity | PathTargetIdentity

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
    return { severity: 'error', code, message, target, ...(fix ? { fix } : {}) }
}

function refuse(code: EnvironmentCode, message: string, target: string, fix?: string): ReclaimResult {
    return { kind: 'refusal', diagnostics: [diagnostic(code, message, target, fix)] }
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
    return {
        id: candidate.id,
        name: candidate.name,
        kind: candidate.kind as ReclaimResourceKind,
        labels: { ...candidate.labels },
        referenced: candidate.referenced,
        bytes: candidate.bytes as number | null,
        ...(candidate.dataBearing === undefined ? {} : { dataBearing: candidate.dataBearing }),
        ...(candidate.generation === undefined ? {} : { generation: candidate.generation }),
    }
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
        || input.discovery === null || typeof input.discovery !== 'object' || Array.isArray(input.discovery)) return undefined
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
    return {
        stackId: input.stackId as StackId,
        cockpitId: input.cockpitId as CockpitId,
        configSha256: input.configSha256,
        coordinationRecord: coordinationRecord as StateRecord | null,
        declaredCacheIds: [...input.declaredCacheIds] as readonly string[],
        discovery: {
            observedAt: discovery.observedAt,
            producer: 'runtime-resource-discovery' as const,
            resources: resources as ReclaimResource[],
        },
    }
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
    return {
        command: `docker ${noun} rm -- ${shellQuote(resource.id)}`,
        risk: `${ownership} ${resource.kind} is not owned for automatic removal; verify its consumers before running this exact command`,
    }
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
        return {
            ...resource,
            ownership: evidence.ownership,
            reversibility: reverse,
            action,
            evidence: [...evidence.evidence],
            reason: evidence.reason,
            ...(action === 'report-only' ? { suggestion: suggestion(resource, evidence.ownership) } : {}),
        }
    }).sort((left, right) => lexical(left.id, right.id))
    return { kind: 'complete', noop: resources.length === 0, resources }
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
    return classified.resources
        .filter(({ kind, ownership, action }) => kind !== 'volume' && action === 'report-only'
            && (ownership === 'current' || ownership === 'stale-config'))
        .map(({ kind, id, name, referenced, reason }) => ({
            kind, id, name,
            reason: !referenced ? reason
                : kind === 'network' ? 'a container outside this stack is still attached to it'
                    : kind === 'image' ? 'it is tagged under more than one name, so another name may still need it'
                        : 'something outside this stack still uses it',
        }))
}

function safeEnvironment(value: unknown): Readonly<Record<string, string>> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const entries = Object.entries(value)
    if (entries.some(([key, item]) => !key || key.includes('\0') || key.includes('=') || DAEMON_ENV.test(key)
        || typeof item !== 'string' || item.includes('\0'))) return undefined
    return Object.fromEntries(entries.filter(([key]) => SAFE_ENV.has(key)).sort(([a], [b]) => lexical(a, b)))
}

const contextSelectionFormat = '{"context":{{json .Name}},"endpoint":{{json .Endpoints.docker.Host}}}'

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
    return labels
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
        ? row.labels !== null && typeof row.labels === 'object' && !Array.isArray(row.labels) && exactKeys(row.labels, []) ? {} : undefined
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
    authority: DiscoveryRuntime,
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

function networkHolderSteps(authority: DiscoveryRuntime, names: readonly string[], labels: Readonly<Record<string, string>>): readonly (ExecutionStep | undefined)[] {
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

export interface ReclaimDiscoveryInput {
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly stackId: StackId
    readonly cockpitId: CockpitId
    readonly timeoutMs: number
    readonly context: string
    /** A local DOCKER_HOST, selected through Docker's `default` context, which reports it exactly. */
    readonly host?: string
}

interface DiscoveryRuntime {
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly stackId: StackId
    readonly cockpitId: CockpitId
    readonly selection: DockerSelection
}

interface Timed<T> {
    readonly value: T
    readonly startedAt: string
    readonly finishedAt: string
}

type DiscoveryRefusal = { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

/** Complete, empty-stderr output of one step, or nothing. */
function cleanOutput(outcome: ExecuteProbeOutcome): Extract<ExecuteProbeOutcome, { kind: 'complete' }> | undefined {
    return outcome.kind === 'complete' && outcome.stderr.byteLength === 0 ? outcome : undefined
}

function utf8(bytes: Buffer): string | undefined {
    const text = bytes.toString('utf8')
    return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined
}

function boundedExecutor(execute: Executor, concurrency: number): Executor {
    let active = 0
    const waiters: Array<() => void> = []
    return async (step) => {
        if (active < concurrency) active += 1
        else await new Promise<void>(resolveWaiter => waiters.push(resolveWaiter))
        try {
            return await execute(step)
        } finally {
            const next = waiters.shift()
            if (next) next()
            else active -= 1
        }
    }
}

async function selectDocker(
    input: Pick<ReclaimDiscoveryInput, 'context' | 'host' | 'cwd' | 'timeoutMs'>,
    executable: ResolvedExecutable,
    env: Readonly<Record<string, string>>,
    execute: Executor,
): Promise<Timed<DockerSelection> | undefined> {
    // Only the selection reads DOCKER_HOST; discovery and actions address the admitted endpoint
    // with --host, so every other step keeps a daemon-free environment.
    const selectionEnv = input.host === undefined ? env : { ...env, DOCKER_HOST: input.host }
    const step = exactStep('runtime:select:context', [executable.canonicalPath, 'context', 'inspect', input.context, '--format', contextSelectionFormat],
        executable, input.cwd, selectionEnv, input.timeoutMs, [], { selectionKind: 'context' })
    if (step === undefined) return undefined
    const outcome = cleanOutput(await execute(step))
    const row = outcome === undefined ? undefined : selectionRow(outcome.stdout)
    if (outcome === undefined || row === undefined || !exactKeys(row, ['context', 'endpoint'])
        || row.context !== input.context
        || typeof row.endpoint !== 'string' || admitLocalDockerEndpoint(row.endpoint) === undefined
        || input.host !== undefined && row.endpoint !== input.host) return undefined
    return { value: { context: input.context, endpoint: row.endpoint }, startedAt: outcome.receipt.startedAt, finishedAt: outcome.receipt.finishedAt }
}

async function listResources(
    runtime: DiscoveryRuntime,
    kind: Exclude<ReclaimResourceKind, 'cache'>,
    execute: Executor,
): Promise<Timed<readonly ReclaimResource[]> | undefined> {
    const step = exactStep(`runtime:discover:${kind}`,
        [runtime.executable.canonicalPath, ...runtimeCommand(kind, runtime.selection, runtime.stackId)],
        runtime.executable, runtime.cwd, runtime.env, runtime.timeoutMs, [], {
            stackId: runtime.stackId, cockpitId: runtime.cockpitId, resourceKind: kind,
            dockerContext: runtime.selection.context, dockerEndpoint: runtime.selection.endpoint,
        }, [], OUTPUT_LIMIT)
    if (step === undefined) return undefined
    const outcome = cleanOutput(await execute(step))
    const text = outcome === undefined ? undefined : utf8(outcome.stdout)
    if (outcome === undefined || text === undefined) return undefined
    const resources: ReclaimResource[] = []
    for (const line of text.split('\n')) {
        if (line.length === 0) continue
        // Unparseable docker output is unproven; the discovery fails closed.
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
            resources.splice(resources.indexOf(duplicate), 1, { ...duplicate, referenced: true, name: [duplicate.name, owned.name].sort(lexical)[0]! })
            continue
        }
        resources.push(owned)
    }
    if (resources.length > MAX_RESOURCES || new Set(resources.map(({ id }) => id)).size !== resources.length) return undefined
    return { value: resources.sort((a, b) => lexical(a.id, b.id)), startedAt: outcome.receipt.startedAt, finishedAt: outcome.receipt.finishedAt }
}

/** Runs one kind's inspection steps; an oversized object names its chunk instead of failing anonymously. */
async function runInspections(
    steps: readonly (ExecutionStep | undefined)[],
    kind: string,
    execute: Executor,
): Promise<readonly { readonly step: ExecutionStep; readonly outcome: Extract<ExecuteProbeOutcome, { kind: 'complete' }> }[] | DiscoveryRefusal | undefined> {
    if (steps.some((step) => step === undefined)) return undefined
    const attempts = await Promise.allSettled((steps as ExecutionStep[]).map(async (step) => ({ step, outcome: await execute(step) })))
    if (attempts.some(({ status }) => status === 'rejected')) return undefined
    const evidence = attempts.map((attempt) => (attempt as PromiseFulfilledResult<{ step: ExecutionStep; outcome: ExecuteProbeOutcome }>).value)
    const overflow = evidence.map(({ step, outcome }) => inspectionOverflow(step, outcome)).find((message) => message !== undefined)
    if (overflow !== undefined) return refusal(ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT, overflow, kind)
    const clean = evidence.map(({ step, outcome }) => ({ step, outcome: cleanOutput(outcome) }))
    return clean.every(({ outcome }) => outcome !== undefined)
        ? clean as { step: ExecutionStep; outcome: Extract<ExecuteProbeOutcome, { kind: 'complete' }> }[] : undefined
}

async function inspectImages(runtime: DiscoveryRuntime, images: readonly ReclaimResource[], execute: Executor) {
    const evidence = await runInspections(inspectionSteps(runtime, 'image', imageInspectionFormat(), images.map(({ id }) => id), {
        resourceKind: 'image-inspection', dockerContext: runtime.selection.context, dockerEndpoint: runtime.selection.endpoint,
    }), 'image', execute)
    if (evidence === undefined || 'diagnostics' in evidence) return evidence
    const labels = new Map<string, Readonly<Record<string, string>>>()
    for (const { step, outcome } of evidence) {
        const ids = inspectedIds(step)
        const rows = inspectionRows(outcome.stdout, ids)
        if (rows === undefined) return undefined
        for (const [position, record] of rows.entries()) {
            const resourceId = ids[position]!
            const observedLabels = exactKeys(record, ['id', 'labels']) ? dockerLabels(record.labels) : undefined
            if (record.id !== resourceId || observedLabels === undefined || labels.has(resourceId)) return undefined
            labels.set(resourceId, observedLabels)
        }
    }
    return { value: images.map((resource) => snapshotResource({ ...resource, labels: labels.get(resource.id) ?? resource.labels })!), finishedAt: latest(evidence) }
}

async function inspectVolumes(runtime: DiscoveryRuntime, volumes: readonly ReclaimResource[], execute: Executor) {
    // Only a volume this stack labels can become a target, so only its generation is read.
    const owned = volumes.filter(({ labels }) => labels[REQUIRED_LABELS.stack] === runtime.stackId)
    const evidence = await runInspections(inspectionSteps(runtime, 'volume',
        `{"name":{{json .Name}},"generation":{{with .Labels}}{{json (or (index . "dev.b0dea.cockpit.generation-id") "")}}{{else}}""{{end}}}`,
        owned.map(({ id }) => id), { resourceKind: 'volume-inspection' }), 'volume', execute)
    if (evidence === undefined || 'diagnostics' in evidence) return evidence
    const generations = new Map<string, string>()
    for (const { step, outcome } of evidence) {
        const ids = inspectedIds(step)
        const rows = inspectionRows(outcome.stdout, ids)
        if (rows === undefined) return undefined
        for (const [position, record] of rows.entries()) {
            if (!exactKeys(record, ['name', 'generation'])) return undefined
            const { name, generation } = record
            if (name !== ids[position] || typeof generation !== 'string'
                || generation.length > 128 || generation.includes('\0') || generations.has(name)) return undefined
            if (generation !== '' && !SHA256.test(generation)) return undefined
            generations.set(name, generation)
        }
    }
    return {
        value: volumes.map((resource) => {
            const generation = generations.get(resource.id)
            return snapshotResource({ ...resource, ...(generation === undefined || generation === '' ? {} : { generation }) })!
        }),
        finishedAt: latest(evidence),
    }
}

async function inspectNetworks(runtime: DiscoveryRuntime, networks: readonly ReclaimResource[], containers: readonly ReclaimResource[], execute: Executor) {
    const selection = { dockerContext: runtime.selection.context, dockerEndpoint: runtime.selection.endpoint }
    const names = [...new Set(networks.map(({ name }) => name))].sort(lexical)
    if (names.some((name) => !NETWORK_NAME.test(name))) return undefined
    const evidence = await runInspections([
        ...inspectionSteps(runtime, 'network', networkInspectionFormat(), networks.map(({ id }) => id), { resourceKind: 'network-inspection', ...selection }),
        ...networkHolderSteps(runtime, names, { resourceKind: 'network-holder-listing', ...selection }),
    ], 'network', execute)
    if (evidence === undefined || 'diagnostics' in evidence) return evidence
    const containersById = new Map(containers.map((container) => [container.id, container]))
    const holders = new Map<string, Set<string>>()
    const inspectedNetworks = new Set<string>()
    const hold = (networkId: string, containerId: string) => {
        holders.set(networkId, (holders.get(networkId) ?? new Set()).add(containerId))
    }
    for (const { step, outcome } of evidence) {
        if (step.labels.resourceKind === 'network-inspection') {
            const ids = inspectedIds(step)
            const rows = inspectionRows(outcome.stdout, ids)
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
            const rows = holderRows(outcome.stdout)
            if (rows === undefined) return undefined
            for (const row of rows) {
                // A created but never started container (as an interrupted Compose recreate leaves
                // its replacement) still names its networks, so it holds every discovered network
                // of that name; refusing the whole discovery left `down` unable to remove the
                // stack that `up` had started.
                for (const name of row.networks) {
                    for (const network of networks) if (network.name === name) hold(network.id, row.id)
                }
            }
        }
    }
    return {
        value: networks.map((resource) => snapshotResource({
            ...resource, referenced: [...holders.get(resource.id) ?? []].some((holder) => !sameStackHolder(resource, containersById.get(holder))),
        })!),
        finishedAt: latest(evidence),
    }
}

function latest(evidence: readonly { readonly outcome: Extract<ExecuteProbeOutcome, { kind: 'complete' }> }[]): string | undefined {
    return evidence.map(({ outcome }) => outcome.receipt.finishedAt).sort(lexical).at(-1)
}

function sameSelection(left: DockerSelection, right: DockerSelection): boolean {
    return left.context === right.context && left.endpoint === right.endpoint
}

async function discoverReclaimRound(
    input: ReclaimDiscoveryInput,
    executable: ResolvedExecutable,
    env: Readonly<Record<string, string>>,
    execute: Executor,
): Promise<ReclaimDiscovery | DiscoveryRefusal | undefined> {
    // The selection is read before and after the listings, and again after the inspections, so the
    // context's endpoint cannot have moved to another daemon while this stack was being read.
    const planned = await selectDocker(input, executable, env, execute)
    if (planned === undefined) return undefined
    const runtime: DiscoveryRuntime = {
        executable, cwd: input.cwd, env, timeoutMs: input.timeoutMs,
        stackId: input.stackId, cockpitId: input.cockpitId, selection: planned.value,
    }
    const listed = await Promise.all(DISCOVERY_KINDS.map((kind) => listResources(runtime, kind, execute)))
    if (listed.some((value) => value === undefined)) return undefined
    const lists = listed as Timed<readonly ReclaimResource[]>[]
    const listedAt = lists.map(({ finishedAt }) => finishedAt).sort(lexical).at(-1)!
    const current = await selectDocker(input, executable, env, execute)
    if (current === undefined || !sameSelection(current.value, planned.value)
        || Date.parse(current.startedAt) < Date.parse(listedAt)
        || Date.parse(current.finishedAt) - Date.parse(listedAt) > 30_000) return undefined
    const [containers, networks, volumes, images, buildCache] = lists.map(({ value }) => value) as [
        readonly ReclaimResource[], readonly ReclaimResource[], readonly ReclaimResource[], readonly ReclaimResource[], readonly ReclaimResource[],
    ]
    const inspect = boundedExecutor(execute, MAX_CONCURRENT_INSPECTIONS)
    const inspected = await Promise.all([
        inspectNetworks(runtime, networks, containers, inspect),
        inspectVolumes(runtime, volumes, inspect),
        inspectImages(runtime, images, inspect),
    ])
    const refused = inspected.find((value): value is DiscoveryRefusal => value !== undefined && 'diagnostics' in value)
    if (refused) return refused
    if (inspected.some((value) => value === undefined)) return undefined
    const [inspectedNetworks, inspectedVolumes, inspectedImages] = inspected as { value: ReclaimResource[]; finishedAt: string | undefined }[]
    const resources = [...containers, ...inspectedNetworks!.value, ...inspectedVolumes!.value, ...inspectedImages!.value, ...buildCache]
        .sort((left, right) => lexical(left.id, right.id))
    if (resources.length > MAX_RESOURCES || new Set(resources.map(({ id }) => id)).size !== resources.length) return undefined
    const startedAt = lists.map(({ startedAt: listStarted }) => listStarted).sort(lexical)[0]!
    const finishedAt = [listedAt, ...inspected.map((value) => (value as { finishedAt: string | undefined }).finishedAt)]
        .filter((value): value is string => value !== undefined).sort(lexical).at(-1)!
    if (Date.parse(finishedAt) - Date.parse(startedAt) > 30_000) return undefined
    const confirmed = await selectDocker(input, executable, env, execute)
    if (confirmed === undefined || !sameSelection(confirmed.value, planned.value)
        || Date.parse(confirmed.startedAt) < Date.parse(finishedAt)) return undefined
    return { observedAt: finishedAt, producer: 'runtime-resource-discovery', resources, startedAt, stackId: input.stackId, selection: planned.value }
}

/**
 * Lists and inspects this stack's runtime resources on the selected Docker context. Discovery
 * lists resources and then inspects what it listed, and a listed resource can vanish in between,
 * as Compose replacing one of this stack's containers does; the round then fails closed on an id
 * that no longer exists, and inside a reserved drain that left the attempt for repair. One more
 * complete round covers that race without admitting partial evidence.
 */
export async function discoverReclaim(input: ReclaimDiscoveryInput, execute: Executor): Promise<ReclaimDiscovery | DiscoveryRefusal | undefined> {
    const executable = resolvedDockerExecutable(input.executable)
    const env = safeEnvironment(input.env)
    if (executable === undefined || env === undefined || !DOCKER_SELECTOR.test(input.context)
        || input.host !== undefined && (admitLocalDockerEndpoint(input.host) === undefined || input.context !== 'default')
        || !STACK_ID.test(input.stackId) || !COCKPIT_ID.test(input.cockpitId)
        || !validExecutionInput(executable, input.cwd, input.env, input.timeoutMs)) return undefined
    return await discoverReclaimRound(input, executable, env, execute)
        ?? await discoverReclaimRound(input, executable, env, execute)
}

/** One container, network or volume that carries every cockpit ownership label, attributed by them alone. */
export interface MachineStackResource {
    readonly kind: 'container' | 'network' | 'volume'
    readonly id: string
    readonly name: string
    readonly cockpitId: CockpitId
    readonly stackId: StackId
    /** Containers only: Docker reports it running, restarting or paused. */
    readonly running: boolean
    readonly composeProject: string | null
    /** Containers only: the directory Compose ran the project from, as Compose itself labelled it. */
    readonly workingDir: string | null
}

export interface MachineStackDiscovery {
    readonly selection: DockerSelection
    readonly observedAt: string
    readonly resources: readonly MachineStackResource[]
    /** Resources carrying the stack label whose other ownership labels are missing or malformed: never attributed. */
    readonly unattributed: number
}

export type MachineStackDiscoveryInput = Omit<ReclaimDiscoveryInput, 'stackId' | 'cockpitId'>

const MACHINE_KINDS = ['container', 'network', 'volume'] as const
const COMPOSE_WORKING_DIR = 'com.docker.compose.project.working_dir'
const MACHINE_LABELS = [...Object.values(REQUIRED_LABELS), COMPOSE_LABELS.project, COMPOSE_WORKING_DIR] as const
const RUNNING_STATES = new Set(['running', 'restarting', 'paused'])

function machineListing(kind: typeof MACHINE_KINDS[number], selection: DockerSelection): readonly string[] {
    const label = (key: string) => `"${key}":{{json (.Label "${key}")}}`
    const id = kind === 'volume' ? '{{json .Name}}' : '{{json .ID}}'
    const name = kind === 'container' ? '{{json .Names}}' : '{{json .Name}}'
    const state = kind === 'container' ? '{{json .State}}' : '""'
    const format = `{"id":${id},"name":${name},"state":${state},"labels":{${MACHINE_LABELS.map(label).join(',')}}}`
    // The presence filter keeps the listing to cockpit's own resources on a shared daemon.
    const filter = ['--filter', `label=${REQUIRED_LABELS.stack}`]
    const command = kind === 'container' ? ['container', 'ls', '--all', '--no-trunc'] : kind === 'network' ? ['network', 'ls', '--no-trunc'] : ['volume', 'ls']
    return ['--host', selection.endpoint, ...command, ...filter, '--format', format]
}

function machineRows(text: string, kind: typeof MACHINE_KINDS[number]): { resources: MachineStackResource[]; unattributed: number } | undefined {
    const resources: MachineStackResource[] = []
    let unattributed = 0
    for (const line of text.split('\n')) {
        if (line.length === 0) continue
        // Unparseable docker output is unproven; the discovery fails closed.
        const row = tryParseJson(line)
        if (row === null || typeof row !== 'object' || Array.isArray(row) || !exactKeys(row, ['id', 'name', 'state', 'labels'])) return undefined
        const { id, name, state, labels } = row as Record<string, unknown>
        if (typeof id !== 'string' || !RESOURCE_ID.test(id) || typeof name !== 'string' || name.length === 0 || name.length > 512
            || typeof state !== 'string' || state.length > 64
            || labels === null || typeof labels !== 'object' || Array.isArray(labels) || !exactKeys(labels, MACHINE_LABELS)) return undefined
        const values = labels as Record<string, unknown>
        if (Object.values(values).some((value) => typeof value !== 'string' || value.length > 4_096 || value.includes('\0'))) return undefined
        const stack = values[REQUIRED_LABELS.stack] as string
        const owner = values[REQUIRED_LABELS.owner] as string
        const config = values[REQUIRED_LABELS.config] as string
        if (!STACK_ID.test(stack) || !COCKPIT_ID.test(owner) || !SHA256.test(config)) {
            unattributed += 1
            continue
        }
        const project = values[COMPOSE_LABELS.project] as string
        const workingDir = values[COMPOSE_WORKING_DIR] as string
        resources.push({
            kind, id, name, cockpitId: owner as CockpitId, stackId: stack as StackId,
            running: kind === 'container' && RUNNING_STATES.has(state),
            composeProject: project === '' ? null : project,
            workingDir: kind === 'container' && workingDir !== '' && isAbsolute(workingDir) ? normalize(workingDir) : null,
        })
    }
    return { resources, unattributed }
}

/**
 * Lists every container, network and volume on the selected daemon that carries cockpit's stack
 * label, whichever cockpit or checkout started it, for the machine-wide stack inventory. Ownership
 * comes from the labels alone; nothing is attributed by its name. The selection is read before and
 * after the listings, as `discoverReclaim` does, so the listings describe one daemon.
 */
export async function discoverMachineStacks(input: MachineStackDiscoveryInput, execute: Executor): Promise<MachineStackDiscovery | undefined> {
    const executable = resolvedDockerExecutable(input.executable)
    const env = safeEnvironment(input.env)
    if (executable === undefined || env === undefined || !DOCKER_SELECTOR.test(input.context)
        || input.host !== undefined && (admitLocalDockerEndpoint(input.host) === undefined || input.context !== 'default')
        || !validExecutionInput(executable, input.cwd, input.env, input.timeoutMs)) return undefined
    const planned = await selectDocker(input, executable, env, execute)
    if (planned === undefined) return undefined
    const listed = await Promise.all(MACHINE_KINDS.map(async (kind) => {
        const step = exactStep(`stacks:discover:${kind}`, [executable.canonicalPath, ...machineListing(kind, planned.value)],
            executable, input.cwd, env, input.timeoutMs, [], {
                resourceKind: kind, dockerContext: planned.value.context, dockerEndpoint: planned.value.endpoint,
            }, [], OUTPUT_LIMIT)
        const outcome = step === undefined ? undefined : cleanOutput(await execute(step))
        const text = outcome === undefined ? undefined : utf8(outcome.stdout)
        return text === undefined ? undefined : { rows: machineRows(text, kind), finishedAt: outcome!.receipt.finishedAt }
    }))
    if (listed.some((value) => value?.rows === undefined)) return undefined
    const lists = listed as { rows: NonNullable<ReturnType<typeof machineRows>>; finishedAt: string }[]
    const listedAt = lists.map(({ finishedAt }) => finishedAt).sort(lexical).at(-1)!
    const confirmed = await selectDocker(input, executable, env, execute)
    if (confirmed === undefined || !sameSelection(confirmed.value, planned.value)
        || Date.parse(confirmed.startedAt) < Date.parse(listedAt)) return undefined
    const resources = lists.flatMap(({ rows }) => rows.resources)
    if (resources.length > MAX_RESOURCES) return undefined
    return {
        selection: planned.value, observedAt: listedAt,
        resources: resources.sort((left, right) => lexical(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`)),
        unattributed: lists.reduce((sum, { rows }) => sum + rows.unattributed, 0),
    }
}

/** The one Docker removal prune runs for a resource the machine discovery attributed to an orphaned stack. */
export function machineStackRemovalStep(
    input: Pick<MachineStackDiscoveryInput, 'executable' | 'cwd' | 'env' | 'timeoutMs'>,
    selection: DockerSelection,
    resource: MachineStackResource,
): ExecutionStep | undefined {
    const executable = resolvedDockerExecutable(input.executable)
    const env = safeEnvironment(input.env)
    if (executable === undefined || env === undefined || admitLocalDockerEndpoint(selection.endpoint) === undefined
        || !RESOURCE_ID.test(resource.id) || !validExecutionInput(executable, input.cwd, input.env, input.timeoutMs)) return undefined
    const command = resource.kind === 'container' ? ['container', 'rm', '--force', '--', resource.id]
        : resource.kind === 'network' ? ['network', 'rm', '--', resource.id] : ['volume', 'rm', '--', resource.id]
    return exactStep(`stacks:prune:${resource.kind}:${digestValue(resource.id).slice(0, 16)}`,
        [executable.canonicalPath, '--host', selection.endpoint, ...command],
        executable, input.cwd, env, input.timeoutMs, [],
        { stackId: resource.stackId, cockpitId: resource.cockpitId, resourceKind: resource.kind, resourceId: resource.id })
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
    readonly discovery: ReclaimDiscovery
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
    readonly confirmationDigest?: string
    readonly consent?: ReclaimConsent
    readonly coordinationAddress?: StateAddress
    readonly continuation?: ReclaimContinuation
    /** A recovered reservation whose reclaim try failed, which plans its remaining committed targets. */
    readonly recoveredReservation?: DrainReservation
    readonly operatorApproval?: ResetPreview
}

export interface ResetPreview {
    readonly kind: 'preview'
    readonly digest: string
    readonly coordinationRevision: number
    readonly targets: readonly ResetTargetInput[]
    readonly noop: boolean
    readonly consent: ReclaimConsent
    /** The exact targets the digest commits, which the drain reservation records. */
    readonly envelope: ReclaimTargetEnvelope
}

export type ResetPlanResult =
    | {
          readonly kind: 'complete'
          readonly action: PlannedReclaimAction | null
          readonly remaining: number
          readonly noop: boolean
          readonly digest: string
          readonly envelope: ReclaimTargetEnvelope
      }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

export interface PlanTeardownInput extends ClassifyReclaimInput {
    readonly discovery: ReclaimDiscovery
    readonly executable: ResolvedExecutable
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly dependencyCaches?: readonly DependencyCacheDeclaration[]
    readonly pathExecutable?: ResolvedExecutable
    readonly expectedDiscoveryDigest?: string
    readonly consent?: ReclaimConsent
    readonly continuation?: ReclaimContinuation
    readonly coordinationAddress?: StateAddress
    /** A recovered reservation whose reclaim try failed, which plans its remaining committed targets. */
    readonly recoveredReservation?: DrainReservation
}

export type TeardownPlanResult =
    | {
          readonly kind: 'complete'
          readonly action: PlannedReclaimAction | null
          readonly remaining: number
          readonly noop: boolean
          readonly discoveryDigest: string
          readonly byteAccounting: {
              readonly observed: ByteClasses
              readonly reclaimable: ByteClasses
              readonly action: { readonly resourceId: string; readonly observedBytes: number | null } | null
              readonly actuallyReclaimed: number | null
          }
          readonly consent: ReclaimConsent | null
          readonly envelope: ReclaimTargetEnvelope
      }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

function refusal(code: EnvironmentCode, message: string, target: string, fix?: string): { kind: 'refusal'; diagnostics: readonly EnvironmentDiagnostic[] } {
    return { kind: 'refusal', diagnostics: [diagnostic(code, message, target, fix)] }
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue)
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => lexical(left, right))
            .map(([key, item]) => [key, canonicalValue(item)]))
    }
    return value
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
function discoveryOfStack(discovery: ReclaimDiscovery, stackId: StackId): boolean {
    return discovery.stackId === stackId
}

// The plan acts only on a discovery read after the approved one, so what is removed is what the
// approved digest names in the daemon's current state, not a replay of the state that was shown.
function followsConsent(consent: ReclaimConsent | undefined, digest: string, discovery: ReclaimDiscovery): boolean {
    return consent !== undefined && consent.digest === digest
        && Date.parse(discovery.startedAt) > Date.parse(consent.observedAt)
}

// After a removal, the discovery that reconciled it may plan the next one. After a removal that
// never started, nothing proved the state since, so the discovery must follow the published failure.
function followsContinuation(discovery: ReclaimDiscovery, continuation: ReclaimContinuation, failed: boolean, record: StateRecord): boolean {
    return failed ? Date.parse(discovery.startedAt) > Date.parse(record.updatedAt)
        : Date.parse(discovery.startedAt) >= Date.parse(continuation.freshAfter)
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
        const ancestors: FilesystemAncestorIdentity[] = [{
            path: declaration.root, ...filesystemObjectIdentity(rootStatus),
        }]
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
                    return {
                        state: 'present', type: status.isDirectory() ? 'directory' : status.isFile() ? 'file' : undefined,
                        ...filesystemObjectIdentity(status), mode: Number(status.mode),
                        size: Number(status.size), mtimeMs: Number(status.mtimeNs) / 1_000_000, ancestors,
                    }
                }
                ancestors.push({ path: cursor, ...filesystemObjectIdentity(status) })
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) return undefined
                return { state: 'absent' }
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
    if (declarations === undefined) return []
    if (!Array.isArray(declarations) || declarations.length > MAX_RESOURCES) return undefined
    const authorities: DependencyCacheAuthority[] = []
    for (const declaration of declarations) {
        if (declaration === null || typeof declaration !== 'object' || !exactKeys(declaration, ['cacheId', 'root', 'path'])
            || typeof declaration.cacheId !== 'string' || !SHA256.test(declaration.cacheId)
            || typeof declaration.root !== 'string' || typeof declaration.path !== 'string'
            || resolve(declaration.root, declaration.cacheId) !== declaration.path) return undefined
        const evidence = await inspectHostPath({ ...declaration, declaration: declaration.cacheId })
        if (evidence === undefined || evidence.state === 'present' && evidence.type !== 'directory') return undefined
        authorities.push({ ...declaration, evidence })
    }
    if (new Set(authorities.map(({ cacheId }) => cacheId)).size !== authorities.length
        || new Set(authorities.map(({ path }) => path)).size !== authorities.length) return undefined
    return authorities.sort((left, right) => lexical(left.cacheId, right.cacheId))
}

function safeTarget(value: ResetTargetAuthority): ResetTargetInput {
    return {
        kind: value.kind,
        identity: value.identity,
        declaration: value.declaration,
        ...(value.labels === undefined ? {} : { labels: { ...value.labels } }),
    }
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
        targets.push({
            kind: 'volume', identity: match.name, declaration: key, labels: { ...match.labels },
            evidence: { resourceId: match.id, bytes: match.bytes, generation: match.generation },
        })
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
            targets.push({
                kind: 'container', identity: match.id, declaration: match.name, labels: { ...match.labels },
                evidence: { resource },
            })
        }
    }
    const hostIdentities = new Set<string>()
    for (const declaration of input.generatedHostPaths) {
        const evidence = await inspectHostPath(declaration)
        if (evidence === undefined || evidence.state === 'present' && evidence.type === undefined || hostIdentities.has(declaration.path)) return undefined
        hostIdentities.add(declaration.path)
        targets.push({
            kind: 'host-path', identity: declaration.path, declaration: declaration.declaration,
            root: declaration.root, evidence,
        })
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
    return value === undefined ? undefined : {
        holders: value.holders,
        lease: value.lease,
        lastReleasedHolder: value.lastReleasedHolder,
    }
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

export async function planReset(input: PlanResetInput): Promise<ResetPreview | ResetPlanResult> {
    try {
        const { discovery, consent, continuation, recoveredReservation, operatorApproval } = input
        const runtimeExecutable = resolvedDockerExecutable(input.runtimeExecutable)
        const pathExecutable = await removalExecutable(input.pathExecutable)
        const env = safeEnvironment(input.env)
        if (runtimeExecutable === undefined || pathExecutable === undefined || env === undefined
            || !validExecutionInput(runtimeExecutable, input.cwd, input.env, input.timeoutMs)
            || !validExecutionInput(pathExecutable, input.cwd, input.env, input.timeoutMs)) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset execution authority is malformed', 'reset')
        }
        if (!discoveryOfStack(discovery, input.stackId)) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reset requires a fresh runtime discovery of this stack', 'reset-discovery')
        }
        const selection = discovery.selection
        const coordination = coordinationForDestruction(input)
        if ('refusal' in coordination) return coordination.refusal
        const coldPlanningRecovery = continuation === undefined && consent === undefined && recoveredReservation !== undefined
            ? inspectFailedReclaimRecovery({ reservation: recoveredReservation, record: input.coordinationRecord! }) : undefined
        if ((recoveredReservation !== undefined) !== (operatorApproval !== undefined)
            || operatorApproval !== undefined && coldPlanningRecovery === undefined) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
                'cold reset recovery requires an authenticated approval of the remaining targets', 'reset-confirmation')
        }
        const coldPlanningIdentities = coldPlanningRecovery === undefined
            ? undefined : committedTargetIdentities(coldPlanningRecovery)
        const observedAuthorities = await resetAuthorities(input)
        if (observedAuthorities === undefined) return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reset targets do not match current declarations and ownership evidence', 'reset-targets')
        if (continuation !== undefined && continuation.purpose !== 'reset') {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset continuation receipt is invalid', 'reset-continuation')
        }
        const continued = continuation
        let authorities = observedAuthorities
        let continuedAfterFailure = false
        if (continued !== undefined) {
            const match = matchReclaimDrainContinuation({ continuation: continued.drain, record: input.coordinationRecord! })
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
            if (!followsContinuation(discovery, continued, continuedAfterFailure, input.coordinationRecord!)
                || !completedRemainAbsent || remainingIdentities === undefined
                || !sameTargetProjections(remainingIdentities, continued.targetIdentities, remainingTargetIds)) {
                return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset continuation no longer matches the remaining consented target set', 'reset-continuation')
            }
            authorities = remainingNow
        }
        const digestTargetIds = authorities
            .filter((candidate) => candidate.kind !== 'host-path' || candidate.evidence.state === 'present')
            .map(({ kind, identity }) => `${kind}:${identity}`).sort(lexical)
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
        const digest = continued?.digest ?? digestValue({
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
        const publicTargets = authorities.map(safeTarget)
        if (input.confirmationDigest === undefined) {
            const actionable = authorities.filter((candidate) => candidate.kind !== 'host-path' || candidate.evidence.state === 'present')
            const targetIds = actionable.map(({ kind, identity }) => `${kind}:${identity}`).sort(lexical)
            const identities = coldPlanningIdentities ?? resetTargetIdentities(targetIds, actionable)
            if (identities === undefined) {
                return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reset target identities could not be committed exactly', 'reset-targets')
            }
            return {
                kind: 'preview' as const, digest, coordinationRevision: coordination.revision,
                targets: publicTargets, noop: authorities.length === 0 && !coldCurrentAbsent,
                consent: { digest, observedAt: discovery.observedAt },
                envelope: reclaimTargetEnvelope('reset', input.stackId, input.configSha256, digest, targetCommitments(identities)),
            }
        }
        if (!SHA256.test(input.confirmationDigest) || input.confirmationDigest !== digest) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset consent does not match the fresh complete preview', 'reset-confirmation')
        }
        const currentCoordination = input.coordinationRecord === null ? undefined
            : await rereadCoordination(input.coordinationAddress, input.coordinationRecord, input.discovery.observedAt)
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
        const followsPersistedFailure = coldTargetsMatch
            && Date.parse(discovery.startedAt) > Date.parse(coldRecovery!.freshAfter)
        const approval = operatorApproval?.envelope
        if (operatorApproval !== undefined && (!coldTargetsMatch || !approval
            || approval.purpose !== 'reset' || approval.stackId !== input.stackId || approval.configSha256 !== input.configSha256
            || digestValue(approval.commitments) !== digestValue(targetCommitments(coldIdentities!
                .filter(({ targetId }) => coldRemainingTargetIds!.includes(targetId)))))) {
            return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
                'approved reset preview does not match the exact remaining persisted targets', 'reset-confirmation')
        }
        if (continued === undefined && !(coldTargetsMatch ? followsPersistedFailure : followsConsent(consent, digest, discovery))) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reset requires a fresh runtime discovery read after the approved preview', 'reset-discovery')
        }
        const actionable = authorities.filter((candidate) => candidate.kind !== 'host-path' || candidate.evidence.state === 'present')
        const targetIds = continued?.targetIds ?? coldReclaimTargetIds ?? actionable.map(({ kind, identity }) => `${kind}:${identity}`).sort(lexical)
        const removedTargetIds = coldTargetsMatch ? coldCompletedTargetIds! : continued === undefined
            ? ([] as string[])
            : continuedAfterFailure ? continued.removedTargetIds
                : [...continued.removedTargetIds, continued.completedTargetId].sort(lexical)
        const targetIdentities = continued?.targetIdentities ?? (coldTargetsMatch ? coldIdentities : resetTargetIdentities(targetIds, actionable))
        if (targetIdentities === undefined) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reset target identities could not be retained exactly', 'reset-targets')
        }
        const envelope = reclaimTargetEnvelope('reset', input.stackId, input.configSha256, digest,
            targetCommitments(coldTargetsMatch ? coldIdentities! : targetIdentities))
        const continuationFor = (completedTargetId: string): ReclaimContinuation => ({
            purpose: 'reset', digest, completedTargetId, runtimeDigest, targetIds, removedTargetIds, targetIdentities,
            freshAfter: new Date().toISOString(), drain: null,
        })
        if (coldTargetsMatch && coldCurrentAbsent) {
            const action: PlannedReclaimAction = {
                stackId: input.stackId, configSha256: input.configSha256, step: null,
                coordinationRecord: currentCoordination, continuation: continuationFor(coldRecovery!.current.targetId),
                observedAt: discovery.observedAt,
                remainingTargets: async next => {
                    const current = await resetAuthorities({ ...input, discovery: next })
                    return current?.filter(candidate => candidate.kind !== 'host-path' || candidate.evidence.state === 'present')
                        .map(({ kind, identity }) => `${kind}:${identity}`).sort(lexical)
                },
            }
            return { kind: 'complete' as const, action, remaining: digestTargetIds.length, noop: false, digest, envelope }
        }
        // Revalidation narrows cooperative races; portable process APIs cannot bind a daemon object or pathname descriptor through its final removal syscall.
        const target = actionable[0]
        if (target === undefined) return { kind: 'complete', action: null, remaining: 0, noop: true, digest, envelope }
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
        const action: PlannedReclaimAction = {
            stackId: input.stackId, configSha256: input.configSha256, step,
            coordinationRecord: currentCoordination, continuation: continuationFor(`${target.kind}:${target.identity}`),
            observedAt: discovery.observedAt,
        }
        return { kind: 'complete' as const, action, remaining: actionable.length - 1, noop: false, digest, envelope }
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

export async function planTeardown(input: PlanTeardownInput): Promise<TeardownPlanResult> {
    try {
        const { discovery, consent, continuation: continued, recoveredReservation } = input
        const executable = resolvedDockerExecutable(input.executable)
        const env = safeEnvironment(input.env)
        const caches = await dependencyCacheAuthorities(input.dependencyCaches)
        const pathExecutable = input.dependencyCaches !== undefined && input.dependencyCaches.length > 0
            ? await removalExecutable(input.pathExecutable) : undefined
        if (executable === undefined || env === undefined || !validExecutionInput(executable, input.cwd, input.env, input.timeoutMs)) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown execution authority is malformed', 'teardown')
        }
        if (!discoveryOfStack(discovery, input.stackId)) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown requires a fresh runtime discovery of this stack', 'teardown-discovery')
        }
        const selection = discovery.selection
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
        const cacheResources = caches.filter(({ evidence }) => evidence.state === 'present').map(({ cacheId }) => ({
            id: cacheId, name: cacheId, kind: 'cache' as const, labels: {}, referenced: false, bytes: null,
        }))
        const observedDiscovery = {
            observedAt: discovery.observedAt, producer: discovery.producer,
            resources: [...discovery.resources, ...cacheResources],
        }
        const classified = classifyReclaim({ ...reclaimInput(input), discovery: observedDiscovery })
        if (classified.kind !== 'complete') return classified
        const coldRecovery = continued === undefined && consent === undefined && recoveredReservation !== undefined
            ? inspectFailedReclaimRecovery({ reservation: recoveredReservation, record: input.coordinationRecord }) : undefined
        const coldIdentities = coldRecovery === undefined ? undefined : committedTargetIdentities(coldRecovery)
        if (continued !== undefined && continued.purpose !== 'down') {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown continuation receipt is invalid', 'teardown-continuation')
        }
        let continuedAfterFailure = false
        if (continued !== undefined) {
            const match = matchReclaimDrainContinuation({ continuation: continued.drain, record: input.coordinationRecord })
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
            if (!followsContinuation(discovery, continued, continuedAfterFailure, input.coordinationRecord!)
                || !completedRemainAbsent || remainingIdentities === undefined
                || !sameTargetProjections(remainingIdentities, continued.targetIdentities, remainingTargetIds)) {
                return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown continuation no longer matches the remaining consented resources', 'teardown-continuation')
            }
        }
        const actionable = actionableReclaimResources(classified.resources)
        const freshTargetIds = actionable.map(({ kind, id }) => `${kind}:${id}`).sort(lexical)
        const freshTargetIdentities = teardownTargetIdentities(freshTargetIds, actionable, caches)
        if (freshTargetIdentities === undefined) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown target identities could not be committed exactly', 'teardown-targets')
        }
        const discoveryDigest = continued?.digest ?? digestValue({
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
        if (input.expectedDiscoveryDigest !== undefined && input.expectedDiscoveryDigest !== discoveryDigest) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'fresh teardown discovery differs from the accepted snapshot', input.stackId)
        }
        let currentCoordination = input.coordinationRecord
        if (input.expectedDiscoveryDigest !== undefined) {
            const current = await rereadCoordination(input.coordinationAddress, input.coordinationRecord, discovery.observedAt)
            const decodedCurrent = current === undefined ? undefined : decodeCoordinationRecord(current, input.stackId)
            if (decodedCurrent === undefined || decodedCurrent.holders.length > 1
                || decodedCurrent.holders.length === 1 && (decodedCurrent.lease === null || decodedCurrent.lease.released)) {
                return refusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'teardown requires fresh retained drain coordination evidence read at the destructive boundary', input.stackId)
            }
            currentCoordination = current!
        }
        const first = actionable[0]
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
            && Date.parse(discovery.startedAt) > Date.parse(coldRecovery!.freshAfter)
        if ((first !== undefined || coldCurrentAbsent) && input.expectedDiscoveryDigest !== undefined
            && continued === undefined && !(coldTargetsMatch ? followsPersistedFailure : followsConsent(consent, discoveryDigest, discovery))) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown requires a fresh runtime discovery read after the accepted snapshot', 'teardown-discovery')
        }
        const absent = coldTargetsMatch && coldCurrentAbsent && input.expectedDiscoveryDigest !== undefined
        const step = absent || first === undefined || input.expectedDiscoveryDigest === undefined
            ? undefined : teardownStep(first, { ...input, executable, env }, selection, caches, pathExecutable)
        if (!absent && first !== undefined && input.expectedDiscoveryDigest !== undefined && step === undefined) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'exact teardown action could not cross the execution boundary', first.id)
        }
        const raw = observedDiscovery.resources
        const observed = {
            orphans: sumBytes(raw.filter(({ kind }) => kind === 'container')),
            images: sumBytes(raw.filter(({ kind }) => kind === 'image')),
            buildCache: sumBytes(raw.filter(({ kind }) => kind === 'build-cache' || kind === 'cache')),
            staleNetworks: sumBytes(classified.resources.filter(({ kind, ownership }) => kind === 'network' && ownership === 'stale-config')),
        }
        const reclaimable = {
            orphans: sumBytes(actionable.filter(({ kind }) => kind === 'container')),
            images: sumBytes(actionable.filter(({ kind }) => kind === 'image')),
            buildCache: sumBytes(actionable.filter(({ kind }) => kind === 'build-cache' || kind === 'cache')),
            staleNetworks: sumBytes(actionable.filter(({ kind, ownership }) => kind === 'network' && ownership === 'stale-config')),
        }
        if ([...Object.values(observed), ...Object.values(reclaimable)].some((value) => value === undefined)) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reclaim byte accounting exceeds the safe integer range', 'teardown-accounting')
        }
        const targetIds = continued?.targetIds ?? coldReclaimTargetIds ?? freshTargetIds
        const removedTargetIds = coldTargetsMatch ? coldCompletedTargetIds! : continued === undefined
            ? ([] as string[])
            : continuedAfterFailure ? continued.removedTargetIds
                : [...continued.removedTargetIds, continued.completedTargetId]
        const targetIdentities = continued?.targetIdentities ?? (coldTargetsMatch ? coldIdentities : freshTargetIdentities)
        if (targetIdentities === undefined) {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown target identities could not be retained exactly', 'teardown-targets')
        }
        const continuationFor = (completedTargetId: string): ReclaimContinuation => ({
            purpose: 'down', digest: discoveryDigest, completedTargetId, runtimeDigest, targetIds, removedTargetIds, targetIdentities,
            freshAfter: new Date().toISOString(), drain: null,
        })
        const action: PlannedReclaimAction | null = absent ? {
            stackId: input.stackId, configSha256: input.configSha256, step: null,
            coordinationRecord: currentCoordination, continuation: continuationFor(coldRecovery!.current.targetId),
            observedAt: discovery.observedAt,
            remainingTargets: async next => {
                const nextCaches = await dependencyCacheAuthorities(input.dependencyCaches)
                if (!nextCaches) return undefined
                const cacheRows = nextCaches.filter(({ evidence }) => evidence.state === 'present').map(({ cacheId }) => ({
                    id: cacheId, name: cacheId, kind: 'cache' as const, labels: {}, referenced: false, bytes: null,
                }))
                const classified = classifyReclaim({ ...reclaimInput(input),
                    discovery: { observedAt: next.observedAt, producer: next.producer, resources: [...next.resources, ...cacheRows] } })
                return classified.kind === 'complete' ? actionableReclaimResources(classified.resources)
                    .map(({ kind, id }) => `${kind}:${id}`).sort(lexical) : undefined
            },
        } : step === undefined || first === undefined ? null : {
            stackId: input.stackId, configSha256: input.configSha256,
            step,
            coordinationRecord: currentCoordination, continuation: continuationFor(`${first.kind}:${first.id}`),
            observedAt: discovery.observedAt,
        }
        return {
            kind: 'complete', action,
            remaining: step === undefined ? actionable.length : actionable.length - 1,
            noop: actionable.length === 0 && !absent, discoveryDigest,
            byteAccounting: {
                observed: observed as ByteClasses, reclaimable: reclaimable as ByteClasses,
                action: first === undefined || step === undefined ? null : { resourceId: first.id, observedBytes: first.bytes },
                actuallyReclaimed: null,
            },
            consent: input.expectedDiscoveryDigest === undefined ? { digest: discoveryDigest, observedAt: discovery.observedAt } : null,
            envelope: reclaimTargetEnvelope('down', input.stackId, input.configSha256, discoveryDigest,
                targetCommitments(coldTargetsMatch ? coldIdentities! : targetIdentities)),
        }
    } catch (error) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, `teardown input could not be inspected safely: ${errorCause(error)}`, 'teardown')
    }
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
    return {
        format: 'cockpit-reclaim-target/v1', targetId: identity.targetId,
        sha256: createHash('sha256').update(body).digest('hex'), body,
    }
}

function targetCommitments(identities: readonly ReclaimTargetIdentity[]): readonly ReclaimTargetCommitment[] {
    return identities.map(targetCommitment)
}

function reclaimTargetEnvelope(
    purpose: ReclaimTargetEnvelope['purpose'],
    stackId: StackId,
    configSha256: string,
    planDigest: string,
    commitments: readonly ReclaimTargetCommitment[],
): ReclaimTargetEnvelope {
    return {
        purpose, stackId, configSha256, planDigest,
        commitments: commitments.map((commitment) => ({ ...commitment })),
    }
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
        return candidate as unknown as ResetVolumeTargetIdentity
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
        return candidate as unknown as TeardownRuntimeTargetIdentity
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
        return candidate as unknown as PathTargetIdentity
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
        return identities.length === targets.length ? identities : undefined
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

function canonicalLabels(labels: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    const required = new Set<string>(Object.values(REQUIRED_LABELS))
    return Object.fromEntries(Object.entries(labels)
        .filter(([key]) => required.has(key))
        .sort(([left], [right]) => lexical(left, right)))
}

function teardownRuntimeTargetIdentity(targetId: string, resource: ReclaimResource): TeardownRuntimeTargetIdentity | undefined {
    if (resource.kind === 'cache') return undefined
    return {
        medium: 'runtime', scope: 'teardown-runtime', targetId, kind: resource.kind,
        runtimeId: resource.id, name: resource.name, labels: canonicalLabels(resource.labels),
        referenced: resource.referenced, dataBearing: resource.dataBearing ?? null,
        generation: resource.generation ?? null,
    }
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
    return {
        medium: 'path', targetId, kind, declaration, root, path, type: evidence.type,
        dev: evidence.dev, ino: evidence.ino, birthtimeNs: evidence.birthtimeNs,
        ancestors: evidence.ancestors.map((ancestor) => ({ ...ancestor })),
    }
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
            ancestors.push({ path, ...filesystemObjectIdentity(status) })
        }
        const target = await lstat(expected.path, { bigint: true })
        const type = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : undefined
        if (target.isSymbolicLink() || type !== expected.type || !sameFilesystemObject(target, expected)) return undefined
        return {
            path: expected.path,
            expected: expected.type,
            identity: { ...filesystemObjectIdentity(target), ancestors },
        }
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
        return [{
            medium: 'runtime' as const, scope: 'reset-volume' as const,
            targetId, kind: 'volume' as const, declaration: target.declaration,
            runtimeId: evidence.resourceId, name: target.identity,
            labels: canonicalLabels(target.labels ?? {}), generation: evidence.generation,
        }]
    }).sort((left, right) => lexical(left.targetId, right.targetId))
    return identities.length === targetIds.length
        && sameStrings(identities.map(({ targetId }) => targetId), targetIds)
        ? identities : undefined
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
        ? identities : undefined
}

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

function reclaimCompletionFact(
    reservation: DrainReservation,
    attempt: NonNullable<DrainReservation['attempt']>,
    observedAt: string,
    remainingTargetIds: readonly string[],
): ReclaimCompleted {
    return {
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
        remainingTargetIds: [...remainingTargetIds],
    } satisfies ReclaimCompleted
}

/** A removal the attempt admitted, with the attempt it ran under and what it observed. */
export interface ExecutedReclaimAction {
    readonly action: PlannedReclaimAction
    readonly reservation: DrainReservation
    readonly attempt: NonNullable<DrainReservation['attempt']>
    readonly drain: ReclaimDrainStep
    /** Null for an already-absent target, which runs nothing. */
    readonly receipt: ExecutionReceipt | null
    readonly fence: ExecutionFence | null
}

export type ReclaimActionExecution =
    | { readonly kind: 'executed'; readonly executed: ExecutedReclaimAction }
    /** The removal provably never started; its failure is settled and ready to publish, and the same target may be retried. */
    | {
          readonly kind: 'not-started'
          readonly code: Extract<ExecuteProbeOutcome, { kind: 'refusal' }>['code']
          readonly outcome: DrainOutcome
          readonly fence: ExecutionFence
          readonly continuation: ReclaimContinuation
      }
    | { readonly kind: 'unavailable' }

/**
 * Runs the planned removal under the reserved attempt: the attempt must name exactly this target
 * of the committed target set, and the step runs fenced to the attempt's validity window.
 */
export async function executeReclaimAction(input: {
    readonly action: PlannedReclaimAction
    readonly attempt: ReservedDrainAttempt
    readonly execute: Executor
}): Promise<ReclaimActionExecution> {
    const { action } = input
    const { continuation } = action
    const candidate = input.attempt
    if (candidate.reservation.attempt?.attemptId !== candidate.attempt.attemptId || candidate.attempt.status !== 'active' || candidate.attempt.currentStage !== 'reclaim') return { kind: 'unavailable' }
    const targetId = continuation.completedTargetId
    const reclaimTargets = candidate.reservation.actions.filter(({ stage }) => stage === 'reclaim').map(({ targetId: id }) => id)
    const reserved = candidate.reservation.actions[candidate.attempt.actionIndex]
    if (candidate.reservation.purpose !== continuation.purpose
        || candidate.reservation.stackId !== action.stackId
        || candidate.reservation.configSha256 !== action.configSha256
        || candidate.reservation.planDigest !== continuation.digest
        || candidate.attempt.reservationId !== candidate.reservation.reservationId
        || candidate.attempt.purpose !== candidate.reservation.purpose
        || candidate.attempt.generation !== candidate.reservation.generation
        || candidate.attempt.actionIndex !== continuation.removedTargetIds.length + 1
        || reserved?.stage !== 'reclaim' || reserved.targetId !== targetId
        || candidate.attempt.currentTarget !== targetId
        || !sameStrings(reclaimTargets, continuation.targetIds)) return { kind: 'unavailable' }
    const drain = reclaimDrainStep({ planningRecord: action.coordinationRecord, reservation: candidate.reservation })
    if (!drain) return { kind: 'unavailable' }
    const executedWith = (receipt: ExecutionReceipt | null, fence: ExecutionFence | null): ReclaimActionExecution => ({
        kind: 'executed',
        executed: { action, reservation: candidate.reservation, attempt: candidate.attempt, drain, receipt, fence },
    })
    if (action.step === null) return executedWith(null, null)
    const pathIdentity = continuation.targetIdentities.find((identity): identity is PathTargetIdentity =>
        identity.targetId === targetId && identity.medium === 'path')
    const identityCheck = pathIdentity === undefined ? undefined : await identityBoundFilesystemCheck(pathIdentity)
    if (pathIdentity !== undefined && identityCheck === undefined) return { kind: 'unavailable' }
    const validThroughMs = Date.parse(candidate.attempt.validThrough)
    const remainingMs = validThroughMs - Date.now()
    if (!Number.isSafeInteger(validThroughMs) || remainingMs < 1) return { kind: 'unavailable' }
    const { fence } = candidate
    const step = snapshotExecutionStep({
        ...action.step,
        timeoutMs: Math.min(action.step.timeoutMs, remainingMs),
        spawnNotAfter: candidate.attempt.validThrough,
        filesystemChecks: identityCheck === undefined ? action.step.filesystemChecks : [identityCheck],
        executionFence: fence,
    })
    if (!step) return { kind: 'unavailable' }
    const outcome = await input.execute(step)
    if (outcome.kind === 'refusal') {
        // Only a removal that provably never started leaves the target as it was.
        if (outcome.receipt !== undefined || outcome.execution.started || outcome.execution.signal !== null
            || outcome.execution.exitCode === 0) return { kind: 'unavailable' }
        const failedAt = new Date().toISOString()
        return {
            kind: 'not-started', code: outcome.code, fence,
            outcome: { kind: 'failure', reservation: candidate.reservation, failedAt },
            continuation: { ...continuation, drain: { ...drain, failedAt } },
        }
    }
    if (outcome.stderr.byteLength !== 0) return { kind: 'unavailable' }
    return executedWith(outcome.receipt, fence)
}

export type ReconcileReclaimActionResult =
    | { readonly kind: 'complete'; readonly outcome: DrainOutcome; readonly continuation: ReclaimContinuation | null }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

/**
 * Settles an executed removal from a discovery read after it: every completed target must be
 * absent and every remaining committed target unchanged, or the attempt stays for repair.
 */
export async function reconcileReclaimAction(input: {
    readonly executed: ExecutedReclaimAction
    readonly discovery: ReclaimDiscovery
}): Promise<ReconcileReclaimActionResult> {
    const { action, reservation, attempt, drain, receipt } = input.executed
    const { discovery } = input
    const { continuation } = action
    const remainder = reservation.actions.slice(attempt.actionIndex + 1)
        .filter(({ stage }) => stage === 'reclaim').map(({ targetId }) => targetId)
    const completed = new Set([...continuation.removedTargetIds, continuation.completedTargetId])
    // An already-absent target ran nothing, so the discovery must follow the one that planned it.
    const freshAfter = receipt === null ? action.observedAt : receipt.finishedAt
    const remaining = action.remainingTargets === undefined ? remainder : await action.remainingTargets(discovery)
    if (discovery.stackId !== reservation.stackId
        || receipt !== null && (Date.parse(receipt.startedAt) < Date.parse(attempt.committedAt)
            || Date.parse(receipt.startedAt) > Date.parse(receipt.finishedAt)
            || Date.parse(receipt.finishedAt) > Date.parse(attempt.validThrough)
            || Date.parse(receipt.finishedAt) > Date.parse(discovery.startedAt))
        || receipt === null && (Date.parse(discovery.startedAt) <= Date.parse(action.observedAt)
            || Date.parse(discovery.startedAt) < Date.parse(attempt.committedAt))
        || Date.parse(discovery.startedAt) > Date.parse(discovery.observedAt)
        || Date.parse(discovery.observedAt) > Date.parse(attempt.validThrough)
        || Date.parse(discovery.observedAt) > Date.now()
        || !remaining || !sameStrings(remaining, remainder)
        || !sameStrings([...completed, ...remainder].sort(lexical), continuation.targetIds)
        || continuation.targetIdentities.length !== continuation.targetIds.length
        || !continuation.targetIdentities.every((identity) => completed.has(identity.targetId)
            ? targetIsAbsent(identity, discovery.resources)
            : remainder.includes(identity.targetId) && sameTargetIdentity(identity, discovery.resources))) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'fresh discovery did not prove the exact reserved removal set', 'reclaim-reconciliation')
    }
    return {
        kind: 'complete',
        outcome: { kind: 'success', reservation, fact: reclaimCompletionFact(reservation, attempt, discovery.observedAt, remainder) },
        continuation: remainder.length === 0 ? null : { ...continuation, freshAfter, drain },
    }
}
