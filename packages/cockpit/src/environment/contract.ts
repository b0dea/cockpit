import { dirname, isAbsolute, normalize } from 'node:path'
import { isProxy } from 'node:util/types'

import { isEntrypointKind, type EntrypointKind } from '../entrypoint-kinds.js'

export interface Diagnostic<Code extends string = string> {
    severity: 'error' | 'warning' | 'info'
    code: Code
    message: string
    target?: string
    fix?: string
}

export const mechanism = {
    id: 'environment-contract',
    module: 'packages/cockpit/src/environment/contract.ts',
    exports: [
        'OUTCOME_KINDS', 'OBSERVATION_STATES', 'OBSERVATION_LIFECYCLE_STAGES', 'STABILITY_VERDICTS', 'OWNERSHIP_VERDICTS',
        'TEMPLATE_RESULTS', 'SETUP_ACTION_KINDS', 'ENVIRONMENT_CODES', 'EXECUTION_FAILURE_CODES',
        'REFUSAL_CODES', 'OBSERVATION_PRODUCER_BYTE_LIMIT', 'OBSERVATION_REASON_BYTE_LIMIT',
        'isCanonicalTimestamp', 'snapshotJson', 'snapshotGeneratedJson', 'snapshotExecutionStep', 'snapshotExecutionPlan',
        'snapshotEnvironmentObservation',
        'snapshotLifecyclePlan', 'inStackCommand',
    ],
} as const

export type JsonSnapshot = null | boolean | number | string | JsonSnapshotArray | JsonSnapshotObject
export interface JsonSnapshotArray extends ReadonlyArray<JsonSnapshot> {}
export interface JsonSnapshotObject { readonly [key: string]: JsonSnapshot }

const JSON_LIMITS = { bytes: 1_048_576, nodes: 65_536, entries: 4_096, scalarBytes: 65_536, depth: 64 } as const
interface JsonTraversal {
    bytes: number
    nodes: number
    entryLimit: number
    readonly byteLimit: number
    readonly scalarLimit: number
    readonly ancestors: WeakSet<object>
}

function reserveBytes(state: JsonTraversal, bytes: number): boolean {
    if (state.bytes + bytes > state.byteLimit) return false
    state.bytes += bytes
    return true
}

function snapshotJsonValue(value: unknown, state: JsonTraversal, depth: number): JsonSnapshot | undefined {
    if (state.nodes >= JSON_LIMITS.nodes || depth > JSON_LIMITS.depth) return undefined
    state.nodes += 1
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        if (typeof value === 'number' && !Number.isFinite(value)) return undefined
        const encoded = JSON.stringify(value)
        return reserveBytes(state, Buffer.byteLength(encoded)) ? value : undefined
    }
    if (typeof value === 'string') {
        const bytes = Buffer.byteLength(value)
        return bytes <= state.scalarLimit && reserveBytes(state, Buffer.byteLength(JSON.stringify(value))) ? value : undefined
    }
    if (typeof value !== 'object' || isProxy(value) || state.ancestors.has(value)) return undefined
    if (!reserveBytes(state, 2)) return undefined
    const ancestors = state.ancestors
    ancestors.add(value)
    try {
        if (Array.isArray(value)) {
            const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
            const keys = Reflect.ownKeys(value)
            const length = descriptors.length.value
            if (typeof length !== 'number' || length > state.entryLimit || keys.length !== length + 1
                || keys.some((key) => typeof key !== 'string' || key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key))
                || !reserveBytes(state, Math.max(0, length - 1))) return undefined
            const result: JsonSnapshot[] = []
            for (let index = 0; index < length; index += 1) {
                const descriptor = descriptors[String(index)]
                if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
                const item = snapshotJsonValue(descriptor.value, state, depth + 1)
                if (item === undefined) return undefined
                result.push(item)
            }
            return Object.freeze(result)
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) return undefined
        const result = Object.create(null) as Record<string, JsonSnapshot>
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const ownKeys = Reflect.ownKeys(value)
        if (ownKeys.some((key) => typeof key !== 'string')) return undefined
        const keys = (ownKeys as string[]).sort()
        if (keys.length > state.entryLimit || !reserveBytes(state, Math.max(0, keys.length - 1))) return undefined
        for (const key of keys) {
            const descriptor = descriptors[key]
            if (!descriptor.enumerable || !('value' in descriptor)) return undefined
            if (Buffer.byteLength(key) > JSON_LIMITS.scalarBytes || !reserveBytes(state, Buffer.byteLength(JSON.stringify(key)) + 1)) return undefined
            const item = snapshotJsonValue(descriptor.value, state, depth + 1)
            if (item === undefined) return undefined
            Object.defineProperty(result, key, { enumerable: true, value: item })
        }
        return Object.freeze(result)
    } catch {
        return undefined
    } finally {
        ancestors.delete(value)
    }
}

export function snapshotJson(value: unknown): JsonSnapshot | undefined {
    return snapshotJsonWithEntryLimit(value, JSON_LIMITS.entries)
}

function snapshotJsonWithEntryLimit(value: unknown, entryLimit: number): JsonSnapshot | undefined {
    return snapshotJsonValue(value, {
        bytes: 0, nodes: 0, entryLimit, byteLimit: JSON_LIMITS.bytes,
        scalarLimit: JSON_LIMITS.scalarBytes, ancestors: new WeakSet<object>(),
    }, 0)
}

export function snapshotGeneratedJson(value: unknown): JsonSnapshot | undefined {
    return snapshotJsonValue(value, {
        bytes: 0, nodes: 0, entryLimit: JSON_LIMITS.entries, byteLimit: 33_554_432,
        scalarLimit: 16_777_216, ancestors: new WeakSet<object>(),
    }, 0)
}

declare const identityBrand: unique symbol

type BrandedIdentity<Name extends string> = string & { readonly [identityBrand]: Name }

export type CockpitId = BrandedIdentity<'CockpitId'>
export type CheckoutId = BrandedIdentity<'CheckoutId'>
export type StackId = BrandedIdentity<'StackId'>
export type HolderId = BrandedIdentity<'HolderId'>

export interface EnvironmentIdentity {
    cockpitId: CockpitId
    checkoutId: CheckoutId
    stackId: StackId
    holderId: HolderId
}

export const OUTCOME_KINDS = ['complete', 'preview', 'refusal'] as const
export const OBSERVATION_STATES = ['available', 'unavailable', 'failed'] as const
export const OBSERVATION_LIFECYCLE_STAGES = ['bootstrap', 'steady'] as const
export const STABILITY_VERDICTS = ['stable', 'void', 'unavailable'] as const
export const OWNERSHIP_VERDICTS = ['owned-live', 'owned-dead', 'unknown', 'unowned', 'malformed', 'escaped'] as const
export const TEMPLATE_RESULTS = ['created', 'unchanged', 'gap'] as const
export const SETUP_ACTION_KINDS = ['clone', 'wire-remote', 'report'] as const
export const OBSERVATION_PRODUCER_BYTE_LIMIT = 256
export const OBSERVATION_REASON_BYTE_LIMIT = 1_024
export const ENVIRONMENT_CODES = Object.freeze({
    CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
    CONFIG_UNREADABLE: 'CONFIG_UNREADABLE',
    CONFIG_ENCODING_INVALID: 'CONFIG_ENCODING_INVALID',
    CONFIG_PARSE_INVALID: 'CONFIG_PARSE_INVALID',
    CONFIG_SCHEMA_INVALID: 'CONFIG_SCHEMA_INVALID',
    STATE_ROOT_UNAVAILABLE: 'STATE_ROOT_UNAVAILABLE',
    STATE_FORMAT_UNSUPPORTED: 'STATE_FORMAT_UNSUPPORTED',
    STATE_RECORD_MALFORMED: 'STATE_RECORD_MALFORMED',
    STATE_LOCKED: 'STATE_LOCKED',
    STATE_DURABILITY_INDETERMINATE: 'STATE_DURABILITY_INDETERMINATE',
    SETUP_CONFIG_REQUIRED: 'SETUP_CONFIG_REQUIRED',
    SETUP_OPTION_DUPLICATE: 'SETUP_OPTION_DUPLICATE',
    SETUP_POSITIONAL_UNSUPPORTED: 'SETUP_POSITIONAL_UNSUPPORTED',
    SETUP_PATH_OUTSIDE_ROOT: 'SETUP_PATH_OUTSIDE_ROOT',
    SETUP_PATH_SYMLINK: 'SETUP_PATH_SYMLINK',
    SETUP_PATH_TYPE_INVALID: 'SETUP_PATH_TYPE_INVALID',
    SETUP_PARENT_MISSING: 'SETUP_PARENT_MISSING',
    SETUP_REMOTE_MISMATCH: 'SETUP_REMOTE_MISMATCH',
    SETUP_MANUAL_MISSING: 'SETUP_MANUAL_MISSING',
    SETUP_NONE_ABSENT: 'SETUP_NONE_ABSENT',
    SETUP_NONE_DIRECTORY: 'SETUP_NONE_DIRECTORY',
    SETUP_NONE_REPOSITORY: 'SETUP_NONE_REPOSITORY',
    SETUP_POSTCHECK_FAILED: 'SETUP_POSTCHECK_FAILED',
    CONFIG_CHANGED_DURING_EXECUTION: 'CONFIG_CHANGED_DURING_EXECUTION',
    EXECUTION_SPAWN_FAILED: 'EXECUTION_SPAWN_FAILED',
    EXECUTION_PRECONDITION_CHANGED: 'EXECUTION_PRECONDITION_CHANGED',
    EXECUTION_STAGING_FAILED: 'EXECUTION_STAGING_FAILED',
    EXECUTION_STAGING_CLEANUP_FAILED: 'EXECUTION_STAGING_CLEANUP_FAILED',
    EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT',
    EXECUTION_STDOUT_LIMIT: 'EXECUTION_STDOUT_LIMIT',
    EXECUTION_STDERR_LIMIT: 'EXECUTION_STDERR_LIMIT',
    EXECUTION_STEP_FAILED: 'EXECUTION_STEP_FAILED',
    EXECUTION_ABORTED: 'EXECUTION_ABORTED',
    EXECUTION_TERMINATION_UNCONFIRMED: 'EXECUTION_TERMINATION_UNCONFIRMED',
    EXECUTION_COMPENSATION_TIMEOUT: 'EXECUTION_COMPENSATION_TIMEOUT',
    EXECUTION_COMPENSATION_STEP_FAILED: 'EXECUTION_COMPENSATION_STEP_FAILED',
    LIFECYCLE_EVIDENCE_INVALID: 'LIFECYCLE_EVIDENCE_INVALID',
    LIFECYCLE_PROGRESS_INVALID: 'LIFECYCLE_PROGRESS_INVALID',
    PORT_FAMILY_COLLISION: 'PORT_FAMILY_COLLISION',
    PORT_LISTENER_EVIDENCE_INVALID: 'PORT_LISTENER_EVIDENCE_INVALID',
    PORT_FAMILY_OUT_OF_RANGE: 'PORT_FAMILY_OUT_OF_RANGE',
    PORT_LEASE_EXHAUSTED: 'PORT_LEASE_EXHAUSTED',
    PORT_LOCAL_VALUE_CORRECTED: 'PORT_LOCAL_VALUE_CORRECTED',
    PORT_EXTERNAL_REGISTRATION_GAP: 'PORT_EXTERNAL_REGISTRATION_GAP',
    CLAIM_CO_TENANT: 'CLAIM_CO_TENANT',
    CLAIM_LIVENESS_UNKNOWN: 'CLAIM_LIVENESS_UNKNOWN',
    DRAIN_ATTEMPT_REPAIR_REQUIRED: 'DRAIN_ATTEMPT_REPAIR_REQUIRED',
    INSTALL_LOCK_HELD: 'INSTALL_LOCK_HELD',
    INSTALL_LOCK_INVALID: 'INSTALL_LOCK_INVALID',
    INSTALL_STALE_PATH: 'INSTALL_STALE_PATH',
    INSTALL_LOAD_PROBE_FAILED: 'INSTALL_LOAD_PROBE_FAILED',
    INSTALL_LOCKFILE_CHANGED: 'INSTALL_LOCKFILE_CHANGED',
    INSTALL_POLICY_OBSERVATION_UNAVAILABLE: 'INSTALL_POLICY_OBSERVATION_UNAVAILABLE',
    INSTALL_POLICY_OBSERVATION_INVALID: 'INSTALL_POLICY_OBSERVATION_INVALID',
    INSTALL_POLICY_MISSING: 'INSTALL_POLICY_MISSING',
    INSTALL_POLICY_AMBIGUOUS: 'INSTALL_POLICY_AMBIGUOUS',
    TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
    TEMPLATE_NOT_TRACKED: 'TEMPLATE_NOT_TRACKED',
    TEMPLATE_IGNORED: 'TEMPLATE_IGNORED',
    TEMPLATE_PATH_OUTSIDE_ROOT: 'TEMPLATE_PATH_OUTSIDE_ROOT',
    ENVIRONMENT_FILE_NOT_FOUND: 'ENVIRONMENT_FILE_NOT_FOUND',
    ENVIRONMENT_FILE_UNREADABLE: 'ENVIRONMENT_FILE_UNREADABLE',
    ENVIRONMENT_FILE_TOO_LARGE: 'ENVIRONMENT_FILE_TOO_LARGE',
    ENVIRONMENT_FILE_MALFORMED: 'ENVIRONMENT_FILE_MALFORMED',
    INSTANCE_NOT_IGNORED: 'INSTANCE_NOT_IGNORED',
    ENVIRONMENT_SEED_PRECONDITION_CHANGED: 'ENVIRONMENT_SEED_PRECONDITION_CHANGED',
    ENVIRONMENT_SEED_FAILED: 'ENVIRONMENT_SEED_FAILED',
    RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
    RUNTIME_UNMEASURED: 'RUNTIME_UNMEASURED',
    RUNTIME_COMPOSE_REMOTE: 'RUNTIME_COMPOSE_REMOTE',
    RUNTIME_LAUNCHER_UNAVAILABLE: 'RUNTIME_LAUNCHER_UNAVAILABLE',
    RUNTIME_PROBE_TIMEOUT: 'RUNTIME_PROBE_TIMEOUT',
    RESET_CONFIRMATION_REQUIRED: 'RESET_CONFIRMATION_REQUIRED',
    RESET_CONFIRMATION_MISMATCH: 'RESET_CONFIRMATION_MISMATCH',
    RESET_CO_TENANT: 'RESET_CO_TENANT',
    EVIDENCE_BASELINE_MISSING: 'EVIDENCE_BASELINE_MISSING',
    EVIDENCE_UNAVAILABLE: 'EVIDENCE_UNAVAILABLE',
    RECLAIM_LABEL_ESCAPE: 'RECLAIM_LABEL_ESCAPE',
    RECLAIM_ACCOUNTING_MISMATCH: 'RECLAIM_ACCOUNTING_MISMATCH',
    CONFIG_STALE: 'CONFIG_STALE',
    SIBLING_MISSING: 'SIBLING_MISSING',
    GUIDE_CAP_EXCEEDED: 'GUIDE_CAP_EXCEEDED',
    MACHINE_MEMORY_BELOW_FLOOR: 'MACHINE_MEMORY_BELOW_FLOOR',
    MACHINE_CPU_BELOW_FLOOR: 'MACHINE_CPU_BELOW_FLOOR',
    MACHINE_DISK_BELOW_FLOOR: 'MACHINE_DISK_BELOW_FLOOR',
    MACHINE_COLD_START_EXCEEDED: 'MACHINE_COLD_START_EXCEEDED',
    GIT_STATE_UNHEALTHY: 'GIT_STATE_UNHEALTHY',
    CHECKOUT_ADJACENCY_UNHEALTHY: 'CHECKOUT_ADJACENCY_UNHEALTHY',
    GIT_COMPARISON_REMOTE_MISMATCH: 'GIT_COMPARISON_REMOTE_MISMATCH',
    RUNNING_CHECKOUT_MISMATCH: 'RUNNING_CHECKOUT_MISMATCH',
    DISK_BUDGET_EXCEEDED: 'DISK_BUDGET_EXCEEDED',
    ENVIRONMENT_KEYS_STALE: 'ENVIRONMENT_KEYS_STALE',
    ENV_SCHEMA_UNHEALTHY: 'ENV_SCHEMA_UNHEALTHY',
    ENV_SCHEMA_TOOL_MISSING: 'ENV_SCHEMA_TOOL_MISSING',
    INSTALL_STATE_UNHEALTHY: 'INSTALL_STATE_UNHEALTHY',
    GENERATED_ENVIRONMENT_UNAVAILABLE: 'GENERATED_ENVIRONMENT_UNAVAILABLE',
    DATA_MODE_UNAVAILABLE: 'DATA_MODE_UNAVAILABLE',
    EXTERNAL_DEPENDENCIES_UNAVAILABLE: 'EXTERNAL_DEPENDENCIES_UNAVAILABLE',
    CLAIM_STATE_UNHEALTHY: 'CLAIM_STATE_UNHEALTHY',
    MOUNT_POSTURE_UNAVAILABLE: 'MOUNT_POSTURE_UNAVAILABLE',
    REGISTRY_AUTH_UNAVAILABLE: 'REGISTRY_AUTH_UNAVAILABLE',
    STATE_UNSEEDED: 'STATE_UNSEEDED',
    SKILL_BUDGET_UNAVAILABLE: 'SKILL_BUDGET_UNAVAILABLE',
    HARNESS_SURFACE_UNAVAILABLE: 'HARNESS_SURFACE_UNAVAILABLE',
    DIRECTORY_GRANTS_UNAVAILABLE: 'DIRECTORY_GRANTS_UNAVAILABLE',
    MOUNT_MATERIALIZATION_UNAVAILABLE: 'MOUNT_MATERIALIZATION_UNAVAILABLE',
    ENVIRONMENT_NOT_DECLARED: 'ENVIRONMENT_NOT_DECLARED',
    GUARD_HOSTS_UNDECLARED: 'GUARD_HOSTS_UNDECLARED',
} as const)

export const EXECUTION_FAILURE_CODES = Object.freeze([
    ENVIRONMENT_CODES.EXECUTION_SPAWN_FAILED,
    ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
    ENVIRONMENT_CODES.EXECUTION_STAGING_FAILED,
    ENVIRONMENT_CODES.EXECUTION_STAGING_CLEANUP_FAILED,
    ENVIRONMENT_CODES.EXECUTION_TIMEOUT,
    ENVIRONMENT_CODES.EXECUTION_STDOUT_LIMIT,
    ENVIRONMENT_CODES.EXECUTION_STDERR_LIMIT,
    ENVIRONMENT_CODES.EXECUTION_STEP_FAILED,
    ENVIRONMENT_CODES.EXECUTION_ABORTED,
    ENVIRONMENT_CODES.EXECUTION_TERMINATION_UNCONFIRMED,
] as const)

export const REFUSAL_CODES = Object.freeze([
    ENVIRONMENT_CODES.CONFIG_NOT_FOUND,
    ENVIRONMENT_CODES.CONFIG_UNREADABLE,
    ENVIRONMENT_CODES.CONFIG_ENCODING_INVALID,
    ENVIRONMENT_CODES.CONFIG_PARSE_INVALID,
    ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
    ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
    ENVIRONMENT_CODES.STATE_FORMAT_UNSUPPORTED,
    ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
    ENVIRONMENT_CODES.STATE_LOCKED,
    ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
    ENVIRONMENT_CODES.SETUP_CONFIG_REQUIRED,
    ENVIRONMENT_CODES.SETUP_OPTION_DUPLICATE,
    ENVIRONMENT_CODES.SETUP_POSITIONAL_UNSUPPORTED,
    ENVIRONMENT_CODES.SETUP_PATH_OUTSIDE_ROOT,
    ENVIRONMENT_CODES.SETUP_PATH_SYMLINK,
    ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
    ENVIRONMENT_CODES.SETUP_PARENT_MISSING,
    ENVIRONMENT_CODES.SETUP_REMOTE_MISMATCH,
    ENVIRONMENT_CODES.SETUP_MANUAL_MISSING,
    ENVIRONMENT_CODES.SETUP_POSTCHECK_FAILED,
    ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION,
    ...EXECUTION_FAILURE_CODES,
    ENVIRONMENT_CODES.EXECUTION_COMPENSATION_TIMEOUT,
    ENVIRONMENT_CODES.EXECUTION_COMPENSATION_STEP_FAILED,
    ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
    ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID,
    ENVIRONMENT_CODES.PORT_FAMILY_COLLISION,
    ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID,
    ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE,
    ENVIRONMENT_CODES.PORT_LEASE_EXHAUSTED,
    ENVIRONMENT_CODES.CLAIM_CO_TENANT,
    ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN,
    ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED,
    ENVIRONMENT_CODES.INSTALL_LOCK_HELD,
    ENVIRONMENT_CODES.INSTALL_LOCK_INVALID,
    ENVIRONMENT_CODES.INSTALL_STALE_PATH,
    ENVIRONMENT_CODES.INSTALL_LOAD_PROBE_FAILED,
    ENVIRONMENT_CODES.INSTALL_LOCKFILE_CHANGED,
    ENVIRONMENT_CODES.INSTALL_POLICY_OBSERVATION_UNAVAILABLE,
    ENVIRONMENT_CODES.INSTALL_POLICY_OBSERVATION_INVALID,
    ENVIRONMENT_CODES.INSTALL_POLICY_MISSING,
    ENVIRONMENT_CODES.INSTALL_POLICY_AMBIGUOUS,
    ENVIRONMENT_CODES.TEMPLATE_NOT_FOUND,
    ENVIRONMENT_CODES.TEMPLATE_NOT_TRACKED,
    ENVIRONMENT_CODES.TEMPLATE_IGNORED,
    ENVIRONMENT_CODES.TEMPLATE_PATH_OUTSIDE_ROOT,
    ENVIRONMENT_CODES.ENVIRONMENT_FILE_NOT_FOUND,
    ENVIRONMENT_CODES.ENVIRONMENT_FILE_UNREADABLE,
    ENVIRONMENT_CODES.ENVIRONMENT_FILE_TOO_LARGE,
    ENVIRONMENT_CODES.ENVIRONMENT_FILE_MALFORMED,
    ENVIRONMENT_CODES.INSTANCE_NOT_IGNORED,
    ENVIRONMENT_CODES.ENVIRONMENT_SEED_PRECONDITION_CHANGED,
    ENVIRONMENT_CODES.ENVIRONMENT_SEED_FAILED,
    ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
    ENVIRONMENT_CODES.RUNTIME_UNMEASURED,
    ENVIRONMENT_CODES.RUNTIME_COMPOSE_REMOTE,
    ENVIRONMENT_CODES.RUNTIME_LAUNCHER_UNAVAILABLE,
    ENVIRONMENT_CODES.RUNTIME_PROBE_TIMEOUT,
    ENVIRONMENT_CODES.RESET_CONFIRMATION_REQUIRED,
    ENVIRONMENT_CODES.RESET_CONFIRMATION_MISMATCH,
    ENVIRONMENT_CODES.RESET_CO_TENANT,
    ENVIRONMENT_CODES.EVIDENCE_BASELINE_MISSING,
    ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
    ENVIRONMENT_CODES.RECLAIM_LABEL_ESCAPE,
    ENVIRONMENT_CODES.RECLAIM_ACCOUNTING_MISMATCH,
    ENVIRONMENT_CODES.GIT_COMPARISON_REMOTE_MISMATCH,
] as const)

export type OutcomeKind = typeof OUTCOME_KINDS[number]
export type ObservationState = typeof OBSERVATION_STATES[number]
export type ObservationLifecycleStage = typeof OBSERVATION_LIFECYCLE_STAGES[number]
export type StabilityVerdict = typeof STABILITY_VERDICTS[number]
export type OwnershipVerdict = typeof OWNERSHIP_VERDICTS[number]
export type TemplateResult = typeof TEMPLATE_RESULTS[number]
export type SetupActionKind = typeof SETUP_ACTION_KINDS[number]
export type EnvironmentCode = typeof ENVIRONMENT_CODES[keyof typeof ENVIRONMENT_CODES]
export type ExecutionFailureCode = typeof EXECUTION_FAILURE_CODES[number]
export type RefusalCode = typeof REFUSAL_CODES[number]
export type EnvironmentDiagnostic = Diagnostic<EnvironmentCode>

const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isCanonicalTimestamp(value: unknown): value is string {
    if (typeof value !== 'string' || !canonicalTimestamp.test(value)) return false
    const milliseconds = Date.parse(value)
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

export type ExpectedObservation =
    | { kind: 'path'; target: string; state: 'absent' | 'directory' | 'repository' }
    | { kind: 'remote'; target: string; name: string; url: string }

export interface FilesystemCheck {
    path: string
    expected: 'absent' | 'directory' | 'file'
    sha256?: string
    maxBytes?: number
    identity?: FilesystemIdentity
}

export interface FilesystemIdentity {
    dev: number
    ino: number
    ancestors: readonly FilesystemAncestorIdentity[]
}

export interface FilesystemAncestorIdentity {
    path: string
    dev: number
    ino: number
}

interface ConsumedFileBase {
    path: string
    sha256: string
    maxBytes: number
    argvIndexes: readonly number[]
}

export type ConsumedFile = ConsumedFileBase & (
    | { executable: true; executionMode: 'staged' | 'verified-path' }
    | { executable: false; executionMode?: never }
)

export interface SourceProvenance {
    path: string
    byteLength: number
    sha256: string
}

export type ConfigSourceSnapshot =
    | ({ state: 'available' } & SourceProvenance)
    | {
          state: 'unavailable'
          path: string
          code: typeof ENVIRONMENT_CODES.CONFIG_NOT_FOUND | typeof ENVIRONMENT_CODES.CONFIG_UNREADABLE
      }

export interface SetupExecutionEvidence {
    mutationMayHaveOccurred: boolean
    completedStepIds: readonly string[]
    failedStep?: { id: string; started: boolean }
    compensation: {
        attemptedStepIds: readonly string[]
        completedStepIds: readonly string[]
        failed: readonly { id: string; code: ExecutionFailureCode }[]
    }
}

export interface SetupRefusalEvidence {
    execution: SetupExecutionEvidence
    source: {
        before: SourceProvenance
        after: ConfigSourceSnapshot
        postcheck?: SourceProvenance
    }
}

export interface ExecutionStep {
    id: string
    argv: readonly [string, ...string[]]
    argv0: string
    cwd: string
    env: Readonly<Record<string, string>>
    timeoutMs: number
    // Unlike timeoutMs, this deadline is rechecked after awaited preconditions, immediately before spawn.
    spawnNotAfter?: string
    stdoutLimitBytes: number
    stderrLimitBytes: number
    paths: readonly string[]
    ports: readonly number[]
    labels: Readonly<Record<string, string>>
    expected: readonly ExpectedObservation[]
    consumedFiles: readonly ConsumedFile[]
    filesystemChecks: readonly FilesystemCheck[]
    compensation: readonly ExecutionStep[]
}

export interface ExecutionPlan {
    steps: readonly ExecutionStep[]
}

export type LifecycleResumeBoundary = Readonly<{
    completedStepIds: readonly string[]
    nextStepId: string | null
}>

type LifecycleStepBase = Readonly<{ id: string }>

export interface LifecycleEntrypoint {
    readonly name: string
    readonly kind: EntrypointKind
    readonly port: string
    readonly value: string
}

export interface LifecycleCompletedService {
    readonly service: string
    readonly containerId: string
}

export interface LifecycleProgress {
    readonly workBasisSha256: string
    readonly operationGeneration: string
    readonly completedServices: readonly LifecycleCompletedService[]
}

export type LifecycleStep =
    | LifecycleStepBase & Readonly<{ kind: 'preflight' }>
    | LifecycleStepBase & Readonly<{ kind: 'claim'; action: 'acquire' | 'release' }>
    | LifecycleStepBase & Readonly<{ kind: 'prepare'; execution: ExecutionStep }>
    | LifecycleStepBase & Readonly<{ kind: 'service'; service: string }>
    | LifecycleStepBase & Readonly<{ kind: 'publish-entrypoints'; values: readonly LifecycleEntrypoint[] }>

type ClaimReleaseStep = LifecycleStepBase & Readonly<{ kind: 'claim'; action: 'release' }>

export type LifecyclePlan = Readonly<{
    verb: 'up' | 'sleep' | 'down' | 'reset'
    progress: LifecycleProgress
    steps: readonly LifecycleStep[]
    resumeBoundary: LifecycleResumeBoundary
    compensation: readonly Readonly<{
        step: ClaimReleaseStep
        ownership: Readonly<{ stackId: StackId; holderId: HolderId; recordRevision: number; change: 'acquired' }>
    }>[]
    diagnostics: readonly EnvironmentDiagnostic[]
}>

function exactKeys(value: object, names: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const expected = [...names].sort()
    return actual.length === expected.length && actual.every((name, index) => name === expected[index])
}

function stringTuple(value: unknown): value is readonly [string, ...string[]] {
    return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && !item.includes('\0'))
}

function stringRecord(value: unknown): value is Readonly<Record<string, string>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.entries(value).every(([name, item]) => name.length > 0 && !name.includes('\0') && !name.includes('=')
            && typeof item === 'string' && !item.includes('\0'))
}

function canonicalPaths(value: unknown): value is readonly string[] {
    return Array.isArray(value) && new Set(value).size === value.length
        && value.every((path) => typeof path === 'string' && isAbsolute(path) && normalize(path) === path && !path.includes('\0'))
}

function filesystemChecks(value: unknown): value is readonly FilesystemCheck[] {
    return Array.isArray(value) && value.every((candidate: unknown) => {
        if (candidate === null || typeof candidate !== 'object') return false
        const check = candidate as Partial<FilesystemCheck>
        const identity = check.identity
        const identityIsValid = identity === undefined || identity !== null && typeof identity === 'object'
            && exactKeys(identity, ['dev', 'ino', 'ancestors'])
            && Number.isSafeInteger(identity.dev) && identity.dev >= 0
            && Number.isSafeInteger(identity.ino) && identity.ino >= 0
            && Array.isArray(identity.ancestors) && identity.ancestors.length >= 1 && identity.ancestors.length <= 64
            && new Set(identity.ancestors.map((ancestor) => ancestor?.path)).size === identity.ancestors.length
            && identity.ancestors.every((ancestor, index) => ancestor !== null && typeof ancestor === 'object'
                && exactKeys(ancestor, ['path', 'dev', 'ino']) && canonicalPaths([ancestor.path])
                && Number.isSafeInteger(ancestor.dev) && ancestor.dev >= 0
                && Number.isSafeInteger(ancestor.ino) && ancestor.ino >= 0
                && (index === 0 || dirname(ancestor.path) === identity.ancestors[index - 1]!.path))
            && typeof check.path === 'string' && dirname(check.path) === identity.ancestors.at(-1)!.path
        const keys = ['path', 'expected', ...(check.sha256 === undefined ? [] : ['sha256', 'maxBytes']), ...(identity === undefined ? [] : ['identity'])]
        return exactKeys(candidate, keys)
            && canonicalPaths([check.path]) && (check.expected === 'absent' || check.expected === 'directory' || check.expected === 'file')
            && (check.sha256 === undefined
                ? check.maxBytes === undefined
                : check.expected === 'file' && typeof check.sha256 === 'string' && /^[a-f0-9]{64}$/.test(check.sha256)
                    && Number.isSafeInteger(check.maxBytes) && (check.maxBytes as number) >= 1 && (check.maxBytes as number) <= 536_870_912)
            && identityIsValid && (identity === undefined || check.expected !== 'absent')
    })
}

function consumedFiles(value: unknown, argv: readonly string[]): value is readonly ConsumedFile[] {
    if (!Array.isArray(value)) return false
    const paths = new Set<string>(); const indexes = new Set<number>(); let executableCount = 0
    for (const candidate of value) {
        if (candidate === null || typeof candidate !== 'object') return false
        const file = candidate as Partial<ConsumedFileBase & { executable: boolean; executionMode: 'staged' | 'verified-path' }>
        if (!exactKeys(candidate, file.executable
            ? ['path', 'sha256', 'maxBytes', 'argvIndexes', 'executable', 'executionMode']
            : ['path', 'sha256', 'maxBytes', 'argvIndexes', 'executable']) || !canonicalPaths([file.path])
            || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !Array.isArray(file.argvIndexes)
            || !Number.isSafeInteger(file.maxBytes) || (file.maxBytes as number) < 1 || (file.maxBytes as number) > 536_870_912
            || file.argvIndexes.length === 0 || typeof file.executable !== 'boolean' || paths.has(file.path as string)
            || (file.executable && file.executionMode !== 'staged' && file.executionMode !== 'verified-path')) return false
        paths.add(file.path as string)
        if (file.executable) executableCount += 1
        for (const index of file.argvIndexes) {
            if (!Number.isSafeInteger(index) || index < 0 || index >= argv.length || indexes.has(index)
                || argv[index] !== file.path || (index === 0) !== file.executable) return false
            indexes.add(index)
        }
    }
    return value.length === 0 || executableCount === 1
}

function expectedObservations(value: unknown): boolean {
    return Array.isArray(value) && value.every((candidate) => {
        if (candidate === null || typeof candidate !== 'object') return false
        const expected = candidate as Record<string, unknown>
        if (expected.kind === 'path') return exactKeys(candidate, ['kind', 'target', 'state']) && canonicalPaths([expected.target])
            && ['absent', 'directory', 'repository'].includes(expected.state as string)
        return expected.kind === 'remote' && exactKeys(candidate, ['kind', 'target', 'name', 'url']) && canonicalPaths([expected.target])
            && typeof expected.name === 'string' && expected.name.length > 0 && !expected.name.includes('\0')
            && typeof expected.url === 'string' && expected.url.length > 0 && !expected.url.includes('\0')
    })
}

interface ExecutionTraversal { count: number; readonly ids: Set<string> }

function executionStepSnapshot(snapshot: JsonSnapshot | undefined, traversal: ExecutionTraversal): ExecutionStep | undefined {
    if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
    const item = snapshot as unknown as ExecutionStep
    if (!(exactKeys(snapshot, ['id', 'argv', 'argv0', 'cwd', 'env', 'timeoutMs', 'stdoutLimitBytes', 'stderrLimitBytes', 'paths', 'ports', 'labels', 'expected', 'consumedFiles', 'filesystemChecks', 'compensation'])
        || exactKeys(snapshot, ['id', 'argv', 'argv0', 'cwd', 'env', 'timeoutMs', 'spawnNotAfter', 'stdoutLimitBytes', 'stderrLimitBytes', 'paths', 'ports', 'labels', 'expected', 'consumedFiles', 'filesystemChecks', 'compensation']))
        || typeof item.id !== 'string' || item.id.length === 0 || item.id.includes('\0') || traversal.count >= 256
        || traversal.ids.has(item.id) || !stringTuple(item.argv) || typeof item.argv0 !== 'string' || item.argv0.length === 0 || item.argv0.includes('\0')
        || item.argv[0].length === 0 || !canonicalPaths([item.cwd]) || !stringRecord(item.env)
        || !Number.isSafeInteger(item.timeoutMs) || item.timeoutMs <= 0 || item.timeoutMs > 300_000
        || item.spawnNotAfter !== undefined && (!isCanonicalTimestamp(item.spawnNotAfter) || !Number.isFinite(Date.parse(item.spawnNotAfter)))
        || !Number.isSafeInteger(item.stdoutLimitBytes) || item.stdoutLimitBytes < 0 || item.stdoutLimitBytes > 16_777_216
        || !Number.isSafeInteger(item.stderrLimitBytes) || item.stderrLimitBytes < 0 || item.stderrLimitBytes > 16_777_216 || !canonicalPaths(item.paths)
        || !Array.isArray(item.ports) || new Set(item.ports).size !== item.ports.length || item.ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)
        || !stringRecord(item.labels) || !expectedObservations(item.expected) || !consumedFiles(item.consumedFiles, item.argv)
        || !filesystemChecks(item.filesystemChecks) || item.filesystemChecks.some((check) => item.consumedFiles.some((file) => file.path === check.path))
        || !Array.isArray(item.compensation) || item.argv.length > 1_024 || Object.keys(item.env).length > 1_024 || Object.keys(item.labels).length > 1_024
        || item.paths.length > 1_024 || item.ports.length > 1_024 || item.expected.length > 1_024
        || item.consumedFiles.length > 1_024 || item.filesystemChecks.length > 1_024 || item.compensation.length > 1_024
    ) return undefined
    traversal.count += 1
    traversal.ids.add(item.id)
    if (item.compensation.some((step) => executionStepSnapshot(step as unknown as JsonSnapshot, traversal) === undefined)) return undefined
    return item
}

export function snapshotExecutionStep(value: unknown): ExecutionStep | undefined {
    return executionStepSnapshot(snapshotJson(value), { count: 0, ids: new Set<string>() })
}

export function snapshotExecutionPlan(value: unknown): ExecutionPlan | undefined {
    const snapshot = snapshotJson(value)
    if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot) || !exactKeys(snapshot, ['steps'])) return undefined
    const plan = snapshot as unknown as ExecutionPlan
    const traversal = { count: 0, ids: new Set<string>() }
    return Array.isArray(plan.steps) && plan.steps.length <= 256
        && plan.steps.every((step) => executionStepSnapshot(step as unknown as JsonSnapshot, traversal) !== undefined) ? plan : undefined
}

export function snapshotLifecyclePlan(value: unknown): LifecyclePlan | undefined {
    const snapshot = snapshotJsonWithEntryLimit(value, 16_384)
    if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || !exactKeys(snapshot, ['verb', 'progress', 'steps', 'resumeBoundary', 'compensation', 'diagnostics'])) return undefined
    const plan = snapshot as unknown as LifecyclePlan
    if (!['up', 'sleep', 'down', 'reset'].includes(plan.verb)) return undefined
    const progress = plan.progress
    if (progress === null || typeof progress !== 'object' || Array.isArray(progress)
        || !exactKeys(progress, ['workBasisSha256', 'operationGeneration', 'completedServices'])
        || typeof progress.workBasisSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(progress.workBasisSha256)
        || typeof progress.operationGeneration !== 'string' || !/^[a-f0-9]{64}$/.test(progress.operationGeneration)
        || !Array.isArray(progress.completedServices) || progress.completedServices.length > 4_096) return undefined
    const completedServices = new Set<string>()
    for (const completed of progress.completedServices) {
        if (completed === null || typeof completed !== 'object' || Array.isArray(completed)
            || !exactKeys(completed, ['service', 'containerId'])
            || typeof completed.service !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/.test(completed.service)
            || typeof completed.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(completed.containerId)
            || completedServices.has(completed.service)) return undefined
        completedServices.add(completed.service)
    }
    const stepIds = new Set<string>()
    const plannedServices = new Set<string>()
    const entrypointNames = new Set<string>()
    const captureStep = (candidate: unknown): candidate is LifecycleStep => {
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false
        const step = candidate as Record<string, unknown>
        if (typeof step.id !== 'string' || step.id.length === 0 || Buffer.byteLength(step.id) > 512 || step.id.includes('\0')
            || typeof step.kind !== 'string' || stepIds.has(step.id)) return false
        let valid = false
        if (step.kind === 'preflight') {
            valid = exactKeys(candidate, ['id', 'kind'])
        } else if (step.kind === 'claim') {
            valid = exactKeys(candidate, ['id', 'kind', 'action']) && (step.action === 'acquire' || step.action === 'release')
        } else if (step.kind === 'prepare') {
            valid = exactKeys(candidate, ['id', 'kind', 'execution']) && snapshotExecutionStep(step.execution) !== undefined
        } else if (step.kind === 'service') {
            const service = step.service
            if (typeof service !== 'string') return false
            valid = exactKeys(candidate, ['id', 'kind', 'service'])
                && /^[a-z0-9][a-z0-9_.-]*$/.test(service)
                && plannedServices.size < 4_096 && !plannedServices.has(service)
            if (valid) plannedServices.add(service)
        } else if (step.kind === 'publish-entrypoints') {
            if (!exactKeys(candidate, ['id', 'kind', 'values']) || !Array.isArray(step.values) || step.values.length > 4_096) return false
            valid = step.values.every((entrypoint) => {
                if (entrypoint === null || typeof entrypoint !== 'object' || Array.isArray(entrypoint)
                    || !exactKeys(entrypoint, ['name', 'kind', 'port', 'value'])) return false
                const value = entrypoint as unknown as LifecycleEntrypoint
                if (typeof value.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value.name)
                    || entrypointNames.has(value.name) || !isEntrypointKind(value.kind)
                    || typeof value.port !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(value.port)
                    || !boundedContractText(value.value, 4_096)) return false
                entrypointNames.add(value.name)
                return true
            })
        }
        if (!valid) return false
        stepIds.add(step.id)
        return true
    }
    const captureSteps = (steps: unknown): steps is readonly LifecycleStep[] => {
        if (!Array.isArray(steps) || steps.length > 16_384) return false
        return steps.every(captureStep)
    }
    if (!captureSteps(plan.steps) || !Array.isArray(plan.compensation) || plan.compensation.length > 256
        || !plan.compensation.every((candidate) => {
            if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)
                || !exactKeys(candidate, ['step', 'ownership'])) return false
            const item = candidate as LifecyclePlan['compensation'][number]
            const ownership = item.ownership
            return captureStep(item.step) && item.step.kind === 'claim' && item.step.action === 'release'
                && ownership !== null && typeof ownership === 'object'
                && !Array.isArray(ownership) && exactKeys(ownership, ['stackId', 'holderId', 'recordRevision', 'change'])
                && typeof ownership.stackId === 'string' && /^stack:[a-f0-9]{64}$/.test(ownership.stackId)
                && typeof ownership.holderId === 'string' && /^holder:[a-f0-9]{64}:(?:compat|session)$/.test(ownership.holderId)
                && Number.isSafeInteger(ownership.recordRevision) && ownership.recordRevision >= 0 && ownership.change === 'acquired'
        })) return undefined
    const boundary = plan.resumeBoundary
    if (boundary === null || typeof boundary !== 'object' || Array.isArray(boundary)
        || !exactKeys(boundary, ['completedStepIds', 'nextStepId']) || !Array.isArray(boundary.completedStepIds)
        || boundary.completedStepIds.length > 16_384 || new Set(boundary.completedStepIds).size !== boundary.completedStepIds.length
        || boundary.completedStepIds.some((id) => typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id) > 512 || !stepIds.has(id))
        || boundary.nextStepId !== null && (typeof boundary.nextStepId !== 'string' || boundary.nextStepId.length === 0 || Buffer.byteLength(boundary.nextStepId) > 512 || !stepIds.has(boundary.nextStepId))
        || boundary.completedStepIds.some((id, index) => plan.steps[index]?.id !== id)
        || boundary.nextStepId !== (plan.steps[boundary.completedStepIds.length]?.id ?? null)
        || !Array.isArray(plan.diagnostics) || plan.diagnostics.length > 256
        || !plan.diagnostics.every((candidate) => {
            if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false
            const item = candidate as EnvironmentDiagnostic
            const keys = ['severity', 'code', 'message', ...(item.target === undefined ? [] : ['target']), ...(item.fix === undefined ? [] : ['fix'])]
            return exactKeys(candidate, keys) && ['error', 'warning', 'info'].includes(item.severity)
                && Object.values(ENVIRONMENT_CODES).includes(item.code) && boundedContractText(item.message, 4_096)
                && (item.target === undefined || boundedContractText(item.target, 4_096))
                && (item.fix === undefined || boundedContractText(item.fix, 4_096))
        })) return undefined
    const completedPlanServices = plan.steps.slice(0, boundary.completedStepIds.length)
        .filter((step): step is Extract<LifecycleStep, { kind: 'service' }> => step.kind === 'service')
    if (progress.completedServices.length !== completedPlanServices.length
        || progress.completedServices.some((completed, index) => completed.service !== completedPlanServices[index]?.service)) return undefined
    return plan
}

export interface ExecutionReceipt {
    readonly stepId: string
    readonly startedAt: string
    readonly finishedAt: string
    readonly receiptMatches: (step: ExecutionStep) => boolean
}

export type Observation<T> =
    | { state: 'available'; value: T; observedAt: string; producer: string }
    | { state: 'unavailable'; reason: string; producer: string }
    | { state: 'failed'; code: RefusalCode; reason: string; producer: string }

export type ObservationExpectation =
    | { readonly kind: 'equal'; readonly value: JsonSnapshot }
    | { readonly kind: 'one-of'; readonly values: readonly JsonSnapshot[] }
    | { readonly kind: 'minimum'; readonly value: number }
    | { readonly kind: 'maximum'; readonly value: number }
    | { readonly kind: 'present' }

export type ObservationApplicability =
    | { readonly state: 'required'; readonly posture: string }
    | { readonly state: 'not-applicable'; readonly posture: string; readonly reason: string }

export type ObservationFreshness =
    | { readonly state: 'current' }
    | { readonly state: 'stale' | 'missing'; readonly reason: string }

export type EnvironmentObservedValue =
    | { readonly state: 'available'; readonly value: JsonSnapshot; readonly observedAt: string }
    | { readonly state: 'unavailable' | 'failed'; readonly reason: string; readonly observedAt: string }

export interface EnvironmentObservation {
    readonly code: EnvironmentCode
    readonly owner: string
    readonly stackId: StackId
    readonly source: string
    readonly observed: EnvironmentObservedValue
    readonly expectation: ObservationExpectation
    readonly applicability: ObservationApplicability
    readonly freshness: ObservationFreshness
    readonly remedy: string
}

export interface ObservationDeclaration {
    readonly id: string
    readonly owner: string
    readonly postures: readonly string[]
    readonly stages: readonly ObservationStageDeclaration[]
    readonly code: EnvironmentCode
    readonly isIssued: (value: unknown) => value is EnvironmentObservation
    readonly issuedAt?: (value: unknown) => number | undefined
}

export type ObservationStageDeclaration =
    | { readonly stage: ObservationLifecycleStage; readonly disposition: 'required' }
    | { readonly stage: ObservationLifecycleStage; readonly disposition: 'not-applicable'; readonly reason: string }

function boundedContractText(value: unknown, maximum = OBSERVATION_REASON_BYTE_LIMIT): value is string {
    return typeof value === 'string' && value.length > 0 && !value.includes('\0')
        && Buffer.byteLength(value, 'utf8') <= maximum
}

function validExpectation(value: unknown): value is ObservationExpectation {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const candidate = value as Partial<ObservationExpectation>
    if (candidate.kind === 'present') return exactKeys(value, ['kind'])
    if (candidate.kind === 'one-of') {
        return exactKeys(value, ['kind', 'values']) && Array.isArray(candidate.values)
            && candidate.values.length > 0 && candidate.values.length <= 4_096
            && candidate.values.every((item) => snapshotJson(item) !== undefined)
    }
    if (candidate.kind === 'minimum' || candidate.kind === 'maximum') {
        return exactKeys(value, ['kind', 'value']) && Number.isSafeInteger(candidate.value)
    }
    return candidate.kind === 'equal' && exactKeys(value, ['kind', 'value'])
        && snapshotJson(candidate.value) !== undefined
}

export function snapshotEnvironmentObservation(value: unknown): EnvironmentObservation | undefined {
    const snapshot = snapshotJson(value)
    if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || !exactKeys(snapshot, ['code', 'owner', 'stackId', 'source', 'observed', 'expectation', 'applicability', 'freshness', 'remedy'])) return undefined
    const candidate = snapshot as unknown as EnvironmentObservation
    if (!Object.values(ENVIRONMENT_CODES).includes(candidate.code) || !boundedContractText(candidate.owner, OBSERVATION_PRODUCER_BYTE_LIMIT)
        || !/^stack:[a-f0-9]{64}$/.test(candidate.stackId) || !boundedContractText(candidate.source)
        || !boundedContractText(candidate.remedy) || !validExpectation(candidate.expectation)) return undefined
    const observed = candidate.observed
    if (observed === null || typeof observed !== 'object' || Array.isArray(observed)
        || !isCanonicalTimestamp(observed.observedAt)) return undefined
    if (observed.state === 'available') {
        if (!exactKeys(observed, ['state', 'value', 'observedAt']) || snapshotJson(observed.value) === undefined) return undefined
    } else if ((observed.state === 'unavailable' || observed.state === 'failed')) {
        if (!exactKeys(observed, ['state', 'reason', 'observedAt']) || !boundedContractText(observed.reason)) return undefined
    } else return undefined
    const applicability = candidate.applicability
    if (applicability === null || typeof applicability !== 'object' || Array.isArray(applicability)
        || !boundedContractText(applicability.posture, OBSERVATION_PRODUCER_BYTE_LIMIT)) return undefined
    if (applicability.state === 'required') {
        if (!exactKeys(applicability, ['state', 'posture'])) return undefined
    } else if (applicability.state === 'not-applicable') {
        if (!exactKeys(applicability, ['state', 'posture', 'reason']) || !boundedContractText(applicability.reason)) return undefined
    } else return undefined
    const freshness = candidate.freshness
    if (freshness === null || typeof freshness !== 'object' || Array.isArray(freshness)) return undefined
    if (freshness.state === 'current') {
        if (!exactKeys(freshness, ['state'])) return undefined
    } else if (freshness.state === 'stale' || freshness.state === 'missing') {
        if (!exactKeys(freshness, ['state', 'reason']) || !boundedContractText(freshness.reason)) return undefined
    } else return undefined
    return snapshot as unknown as EnvironmentObservation
}

export type EnvironmentCommandOutcome<Result> =
    | {
          kind: 'complete'
          status: 0
          diagnostics: readonly EnvironmentDiagnostic[]
          result: Result
          plan?: never
      }
    | {
          kind: 'preview'
          status: 0
          diagnostics: readonly EnvironmentDiagnostic[]
          result: Result
          plan: ExecutionPlan
      }
    | {
          kind: 'refusal'
          status: 2
          diagnostics: readonly EnvironmentDiagnostic[]
          result: null
          plan?: never
      }

export interface EnvironmentAdapter {
    observePath(path: string): Promise<Observation<'absent' | 'directory' | 'repository' | 'symlink'>>
}

/**
 * The command `compose exec` runs for an in-stack operation. Its cwd is relative to the service's
 * working directory, as in the rendered healthcheck; `compose exec --workdir` accepts only an
 * absolute path, so passing the declared cwd there failed every in-stack probe ("Cwd must be an
 * absolute path"). `.` runs in the working directory and any other cwd changes into it first.
 */
export function inStackCommand(cwd: string, argv: readonly string[]): readonly string[] {
    return cwd === '.' ? argv : ['/bin/sh', '-c', 'cd -- "$0" && exec "$@"', cwd, ...argv]
}
