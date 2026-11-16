import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { admitLocalDockerEndpoint } from './docker-endpoint.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { decodeCoordinationRecord } from './claims.js'
import {
    hasErrorCode,
    tryParseJson,
    ENVIRONMENT_CODES,
    isCanonicalTimestamp,
    snapshotExecutionStep,
    snapshotJson,
    type CockpitId,
    type EnvironmentCode,
    type EnvironmentDiagnostic,
    type ExecutionStep,
    type StackId,
} from './contract.js'
import type { ResolvedExecutable } from './executable.js'
import { resolvedDockerExecutable, resolvedExecutable } from './executable.js'
import type { StateRecord } from './state.js'
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

interface DockerSelection {
    readonly context: string
    readonly endpoint: string
}

/** One complete discovery of a stack's runtime resources, as `discoverReclaim` observed it. */
export interface ReclaimDiscovery extends ReclaimDiscoverySnapshot {
    readonly startedAt: string
    readonly stackId: StackId
    readonly selection: DockerSelection
}

type ReclaimResourceKind = 'container' | 'network' | 'volume' | 'image' | 'build-cache' | 'cache'
type OwnershipEvidence = 'current' | 'stale-config' | 'foreign' | 'unknown' | 'malformed' | 'partial' | 'unlabelled'
type Reversibility = 'runtime' | 'regenerable-cache' | 'data-bearing'
type ReclaimAction = 'teardown' | 'reclaim' | 'reset-required' | 'report-only'

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

interface ClassifiedReclaimResource extends ReclaimResource {
    readonly ownership: OwnershipEvidence
    readonly reversibility: Reversibility
    readonly action: ReclaimAction
    readonly evidence: readonly string[]
    readonly reason: string
    readonly suggestion?: { readonly command: string; readonly risk: string }
}

interface ClassifyReclaimInput {
    readonly stackId: StackId
    readonly cockpitId: CockpitId
    readonly configSha256: string
    readonly coordinationRecord: StateRecord | null
    readonly declaredCacheIds: readonly string[]
    readonly discovery: ReclaimDiscoverySnapshot
}

type ReclaimResult =
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

interface KeptTeardownResource {
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
// `container ls --size` alone ran past the step timeout. A stack's volumes stay unfiltered because a
// reset refuses when a declared volume name belongs to something this stack does not own, and an
// unlabelled volume of that name would otherwise be invisible; their inspection is still scoped.
// The machine-wide listing has no such name to check, so it lists cockpit-labelled volumes alone.
function runtimeCommand(kind: Exclude<ReclaimResourceKind, 'cache'>, selection: DockerSelection, owner: ListingOwner): readonly string[] {
    if (kind === 'build-cache') return ['--host', selection.endpoint, 'builder', 'du', '--format', 'json']
    const owned = ['--filter', owner === null ? `label=${REQUIRED_LABELS.stack}` : `label=${REQUIRED_LABELS.stack}=${owner.stackId}`]
    const command = kind === 'container' ? ['container', 'ls', '--all', '--no-trunc', ...owned]
        : kind === 'volume' ? ['volume', 'ls', ...owner === null ? owned : []]
            : kind === 'image' ? ['image', 'ls', '--all', '--no-trunc', ...owned] : [kind, 'ls', '--no-trunc', ...owned]
    return ['--host', selection.endpoint, ...command, '--format', discoveryFormat(kind, owner)]
}

function discoveryFormat(kind: Exclude<ReclaimResourceKind, 'build-cache'>, owner: ListingOwner): string {
    const id = kind === 'volume' ? '{{json .Name}}' : '{{json .ID}}'
    const name = kind === 'container' ? '{{json .Names}}' : kind === 'image' ? '{{json .Repository}}' : '{{json .Name}}'
    const label = (key: string) => `{{json (.Label "${key}")}}`
    const labels = kind === 'image' ? '{}' : `{${(owner === null ? MACHINE_LABELS : listedLabels(kind)).map((key) => `"${key}":${label(key)}`).join(',')}}`
    // The machine-wide listing attributes each resource by its labels alone and reports whether a container runs.
    if (owner === null) return `{"id":${id},"name":${name},"state":${kind === 'container' ? '{{json .State}}' : '""'},"labels":${labels}}`
    // Without `--size` a container prints a misleading "0B (virtual ...)", so its size is unmeasured.
    const bytes = kind === 'network' || kind === 'container' ? 'null' : '{{json .Size}}'
    return `{"id":${id},"name":${name},"labels":${labels},"referenced":false,"bytes":${bytes}}`
}

function listedLabels(kind?: ReclaimResourceKind): readonly string[] {
    return [...Object.values(REQUIRED_LABELS), ...kind === 'volume' ? Object.values(COMPOSE_LABELS) : []]
}

/** The labels Docker printed, refused when any is not `allowed` or its value is too long or holds a NUL; empty values are dropped. */
function dockerLabels(value: unknown, allowed: readonly string[], maxLength = 512): Readonly<Record<string, string>> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const labels: Record<string, string> = {}
    if (Object.keys(value).some((key) => !allowed.includes(key))) return undefined
    for (const [key, labelValue] of Object.entries(value)) {
        if (typeof labelValue !== 'string' || labelValue.length > maxLength || labelValue.includes('\0')) return undefined
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
        : dockerLabels(row.labels, listedLabels(kind))
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

interface ReclaimDiscoveryInput {
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

/** Whose resources a listing asks for: one stack's, by its stack label's value, or every stack's (null), by the label's presence. */
type ListingOwner = Readonly<{ stackId: StackId; cockpitId: CockpitId }> | null

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

/** One stack's listed resources of one kind, or nothing when any row cannot be read. */
function stackRows(text: string, kind: Exclude<ReclaimResourceKind, 'cache'>): readonly ReclaimResource[] | undefined {
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
    return resources.sort((a, b) => lexical(a.id, b.id))
}

interface DaemonListing<Rows> {
    readonly selection: DockerSelection
    readonly lists: readonly Timed<Rows>[]
    /** When the last listing finished. */
    readonly listedAt: string
    readonly reselected: Timed<DockerSelection>
}

/**
 * Lists every kind at once on the context's daemon, reading the selection before and after so the
 * listings describe one daemon. A step that fails, writes to stderr or prints a row `parse` rejects
 * fails the whole listing closed.
 */
async function listOnSelectedDaemon<Kind extends Exclude<ReclaimResourceKind, 'cache'>, Rows>(
    input: Pick<ReclaimDiscoveryInput, 'context' | 'host' | 'cwd' | 'timeoutMs'>,
    executable: ResolvedExecutable,
    env: Readonly<Record<string, string>>,
    execute: Executor,
    owner: ListingOwner,
    kinds: readonly Kind[],
    parse: (text: string, kind: Kind) => Rows | undefined,
): Promise<DaemonListing<Rows> | undefined> {
    const planned = await selectDocker(input, executable, env, execute)
    if (planned === undefined) return undefined
    const selection = planned.value
    const listed = await Promise.all(kinds.map(async (kind): Promise<Timed<Rows> | undefined> => {
        const step = exactStep(`${owner === null ? 'stacks' : 'runtime'}:discover:${kind}`,
            [executable.canonicalPath, ...runtimeCommand(kind, selection, owner)],
            executable, input.cwd, env, input.timeoutMs, [], {
                ...owner === null ? {} : { stackId: owner.stackId, cockpitId: owner.cockpitId },
                resourceKind: kind, dockerContext: selection.context, dockerEndpoint: selection.endpoint,
            }, [], OUTPUT_LIMIT)
        const outcome = step === undefined ? undefined : cleanOutput(await execute(step))
        const text = outcome === undefined ? undefined : utf8(outcome.stdout)
        const rows = text === undefined ? undefined : parse(text, kind)
        return rows === undefined ? undefined : { value: rows, startedAt: outcome!.receipt.startedAt, finishedAt: outcome!.receipt.finishedAt }
    }))
    if (listed.some((value) => value === undefined)) return undefined
    const lists = listed as Timed<Rows>[]
    const listedAt = lists.map(({ finishedAt }) => finishedAt).sort(lexical).at(-1)!
    const reselected = await selectDocker(input, executable, env, execute)
    if (reselected === undefined || !sameSelection(reselected.value, selection)
        || Date.parse(reselected.startedAt) < Date.parse(listedAt)) return undefined
    return { selection, lists, listedAt, reselected }
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
            const observedLabels = exactKeys(record, ['id', 'labels']) ? dockerLabels(record.labels, listedLabels()) : undefined
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
    const listed = await listOnSelectedDaemon(input, executable, env, execute,
        { stackId: input.stackId, cockpitId: input.cockpitId }, DISCOVERY_KINDS, stackRows)
    if (listed === undefined || Date.parse(listed.reselected.finishedAt) - Date.parse(listed.listedAt) > 30_000) return undefined
    const { lists, listedAt, selection } = listed
    const runtime: DiscoveryRuntime = {
        executable, cwd: input.cwd, env, timeoutMs: input.timeoutMs,
        stackId: input.stackId, cockpitId: input.cockpitId, selection,
    }
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
    if (confirmed === undefined || !sameSelection(confirmed.value, selection)
        || Date.parse(confirmed.startedAt) < Date.parse(finishedAt)) return undefined
    return { observedAt: finishedAt, producer: 'runtime-resource-discovery', resources, startedAt, stackId: input.stackId, selection }
}

/**
 * Lists and inspects this stack's runtime resources on the selected Docker context. Discovery
 * lists resources and then inspects what it listed, and a listed resource can vanish in between,
 * as Compose replacing one of this stack's containers does; the round then fails closed on an id
 * that no longer exists and the teardown stops. One more
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

type MachineStackDiscoveryInput = Omit<ReclaimDiscoveryInput, 'stackId' | 'cockpitId'>

const MACHINE_KINDS = ['container', 'network', 'volume'] as const
const COMPOSE_WORKING_DIR = 'com.docker.compose.project.working_dir'
const MACHINE_LABELS = [...Object.values(REQUIRED_LABELS), COMPOSE_LABELS.project, COMPOSE_WORKING_DIR] as const
const RUNNING_STATES = new Set(['running', 'restarting', 'paused'])
// Each removal names its resources in argv, which a step bounds; a chunk also keeps the ids Docker
// echoes on stdout within the step's default output cap.
const REMOVAL_CHUNK = 128

function machineRows(text: string, kind: typeof MACHINE_KINDS[number]): { resources: MachineStackResource[]; unattributed: number } | undefined {
    const resources: MachineStackResource[] = []
    let unattributed = 0
    for (const line of text.split('\n')) {
        if (line.length === 0) continue
        // Unparseable docker output is unproven; the discovery fails closed.
        const row = tryParseJson(line)
        if (row === null || typeof row !== 'object' || Array.isArray(row) || !exactKeys(row, ['id', 'name', 'state', 'labels'])) return undefined
        const { id, name, state, labels: listed } = row as Record<string, unknown>
        // A working directory is a path, so its label may run far past a stack's own label bound.
        const labels = listed !== null && typeof listed === 'object' && exactKeys(listed, MACHINE_LABELS) ? dockerLabels(listed, MACHINE_LABELS, 4_096) : undefined
        if (typeof id !== 'string' || !RESOURCE_ID.test(id) || typeof name !== 'string' || name.length === 0 || name.length > 512
            || typeof state !== 'string' || state.length > 64 || labels === undefined) return undefined
        const stack = labels[REQUIRED_LABELS.stack] ?? ''
        const owner = labels[REQUIRED_LABELS.owner] ?? ''
        if (!STACK_ID.test(stack) || !COCKPIT_ID.test(owner) || !SHA256.test(labels[REQUIRED_LABELS.config] ?? '')) {
            unattributed += 1
            continue
        }
        const workingDir = labels[COMPOSE_WORKING_DIR]
        resources.push({
            kind, id, name, cockpitId: owner as CockpitId, stackId: stack as StackId,
            running: kind === 'container' && RUNNING_STATES.has(state),
            composeProject: labels[COMPOSE_LABELS.project] ?? null,
            workingDir: kind === 'container' && workingDir !== undefined && isAbsolute(workingDir) ? normalize(workingDir) : null,
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
    const listed = await listOnSelectedDaemon(input, executable, env, execute, null, MACHINE_KINDS, machineRows)
    if (listed === undefined) return undefined
    const resources = listed.lists.flatMap(({ value }) => value.resources)
    if (resources.length > MAX_RESOURCES) return undefined
    return {
        selection: listed.selection, observedAt: listed.listedAt,
        resources: resources.sort((left, right) => lexical(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`)),
        unattributed: listed.lists.reduce((sum, { value }) => sum + value.unattributed, 0),
    }
}

/**
 * The Docker removals prune runs for one kind of one orphaned stack's resources, as the machine
 * discovery attributed them: one client per chunk rather than one per resource. Undefined when the
 * resources are not all of one kind and one stack, or a step cannot be built.
 */
export function machineStackRemovalSteps(
    input: Pick<MachineStackDiscoveryInput, 'executable' | 'cwd' | 'env' | 'timeoutMs'>,
    selection: DockerSelection,
    resources: readonly MachineStackResource[],
): readonly Readonly<{ step: ExecutionStep; resources: readonly MachineStackResource[] }>[] | undefined {
    const executable = resolvedDockerExecutable(input.executable)
    const env = safeEnvironment(input.env)
    const [first] = resources
    if (first === undefined || executable === undefined || env === undefined || admitLocalDockerEndpoint(selection.endpoint) === undefined
        || resources.some(({ kind, stackId, cockpitId, id }) => kind !== first.kind || stackId !== first.stackId || cockpitId !== first.cockpitId || !RESOURCE_ID.test(id))
        || !validExecutionInput(executable, input.cwd, input.env, input.timeoutMs)) return undefined
    const command = first.kind === 'container' ? ['container', 'rm', '--force'] : [first.kind, 'rm']
    const removals: { step: ExecutionStep; resources: readonly MachineStackResource[] }[] = []
    for (let start = 0; start < resources.length; start += REMOVAL_CHUNK) {
        const chunk = resources.slice(start, start + REMOVAL_CHUNK)
        const ids = chunk.map(({ id }) => id)
        const step = exactStep(`stacks:prune:${first.kind}:${digestValue(ids).slice(0, 16)}`,
            [executable.canonicalPath, '--host', selection.endpoint, ...command, '--', ...ids],
            executable, input.cwd, env, input.timeoutMs, [],
            { stackId: first.stackId, cockpitId: first.cockpitId, resourceKind: first.kind, resourceCount: String(ids.length) })
        if (step === undefined) return undefined
        removals.push({ step, resources: chunk })
    }
    return removals
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

interface RemovalExecution {
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
}

export interface PlanTeardownInput extends ClassifyReclaimInput, RemovalExecution {
    readonly discovery: ReclaimDiscovery
    readonly executable: ResolvedExecutable
}

export interface PlanResetInput extends ClassifyReclaimInput, RemovalExecution {
    readonly discovery: ReclaimDiscovery
    readonly requesterHolderId: string | null
    /** Compose volume keys, matched within `composeProject`; Docker's volume name is not one. */
    readonly resettableVolumes: readonly string[]
    readonly composeProject: string
    readonly generatedHostPaths: readonly HostPathDeclaration[]
    readonly runtimeExecutable: ResolvedExecutable
    readonly pathExecutable: ResolvedExecutable
}

/** One thing down or reset removes, by its runtime id or host path, with the exact step that removes it. */
export interface RemovalTarget {
    readonly kind: ReclaimResourceKind | 'host-path'
    readonly id: string
    readonly name: string
    readonly step: ExecutionStep
}

type PlanRefusal = { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

export type TeardownPlan = { readonly kind: 'complete'; readonly targets: readonly RemovalTarget[] } | PlanRefusal

export interface ResetPlan {
    readonly kind: 'complete'
    /** Names the exact targets; a person approves it, and the reset acts only while it still matches. */
    readonly digest: string
    readonly targets: readonly ResetTargetInput[]
    readonly noop: boolean
    readonly removals: readonly RemovalTarget[]
}

function refusal(code: EnvironmentCode, message: string, target: string, fix?: string): PlanRefusal {
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
        const rootStatus = await lstat(declaration.root)
        if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() || await realpath(declaration.root) !== declaration.root) return undefined
        let cursor = declaration.root
        const parts = relation.split(sep)
        for (let index = 0; index < parts.length; index += 1) {
            cursor = resolve(cursor, parts[index]!)
            try {
                const status = await lstat(cursor)
                if (status.isSymbolicLink()) return undefined
                if (index < parts.length - 1 && !status.isDirectory()) return undefined
                if (index === parts.length - 1) {
                    if (await realpath(cursor) !== cursor) return undefined
                    return { state: 'present', type: status.isDirectory() ? 'directory' : status.isFile() ? 'file' : undefined }
                }
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


// Each removal names a resource by its id, so a resource another stack or a person created later
// under the same name is never the one removed.
function teardownStep(resource: ClassifiedReclaimResource, input: PlanTeardownInput, selection: DockerSelection): ExecutionStep | undefined {
    const command = resource.kind === 'container' ? ['container', 'rm', '--force', '--', resource.id]
        : resource.kind === 'network' ? ['network', 'rm', '--', resource.id]
            : resource.kind === 'image' ? ['image', 'rm', '--', resource.id]
                : resource.kind === 'build-cache' ? ['builder', 'prune', '--filter', `id=${resource.id}`, '--force']
                    : undefined
    if (command === undefined) return undefined
    return exactStep(
        `teardown:${resource.kind}:${digestValue(resource.id).slice(0, 16)}`,
        [input.executable.canonicalPath, '--host', selection.endpoint, ...command],
        input.executable, input.cwd, input.env, input.timeoutMs, [],
        { stackId: input.stackId, configSha256: input.configSha256, resourceKind: resource.kind, resourceId: resource.id },
    )
}

/**
 * What `down` removes from one discovery, in removal order: the resources the labels and coordinated
 * state show are this stack's and nothing outside it uses. Containers sort before the networks and
 * images they hold, and volumes are never among them.
 */
export function planTeardown(input: PlanTeardownInput): TeardownPlan {
    const executable = resolvedDockerExecutable(input.executable)
    if (executable === undefined || !validExecutionInput(executable, input.cwd, input.env, input.timeoutMs)) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown execution input is malformed', 'teardown')
    }
    if (!discoveryOfStack(input.discovery, input.stackId)) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'teardown requires a fresh runtime discovery of this stack', 'teardown-discovery')
    }
    if (input.coordinationRecord === null || decodeCoordinationRecord(input.coordinationRecord, input.stackId) === undefined) {
        return refusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'teardown requires this stack\'s coordination record', input.stackId)
    }
    const classified = classifyReclaim(reclaimInput(input))
    if (classified.kind !== 'complete') return classified
    const targets: RemovalTarget[] = []
    const actionable = classified.resources.filter((resource) => resource.action === 'teardown'
        || resource.action === 'reclaim' && resource.kind === 'build-cache')
        .sort((left, right) => lexical(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`))
    for (const resource of actionable) {
        const step = teardownStep(resource, { ...input, executable }, input.discovery.selection)
        if (step === undefined) return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'a teardown step could not be built', resource.id)
        targets.push({ kind: resource.kind, id: resource.id, name: resource.name, step })
    }
    return { kind: 'complete', targets }
}

function resetStep(target: ResetTargetAuthority, input: PlanResetInput, runtime: ResolvedExecutable, path: ResolvedExecutable): ExecutionStep | undefined {
    const labels = { stackId: input.stackId, configSha256: input.configSha256, resetKind: target.kind }
    const id = `reset:${target.kind}:${digestValue(target.identity).slice(0, 16)}`
    if (target.kind === 'host-path') {
        return exactStep(id, [path.canonicalPath, '-rf', '--', target.identity], path, input.cwd, input.env, input.timeoutMs,
            [target.identity], labels, [{ path: target.identity, expected: target.evidence.type! }])
    }
    const command = target.kind === 'container' ? ['container', 'rm', '--force', '--', target.identity]
        : ['volume', 'rm', '--', target.evidence.resourceId]
    return exactStep(id, [runtime.canonicalPath, '--host', input.discovery.selection.endpoint, ...command], runtime,
        input.cwd, input.env, input.timeoutMs, [], labels)
}

// What a person approves: each target's identity, never its size or timestamps, so the same
// targets read twice give the same digest and a replaced volume or path gives another.
function resetTargetIdentity(target: ResetTargetAuthority): unknown {
    if (target.kind === 'volume') return { kind: target.kind, name: target.identity, declaration: target.declaration,
        id: target.evidence.resourceId, generation: target.evidence.generation }
    if (target.kind === 'container') return { kind: target.kind, id: target.identity, name: target.declaration }
    return { kind: target.kind, path: target.identity, declaration: target.declaration, ...target.evidence }
}

/**
 * The declared volumes and generated host paths `reset` deletes, with the containers that still
 * reference those volumes, and a digest of exactly those targets.
 */
export async function planReset(input: PlanResetInput): Promise<ResetPlan | PlanRefusal> {
    const runtime = resolvedDockerExecutable(input.runtimeExecutable)
    const path = await removalExecutable(input.pathExecutable)
    if (runtime === undefined || path === undefined
        || !validExecutionInput(runtime, input.cwd, input.env, input.timeoutMs)
        || !validExecutionInput(path, input.cwd, input.env, input.timeoutMs)) {
        return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'reset execution input is malformed', 'reset')
    }
    if (!discoveryOfStack(input.discovery, input.stackId)) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reset requires a fresh runtime discovery of this stack', 'reset-discovery')
    }
    const coordination = input.coordinationRecord === null ? undefined : decodeCoordinationRecord(input.coordinationRecord, input.stackId)
    if (coordination === undefined) return refusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'reset requires this stack\'s coordination record', input.stackId)
    if (coordination.holders.some(({ holderId }) => holderId !== input.requesterHolderId)) {
        return refusal(ENVIRONMENT_CODES.RESET_CO_TENANT, 'reset requires that no other session holds the stack', input.stackId)
    }
    const authorities = await resetAuthorities(input)
    if (authorities === undefined) {
        return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH, 'reset targets do not match current declarations and ownership evidence', 'reset-targets')
    }
    const removals: RemovalTarget[] = []
    for (const target of authorities) {
        if (target.kind === 'host-path' && target.evidence.state === 'absent') continue
        const step = resetStep(target, input, runtime, path)
        if (step === undefined) return refusal(ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH, 'a reset step could not be built', target.identity)
        removals.push({ kind: target.kind, id: target.kind === 'volume' ? target.evidence.resourceId : target.identity, name: target.declaration, step })
    }
    return {
        kind: 'complete',
        digest: digestValue({
            format: 'cockpit-reset-preview/v2', stackId: input.stackId, cockpitId: input.cockpitId,
            configSha256: input.configSha256, targets: authorities.map(resetTargetIdentity),
        }),
        targets: authorities.map(safeTarget),
        noop: authorities.length === 0,
        removals,
    }
}

/** Runs each removal in order, and stops at the first that fails. */
export async function removeTargets(targets: readonly RemovalTarget[], execute: Executor): Promise<PlanRefusal | undefined> {
    for (const target of targets) {
        const outcome = await execute(target.step)
        if (outcome.kind !== 'complete') {
            return refusal(ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH,
                `removing ${target.kind} ${target.name} (${target.id}) failed (${outcome.code}); what was removed before it stays removed`, target.id,
                'resolve what blocks that removal, then run the same command again: it removes only what is still there')
        }
    }
    return undefined
}

/** The removals a later discovery still shows: Docker or the filesystem reported success, but the target remains. */
export function remainingTargets(targets: readonly RemovalTarget[], discovery: ReclaimDiscovery): readonly RemovalTarget[] {
    const present = new Set(discovery.resources.map(({ kind, id }) => `${kind}:${id}`))
    return targets.filter((target) => target.kind === 'host-path' ? !pathIsAbsent(target.id) : present.has(`${target.kind}:${target.id}`))
}

function pathIsAbsent(path: string): boolean {
    try { lstatSync(path); return false } catch (error) { return hasErrorCode(error, 'ENOENT') }
}
