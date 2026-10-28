import { access, link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isProxy } from 'node:util/types'
import { z } from 'zod'
import { loadCockpitConfig } from '../config/load.js'
import { SURFACE_TARGETS, type SurfaceTarget } from '../surfaces/contract.js'
import { checkoutId as deriveCheckoutId, type BootstrapLockOwnerId } from './identity.js'
import { redactSensitiveText } from './sensitive.js'
import {
    ENVIRONMENT_CODES,
    snapshotEnvironmentObservation,
    snapshotJson,
    isCanonicalTimestamp,
    type CheckoutId,
    type CockpitId,
    type HolderId,
    type EnvironmentObservation,
    type JsonSnapshot,
    type StackId,
} from './contract.js'

export const mechanism = {
    id: 'environment-state',
    module: 'packages/cockpit/src/environment/state.ts',
    exports: ['SERIALIZED_RECORD_BYTE_LIMIT', 'selectStateRoot', 'selectBootstrapStateRoot', 'snapshotStateNamespace', 'snapshotBootstrapStateNamespace', 'authenticateStateNamespace', 'authenticateBootstrapStateNamespace', 'issueStateScopedLock', 'withStateScopedLock', 'lifecycleHistoryAddress', 'readState', 'inspectStateLock', 'abortStateTransaction', 'transactState', 'authenticateStatePublication', 'observeConfiguration', 'isStateObservation', 'observationDeclarations'],
} as const

export const observationDeclarations = Object.freeze([
    { id: 'config-freshness', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.CONFIG_STALE, isIssued: isStateObservation, issuedAt: observationIssuedAt },
    { id: 'config-schema-validity', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID, isIssued: isStateObservation, issuedAt: observationIssuedAt },
] as const)

const issuedObservations = new WeakMap<object, number>()
const issuedNamespaces = new WeakSet<object>()
const issuedBootstrapNamespaces = new WeakSet<object>()
const issuedScopedLocks = new WeakMap<object, Readonly<{ namespace: StateNamespace; path: string }>>()

function issueObservation(value: EnvironmentObservation): EnvironmentObservation {
    const snapshot = snapshotEnvironmentObservation(value)
    if (!snapshot || snapshot.owner !== mechanism.id) throw new TypeError('state observation is malformed')
    issuedObservations.set(snapshot, Date.now())
    return snapshot
}

export function isStateObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedObservations.has(value)
}

function observationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedObservations.get(value) : undefined
}

export async function observeConfiguration(input: { readonly path: string; readonly stackId: StackId; readonly observedAt: string }): Promise<readonly EnvironmentObservation[]> {
    const snapshot = snapshotJson(input)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('configuration observation input is malformed')
    const owned = snapshot as Readonly<Record<string, JsonSnapshot>>
    if (typeof owned.path !== 'string' || owned.path.length === 0 || typeof owned.stackId !== 'string'
        || !/^stack:[a-f0-9]{64}$/.test(owned.stackId) || typeof owned.observedAt !== 'string'
        || !isCanonicalTimestamp(owned.observedAt)) throw new TypeError('configuration observation input is malformed')
    const loaded = await loadCockpitConfig(owned.path)
    const failure = loaded.kind === 'refusal' ? loaded.diagnostics[0] : undefined
    const source = loaded.kind === 'complete' ? loaded.result.source.path : failure?.target ?? owned.path
    return Object.freeze([
        issueObservation({
            code: ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID, owner: mechanism.id, stackId: owned.stackId as StackId, source,
            observed: failure
                ? { state: 'failed', reason: failure.message, observedAt: owned.observedAt }
                : { state: 'available', value: true, observedAt: owned.observedAt },
            expectation: { kind: 'equal', value: true }, applicability: { state: 'required', posture: 'environment' }, freshness: { state: 'current' },
            remedy: 'repair the configuration before evaluating the environment',
        }),
        issueObservation({
            code: ENVIRONMENT_CODES.CONFIG_STALE, owner: mechanism.id, stackId: owned.stackId as StackId, source,
            observed: loaded.kind === 'complete'
                ? { state: 'available', value: loaded.result.source.sha256, observedAt: owned.observedAt }
                : { state: 'unavailable', reason: 'configuration revision is unavailable', observedAt: owned.observedAt },
            expectation: loaded.kind === 'complete' ? { kind: 'equal', value: loaded.result.source.sha256 } : { kind: 'present' },
            applicability: { state: 'required', posture: 'environment' }, freshness: { state: 'current' }, remedy: 'regenerate from the current configuration revision',
        }),
    ])
}

const STATE_FORMAT = 'cockpit-state/v1'
export const SERIALIZED_RECORD_BYTE_LIMIT = 1_048_576
const RECORD_KINDS = ['claim', 'lease', 'coordination', 'lifecycle', 'lifecycle-history', 'data-outcome', 'cache', 'baseline'] as const
const safeSegment = /^[a-z0-9][a-z0-9._-]*$/
const digest = /^[a-f0-9]{64}$/
const cockpitIdentity = /^cockpit:[a-z0-9][a-z0-9-]*:[a-f0-9]{64}$/
const checkoutIdentity = /^checkout:[a-f0-9]{64}$/
const stackIdentity = /^stack:[a-f0-9]{64}$/
const holderIdentity = /^holder:[a-f0-9]{64}:(?:compat|session)$/
const bootstrapHolderIdentity = /^bootstrap-holder:[a-f0-9]{64}:session$/
const lockOwnerIdentity = /^(?:holder:[a-f0-9]{64}:(?:compat|session)|bootstrap-holder:[a-f0-9]{64}:session)$/
const surfaceTargets = new Set<string>(SURFACE_TARGETS)
const bootstrapStages = ['surface-previewed', 'surface-published', 'draft-prepared', 'draft-observed', 'environment-verified'] as const
const BootstrapPathSchema = z.string().min(1).max(4_096)
    .regex(/^(?!\/)(?!.*\\)(?!.*[\x00-\x1f\x7f])[^/]+(?:\/[^/]+)*$/)
    .refine(path => path.split('/').every(segment => segment !== '.' && segment !== '..'))

const StateRecordSchema = z.object({
    format: z.literal(STATE_FORMAT),
    kind: z.enum(RECORD_KINDS),
    cockpitId: z.string().min(1),
    subjectId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().refine(isCanonicalTimestamp),
    value: z.json(),
}).strict()

const StateLockSchema = z.object({
    format: z.literal(STATE_FORMAT),
    kind: z.literal('state-lock'),
    ownerId: z.string().regex(lockOwnerIdentity),
    pid: z.number().int().positive(),
    acquiredAt: z.string().refine(isCanonicalTimestamp),
    token: z.string().uuid(),
}).strict()

export type StateRecord = z.infer<typeof StateRecordSchema>
export type StateRecordKind = typeof RECORD_KINDS[number]

const BootstrapDigestRowSchema = z.object({
    path: BootstrapPathSchema,
    sha256: z.string().regex(digest),
}).strict()

const GreenfieldQuestionSchema = z.object({
    id: z.string().regex(/^question:[a-f0-9]{64}$/),
    field: z.string().min(1).max(256),
    source: z.string().min(1).max(4_096),
    why: z.string().min(1).max(512),
    expectedSha256: z.string().regex(digest).optional(),
}).strict()
const GreenfieldAnswerSchema = z.object({
    questionId: z.string().regex(/^question:[a-f0-9]{64}$/),
    bytes: z.string().min(1).max(262_144)
        .refine(value => Buffer.byteLength(value, 'utf8') <= 262_144)
        .refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value) && redactSensitiveText(value) === value),
    sha256: z.string().regex(digest),
    provenance: z.literal('operator-confirmed'),
}).strict()
const GreenfieldStateSchema = z.object({
    mode: z.enum(['estate', 'registry']).optional(),
    stage: z.enum(['question-pending', 'answers-recorded', 'resolved']),
    classification: z.enum(['one-sibling', 'incomplete-multi-repository', 'no-runnable-product', 'ready-multi-repository']).optional(),
    sourceObservationSha256: z.string().regex(digest),
    notice: z.string().min(1).max(1_024).optional(),
    applicability: z.object({
        stack: z.literal(true), seed: z.literal(true), postures: z.literal(true),
        registry: z.boolean(), projection: z.boolean(), drift: z.boolean(),
        compose: z.enum(['applicable', 'inapplicable', 'unknown']),
    }).strict().optional(),
    questions: z.array(GreenfieldQuestionSchema).max(64),
    answers: z.array(GreenfieldAnswerSchema).max(64),
}).strict().superRefine((value, context) => {
    if (new Set(value.questions.map(row => row.id)).size !== value.questions.length
        || new Set(value.answers.map(row => row.questionId)).size !== value.answers.length
        || value.answers.some((answer, index) => answer.questionId !== value.questions[index]?.id
            || createHash('sha256').update(answer.bytes).digest('hex') !== answer.sha256)) {
        context.addIssue({ code: 'custom', message: 'greenfield answer provenance is malformed' })
    }
    const complete = value.answers.length === value.questions.length
    if ((value.stage === 'question-pending' && complete)
        || (value.stage === 'answers-recorded' && (!complete || value.questions.length === 0))
        || (value.stage === 'resolved' && (value.questions.length !== 0 || value.answers.length !== 0))) {
        context.addIssue({ code: 'custom', message: 'greenfield answers do not match the interview stage' })
    }
    if ((value.mode ?? 'estate') === 'estate' && (!value.classification || !value.notice || !value.applicability)) {
        context.addIssue({ code: 'custom', message: 'estate interview provenance is incomplete' })
    }
    if (value.mode === 'registry' && (value.classification || value.notice || value.applicability)) {
        context.addIssue({ code: 'custom', message: 'registry interview cannot claim estate classification provenance' })
    }
    if (value.stage === 'resolved' && value.classification === 'incomplete-multi-repository') {
        context.addIssue({ code: 'custom', message: 'an incomplete estate cannot be resolved without recorded answers' })
    }
})

const BootstrapStateRecordSchema = z.object({
    format: z.literal(STATE_FORMAT),
    kind: z.literal('bootstrap'),
    checkoutId: z.string().regex(checkoutIdentity),
    target: z.enum(SURFACE_TARGETS),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().refine(isCanonicalTimestamp),
    value: z.object({
        stage: z.enum(bootstrapStages),
        checkoutRoot: z.string().min(1).max(4_096),
        target: z.enum(SURFACE_TARGETS),
        // Entry point plus shared procedure for every shipped skill; a new shipped skill must not need a state bump.
        sources: z.array(BootstrapDigestRowSchema).min(1).max(16),
        commandSha256: z.string().regex(digest),
        previewSha256: z.string().regex(digest),
        published: z.array(BootstrapDigestRowSchema).max(3),
        destination: BootstrapPathSchema.nullable(),
        artifactBytes: z.string().max(262_144).nullable(),
        artifactSha256: z.string().regex(digest).nullable(),
        nextCommand: z.string().min(1).max(1_024),
        greenfield: GreenfieldStateSchema.optional(),
    }).strict(),
}).strict().superRefine((record, context) => {
    const value = record.value
    if (value.target !== record.target || !isAbsolute(value.checkoutRoot) || resolve(value.checkoutRoot) !== value.checkoutRoot) {
        context.addIssue({ code: 'custom', message: 'bootstrap record identity is malformed' })
    }
    if (new Set(value.sources.map(row => row.path)).size !== value.sources.length
        || new Set(value.published.map(row => row.path)).size !== value.published.length) {
        context.addIssue({ code: 'custom', message: 'bootstrap record paths are duplicated' })
    }
    if ((value.stage === 'surface-previewed') !== (value.published.length === 0)) {
        context.addIssue({ code: 'custom', message: 'bootstrap publication rows do not match the stage' })
    }
    const draftRequired = ['draft-prepared', 'draft-observed', 'environment-verified'].includes(value.stage)
    const draftFields = [value.destination, value.artifactBytes, value.artifactSha256]
    if (draftRequired !== draftFields.every(field => field !== null)
        || !draftRequired && draftFields.some(field => field !== null)) {
        context.addIssue({ code: 'custom', message: 'bootstrap draft fields do not match the stage' })
    }
    if (value.artifactBytes !== null && value.artifactSha256 !== null
        && createHash('sha256').update(value.artifactBytes).digest('hex') !== value.artifactSha256) {
        context.addIssue({ code: 'custom', message: 'bootstrap draft digest does not match its bytes' })
    }
})

export type BootstrapStateRecord = z.infer<typeof BootstrapStateRecordSchema>
type AnyStateRecord = StateRecord | BootstrapStateRecord

export interface StateAddress {
    readonly path: string
    readonly stateRoot: string
    readonly cockpitRoot: string
    readonly kind: StateRecordKind
    readonly cockpitId: CockpitId
    readonly subjectId: string
    readonly qualifier?: string
}

export interface StateNamespace {
    readonly root: string
    readonly cockpitRoot: string
    readonly paths: {
        readonly claim: (stackId: StackId) => StateAddress
        readonly lease: (stackId: StackId) => StateAddress
        readonly coordination: (stackId: StackId) => StateAddress
        readonly lifecycle: (stackId: StackId) => StateAddress
        readonly dataOutcome: (stackId: StackId) => StateAddress
        readonly stateLock: string
        readonly installLock: (cacheId: string) => string
        readonly cache: (checkoutId: CheckoutId, lockfileSha256: string) => StateAddress
        readonly baseline: (stackId: StackId) => StateAddress
    }
}

export interface BootstrapStateAddress {
    readonly path: string
    readonly stateRoot: string
    readonly checkoutRoot: string
    readonly kind: 'bootstrap'
    readonly checkoutId: CheckoutId
    readonly target: SurfaceTarget
}

export interface BootstrapStateNamespace {
    readonly root: string
    readonly checkoutRoot: string
    readonly checkoutId: CheckoutId
    readonly target: SurfaceTarget
    readonly paths: {
        readonly bootstrap: (target: SurfaceTarget) => BootstrapStateAddress
        readonly stateLock: string
    }
}

export type StateResult<T> =
    | { readonly kind: 'complete'; readonly value: T }
    | { readonly kind: 'missing'; readonly path: string }
    | {
          readonly kind: 'indeterminate'
          readonly code: typeof ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE
          readonly message: string
          readonly target: string
          readonly recovery: string
          readonly value: T
      }
    | {
          readonly kind: 'refusal'
          readonly code: typeof ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE
              | typeof ENVIRONMENT_CODES.STATE_FORMAT_UNSUPPORTED
              | typeof ENVIRONMENT_CODES.STATE_RECORD_MALFORMED
              | typeof ENVIRONMENT_CODES.STATE_LOCKED
          readonly message: string
          readonly target: string
          readonly recovery?: string
      }

export interface SelectStateRootInput {
    readonly platform: 'darwin' | 'linux'
    readonly home: string | undefined
    readonly xdgStateHome?: string
    readonly checkoutRoot?: string
    readonly checkoutRoots?: readonly string[]
    readonly cockpitId: CockpitId
    readonly uid?: number
}

export interface SelectBootstrapStateRootInput {
    readonly platform: 'darwin' | 'linux'
    readonly home: string | undefined
    readonly xdgStateHome?: string
    readonly checkoutRoot: string
    readonly target: SurfaceTarget
    readonly uid?: number
}

type LockHolderState = 'live' | 'dead' | 'unknown'

export interface StateLockInspection {
    readonly holderState: LockHolderState | 'invalid'
    readonly description: string
    readonly recovery: string
}

export interface StateTransactionOptions {
    readonly ownerId: HolderId | BootstrapLockOwnerId
    readonly observeHolder?: (holder: {
        readonly ownerId: HolderId | BootstrapLockOwnerId
        readonly pid: number
    }) => Promise<LockHolderState>
    readonly beforePublish?: (temporaryPath: string) => Promise<void>
    readonly beforeCommit?: () => StateTransactionAbort<unknown> | undefined
    readonly beforeRelease?: () => Promise<void>
    readonly beforeLockMetadata?: (operation: 'owner-unlink' | 'tombstone-rmdir' | 'owner-restore-link' | 'backup-unlink') => Promise<void>
    readonly contentionTimeoutMs?: number
}

export interface StateScopedLock {
    readonly kind: 'state-scoped-lock'
}

export interface StateTransactionAbort<T> {
    readonly aborted: true
    readonly value: T
}

export function abortStateTransaction<T>(value: T): StateTransactionAbort<T> {
    const abort = Object.freeze({ aborted: true as const, value })
    stateTransactionAborts.add(abort)
    return abort
}

const stateTransactionAborts = new WeakSet<object>()

type StatePublicationStatus = 'complete' | 'indeterminate'
interface StatePublicationMetadata {
    readonly status: StatePublicationStatus
    readonly address: Readonly<StateAddress | BootstrapStateAddress>
    readonly record: AnyStateRecord
}

const issuedStatePublications = new WeakMap<object, StatePublicationMetadata>()

function issueStatePublication<T>(
    result: StateResult<AnyStateRecord> | StateTransactionAbort<T>,
    address: StateAddress | BootstrapStateAddress,
): StateResult<AnyStateRecord> | StateTransactionAbort<T> {
    if (!('kind' in result) || result.kind !== 'complete' && result.kind !== 'indeterminate') return result
    const record = snapshotJson(result.value)
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || !StateRecordSchema.safeParse(record).success && !BootstrapStateRecordSchema.safeParse(record).success) return result
    const issued = Object.freeze({ ...result }) as StateResult<AnyStateRecord>
    issuedStatePublications.set(issued, Object.freeze({
        status: result.kind,
        address: Object.freeze({ ...address }),
        record: record as AnyStateRecord,
    }))
    return issued
}

export function authenticateStatePublication(input: {
    readonly publication: StateResult<AnyStateRecord>
    readonly address: StateAddress | BootstrapStateAddress
}): Readonly<{ readonly status: StatePublicationStatus; readonly record: AnyStateRecord }> | undefined {
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return undefined
        const keys = Reflect.ownKeys(input)
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (keys.length !== 2 || !keys.includes('publication') || !keys.includes('address')
            || ['publication', 'address'].some((key) => {
                const descriptor = descriptors[key]
                return descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
            })) return undefined
        const publication = descriptors.publication!.value
        if (publication === null || typeof publication !== 'object' || isProxy(publication)) return undefined
        const issued = issuedStatePublications.get(publication)
        const address = snapshotJson(descriptors.address!.value)
        if (!issued || !address || typeof address !== 'object' || Array.isArray(address)) return undefined
        const ownedAddress = address as Readonly<Record<string, JsonSnapshot>>
        const expectedAddress = issued.address
        const addressKeys = Reflect.ownKeys(ownedAddress)
        const expectedAddressKeys = Reflect.ownKeys(expectedAddress)
        if (addressKeys.length !== expectedAddressKeys.length
            || expectedAddressKeys.some((key) => typeof key !== 'string'
                || ownedAddress[key] !== (expectedAddress as unknown as Record<string, unknown>)[key])) return undefined
        return Object.freeze({ status: issued.status, record: issued.record })
    } catch {
        return undefined
    }
}

function isStateTransactionAbort(value: unknown): value is StateTransactionAbort<unknown> {
    return typeof value === 'object' && value !== null && stateTransactionAborts.has(value)
}

function refusal<T>(
    code: Extract<StateResult<T>, { kind: 'refusal' }>['code'],
    message: string,
    target: string,
    recovery?: string,
): StateResult<T> {
    return { kind: 'refusal', code, message, target, ...(recovery ? { recovery } : {}) }
}

function confinedTo(parent: string, candidate: string): boolean {
    const relation = relative(resolve(parent), resolve(candidate))
    return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
}

// Directory write access lets another user replace otherwise private authority records.
function privatelyOwned(status: { readonly uid: number; readonly mode: number }, uid = process.getuid?.()): boolean {
    return uid !== undefined && status.uid === uid && (status.mode & 0o022) === 0
}

async function usableBase(path: string, uid: number): Promise<boolean> {
    if (!isAbsolute(path)) return false
    try {
        const status = await lstat(path)
        if (!status.isDirectory() || status.isSymbolicLink() || !privatelyOwned(status, uid) || (status.mode & 0o200) === 0) {
            return false
        }
        await access(path, constants.W_OK)
        return true
    } catch {
        return false
    }
}

async function usableSelectedBase(path: string, uid: number): Promise<boolean> {
    if (!isAbsolute(path)) return false
    let cursor = path
    while (true) {
        try {
            const status = await lstat(cursor)
            if (!status.isDirectory() || status.isSymbolicLink() || !privatelyOwned(status, uid) || (status.mode & 0o200) === 0) {
                return false
            }
            await access(cursor, constants.W_OK)
            return true
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
        }
        const parent = dirname(cursor)
        if (parent === cursor) return false
        cursor = parent
    }
}

async function safeDescendant(base: string, candidate: string, uid: number): Promise<boolean> {
    if (!(await usableSelectedBase(base, uid)) || !confinedTo(base, candidate)) return false
    const relation = relative(base, candidate)
    let cursor = base
    for (const segment of relation.split(sep).filter(Boolean)) {
        cursor = join(cursor, segment)
        try {
            const status = await lstat(cursor)
            if (
                !status.isDirectory()
                || status.isSymbolicLink()
                || !privatelyOwned(status, uid)
                || (status.mode & 0o200) === 0
            ) return false
            try {
                await access(cursor, constants.W_OK)
            } catch {
                return false
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
            return false
        }
    }
    return true
}

function checkedSegment(value: string, label: string): string {
    if (!safeSegment.test(value)) throw new TypeError(`${label} is not a safe state path segment`)
    return value
}

function checkedIdentity(value: string, pattern: RegExp, label: string): string {
    if (!pattern.test(value)) throw new TypeError(`${label} is not a canonical environment identity`)
    return value
}

function checkedDigest(value: string): string {
    if (!digest.test(value)) throw new TypeError('lockfile digest must be 64 lowercase hexadecimal characters')
    return value
}

function address(
    path: string,
    stateRoot: string,
    cockpitRoot: string,
    kind: StateRecordKind,
    cockpitId: CockpitId,
    subjectId: string,
    qualifier?: string,
): StateAddress {
    return { path, stateRoot, cockpitRoot, kind, cockpitId, subjectId, ...(qualifier ? { qualifier } : {}) }
}

function namespace(root: string, cockpitId: CockpitId): StateNamespace {
    const id = checkedIdentity(cockpitId, cockpitIdentity, 'cockpit id')
    const cockpitRoot = join(root, 'cockpits', id)
    const stackAddress = (
        kind: 'claim' | 'lease' | 'coordination' | 'lifecycle' | 'lifecycle-history' | 'data-outcome',
        stackId: StackId,
    ): StateAddress => {
        const subjectId = checkedIdentity(stackId, stackIdentity, 'stack id')
        const directory = kind === 'lifecycle' || kind === 'lifecycle-history' || kind === 'coordination' || kind === 'data-outcome'
            ? kind
            : `${kind}s`
        return address(join(cockpitRoot, 'records', directory, `${subjectId}.json`), root, cockpitRoot, kind, cockpitId, subjectId)
    }
    const paths: StateNamespace['paths'] = Object.freeze({
        claim: (stackId) => stackAddress('claim', stackId),
        lease: (stackId) => stackAddress('lease', stackId),
        coordination: (stackId) => stackAddress('coordination', stackId),
        lifecycle: (stackId) => stackAddress('lifecycle', stackId),
        dataOutcome: (stackId) => stackAddress('data-outcome', stackId),
        stateLock: join(cockpitRoot, 'locks', 'state.lock'),
        installLock: (cacheId) => join(cockpitRoot, 'locks', 'install', `${checkedSegment(cacheId, 'cache id')}.lock`),
        cache: (checkoutId, lockfileSha256) => {
            const subjectId = checkedIdentity(checkoutId, checkoutIdentity, 'checkout id')
            const checksum = checkedDigest(lockfileSha256)
            return address(
                join(cockpitRoot, 'cache', subjectId, `${checksum}.json`),
                root,
                cockpitRoot,
                'cache',
                cockpitId,
                subjectId,
                checksum,
            )
        },
        baseline: (stackId) => {
            const subjectId = checkedIdentity(stackId, stackIdentity, 'stack id')
            return address(
                join(cockpitRoot, 'evidence', 'baselines', `${subjectId}.json`),
                root,
                cockpitRoot,
                'baseline',
                cockpitId,
                subjectId,
            )
        },
    })
    const value: StateNamespace = Object.freeze({ root, cockpitRoot, paths })
    issuedNamespaces.add(value)
    return value
}

function bootstrapNamespace(root: string, checkoutRoot: string, checkoutId: CheckoutId, selectedTarget: SurfaceTarget): BootstrapStateNamespace {
    const id = checkedIdentity(checkoutId, checkoutIdentity, 'checkout id') as CheckoutId
    const scopedRoot = join(root, 'checkouts', id)
    const bootstrap = (target: SurfaceTarget): BootstrapStateAddress => {
        if (!surfaceTargets.has(target) || target !== selectedTarget) throw new TypeError('surface target does not match the selected bootstrap target')
        return Object.freeze({
            path: join(scopedRoot, 'records', 'bootstrap', `${target}.json`),
            stateRoot: root,
            checkoutRoot,
            kind: 'bootstrap' as const,
            checkoutId: id,
            target,
        })
    }
    const value: BootstrapStateNamespace = Object.freeze({
        root,
        checkoutRoot,
        checkoutId: id, target: selectedTarget,
        paths: Object.freeze({ bootstrap, stateLock: join(scopedRoot, 'locks', 'state.lock') }),
    })
    issuedBootstrapNamespaces.add(value)
    return value
}

export function authenticateStateNamespace(value: unknown): StateNamespace | undefined {
    return value !== null && typeof value === 'object' && issuedNamespaces.has(value)
        ? value as StateNamespace
        : undefined
}

export function authenticateBootstrapStateNamespace(value: unknown): BootstrapStateNamespace | undefined {
    return value !== null && typeof value === 'object' && issuedBootstrapNamespaces.has(value)
        ? value as BootstrapStateNamespace
        : undefined
}

export function issueStateScopedLock(namespace: StateNamespace, input: Readonly<{ owner: string; identity: string }>): StateScopedLock | undefined {
    const authenticated = authenticateStateNamespace(namespace)
    const captured = snapshotJson(input) as Readonly<{ owner?: unknown; identity?: unknown }> | undefined
    if (!authenticated || !captured || Object.keys(captured).sort().join(',') !== 'identity,owner'
        || typeof captured.owner !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(captured.owner)
        || typeof captured.identity !== 'string' || !digest.test(captured.identity)) return undefined
    const scope = Object.freeze({ kind: 'state-scoped-lock' as const })
    issuedScopedLocks.set(scope, Object.freeze({ namespace: authenticated,
        path: join(authenticated.cockpitRoot, 'locks', 'scoped', `${captured.owner}-${captured.identity}`, 'state.lock') }))
    return scope
}

export function lifecycleHistoryAddress(value: StateNamespace, stackId: StackId): StateAddress | undefined {
    const authenticated = authenticateStateNamespace(value)
    if (!authenticated) return undefined
    const subjectId = checkedIdentity(stackId, stackIdentity, 'stack id') as StackId
    const lifecycle = authenticated.paths.lifecycle(subjectId)
    return address(
        join(authenticated.cockpitRoot, 'records', 'lifecycle-history', `${subjectId}.json`),
        authenticated.root,
        authenticated.cockpitRoot,
        'lifecycle-history',
        lifecycle.cockpitId,
        subjectId,
    )
}

export function snapshotStateNamespace(value: StateNamespace): StateNamespace | undefined {
    try {
        const own = (object: object, key: PropertyKey): unknown => {
            const descriptor = Object.getOwnPropertyDescriptor(object, key)
            if (!descriptor || !('value' in descriptor)) throw new Error('namespace properties must be owned data')
            return descriptor.value
        }
        const root = own(value, 'root')
        const cockpitRoot = own(value, 'cockpitRoot')
        const paths = own(value, 'paths')
        if (typeof root !== 'string' || typeof cockpitRoot !== 'string' || !paths || typeof paths !== 'object') return undefined
        const claim = own(paths, 'claim')
        const lease = own(paths, 'lease')
        const coordination = own(paths, 'coordination')
        const lifecycle = own(paths, 'lifecycle')
        const dataOutcome = own(paths, 'dataOutcome')
        const stateLock = own(paths, 'stateLock')
        const installLock = own(paths, 'installLock')
        const cache = own(paths, 'cache')
        const baseline = own(paths, 'baseline')
        if (
            typeof claim !== 'function'
            || typeof lease !== 'function'
            || typeof coordination !== 'function'
            || typeof lifecycle !== 'function'
            || typeof dataOutcome !== 'function'
            || typeof stateLock !== 'string'
            || typeof installLock !== 'function'
            || typeof cache !== 'function'
            || typeof baseline !== 'function'
        ) return undefined
        return Object.freeze({
            root,
            cockpitRoot,
            paths: Object.freeze({
                claim,
                lease,
                coordination,
                lifecycle,
                dataOutcome,
                stateLock,
                installLock,
                cache,
                baseline,
            }),
        }) as StateNamespace
    } catch {
        return undefined
    }
}

export function snapshotBootstrapStateNamespace(value: BootstrapStateNamespace): BootstrapStateNamespace | undefined {
    try {
        if (!authenticateBootstrapStateNamespace(value)) return undefined
        const root = Object.getOwnPropertyDescriptor(value, 'root')?.value
        const checkoutRoot = Object.getOwnPropertyDescriptor(value, 'checkoutRoot')?.value
        const checkoutId = Object.getOwnPropertyDescriptor(value, 'checkoutId')?.value
        const target = Object.getOwnPropertyDescriptor(value, 'target')?.value
        const paths = Object.getOwnPropertyDescriptor(value, 'paths')?.value
        if (typeof root !== 'string' || typeof checkoutRoot !== 'string' || typeof checkoutId !== 'string'
            || typeof target !== 'string' || !surfaceTargets.has(target)
            || !paths || typeof paths !== 'object') return undefined
        const bootstrap = Object.getOwnPropertyDescriptor(paths, 'bootstrap')?.value
        const stateLock = Object.getOwnPropertyDescriptor(paths, 'stateLock')?.value
        if (typeof bootstrap !== 'function' || typeof stateLock !== 'string') return undefined
        return Object.freeze({ root, checkoutRoot, checkoutId, target,
            paths: Object.freeze({ bootstrap, stateLock }) }) as BootstrapStateNamespace
    } catch { return undefined }
}

export async function selectBootstrapStateRoot(input: SelectBootstrapStateRootInput): Promise<StateResult<BootstrapStateNamespace>> {
    let stableInput: SelectBootstrapStateRootInput
    try {
        stableInput = Object.freeze({ platform: input.platform, home: input.home, xdgStateHome: input.xdgStateHome,
            checkoutRoot: input.checkoutRoot, target: input.target, uid: input.uid })
    } catch {
        return refusal(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'bootstrap state root input could not be read safely', 'bootstrap state root input')
    }
    const uid = stableInput.uid ?? process.getuid?.()
    if (uid === undefined || typeof stableInput.checkoutRoot !== 'string' || !isAbsolute(stableInput.checkoutRoot)
        || resolve(stableInput.checkoutRoot) !== stableInput.checkoutRoot || stableInput.checkoutRoot.includes('\0')
        || !surfaceTargets.has(stableInput.target)) {
        return refusal(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'bootstrap state root input is malformed', 'bootstrap state root input')
    }
    let root: string
    let base: string
    if (stableInput.platform === 'darwin') {
        if (!stableInput.home || !(await usableBase(stableInput.home, uid))) {
            return refusal(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'state root requires an absolute usable home directory', stableInput.home ?? '')
        }
        base = stableInput.home
        root = join(base, 'Library', 'Application Support', 'cockpit', 'state', 'v1')
    } else if (stableInput.xdgStateHome !== undefined) {
        if (!(await usableSelectedBase(stableInput.xdgStateHome, uid))) {
            return refusal(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'present XDG state home is not safely usable', stableInput.xdgStateHome)
        }
        base = stableInput.xdgStateHome
        root = join(base, 'cockpit', 'v1')
    } else {
        if (!stableInput.home || !(await usableBase(stableInput.home, uid))) {
            return refusal(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'state root requires an absolute usable home directory', stableInput.home ?? '')
        }
        base = stableInput.home
        root = join(base, '.local', 'state', 'cockpit', 'v1')
    }
    if (!(await safeDescendant(base, root, uid)) || confinedTo(stableInput.checkoutRoot, root)) {
        return refusal(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'selected state root is not safely usable', root)
    }
    try {
        const canonicalCheckout = await lstat(stableInput.checkoutRoot)
        if (!canonicalCheckout.isDirectory() || canonicalCheckout.isSymbolicLink()
            || await realpath(stableInput.checkoutRoot) !== stableInput.checkoutRoot) throw new Error('unsafe checkout')
        const id = deriveCheckoutId({ checkoutPath: stableInput.checkoutRoot })
        return { kind: 'complete', value: bootstrapNamespace(root, stableInput.checkoutRoot, id, stableInput.target) }
    } catch {
        return refusal(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'checkout identity cannot scope the bootstrap state root safely', stableInput.checkoutRoot)
    }
}

export async function selectStateRoot(input: SelectStateRootInput): Promise<StateResult<StateNamespace>> {
    let stableInput: SelectStateRootInput
    try {
        const checkoutRoots = input.checkoutRoots
        if (checkoutRoots !== undefined && (!Array.isArray(checkoutRoots) || isProxy(checkoutRoots))) {
            throw new TypeError('checkout roots are malformed')
        }
        stableInput = Object.freeze({
            platform: input.platform,
            home: input.home,
            xdgStateHome: input.xdgStateHome,
            checkoutRoot: input.checkoutRoot,
            checkoutRoots: checkoutRoots === undefined ? undefined : Object.freeze([...checkoutRoots]),
            cockpitId: input.cockpitId,
            uid: input.uid,
        })
    } catch {
        return refusal(
            ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
            'state root input could not be read safely',
            'state root input',
        )
    }
    const uid = stableInput.uid ?? process.getuid?.()
    if (uid === undefined) {
        return refusal(
            ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
            'state root requires an absolute usable home directory',
            stableInput.home ?? '',
        )
    }
    const checkoutRoots = [
        ...(stableInput.checkoutRoot === undefined ? [] : [stableInput.checkoutRoot]),
        ...(stableInput.checkoutRoots ?? []),
    ]
    if (checkoutRoots.some((checkoutRoot) => typeof checkoutRoot !== 'string'
        || !isAbsolute(checkoutRoot) || resolve(checkoutRoot) !== checkoutRoot || checkoutRoot.includes('\0'))) {
        return refusal(
            ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
            'state root input contains a non-canonical checkout root',
            'state root input',
        )
    }

    let root: string
    let base: string
    if (stableInput.platform === 'darwin') {
        if (!stableInput.home || !(await usableBase(stableInput.home, uid))) {
            return refusal(
                ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
                'state root requires an absolute usable home directory',
                stableInput.home ?? '',
            )
        }
        base = stableInput.home
        root = join(stableInput.home, 'Library', 'Application Support', 'cockpit', 'state', 'v1')
    } else if (stableInput.xdgStateHome !== undefined) {
        if (!(await usableSelectedBase(stableInput.xdgStateHome, uid))) {
            return refusal(
                ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
                'present XDG state home is not safely usable',
                stableInput.xdgStateHome,
            )
        }
        base = stableInput.xdgStateHome
        root = join(stableInput.xdgStateHome, 'cockpit', 'v1')
    } else {
        if (!stableInput.home || !(await usableBase(stableInput.home, uid))) {
            return refusal(
                ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE,
                'state root requires an absolute usable home directory',
                stableInput.home ?? '',
            )
        }
        base = stableInput.home
        root = join(stableInput.home, '.local', 'state', 'cockpit', 'v1')
    }

    if (!(await safeDescendant(base, root, uid)) || checkoutRoots.some((checkoutRoot) => confinedTo(checkoutRoot, root))) {
        return refusal(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'selected state root is not safely usable', root)
    }

    try {
        return { kind: 'complete', value: namespace(root, stableInput.cockpitId) }
    } catch {
        return refusal(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'cockpit identity cannot scope the state root safely', root)
    }
}

function malformed<T>(address: StateAddress | BootstrapStateAddress): StateResult<T> {
    return refusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'state record is malformed or does not match its address', address.path)
}

function expectedAddressPath(address: StateAddress | BootstrapStateAddress): string | undefined {
    if (address.kind === 'bootstrap') {
        if (!isAbsolute(address.stateRoot) || !isAbsolute(address.checkoutRoot)
            || resolve(address.checkoutRoot) !== address.checkoutRoot || !checkoutIdentity.test(address.checkoutId)
            || !surfaceTargets.has(address.target)) return undefined
        return join(address.stateRoot, 'checkouts', address.checkoutId, 'records', 'bootstrap', `${address.target}.json`)
    }
    if (
        !isAbsolute(address.stateRoot)
        || address.cockpitRoot !== join(address.stateRoot, 'cockpits', address.cockpitId)
    ) return undefined
    if (!cockpitIdentity.test(address.cockpitId)) return undefined
    const expectedSubject = address.kind === 'cache' ? checkoutIdentity : stackIdentity
    if (!expectedSubject.test(address.subjectId)) return undefined
    if (address.kind === 'claim' || address.kind === 'lease') {
        return join(address.cockpitRoot, 'records', `${address.kind}s`, `${address.subjectId}.json`)
    }
    if (
        address.kind === 'lifecycle'
        || address.kind === 'lifecycle-history'
        || address.kind === 'coordination'
        || address.kind === 'data-outcome'
    ) {
        return join(address.cockpitRoot, 'records', address.kind, `${address.subjectId}.json`)
    }
    if (address.kind === 'baseline') {
        return join(address.cockpitRoot, 'evidence', 'baselines', `${address.subjectId}.json`)
    }
    if (address.kind === 'cache' && address.qualifier && digest.test(address.qualifier)) {
        return join(address.cockpitRoot, 'cache', address.subjectId, `${address.qualifier}.json`)
    }
    return undefined
}

async function addressIsSafe(address: StateAddress | BootstrapStateAddress): Promise<boolean> {
    const expected = expectedAddressPath(address)
    const scopedRoot = address.kind === 'bootstrap'
        ? join(address.stateRoot, 'checkouts', address.checkoutId)
        : address.cockpitRoot
    if (!expected || resolve(expected) !== resolve(address.path) || !confinedTo(scopedRoot, address.path)) return false
    return ownedPathIsSafe(address.stateRoot, address.path, 'file')
}

async function ownedPathIsSafe(root: string, path: string, kind: 'file' | 'directory'): Promise<boolean> {
    if (!isAbsolute(root) || !confinedTo(root, path)) return false
    let cursor = root
    const paths = [cursor]
    for (const segment of relative(root, path).split(sep).filter(Boolean)) {
        cursor = join(cursor, segment)
        paths.push(cursor)
    }
    for (const candidate of paths) {
        try {
            const status = await lstat(candidate)
            const isFile = candidate === path && kind === 'file'
            if (!privatelyOwned(status) || status.isSymbolicLink() || (isFile ? !status.isFile() : !status.isDirectory())) return false
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
            return false
        }
    }
    return true
}

interface FileSnapshot {
    readonly bytes: Buffer
    readonly dev: number
    readonly ino: number
}

async function readRegularFileSnapshotNoFollow(
    path: string,
    revalidate: () => Promise<boolean>,
): Promise<FileSnapshot> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
        const opened = await handle.stat()
        if (!privatelyOwned(opened) || !opened.isFile() || opened.size > SERIALIZED_RECORD_BYTE_LIMIT || !(await revalidate())) throw new Error('unsafe file path')
        const current = await lstat(path)
        if (!privatelyOwned(current) || current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
            throw new Error('file path changed while opening')
        }
        const bounded = Buffer.allocUnsafe(SERIALIZED_RECORD_BYTE_LIMIT + 1)
        let byteLength = 0
        while (byteLength < bounded.length) {
            const { bytesRead } = await handle.read(bounded, byteLength, bounded.length - byteLength, byteLength)
            if (bytesRead === 0) break
            byteLength += bytesRead
        }
        if (byteLength > SERIALIZED_RECORD_BYTE_LIMIT) throw new Error('file exceeds the byte limit')
        if (!(await revalidate())) throw new Error('unsafe file path after read')
        const openedAfter = await handle.stat()
        const after = await lstat(path)
        if (
            openedAfter.size > SERIALIZED_RECORD_BYTE_LIMIT
            || after.size > SERIALIZED_RECORD_BYTE_LIMIT
            || after.isSymbolicLink()
            || !privatelyOwned(after)
            || !after.isFile()
            || after.dev !== opened.dev
            || after.ino !== opened.ino
        ) {
            throw new Error('file path changed while reading')
        }
        return { bytes: bounded.subarray(0, byteLength), dev: opened.dev, ino: opened.ino }
    } finally {
        await handle.close()
    }
}

async function readRegularFileNoFollow(path: string, revalidate: () => Promise<boolean>): Promise<Buffer> {
    return (await readRegularFileSnapshotNoFollow(path, revalidate)).bytes
}

export function readState(address: BootstrapStateAddress): Promise<StateResult<BootstrapStateRecord>>
export function readState(address: StateAddress): Promise<StateResult<StateRecord>>
export function readState(address: StateAddress | BootstrapStateAddress): Promise<StateResult<AnyStateRecord>>
export async function readState(address: StateAddress | BootstrapStateAddress): Promise<StateResult<AnyStateRecord>> {
    let stableAddress: StateAddress | BootstrapStateAddress
    try {
        if (address.kind === 'bootstrap') {
            if (Reflect.ownKeys(address).sort().join(',') !== 'checkoutId,checkoutRoot,kind,path,stateRoot,target') {
                throw new Error('bootstrap address shape is not closed')
            }
            stableAddress = Object.freeze({
                path: address.path, stateRoot: address.stateRoot, checkoutRoot: address.checkoutRoot,
                kind: 'bootstrap', checkoutId: address.checkoutId, target: address.target,
            })
        } else {
        const qualifier = address.qualifier
        stableAddress = Object.freeze({
            path: address.path,
            stateRoot: address.stateRoot,
            cockpitRoot: address.cockpitRoot,
            kind: address.kind,
            cockpitId: address.cockpitId,
            subjectId: address.subjectId,
            ...(qualifier ? { qualifier } : {}),
        })
        }
    } catch {
        return refusal(
            ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
            'state record address could not be read safely',
            'state record address',
        )
    }
    if (!(await addressIsSafe(stableAddress))) return malformed(stableAddress)
    let bytes: Buffer
    try {
        bytes = await readRegularFileNoFollow(stableAddress.path, () => addressIsSafe(stableAddress))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', path: stableAddress.path }
        return malformed(stableAddress)
    }

    let parsed: unknown
    try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        parsed = JSON.parse(source)
    } catch {
        return malformed(stableAddress)
    }

    if (
        typeof parsed === 'object'
        && parsed !== null
        && 'format' in parsed
        && typeof parsed.format === 'string'
        && /^cockpit-state\/v[^/]+$/.test(parsed.format)
        && parsed.format !== STATE_FORMAT
    ) {
        return refusal(ENVIRONMENT_CODES.STATE_FORMAT_UNSUPPORTED, 'state record format is not supported', stableAddress.path)
    }

    if (stableAddress.kind === 'bootstrap') {
        const validated = BootstrapStateRecordSchema.safeParse(parsed)
        if (!validated.success || validated.data.checkoutId !== stableAddress.checkoutId
            || validated.data.target !== stableAddress.target || validated.data.value.checkoutRoot !== stableAddress.checkoutRoot
            || validated.data.value.target !== stableAddress.target) return malformed(stableAddress)
        return { kind: 'complete', value: validated.data }
    }
    const validated = StateRecordSchema.safeParse(parsed)
    if (
        !validated.success
        || validated.data.kind !== stableAddress.kind
        || validated.data.cockpitId !== stableAddress.cockpitId
        || validated.data.subjectId !== stableAddress.subjectId
    ) {
        return malformed(stableAddress)
    }
    return { kind: 'complete', value: validated.data }
}

async function ensureDirectory(path: string, stateRoot: string): Promise<void> {
    if (!(await ownedPathIsSafe(stateRoot, path, 'directory'))) throw new Error('unsafe state directory path')
    const absent: string[] = []
    let cursor = path
    while (true) {
        try {
            const status = await lstat(cursor)
            if (!status.isDirectory() || status.isSymbolicLink() || !privatelyOwned(status) || (status.mode & 0o200) === 0) throw new Error('unsafe directory component')
            break
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            absent.push(cursor)
            const parent = dirname(cursor)
            if (parent === cursor) throw new Error('no usable state ancestor')
            cursor = parent
        }
    }
    for (const directory of absent.reverse()) {
        try {
            await mkdir(directory, { mode: 0o700 })
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        const status = await lstat(directory)
        if (!status.isDirectory() || status.isSymbolicLink() || !privatelyOwned(status) || (status.mode & 0o200) === 0) throw new Error('unsafe directory component')
    }
    if (!(await ownedPathIsSafe(stateRoot, path, 'directory'))) throw new Error('state directory path changed during creation')
}

function validateRecordForAddress(
    address: StateAddress | BootstrapStateAddress,
    value: unknown,
    current: AnyStateRecord | null,
): AnyStateRecord | undefined {
    if (address.kind === 'bootstrap') {
        const validated = BootstrapStateRecordSchema.safeParse(value)
        if (!validated.success) return undefined
        const record = validated.data
        const expectedRevision = current === null ? 0 : current.revision + 1
        const currentBootstrap = current?.kind === 'bootstrap' ? current : null
        const immutableEvidenceMatches = currentBootstrap === null
            || record.value.commandSha256 === currentBootstrap.value.commandSha256
                && record.value.previewSha256 === currentBootstrap.value.previewSha256
                && JSON.stringify(record.value.sources) === JSON.stringify(currentBootstrap.value.sources)
        const stageDelta = currentBootstrap === null ? 0
            : bootstrapStages.indexOf(record.value.stage) - bootstrapStages.indexOf(currentBootstrap.value.stage)
        const stageAdvances = currentBootstrap === null || stageDelta === 0 || stageDelta === 1
        const publishedEvidenceMatches = currentBootstrap === null || currentBootstrap.value.published.length === 0
            || JSON.stringify(record.value.published) === JSON.stringify(currentBootstrap.value.published)
        const draftEvidenceMatches = currentBootstrap === null || currentBootstrap.value.destination === null
            || record.value.destination === currentBootstrap.value.destination
                && record.value.artifactBytes === currentBootstrap.value.artifactBytes
                && record.value.artifactSha256 === currentBootstrap.value.artifactSha256
        const currentGreenfield = currentBootstrap?.value.greenfield
        const nextGreenfield = record.value.greenfield
        const greenfieldEvidenceMatches = currentGreenfield === undefined
            ? nextGreenfield === undefined || nextGreenfield.answers.length === 0
                && (nextGreenfield.stage === 'question-pending' || nextGreenfield.stage === 'resolved')
            : nextGreenfield !== undefined
                && nextGreenfield.mode === currentGreenfield.mode
                && nextGreenfield.classification === currentGreenfield.classification
                && nextGreenfield.sourceObservationSha256 === currentGreenfield.sourceObservationSha256
                && nextGreenfield.notice === currentGreenfield.notice
                && JSON.stringify(nextGreenfield.applicability) === JSON.stringify(currentGreenfield.applicability)
                && JSON.stringify(nextGreenfield.questions.slice(0, currentGreenfield.questions.length)) === JSON.stringify(currentGreenfield.questions)
                && nextGreenfield.questions.length - currentGreenfield.questions.length >= 0
                && nextGreenfield.questions.length - currentGreenfield.questions.length <= 1
                && JSON.stringify(nextGreenfield.answers.slice(0, currentGreenfield.answers.length)) === JSON.stringify(currentGreenfield.answers)
                && nextGreenfield.answers.length - currentGreenfield.answers.length >= 0
                && nextGreenfield.answers.length - currentGreenfield.answers.length <= 1
                && (() => {
                    const stages = ['question-pending', 'answers-recorded', 'resolved']
                    const delta = stages.indexOf(nextGreenfield.stage) - stages.indexOf(currentGreenfield.stage)
                    return delta === 0 || delta === 1
                })()
        return record.checkoutId === address.checkoutId && record.target === address.target
            && record.value.checkoutRoot === address.checkoutRoot && record.value.target === address.target
            && record.revision === expectedRevision && immutableEvidenceMatches && stageAdvances
            && publishedEvidenceMatches && draftEvidenceMatches && greenfieldEvidenceMatches ? record : undefined
    }
    const validated = StateRecordSchema.safeParse(value)
    if (!validated.success) return undefined
    const record = validated.data
    const expectedRevision = current === null ? 0 : current.revision + 1
    if (
        record.kind !== address.kind
        || record.cockpitId !== address.cockpitId
        || record.subjectId !== address.subjectId
        || record.revision !== expectedRevision
    ) return undefined
    return record
}

async function inspectLock(
    lockPath: string,
    stateRoot: string,
    observeHolder: StateTransactionOptions['observeHolder'],
): Promise<StateLockInspection> {
    const ownerPath = join(lockPath, 'owner.json')
    try {
        const bytes = await readRegularFileNoFollow(ownerPath, async () => {
            const lock = await lstat(lockPath)
            return lock.isDirectory() && !lock.isSymbolicLink() && privatelyOwned(lock) && await ownedPathIsSafe(stateRoot, ownerPath, 'file')
        })
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const parsed = StateLockSchema.safeParse(JSON.parse(source))
        if (!parsed.success) throw new Error('invalid lock metadata')
        let holderState: LockHolderState = 'unknown'
        if (observeHolder) {
            try {
                holderState = await observeHolder({ ownerId: parsed.data.ownerId as HolderId | BootstrapLockOwnerId, pid: parsed.data.pid })
            } catch {
                holderState = 'unknown'
            }
        }
        return {
            holderState,
            description: `state is locked by ${parsed.data.ownerId} (${holderState})`,
            recovery: holderState === 'dead'
                ? 'request explicit state-lock reclamation using the recorded holder evidence'
                : 'inspect the named holder and retry after it releases the state lock',
        }
    } catch {
        return {
            holderState: 'invalid',
            description: 'state lock metadata is missing or malformed',
            recovery: 'inspect the lock directory and establish positive holder evidence before explicit reclamation',
        }
    }
}

export async function inspectStateLock(
    namespace: StateNamespace | BootstrapStateNamespace,
    observeHolder?: StateTransactionOptions['observeHolder'],
): Promise<StateLockInspection> {
    const bootstrap = authenticateBootstrapStateNamespace(namespace)
    const stableNamespace = bootstrap
        ? snapshotBootstrapStateNamespace(bootstrap)
        : snapshotStateNamespace(namespace as StateNamespace)
    if (!stableNamespace) {
        return {
            holderState: 'invalid',
            description: 'state lock namespace is malformed',
            recovery: 'inspect the state namespace before relying on lock ownership',
        }
    }
    return inspectLock(stableNamespace.paths.stateLock, stableNamespace.root, observeHolder)
}

async function acquireLock(
    namespace: { readonly root: string; readonly paths: { readonly stateLock: string } },
    options: StateTransactionOptions,
    ownerPattern = holderIdentity,
): Promise<
    | { kind: 'acquired'; ownerBytes: string }
    | Extract<StateResult<never>, { kind: 'refusal' }>
> {
    if (!ownerPattern.test(options.ownerId)) {
        return refusal(ENVIRONMENT_CODES.STATE_LOCKED, 'state lock owner is invalid', namespace.paths.stateLock) as Extract<
            StateResult<never>, { kind: 'refusal' }
        >
    }
    const locksRoot = dirname(namespace.paths.stateLock)
    await ensureDirectory(locksRoot, namespace.root)
    const existingQuarantine = await releaseQuarantine(locksRoot)
    if (existingQuarantine) {
        return refusal(
            ENVIRONMENT_CODES.STATE_LOCKED,
            'state has a quarantined lock awaiting explicit recovery',
            existingQuarantine,
            await quarantineRecovery(existingQuarantine),
        ) as Extract<StateResult<never>, { kind: 'refusal' }>
    }
    let createdLock = false
    let createdNode: { readonly dev: number; readonly ino: number } | undefined
    try {
        await mkdir(namespace.paths.stateLock, { mode: 0o700 })
        createdLock = true
        const created = await lstat(namespace.paths.stateLock)
        createdNode = created
        let concurrentQuarantine: string | undefined
        try {
            concurrentQuarantine = await releaseQuarantine(locksRoot)
        } catch {
            createdLock = false
            return refusal(
                ENVIRONMENT_CODES.STATE_LOCKED,
                'state locks root changed while acquiring the state lock',
                namespace.paths.stateLock,
                'inspect the state locks root and establish positive holder evidence before explicit recovery',
            ) as Extract<StateResult<never>, { kind: 'refusal' }>
        }
        if (concurrentQuarantine) {
            const current = await lstat(namespace.paths.stateLock)
            createdLock = false
            let leftover = ''
            if (current.isDirectory() && !current.isSymbolicLink() && sameNode(current, created)) {
                try { await rmdir(namespace.paths.stateLock) }
                catch (error) {
                    // A lock directory this acquisition created but could not remove blocks every
                    // later acquisition, so the operator must be told it exists.
                    leftover = `; the lock directory this acquisition created at ${namespace.paths.stateLock} could not be removed: ${(error as Error).message}`
                }
            }
            return refusal(
                ENVIRONMENT_CODES.STATE_LOCKED,
                `state lock release raced with acquisition and remains quarantined${leftover}`,
                concurrentQuarantine,
                await quarantineRecovery(concurrentQuarantine),
            ) as Extract<StateResult<never>, { kind: 'refusal' }>
        }
        const owner = {
            format: STATE_FORMAT,
            kind: 'state-lock',
            ownerId: options.ownerId,
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
            token: randomUUID(),
        } as const
        const ownerBytes = `${JSON.stringify(owner)}\n`
        const handle = await open(join(namespace.paths.stateLock, 'owner.json'), 'wx', 0o600)
        try {
            await handle.writeFile(ownerBytes, 'utf8')
            await handle.sync()
        } finally {
            await handle.close()
        }
        return { kind: 'acquired', ownerBytes }
    } catch (error) {
        if (createdLock) {
            try {
                const current = await lstat(namespace.paths.stateLock)
                const entries = await readdir(namespace.paths.stateLock)
                if (
                    createdNode
                    && current.isDirectory()
                    && !current.isSymbolicLink()
                    && sameNode(current, createdNode)
                    && entries.length === 0
                ) {
                    await rmdir(namespace.paths.stateLock)
                }
            } catch {
                // A partially created or replaced lock is authority evidence and must survive for recovery.
            }
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const observed = await inspectLock(namespace.paths.stateLock, namespace.root, options.observeHolder)
        return refusal(
            ENVIRONMENT_CODES.STATE_LOCKED,
            observed.description,
            namespace.paths.stateLock,
            observed.recovery,
        ) as Extract<StateResult<never>, { kind: 'refusal' }>
    }
}

async function releaseQuarantine(locksRoot: string): Promise<string | undefined> {
    const before = await lstat(locksRoot)
    if (!before.isDirectory() || before.isSymbolicLink() || !privatelyOwned(before)) throw new Error('state locks root is unsafe')
    const names = await readdir(locksRoot)
    const after = await lstat(locksRoot)
    if (!sameNode(before, after)) throw new Error('state locks root changed during quarantine inspection')
    const name = names.filter((entry) => entry.startsWith('.state.lock.release-')).sort()[0]
    return name ? join(locksRoot, name) : undefined
}

async function quarantineRecovery(path: string): Promise<string> {
    const evidencePath = path.endsWith('.owner.json') ? path : `${path}.owner.json`
    try {
        const evidence = await lstat(evidencePath)
        if (evidence.isFile() && !evidence.isSymbolicLink()) {
            return `inspect the quarantined lock owner evidence at ${evidencePath} before explicit recovery`
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return 'inspect the quarantined lock holder and restore or reclaim it using positive owner evidence'
}

function sameNode(
    actual: { readonly dev: number; readonly ino: number },
    expected: { readonly dev: number; readonly ino: number },
): boolean {
    return actual.dev === expected.dev && actual.ino === expected.ino
}

class LockReleaseError extends Error {
    constructor(
        message: string,
        readonly target: string,
        readonly recovery: string,
    ) {
        super(message)
    }
}

function samePrivateNode(
    actual: { readonly dev: number; readonly ino: number; readonly uid: number; readonly mode: number },
    expected: { readonly dev: number; readonly ino: number },
): boolean {
    return privatelyOwned(actual) && sameNode(actual, expected)
}

async function releaseLock(
    lockPath: string,
    ownerBytes: string,
    beforeRelease?: StateTransactionOptions['beforeRelease'],
    beforeLockMetadata?: StateTransactionOptions['beforeLockMetadata'],
): Promise<void> {
    const releaseRoot = dirname(lockPath)
    const ownerPath = join(lockPath, 'owner.json')
    const verifiedRoot = await lstat(releaseRoot)
    const verifiedLock = await lstat(lockPath)
    if (
        !verifiedRoot.isDirectory()
        || verifiedRoot.isSymbolicLink()
        || !privatelyOwned(verifiedRoot)
        || !verifiedLock.isDirectory()
        || verifiedLock.isSymbolicLink()
        || !privatelyOwned(verifiedLock)
    ) {
        throw new Error('state lock changed before release')
    }
    const currentOwner = await readRegularFileSnapshotNoFollow(ownerPath, async () => {
        const root = await lstat(releaseRoot)
        const lock = await lstat(lockPath)
        return samePrivateNode(root, verifiedRoot)
            && lock.isDirectory()
            && !lock.isSymbolicLink()
            && samePrivateNode(lock, verifiedLock)
    })
    if (currentOwner.bytes.toString('utf8') !== ownerBytes) {
        throw new Error('state lock ownership changed before release')
    }
    const parsedOwner = StateLockSchema.parse(JSON.parse(ownerBytes))
    await beforeRelease?.()
    if (!samePrivateNode(lstatSync(releaseRoot), verifiedRoot)
        || !samePrivateNode(lstatSync(lockPath), verifiedLock)
        || !samePrivateNode(lstatSync(ownerPath), currentOwner)) {
        throw new Error('state lock permissions or ownership changed before release')
    }

    const tombstone = join(releaseRoot, `.state.lock.release-${parsedOwner.token}`)
    const movedOwnerPath = join(tombstone, 'owner.json')
    let evidencePath = movedOwnerPath
    await rename(lockPath, tombstone)
    try {
        await syncDirectory(releaseRoot)
        const movedRoot = await lstat(releaseRoot)
        const movedLock = await lstat(tombstone)
        if (
            !samePrivateNode(movedRoot, verifiedRoot)
            || !movedLock.isDirectory()
            || movedLock.isSymbolicLink()
            || !samePrivateNode(movedLock, verifiedLock)
        ) {
            throw new Error('moved lock directory does not match verified owner')
        }
        const movedOwner = await readRegularFileSnapshotNoFollow(movedOwnerPath, async () => {
            const root = await lstat(releaseRoot)
            const lock = await lstat(tombstone)
            return samePrivateNode(root, verifiedRoot)
                && lock.isDirectory()
                && !lock.isSymbolicLink()
                && samePrivateNode(lock, movedLock)
        })
        if (!sameNode(movedOwner, currentOwner) || movedOwner.bytes.toString('utf8') !== ownerBytes) {
            throw new Error('moved lock owner does not match verified owner')
        }
        const entries = await readdir(tombstone)
        if (entries.length !== 1 || entries[0] !== 'owner.json') {
            throw new Error('quarantined lock contains unexpected entries')
        }
        const deletionRoot = await lstat(releaseRoot)
        const deletionLock = await lstat(tombstone)
        const deletionOwner = await lstat(movedOwnerPath)
        if (
            !samePrivateNode(deletionRoot, verifiedRoot)
            || !samePrivateNode(deletionLock, movedLock)
            || !samePrivateNode(deletionOwner, movedOwner)
        ) {
            throw new Error('quarantined lock changed before deletion')
        }
        const ownerBackupPath = `${tombstone}.owner.json`
        await link(movedOwnerPath, ownerBackupPath)
        await syncDirectory(releaseRoot)
        const linkedOwner = await lstat(movedOwnerPath)
        const linkedBackup = await lstat(ownerBackupPath)
        if (!samePrivateNode(linkedOwner, movedOwner) || !samePrivateNode(linkedBackup, movedOwner)) {
            throw new Error('quarantined lock owner changed after evidence link')
        }
        // Node has no portable fd-relative conditional unlink. This checkpoint protects cooperative
        // concurrent processes and injected pre-syscall interference, not a malicious same-UID syscall race.
        await beforeLockMetadata?.('owner-unlink')
        if (!samePrivateNode(lstatSync(releaseRoot), verifiedRoot)
            || !samePrivateNode(lstatSync(tombstone), movedLock)) {
            throw new Error('state lock permissions changed before owner unlink')
        }
        const ownerBeforeUnlink = await lstat(movedOwnerPath)
        const backupBeforeUnlink = await lstat(ownerBackupPath)
        if (!samePrivateNode(ownerBeforeUnlink, movedOwner) || !samePrivateNode(backupBeforeUnlink, movedOwner)) {
            throw new Error('quarantined lock owner changed before unlink')
        }
        await unlink(movedOwnerPath)
        evidencePath = ownerBackupPath
        try {
            await syncDirectory(tombstone)
        } catch (error) {
            await restoreOwnerEvidence(ownerBackupPath, movedOwnerPath, movedOwner, tombstone, beforeLockMetadata)
            evidencePath = movedOwnerPath
            throw error
        }
        try {
            const emptyRoot = await lstat(releaseRoot)
            const emptyLock = await lstat(tombstone)
            if (!samePrivateNode(emptyRoot, verifiedRoot) || !samePrivateNode(emptyLock, movedLock)) {
                throw new Error('quarantined lock changed before directory removal')
            }
            await beforeLockMetadata?.('tombstone-rmdir')
            if (!samePrivateNode(lstatSync(releaseRoot), verifiedRoot)
                || !samePrivateNode(lstatSync(tombstone), movedLock)) {
                throw new Error('state lock permissions changed before directory removal')
            }
            await rmdir(tombstone)
            await syncDirectory(releaseRoot)
        } catch (error) {
            try {
                await restoreOwnerEvidence(ownerBackupPath, movedOwnerPath, movedOwner, tombstone, beforeLockMetadata)
                evidencePath = movedOwnerPath
            } catch (restoreError) {
                throw new Error(`${(error as Error).message}; owner evidence remains at ${evidencePath}; restoration failed: ${(restoreError as Error).message}`)
            }
            throw error
        }
        await beforeLockMetadata?.('backup-unlink')
        if (!samePrivateNode(lstatSync(releaseRoot), verifiedRoot)) throw new Error('state locks root permissions changed before backup cleanup')
        const finalBackup = await lstat(ownerBackupPath)
        if (!samePrivateNode(finalBackup, movedOwner)) throw new Error('owner evidence backup changed before cleanup')
        await unlink(ownerBackupPath)
        try {
            await syncDirectory(releaseRoot)
        } catch (error) {
            evidencePath = ownerBackupPath
            const evidence = await open(evidencePath, 'wx', 0o600)
            try {
                await evidence.writeFile(ownerBytes, 'utf8')
                await evidence.sync()
            } finally {
                await evidence.close()
            }
            await syncDirectory(releaseRoot).catch(() => undefined)
            throw error
        }
    } catch (error) {
        throw new LockReleaseError(
            `state lock release quarantined an unverified holder: ${(error as Error).message}`,
            tombstone,
            evidencePath === movedOwnerPath
                ? 'inspect the quarantined lock holder and restore or reclaim it using positive owner evidence'
                : `inspect the quarantined lock owner evidence at ${evidencePath} before explicit recovery`,
        )
    }
}

export async function withStateScopedLock<T>(namespace: StateNamespace, scope: StateScopedLock,
    options: Pick<StateTransactionOptions, 'ownerId' | 'observeHolder' | 'contentionTimeoutMs' | 'beforeRelease' | 'beforeLockMetadata'>,
    operation: () => T | Promise<T>): Promise<StateResult<T>> {
    const authenticated = authenticateStateNamespace(namespace)
    const binding = scope !== null && typeof scope === 'object' ? issuedScopedLocks.get(scope) : undefined
    let stableOptions: StateTransactionOptions | undefined
    try {
        if (!options || typeof options !== 'object' || isProxy(options)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new Error('invalid options')
        const descriptors = Object.getOwnPropertyDescriptors(options)
        const allowed = new Set(['ownerId', 'observeHolder', 'contentionTimeoutMs', 'beforeRelease', 'beforeLockMetadata'])
        if (!descriptors.ownerId || !('value' in descriptors.ownerId)
            || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.has(key))
            || Object.values(descriptors).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) throw new Error('invalid options')
        const values = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
        if (typeof values.ownerId !== 'string'
            || values.observeHolder !== undefined && typeof values.observeHolder !== 'function'
            || values.contentionTimeoutMs !== undefined && typeof values.contentionTimeoutMs !== 'number'
            || values.beforeRelease !== undefined && typeof values.beforeRelease !== 'function'
            || values.beforeLockMetadata !== undefined && typeof values.beforeLockMetadata !== 'function') throw new Error('invalid options')
        stableOptions = Object.freeze({ ownerId: values.ownerId as HolderId,
            ...(values.observeHolder ? { observeHolder: values.observeHolder as StateTransactionOptions['observeHolder'] } : {}),
            ...(values.contentionTimeoutMs !== undefined ? { contentionTimeoutMs: values.contentionTimeoutMs } : {}),
            ...(values.beforeRelease ? { beforeRelease: values.beforeRelease as StateTransactionOptions['beforeRelease'] } : {}),
            ...(values.beforeLockMetadata ? { beforeLockMetadata: values.beforeLockMetadata as StateTransactionOptions['beforeLockMetadata'] } : {}) })
    } catch { stableOptions = undefined }
    if (!authenticated || !binding || binding.namespace !== authenticated || !stableOptions || typeof operation !== 'function') {
        return refusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'scoped state lock authority is malformed', 'scoped state lock')
    }
    const stableNamespace = Object.freeze({ root: authenticated.root, cockpitRoot: authenticated.cockpitRoot,
        paths: Object.freeze({ stateLock: binding.path }) })
    if (!holderIdentity.test(stableOptions.ownerId)
        || stableOptions.contentionTimeoutMs !== undefined && (!Number.isSafeInteger(stableOptions.contentionTimeoutMs)
            || stableOptions.contentionTimeoutMs < 0 || stableOptions.contentionTimeoutMs > 30_000)) {
        return refusal(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'scoped state lock options are malformed', binding.path)
    }
    let acquired: Awaited<ReturnType<typeof acquireLock>>
    const deadline = Date.now() + (stableOptions.contentionTimeoutMs ?? 0)
    let backoffMs = 5
    while (true) {
        try { acquired = await acquireLock(stableNamespace, stableOptions) }
        catch { return refusal(ENVIRONMENT_CODES.STATE_LOCKED, 'scoped state lock could not be acquired safely', binding.path) }
        if (acquired.kind === 'acquired' || acquired.code !== ENVIRONMENT_CODES.STATE_LOCKED) break
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0 || stableOptions.contentionTimeoutMs === undefined) break
        await delay(Math.min(backoffMs, remainingMs))
        backoffMs = Math.min(backoffMs * 2, 50)
    }
    if (acquired.kind !== 'acquired') return acquired
    // The operation is the caller's own work, not a state record: its exception is rethrown
    // unchanged once the lock is released. Labelling it STATE_RECORD_MALFORMED sent the operator
    // to inspect state that was never touched.
    let outcome: { readonly kind: 'complete'; readonly value: T } | { readonly kind: 'thrown'; readonly error: unknown }
    try { outcome = { kind: 'complete', value: await operation() } }
    catch (error) { outcome = { kind: 'thrown', error } }
    try { await releaseLock(binding.path, acquired.ownerBytes, stableOptions.beforeRelease, stableOptions.beforeLockMetadata) }
    catch (error) {
        const release = error instanceof LockReleaseError ? error : undefined
        const lockRecovery = release?.recovery ?? 'inspect the recorded scoped lock owner before explicit reclamation'
        // As in transactState: completed work survives a failed release, so the caller can
        // still act on it while the stuck lock is reported.
        if (outcome.kind === 'complete') return {
            kind: 'indeterminate',
            code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
            message: 'scoped state operation completed but its lock could not be released safely',
            target: release?.target ?? binding.path,
            recovery: lockRecovery,
            value: outcome.value,
        }
        const cause = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        return refusal(ENVIRONMENT_CODES.STATE_LOCKED,
            `scoped state operation failed (${cause}) and its lock could not be released safely`,
            release?.target ?? binding.path, lockRecovery)
    }
    if (outcome.kind === 'thrown') throw outcome.error
    return outcome
}

async function restoreOwnerEvidence(
    backupPath: string,
    ownerPath: string,
    expectedOwner: FileSnapshot,
    tombstone: string,
    beforeLockMetadata?: StateTransactionOptions['beforeLockMetadata'],
): Promise<void> {
    const backup = await lstat(backupPath)
    if (!backup.isFile() || backup.isSymbolicLink() || !samePrivateNode(backup, expectedOwner)) {
        throw new Error('owner evidence backup changed before restoration')
    }
    try {
        await beforeLockMetadata?.('owner-restore-link')
        const root = lstatSync(dirname(tombstone))
        const lock = lstatSync(tombstone)
        if (!root.isDirectory() || root.isSymbolicLink() || !privatelyOwned(root)
            || !lock.isDirectory() || lock.isSymbolicLink() || !privatelyOwned(lock)
            || !samePrivateNode(lstatSync(backupPath), expectedOwner)) {
            throw new Error('state lock path became unsafe before owner restoration')
        }
        await link(backupPath, ownerPath)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const restored = await lstat(ownerPath)
    if (!restored.isFile() || restored.isSymbolicLink() || !samePrivateNode(restored, expectedOwner)) {
        throw new Error('owner evidence path changed during restoration')
    }
    await syncDirectory(tombstone)
}

async function syncDirectory(directoryPath: string): Promise<void> {
    const directory = await open(directoryPath, 'r')
    try {
        await directory.sync()
    } finally {
        await directory.close()
    }
}

class TemporaryPublicationError extends Error {
    constructor(readonly target: string) {
        super('temporary state publication path changed; unverified bytes were preserved')
    }
}

function preparedRecordMatches(
    path: string,
    expectedNode: { readonly dev: number; readonly ino: number },
    expectedBytes: Buffer,
): boolean {
    if (expectedBytes.byteLength > SERIALIZED_RECORD_BYTE_LIMIT) return false
    let descriptor: number | undefined
    try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = fstatSync(descriptor)
        const named = lstatSync(path)
        if (
            !privatelyOwned(opened)
            || !opened.isFile()
            || opened.isSymbolicLink()
            || !privatelyOwned(named)
            || !named.isFile()
            || named.isSymbolicLink()
            || !sameNode(opened, expectedNode)
            || !sameNode(named, expectedNode)
            || opened.size !== expectedBytes.byteLength
            || named.size !== expectedBytes.byteLength
        ) return false

        const bytes = Buffer.alloc(expectedBytes.byteLength + 1)
        let offset = 0
        while (offset < bytes.byteLength) {
            const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset)
            if (count === 0) break
            offset += count
        }
        const openedAfter = fstatSync(descriptor)
        const namedAfter = lstatSync(path)
        if (
            offset !== expectedBytes.byteLength
            || !openedAfter.isFile()
            || openedAfter.isSymbolicLink()
            || !privatelyOwned(namedAfter)
            || !namedAfter.isFile()
            || namedAfter.isSymbolicLink()
            || !sameNode(openedAfter, expectedNode)
            || !sameNode(namedAfter, expectedNode)
            || openedAfter.size !== expectedBytes.byteLength
            || namedAfter.size !== expectedBytes.byteLength
        ) return false
        return bytes.subarray(0, offset).equals(expectedBytes)
    } catch {
        return false
    } finally {
        if (descriptor !== undefined) closeSync(descriptor)
    }
}

async function publishRecord(
    address: StateAddress | BootstrapStateAddress,
    record: AnyStateRecord,
    beforePublish?: StateTransactionOptions['beforePublish'],
    beforeCommit?: StateTransactionOptions['beforeCommit'],
): Promise<'durable' | 'indeterminate' | StateTransactionAbort<unknown>> {
    await ensureDirectory(dirname(address.path), address.stateRoot)
    const temporaryPath = join(dirname(address.path), `.${address.kind === 'bootstrap' ? address.target : address.subjectId}.${randomUUID()}.tmp`)
    const source = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
    let temporaryExists = false
    let temporaryNode: { readonly dev: number; readonly ino: number } | undefined
    try {
        const handle = await open(temporaryPath, 'wx', 0o600)
        temporaryExists = true
        try {
            if (source.byteLength > SERIALIZED_RECORD_BYTE_LIMIT) throw new Error('state record exceeds the byte limit')
            await handle.writeFile(source)
            await handle.sync()
            temporaryNode = await handle.stat()
        } finally {
            await handle.close()
        }
        await beforePublish?.(temporaryPath)
        const currentTemporary = await lstat(temporaryPath)
        if (!temporaryNode || !currentTemporary.isFile() || currentTemporary.isSymbolicLink() || !sameNode(currentTemporary, temporaryNode)) {
            throw new TemporaryPublicationError(temporaryPath)
        }
        if (beforeCommit) {
            const cancellation = beforeCommit()
            if (cancellation !== undefined) {
                if (!isStateTransactionAbort(cancellation)) throw new Error('state commit veto is malformed')
                return cancellation
            }
        }
        if (!temporaryNode || !preparedRecordMatches(temporaryPath, temporaryNode, source)) {
            throw new TemporaryPublicationError(temporaryPath)
        }
        let cursor = address.stateRoot
        for (const segment of ['', ...relative(address.stateRoot, address.path).split(sep)]) {
            cursor = segment ? join(cursor, segment) : cursor
            try {
                const status = lstatSync(cursor)
                if (!privatelyOwned(status) || status.isSymbolicLink() || (cursor === address.path ? !status.isFile() : !status.isDirectory())) {
                    throw new Error('unsafe state path before publication')
                }
            } catch (error) {
                if (cursor === address.path && (error as NodeJS.ErrnoException).code === 'ENOENT') break
                throw error
            }
        }
        renameSync(temporaryPath, address.path)
        temporaryExists = false
        try {
            await syncDirectory(dirname(address.path))
        } catch (error) {
            return 'indeterminate'
        }
        return 'durable'
    } finally {
        if (temporaryExists) {
            try {
                if (!temporaryNode || !preparedRecordMatches(temporaryPath, temporaryNode, source)) {
                    throw new TemporaryPublicationError(temporaryPath)
                }
                await unlink(temporaryPath)
                await syncDirectory(dirname(address.path))
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
        }
    }
}

export function transactState(
    namespace: StateNamespace,
    address: StateAddress,
    options: StateTransactionOptions,
    update: (current: StateRecord | null) => StateRecord | Promise<StateRecord>,
): Promise<StateResult<StateRecord>>
export function transactState<T>(
    namespace: StateNamespace,
    address: StateAddress,
    options: StateTransactionOptions,
    update: (
        current: StateRecord | null,
    ) => StateRecord | StateTransactionAbort<T> | Promise<StateRecord | StateTransactionAbort<T>>,
): Promise<StateResult<StateRecord> | StateTransactionAbort<T>>
export function transactState(
    namespace: BootstrapStateNamespace,
    address: BootstrapStateAddress,
    options: StateTransactionOptions,
    update: (current: BootstrapStateRecord | null) => BootstrapStateRecord | Promise<BootstrapStateRecord>,
): Promise<StateResult<BootstrapStateRecord>>
export function transactState<T>(
    namespace: BootstrapStateNamespace,
    address: BootstrapStateAddress,
    options: StateTransactionOptions,
    update: (current: BootstrapStateRecord | null) => BootstrapStateRecord | StateTransactionAbort<T>
        | Promise<BootstrapStateRecord | StateTransactionAbort<T>>,
): Promise<StateResult<BootstrapStateRecord> | StateTransactionAbort<T>>
export async function transactState<T>(
    namespace: StateNamespace | BootstrapStateNamespace,
    address: StateAddress | BootstrapStateAddress,
    options: StateTransactionOptions,
    update: unknown,
): Promise<StateResult<AnyStateRecord> | StateTransactionAbort<T>> {
    let stableAddress: StateAddress | BootstrapStateAddress
    let stableNamespace: Readonly<{
        root: string
        scope: 'cockpit' | 'bootstrap'
        cockpitRoot?: string
        checkoutRoot?: string
        checkoutId?: CheckoutId
        target?: SurfaceTarget
        paths: Readonly<{ stateLock: string }>
    }>
    let stableOptions: StateTransactionOptions
    try {
        if (typeof update !== 'function') throw new Error('state transaction update is malformed')
        if (address.kind === 'bootstrap') {
            const authenticated = authenticateBootstrapStateNamespace(namespace)
            if (!authenticated) throw new Error('bootstrap namespace is not issued')
            if (Reflect.ownKeys(address).sort().join(',') !== 'checkoutId,checkoutRoot,kind,path,stateRoot,target') {
                throw new Error('bootstrap address shape is not closed')
            }
            stableAddress = Object.freeze({ path: address.path, stateRoot: address.stateRoot,
                checkoutRoot: address.checkoutRoot, kind: 'bootstrap', checkoutId: address.checkoutId, target: address.target })
            stableNamespace = Object.freeze({ root: authenticated.root, scope: 'bootstrap' as const,
                checkoutRoot: authenticated.checkoutRoot, checkoutId: authenticated.checkoutId, target: authenticated.target,
                paths: Object.freeze({ stateLock: authenticated.paths.stateLock }) })
        } else {
            const namespacePaths = (namespace as StateNamespace).paths
            const qualifier = address.qualifier
            stableAddress = Object.freeze({ path: address.path, stateRoot: address.stateRoot, cockpitRoot: address.cockpitRoot,
                kind: address.kind, cockpitId: address.cockpitId, subjectId: address.subjectId, ...(qualifier ? { qualifier } : {}) })
            stableNamespace = Object.freeze({ root: namespace.root, scope: 'cockpit' as const,
                cockpitRoot: (namespace as StateNamespace).cockpitRoot, paths: Object.freeze({ stateLock: namespacePaths.stateLock }) })
        }
        stableOptions = Object.freeze({
            ownerId: options.ownerId,
            contentionTimeoutMs: options.contentionTimeoutMs,
            observeHolder: options.observeHolder,
            beforePublish: options.beforePublish,
            beforeCommit: options.beforeCommit,
            beforeRelease: options.beforeRelease,
            beforeLockMetadata: options.beforeLockMetadata,
        })
    } catch {
        return refusal(
            ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
            'state transaction input could not be read safely',
            'state transaction input',
        )
    }
    const bootstrapTransaction = stableNamespace.scope === 'bootstrap' && stableAddress.kind === 'bootstrap'
    const ordinaryTransaction = stableNamespace.scope === 'cockpit' && stableAddress.kind !== 'bootstrap'
    const identityValid = stableAddress.kind === 'bootstrap'
        ? stableNamespace.scope === 'bootstrap'
            && stableAddress.checkoutRoot === stableNamespace.checkoutRoot
            && stableAddress.checkoutId === stableNamespace.checkoutId
            && stableAddress.target === stableNamespace.target
            && stableNamespace.paths.stateLock === join(stableNamespace.root, 'checkouts', stableAddress.checkoutId, 'locks', 'state.lock')
        : stableNamespace.scope === 'cockpit'
            && stableNamespace.cockpitRoot === join(stableNamespace.root, 'cockpits', stableAddress.cockpitId)
            && stableAddress.cockpitRoot === stableNamespace.cockpitRoot
            && stableNamespace.paths.stateLock === join(stableNamespace.cockpitRoot, 'locks', 'state.lock')
            && stableAddress.kind !== 'claim' && stableAddress.kind !== 'lease'
    if (!isAbsolute(stableNamespace.root) || stableAddress.stateRoot !== stableNamespace.root
        || !(await addressIsSafe(stableAddress))
        || !identityValid || !bootstrapTransaction && !ordinaryTransaction
        || stableOptions.contentionTimeoutMs !== undefined && (
            !Number.isSafeInteger(stableOptions.contentionTimeoutMs)
            || stableOptions.contentionTimeoutMs < 0
            || stableOptions.contentionTimeoutMs > 30_000
        )
    ) {
        return malformed(stableAddress)
    }

    let acquired: Awaited<ReturnType<typeof acquireLock>>
    const deadline = Date.now() + (stableOptions.contentionTimeoutMs ?? 0)
    let backoffMs = 5
    while (true) {
        try {
            acquired = await acquireLock(stableNamespace, stableOptions,
                bootstrapTransaction ? bootstrapHolderIdentity : holderIdentity)
        } catch {
            return refusal(ENVIRONMENT_CODES.STATE_LOCKED, 'state lock could not be acquired safely', stableNamespace.paths.stateLock)
        }
        if (acquired.kind === 'acquired' || acquired.code !== ENVIRONMENT_CODES.STATE_LOCKED) break
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0 || stableOptions.contentionTimeoutMs === undefined) break
        await delay(Math.min(backoffMs, remainingMs))
        backoffMs = Math.min(backoffMs * 2, 50)
    }
    if (acquired.kind !== 'acquired') return acquired

    let result: StateResult<AnyStateRecord> | StateTransactionAbort<T>
    try {
        const currentResult = await readState(stableAddress)
        if (currentResult.kind === 'refusal') {
            result = currentResult
        } else {
            const current = currentResult.kind === 'complete' ? currentResult.value : null
            try {
                const proposed = await (update as (value: AnyStateRecord | null) => AnyStateRecord | StateTransactionAbort<T>
                    | Promise<AnyStateRecord | StateTransactionAbort<T>>)(current)
                if (isStateTransactionAbort(proposed)) {
                    result = proposed as StateTransactionAbort<T>
                } else {
                    const record = validateRecordForAddress(stableAddress, proposed, current)
                    if (!record) {
                        result = malformed(stableAddress)
                    } else {
                        const publication = await publishRecord(
                            stableAddress,
                            record,
                            stableOptions.beforePublish,
                            stableOptions.beforeCommit,
                        )
                        if (isStateTransactionAbort(publication)) {
                            result = publication as StateTransactionAbort<T>
                        } else {
                            result = publication === 'durable'
                                ? { kind: 'complete', value: record }
                                : {
                                      kind: 'indeterminate',
                                      code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
                                      message: 'state bytes were renamed but parent directory durability could not be confirmed',
                                      target: stableAddress.path,
                                      recovery: 'read the record before deciding whether to retry the transaction',
                                      value: record,
                                  }
                        }
                    }
                }
            } catch (error) {
                result = error instanceof TemporaryPublicationError
                    ? refusal(
                          ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                          error.message,
                          error.target,
                          'inspect and remove the preserved temporary path only after proving its ownership',
                      )
                    : malformed(stableAddress)
            }
        }
    } catch {
        result = malformed(stableAddress)
    }
    try {
        await releaseLock(
            stableNamespace.paths.stateLock,
            acquired.ownerBytes,
            stableOptions.beforeRelease,
            stableOptions.beforeLockMetadata,
        )
    } catch (error) {
        const release = error instanceof LockReleaseError ? error : undefined
        if ('kind' in result && (result.kind === 'complete' || result.kind === 'indeterminate')) {
            const publicationRecovery = result.kind === 'indeterminate'
                ? result.recovery
                : 'read the committed record and reconcile its revision before deciding whether to retry the transaction'
            const lockRecovery = release?.recovery
                ?? 'inspect the recorded lock owner before explicit reclamation'
            return issueStatePublication({
                kind: 'indeterminate',
                code: ENVIRONMENT_CODES.STATE_DURABILITY_INDETERMINATE,
                message: result.kind === 'indeterminate'
                    ? `${result.message}; the state lock also could not be released safely`
                    : 'state bytes were committed but the state lock could not be released safely',
                target: stableAddress.path,
                recovery: `${publicationRecovery}; ${lockRecovery}`,
                value: result.value,
            }, stableAddress)
        }
        return refusal(
            ENVIRONMENT_CODES.STATE_LOCKED,
            'state transaction completed but its lock could not be released safely',
            release?.target ?? stableNamespace.paths.stateLock,
            release?.recovery ?? 'inspect the recorded lock owner before explicit reclamation',
        )
    }
    return issueStatePublication(result, stableAddress)
}
