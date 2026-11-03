import { z } from 'zod'
import { lstat, opendir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { platform } from 'node:os'
import { STRUCTURED_INPUT_ENTRY_LIMIT } from '../schema.js'
import {
    hasErrorCode,
    RefusalError,
    ENVIRONMENT_CODES,
    errorCause,
    isCanonicalTimestamp,
    snapshotJson,
    snapshotExecutionPlan,
    snapshotEnvironmentObservation,
    type CheckoutId,
    type CockpitId,
    type EnvironmentCode,
    type EnvironmentDiagnostic,
    type EnvironmentObservation,
    type HolderId,
    type ExecutionStep,
    type ExecutionFence,
    type JsonSnapshot,
    type StackId,
} from './contract.js'
import { authenticatedExecutionOutcome, consumeFencedExecutionTermination, type ExecuteProbeOutcome, type FencedExecutionTermination } from '../environment-exec/execute.js'
import { resolveExecutablePath, type ResolvedExecutable } from './executable.js'
import {
    abortStateTransaction,
    authenticateStateNamespace,
    inspectStateLock,
    parseCoordinationStateEntry,
    readState,
    SERIALIZED_RECORD_BYTE_LIMIT,
    snapshotStateNamespace,
    transactState,
    withStateNamespaceInventory,
    type SkippedStateNamespace,
    type StateNamespace,
    type StateAddress,
    type StateRecord,
    type StateResult,
    type StateTransactionAbort,
    type StateTransactionOptions,
} from './state.js'

const OWNER = 'environment-claims'

export const observationDeclarations = Object.freeze([
    { id: 'claim-state', owner: OWNER, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'not-applicable', reason: 'claims do not exist before the first seed' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.CLAIM_STATE_UNHEALTHY, isIssued: isClaimObservation, issuedAt: observationIssuedAt },
] as const)

const issuedObservations = new WeakMap<object, number>()

function issueObservation(value: EnvironmentObservation): EnvironmentObservation {
    const snapshot = snapshotEnvironmentObservation(value)
    if (!snapshot || snapshot.owner !== OWNER) throw new RefusalError('claim observation is malformed')
    issuedObservations.set(snapshot, Date.now())
    return snapshot
}

export function isClaimObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedObservations.has(value)
}

function observationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedObservations.get(value) : undefined
}

export async function observeClaimState(input: { readonly namespace: StateNamespace; readonly stackId: StackId; readonly observedAt: string }): Promise<EnvironmentObservation> {
    const namespace = snapshotStateNamespace(input.namespace)
    if (!namespace || !/^stack:[a-f0-9]{64}$/.test(input.stackId) || !isCanonicalTimestamp(input.observedAt)) {
        throw new RefusalError('claim observation input is malformed')
    }
    const inventory = await readActiveStackInventory(namespace)
    const refusal = inventory.kind === 'refusal' ? inventory.diagnostics[0] : undefined
    return issueObservation({
        code: ENVIRONMENT_CODES.CLAIM_STATE_UNHEALTHY,
        owner: OWNER,
        stackId: input.stackId,
        source: namespace.paths.coordination(input.stackId).path,
        observed: refusal
            ? { state: 'failed', reason: refusal.message, observedAt: input.observedAt }
            : { state: 'available', value: true, observedAt: input.observedAt },
        expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'environment' },
        freshness: { state: 'current' },
        remedy: 'repair or release malformed coordination state',
    })
}

const holderIdentity = /^holder:[a-f0-9]{64}:session$/
const checkoutIdentity = /^checkout:[a-f0-9]{64}$/
const stackIdentity = /^stack:[a-f0-9]{64}$/
const sha256Identity = /^[a-f0-9]{64}$/

const ClaimHolderSchema = z.object({
    holderId: z.string().regex(holderIdentity),
    checkoutId: z.string().regex(checkoutIdentity),
    claimedAt: z.string().refine(isCanonicalTimestamp),
    pid: z.number().int().positive().max(2_147_483_647).optional(),
    processStart: z.string().refine(isProcessStart).optional(),
}).strict().refine((holder) => holder.processStart === undefined || holder.pid !== undefined)

const PortLeaseRecordSchema = z.object({
    offset: z.number().int().nonnegative().safe(),
    ports: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.number().int().min(1).max(65535))
        .refine((ports) => Object.keys(ports).length > 0)
        .refine((ports) => new Set(Object.values(ports)).size === Object.keys(ports).length),
    released: z.boolean(),
    declaration: z.object({
        step: z.number().int().positive().safe(),
        count: z.number().int().positive().safe(),
        bases: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.number().int().min(1).max(65535))
            .refine((bases) => Object.keys(bases).length > 0)
            .refine((bases) => new Set(Object.values(bases)).size === Object.keys(bases).length),
    }).strict(),
}).strict().superRefine((lease, context) => {
    const portKeys = Object.keys(lease.ports).sort()
    const baseKeys = Object.keys(lease.declaration.bases).sort()
    const candidate = lease.offset % lease.declaration.step === 0
        && lease.offset / lease.declaration.step < lease.declaration.count
    const derived = baseKeys.every((key) => lease.ports[key] === lease.declaration.bases[key]! + lease.offset)
    if (!candidate || portKeys.join('\0') !== baseKeys.join('\0') || !derived) {
        context.addIssue({ code: 'custom', message: 'lease does not match its declaration' })
    }
})

const DrainAttemptSchema = z.object({
    attemptId: z.string().regex(sha256Identity),
    reservationId: z.string().regex(sha256Identity),
    purpose: z.enum(['sleep', 'down', 'reset']),
    targetIds: z.array(z.string().min(1)).min(1).max(STRUCTURED_INPUT_ENTRY_LIMIT),
    generation: z.string().regex(sha256Identity),
    actionIndex: z.number().int().nonnegative().safe(),
    currentTarget: z.string().min(1),
    currentStage: z.enum(['runtime-stop', 'reclaim']),
    committedRevision: z.number().int().positive().safe(),
    committedAt: z.string().refine(isCanonicalTimestamp),
    validThrough: z.string().refine(isCanonicalTimestamp),
    status: z.enum(['active', 'failed']),
    failedRevision: z.number().int().positive().safe().nullable(),
    failedAt: z.string().refine(isCanonicalTimestamp).nullable(),
}).strict().superRefine((attempt, context) => {
    if (new Set(attempt.targetIds).size !== attempt.targetIds.length
        || attempt.targetIds.some((target, index) => Buffer.byteLength(target, 'utf8') > 512
            || target.includes('\0') || index > 0 && attempt.targetIds[index - 1]! >= target)
        || Buffer.byteLength(attempt.currentTarget, 'utf8') > 512 || attempt.currentTarget.includes('\0')
        || Date.parse(attempt.validThrough) <= Date.parse(attempt.committedAt)
        || attempt.status === 'active' && (attempt.failedRevision !== null || attempt.failedAt !== null)
        || attempt.status === 'failed' && (attempt.failedRevision !== attempt.committedRevision + 1
            || attempt.failedAt === null || Date.parse(attempt.failedAt) < Date.parse(attempt.committedAt))) {
        context.addIssue({ code: 'custom', message: 'drain attempt targets are not canonical' })
    }
})

function canonicalJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalJsonValue)
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([key, item]) => [key, canonicalJsonValue(item)]))
    }
    return value
}

function isCanonicalJson(body: string): boolean {
    try {
        return JSON.stringify(canonicalJsonValue(JSON.parse(body))) === body
    } catch {
        // Unparseable JSON is simply not canonical.
        return false
    }
}

const DrainTargetCommitmentSchema = z.object({
    format: z.literal('cockpit-reclaim-target/v1'),
    sha256: z.string().regex(sha256Identity),
    body: z.string().min(2).max(32_768),
}).strict().superRefine((commitment, context) => {
    if (Buffer.byteLength(commitment.body, 'utf8') > 32_768
        || createHash('sha256').update(commitment.body).digest('hex') !== commitment.sha256
        || !isCanonicalJson(commitment.body)) {
        context.addIssue({ code: 'custom', message: 'drain target commitment is malformed' })
    }
})

const DrainActionSchema = z.discriminatedUnion('stage', [
    z.object({
        stage: z.literal('runtime-stop'),
        targetId: z.string().min(1),
        validForMs: z.number().int().min(1).max(300_000).safe(),
    }).strict(),
    z.object({
        stage: z.literal('reclaim'),
        targetId: z.string().min(1),
        validForMs: z.number().int().min(1).max(300_000).safe(),
        targetCommitment: DrainTargetCommitmentSchema,
    }).strict(),
])

const DrainReservationSchema = z.object({
    purpose: z.enum(['sleep', 'down', 'reset']),
    stackId: z.string().regex(stackIdentity),
    holderId: z.string().regex(holderIdentity),
    requesterId: z.string().regex(holderIdentity),
    configSha256: z.string().regex(sha256Identity),
    planDigest: z.string().regex(sha256Identity),
    operationBasis: z.string().regex(sha256Identity),
    generation: z.string().regex(sha256Identity),
    targetIds: z.array(z.string().min(1)).min(1).max(STRUCTURED_INPUT_ENTRY_LIMIT),
    actions: z.array(DrainActionSchema).min(1).max(STRUCTURED_INPUT_ENTRY_LIMIT),
    expectedCoordinationRevision: z.number().int().nonnegative().safe(),
    coordinationRevision: z.number().int().positive().safe(),
    completedActionCount: z.number().int().nonnegative().safe(),
    progressRevision: z.number().int().positive().safe(),
    reservedAt: z.string().refine(isCanonicalTimestamp),
    reservationId: z.string().regex(sha256Identity),
    attempt: DrainAttemptSchema.nullable().optional().default(null),
}).strict().superRefine((value, context) => {
    if (value.coordinationRevision !== value.expectedCoordinationRevision + 1
        || value.attempt !== null && (
            value.attempt.reservationId !== value.reservationId
            || value.attempt.purpose !== value.purpose
            || value.attempt.generation !== value.generation
            || !sameTargets(value.attempt.targetIds, value.targetIds)
            || value.attempt.committedRevision <= value.progressRevision
            || (value.attempt.committedRevision - value.progressRevision) % 2 !== 1
            || Date.parse(value.attempt.committedAt) < Date.parse(value.reservedAt)
            || value.attempt.actionIndex !== value.completedActionCount
            || value.actions[value.completedActionCount]?.stage !== value.attempt.currentStage
            || value.actions[value.completedActionCount]?.targetId !== value.attempt.currentTarget
            || Date.parse(value.attempt.validThrough) - Date.parse(value.attempt.committedAt) !== value.actions[value.completedActionCount]?.validForMs
        ) || value.generation === value.reservationId
        || value.completedActionCount >= value.actions.length
        || value.progressRevision < value.coordinationRevision
        || new Set(value.targetIds).size !== value.targetIds.length
        || value.targetIds.some((target, index) => Buffer.byteLength(target, 'utf8') > 512
            || target.includes('\0') || index > 0 && value.targetIds[index - 1]! >= target)
        || value.actions[0]?.stage !== 'runtime-stop' || value.actions[0]?.targetId !== value.stackId
        || value.actions.slice(1).some((action, index) => action.stage !== 'reclaim'
            || action.targetId !== value.targetIds.filter((target) => target !== value.stackId)[index])
        || value.actions.length !== value.targetIds.length
        || !sameTargets([...value.actions.map(({ targetId }) => targetId)].sort(), value.targetIds)
        || value.purpose === 'sleep' && value.actions.length !== 1) {
        context.addIssue({ code: 'custom', message: 'drain reservation chronology is inconsistent' })
    }
})

const CoordinationValueSchema = z.object({
    holders: z.array(ClaimHolderSchema).max(STRUCTURED_INPUT_ENTRY_LIMIT),
    lease: PortLeaseRecordSchema.nullable(),
    lastReleasedHolder: z.string().regex(holderIdentity).nullable().optional().default(null),
    drain: DrainReservationSchema.nullable().optional().default(null),
}).strict().superRefine((value, context) => {
    const holderIds = value.holders.map(({ holderId }) => holderId)
    if (
        new Set(holderIds).size !== holderIds.length
        || value.lastReleasedHolder !== null && holderIds.includes(value.lastReleasedHolder)
        || value.holders.length > 0 && (value.lease === null || value.lease.released)
        || value.holders.length === 0 && value.lease !== null && !value.lease.released && value.lastReleasedHolder === null
        || value.drain !== null && (
            value.holders.length !== 1
            || value.lease === null
            || value.lease.released
            || value.drain.holderId !== value.drain.requesterId
            || value.holders[0]?.holderId !== value.drain.holderId
            || !holderIds.includes(value.drain.holderId)
            || !holderIds.includes(value.drain.requesterId)
        )
    ) {
        context.addIssue({ code: 'custom', message: 'coordination invariants are inconsistent' })
    }
})

export interface ClaimHolder {
    readonly holderId: HolderId
    readonly checkoutId: CheckoutId
    readonly claimedAt: string
    readonly pid?: number
    // The holding process's start identity (see `observeProcessStart`). Present only for a `cockpit
    // session` wrapper, whose hold ends with its process; the plain CLI's hold outlives every command.
    readonly processStart?: string
}

export interface PortLeaseRecord {
    readonly offset: number
    readonly ports: Readonly<Record<string, number>>
    readonly released: boolean
    readonly declaration: {
        readonly step: number
        readonly count: number
        readonly bases: Readonly<Record<string, number>>
    }
}

export interface CoordinationRecord {
    readonly holders: readonly ClaimHolder[]
    readonly lease: PortLeaseRecord | null
    readonly lastReleasedHolder: HolderId | null
    readonly drain?: DrainReservation | null
}

export type DrainPurpose = 'sleep' | 'down' | 'reset'

export type DrainAction =
    | { readonly stage: 'runtime-stop'; readonly targetId: string; readonly validForMs: number }
    | { readonly stage: 'reclaim'; readonly targetId: string; readonly validForMs: number; readonly targetCommitment: DrainTargetCommitment }

export interface DrainTargetCommitment {
    readonly format: 'cockpit-reclaim-target/v1'
    readonly sha256: string
    readonly body: string
}

export interface DrainReservationRequest {
    readonly purpose: DrainPurpose
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly requesterId: HolderId
    readonly configSha256: string
    readonly planDigest: string
    readonly operationBasis: string
    readonly generation: string
    readonly targetIds: readonly string[]
    readonly actions: readonly DrainAction[]
    readonly expectedCoordinationRevision: number
}

export interface DrainReservation extends DrainReservationRequest {
    readonly coordinationRevision: number
    readonly reservedAt: string
    readonly reservationId: string
    readonly completedActionCount: number
    readonly progressRevision: number
    readonly attempt: DrainAttempt | null
}

export interface DrainAttempt {
    readonly attemptId: string
    readonly reservationId: string
    readonly purpose: DrainPurpose
    readonly targetIds: readonly string[]
    readonly generation: string
    readonly actionIndex: number
    readonly currentTarget: string
    readonly currentStage: DrainAction['stage']
    readonly committedRevision: number
    readonly committedAt: string
    readonly validThrough: string
    readonly status: 'active' | 'failed'
    readonly failedRevision: number | null
    readonly failedAt: string | null
}

declare const drainReservationAuthorityBrand: unique symbol
export interface DrainReservationAuthority {
    readonly [drainReservationAuthorityBrand]: true
    readonly reservation: DrainReservation
}

declare const sleepDrainRecoveryAuthorityBrand: unique symbol
export interface SleepDrainRecoveryAuthority {
    readonly [sleepDrainRecoveryAuthorityBrand]: true
}

declare const drainAttemptAuthorityBrand: unique symbol
export interface DrainAttemptAuthority {
    readonly [drainAttemptAuthorityBrand]: true
    readonly reservation: DrainReservation
    readonly attempt: DrainAttempt
}

declare const failedReclaimRecoveryBrand: unique symbol
export interface FailedReclaimRecoveryAuthority {
    readonly [failedReclaimRecoveryBrand]: true
}

export interface FailedReclaimRecoveryTarget {
    readonly targetId: string
    readonly targetCommitment: DrainTargetCommitment
}

export interface FailedReclaimRecovery {
    readonly purpose: 'down' | 'reset'
    readonly stackId: StackId
    readonly configSha256: string
    readonly planDigest: string
    readonly freshAfter: string
    readonly completed: readonly FailedReclaimRecoveryTarget[]
    readonly current: FailedReclaimRecoveryTarget
    readonly pending: readonly FailedReclaimRecoveryTarget[]
}

declare const drainAttemptCandidateBrand: unique symbol
export interface DrainAttemptCandidate {
    readonly [drainAttemptCandidateBrand]: true
    readonly reservation: DrainReservation
    readonly attempt: DrainAttempt
}

declare const drainAttemptSuccessAuthorityBrand: unique symbol
interface DrainAttemptSuccessAuthority {
    readonly [drainAttemptSuccessAuthorityBrand]: true
}

declare const drainAttemptFailureAuthorityBrand: unique symbol
interface DrainAttemptFailureAuthority {
    readonly [drainAttemptFailureAuthorityBrand]: true
}

interface DrainAttemptPermit<Success extends RuntimeStopped | ReclaimCompleted> {
    readonly reservation: DrainReservation
    readonly attempt: DrainAttempt
    readonly provenance: DrainAttemptProvenance
    readonly sealSuccess: (success: Success) => DrainAttemptSuccessAuthority | undefined
    readonly sealFailure: (failure: DrainAttemptFailure) => DrainAttemptFailureAuthority | undefined
}

declare const drainProgressAuthorityBrand: unique symbol
interface DrainProgressAuthority {
    readonly [drainProgressAuthorityBrand]: true
}

declare const runtimeDrainExecutionAuthorityBrand: unique symbol
export interface RuntimeDrainExecutionAuthority { readonly [runtimeDrainExecutionAuthorityBrand]: true }
declare const reclaimDrainExecutionAuthorityBrand: unique symbol
export interface ReclaimDrainExecutionAuthority { readonly [reclaimDrainExecutionAuthorityBrand]: true }

declare const drainOutcomeAuthorityBrand: unique symbol
export interface DrainOutcomeAuthority {
    readonly [drainOutcomeAuthorityBrand]: true
}

interface ReclaimAttemptPermit extends DrainAttemptPermit<ReclaimCompleted> {
    readonly progressAuthority: DrainProgressAuthority
}

export interface RuntimeStopped {
    readonly purpose: DrainPurpose
    readonly stackId: StackId
    readonly configSha256: string
    readonly planDigest: string
    readonly operationBasis: string
    readonly coordinationRevision: number
    readonly reservationId: string
    readonly reservedAt: string
    readonly generation: string
    readonly attemptId: string
    readonly attemptRevision: number
    readonly attemptCommittedAt: string
    readonly validThrough: string
    readonly actionIndex: number
    readonly currentTarget: string
    readonly currentStage: DrainAction['stage']
    readonly observedAt: string
}

export interface ReclaimCompleted extends RuntimeStopped {
    readonly remainingTargetIds: readonly string[]
}

const drainAuthorities = new WeakSet<object>()
const drainAuthorityRecords = new WeakMap<object, string>()
const drainAuthorityAddresses = new WeakMap<object, StateAddress>()
const drainAuthorityEpochs = new Map<string, string>()
interface SleepDrainRecoveryRecord {
    readonly namespace: StateNamespace
    readonly address: StateAddress
    readonly recordFingerprint: string
    readonly reservation: DrainReservation
}
const sleepDrainRecoveries = new WeakMap<object, SleepDrainRecoveryRecord>()
interface DrainAttemptProvenance {
    readonly kind: 'coordination'
    readonly cockpitId: CockpitId
    readonly subjectId: string
    readonly address: StateAddress
}

const drainAttemptAuthorities = new WeakMap<object, {
    readonly reservation: DrainReservation
    readonly attempt: DrainAttempt
    readonly provenance: DrainAttemptProvenance
}>()
const failedReclaimRecoveries = new WeakMap<object, FailedReclaimRecovery>()
const drainAttemptCandidates = new WeakMap<object, { readonly authority: object; readonly reservation: DrainReservation; readonly attempt: DrainAttempt }>()
const drainAttemptSuccessAuthorities = new WeakMap<object, {
    readonly reservation: DrainReservation
    readonly fact: RuntimeStopped | ReclaimCompleted
    readonly provenance: DrainAttemptProvenance
}>()
const drainAttemptFailureAuthorities = new WeakMap<object, {
    readonly reservation: DrainReservation
    readonly fact: DrainAttemptFailure
    readonly provenance: DrainAttemptProvenance
}>()
const drainProgressAuthorities = new WeakMap<object, {
    readonly planningRecord: StateRecord
    readonly reservation: DrainReservation
    readonly attempt: DrainAttempt
}>()
const drainFailureProgressAuthorities = new WeakMap<object, {
    readonly planningRecord: StateRecord
    readonly reservation: DrainReservation
    readonly attempt: DrainAttempt
    readonly failure: DrainAttemptFailure
}>()
const drainExecutions = new WeakMap<object,
    | { readonly kind: 'runtime-stop'; readonly permit: DrainAttemptPermit<RuntimeStopped>; readonly fence: ExecutionFence }
    | { readonly kind: 'reclaim'; readonly permit: ReclaimAttemptPermit; readonly continuation: object; readonly fence: ExecutionFence }>()
const drainOutcomes = new WeakMap<object,
    | { readonly kind: 'success'; readonly authority: DrainAttemptSuccessAuthority; readonly provenance: DrainAttemptProvenance }
    | { readonly kind: 'failure'; readonly authority: DrainAttemptFailureAuthority; readonly provenance: DrainAttemptProvenance }>()

const drainContinuationEvidence = new WeakMap<object,
    | { readonly kind: 'progress'; readonly authority: DrainProgressAuthority }
    | { readonly kind: 'failure'; readonly authority: DrainAttemptFailureAuthority }>()

type ClaimMutationRefusal = {
    readonly kind: 'refusal'
    readonly diagnostics: readonly EnvironmentDiagnostic[]
}

export type ReleaseClaimResult =
    | {
          readonly kind: 'complete'
          readonly change: 'released' | 'unchanged'
          readonly decision: 'stop' | 'retain'
          readonly remaining: readonly HolderId[]
      }
    | ClaimMutationRefusal

export interface HolderProcess {
    readonly pid?: number
    readonly processStart?: string
}

export type ProcessStartObservation =
    | { readonly state: 'absent' }
    | { readonly state: 'present'; readonly start: string }
    | { readonly state: 'unknown'; readonly reason: string }

/** What observing a process reads from this machine; production binds it with `processHost`. */
export interface ProcessHost {
    readonly platform: NodeJS.Platform
    /** Whether the pid exists, by signal 0; anything short of proof of absence is `live` or `unavailable`. */
    readonly presence: (pid: number) => Promise<'live' | 'absent' | 'unavailable'>
    /** `ps -o lstart=` for the pid under a fixed locale and zone. */
    readonly psStart: (pid: number) => Promise<{ readonly kind: 'complete'; readonly text: string } | { readonly kind: 'failed'; readonly reason: string }>
    /** A file's UTF-8 text; rejects with the read's errno error. */
    readonly readFile: (path: string) => Promise<string>
}

const PS_START = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LSTART_START = /^lstart:(.+)$/
const PROC_START = /^proc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$/

/** A start identity as `observeProcessStart` reports it: `lstart:<timestamp>` or `proc:<boot id>:<ticks>`. */
export function isProcessStart(value: unknown): value is string {
    return typeof value === 'string' && (PROC_START.test(value) || isCanonicalTimestamp(LSTART_START.exec(value)?.[1]))
}

const startKind = (start: string): string => start.slice(0, start.indexOf(':'))

/**
 * Whether an observation proves gone the process recorded with `processStart`. A gone pid proves it
 * whether or not a start was recorded, since reuse can only make a dead process look alive; a start
 * identity decides only against one read the same way.
 */
export function isProcessGone(processStart: string | undefined, observed: ProcessStartObservation): boolean {
    return observed.state === 'absent' || observed.state === 'present' && processStart !== undefined
        && startKind(observed.start) === startKind(processStart) && observed.start !== processStart
}

// A pid alone does not name a holder: the pid of a killed session is reused, and a reused pid read
// as the session would wedge its stack for as long as the stranger runs. So a session records its
// process's start identity, and a holder is dead when its pid is gone or now belongs to a process
// with another identity. On Linux the identity is the start in clock ticks since boot (field 22 of
// /proc/<pid>/stat) with the boot's ID: ps derives a wall-clock start from the boot time, which moves
// whenever the wall clock is stepped (NTP, a resumed VM), so a running session would read as a
// stranger and lose its hold. macOS records the wall-clock start once, and ps prints it to the
// second under a fixed locale and zone. Each identity names how it was read; anything that cannot
// be confirmed reads as unknown, and unknown is never dead.
export async function observeProcessStart(pid: number, host: ProcessHost): Promise<ProcessStartObservation> {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) return { state: 'unknown', reason: `process id ${pid} is invalid` }
    const presence = await host.presence(pid)
    if (presence === 'absent') return { state: 'absent' }
    if (presence !== 'live') return { state: 'unknown', reason: `the presence of process ${pid} could not be confirmed` }
    return host.platform === 'linux' ? observeProcStart(pid, host) : observeLstart(pid, host)
}

async function observeProcStart(pid: number, host: ProcessHost): Promise<ProcessStartObservation> {
    let stat: string
    try { stat = await host.readFile(`/proc/${pid}/stat`) } catch (error) {
        // Signal 0 just found it, so a missing entry means it exited since, unless this /proc is not
        // this pid namespace's (unmounted in a chroot or sandbox); only a second signal decides.
        if (hasErrorCode(error, 'ENOENT') && await host.presence(pid) === 'absent') return { state: 'absent' }
        return { state: 'unknown', reason: `/proc/${pid}/stat could not be read (${errorCause(error)})` }
    }
    let bootId: string
    try { bootId = (await host.readFile('/proc/sys/kernel/random/boot_id')).trim() } catch (error) {
        return { state: 'unknown', reason: `the boot ID could not be read (${errorCause(error)})` }
    }
    // The command name in parentheses may itself hold spaces and parentheses; the fields after the
    // last `)` start at field 3, so field 22 is the twentieth.
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    if (stat.lastIndexOf(')') === -1 || ticks === undefined || !/^[0-9]{1,20}$/.test(ticks) || !BOOT_ID.test(bootId)) {
        return { state: 'unknown', reason: `/proc reported an unrecognised start for process ${pid}` }
    }
    return { state: 'present', start: `proc:${bootId}:${ticks}` }
}

async function observeLstart(pid: number, host: ProcessHost): Promise<ProcessStartObservation> {
    const started = await host.psStart(pid)
    if (started.kind === 'failed') return { state: 'unknown', reason: started.reason }
    const match = PS_START.exec(started.text.trim())
    if (!match) return { state: 'unknown', reason: `ps reported an unrecognised start time for process ${pid}` }
    const [, month, day, hours, minutes, seconds, year] = match
    const startedAt = new Date(Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day), Number(hours), Number(minutes), Number(seconds)))
    return Number.isNaN(startedAt.getTime()) ? { state: 'unknown', reason: `ps reported an invalid start time for process ${pid}` }
        : { state: 'present', start: `lstart:${startedAt.toISOString()}` }
}

/** The production `ProcessHost`: signal 0 and ps cross the executor, and /proc is read directly. */
export function processHost(execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>): ProcessHost {
    return {
        platform: process.platform,
        presence: async (pid: number) => {
            const node = await resolveExecutablePath(process.execPath)
            if (node.state !== 'available') return 'unavailable' as const
            const answer = await runBoundedProbe(node.value, `process:presence:${pid}`, ['-e', PROCESS_PRESENCE_PROBE, String(pid)], {}, execute)
            return answer === 'live' || answer === 'absent' ? answer : 'unavailable' as const
        },
        psStart: async (pid: number) => {
            let ps: ResolvedExecutable | undefined
            for (const candidate of ['/bin/ps', '/usr/bin/ps']) {
                const resolved = await resolveExecutablePath(candidate)
                if (resolved.state === 'available') { ps = resolved.value; break }
            }
            if (!ps) return { kind: 'failed' as const, reason: 'ps is not installed at /bin/ps or /usr/bin/ps' }
            const text = await runBoundedProbe(ps, `process:start:${pid}`, ['-o', 'lstart=', '-p', String(pid)], { LC_ALL: 'C', TZ: 'UTC0' }, execute)
            return text === undefined ? { kind: 'failed' as const, reason: `ps did not report when process ${pid} started` } : { kind: 'complete' as const, text }
        },
        readFile: (path: string) => readFile(path, 'utf8'),
    }
}

// Reports `live` or `absent` for a pid; twice, so a transient answer reads as `unavailable`.
const PROCESS_PRESENCE_PROBE = "const p=Number(process.argv[1]);const c=()=>{try{process.kill(p,0);return'live'}catch(e){return e&&e.code==='ESRCH'?'absent':'unavailable'}};const a=c(),b=c();process.stdout.write(a===b?a:'unavailable')"

// One short read-only step through the executor; its stdout when it exits 0, otherwise undefined.
async function runBoundedProbe(
    executable: ResolvedExecutable,
    id: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<string | undefined> {
    const step = snapshotExecutionPlan({ steps: [{
        id, argv: [executable.canonicalPath, ...args] as const,
        argv0: executable.invocationPath, cwd: '/', env: { ...env }, timeoutMs: 5_000,
        stdoutLimitBytes: 256, stderrLimitBytes: 1_024, paths: [], ports: [],
        labels: { probe: id }, expected: [],
        consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912,
            argvIndexes: [0], executable: true, executionMode: executable.executionMode }],
        filesystemChecks: [], compensation: [],
    }] })?.steps[0]
    if (!step) return undefined
    const outcome = authenticatedExecutionOutcome(await execute(step), step)
    return outcome?.kind === 'complete' && outcome.execution.exitCode === 0 ? Buffer.from(outcome.stdout).toString('utf8') : undefined
}

function describeHolder(holder: ClaimHolder): string {
    return holder.pid === undefined ? holder.holderId : `${holder.holderId} (process ${holder.pid})`
}

// Names each other holder and how to end it. A dead session's hold is released before this is
// reached, so every holder named here is running, or could not be confirmed gone.
export function liveHolderMessage(holders: readonly ClaimHolder[]): string {
    const pids = holders.flatMap(({ pid }) => pid === undefined ? [] : [pid])
    return `another cockpit session holds this stack (${holders.map(describeHolder).join(', ')}), and down and reset never displace a running session; `
        + `let its command finish${pids.length > 0 ? ` or stop it with \`kill ${pids.join(' ')}\`` : ''}, then retry`
}

export type ReleaseDeadSessionHoldersResult =
    | {
          readonly kind: 'complete'
          readonly released: readonly ClaimHolder[]
      }
    | ClaimMutationRefusal

// Every probe is a child process; a record may name thousands of holders.
const MAX_CONCURRENT_HOLDER_PROBES = 4

/**
 * Remove the holds of `cockpit session` wrappers whose process is gone. A session killed with
 * SIGKILL, a crash or a closed terminal never runs its closing `sleep`, and its hold then made
 * `down`, `reset` and `sleep` refuse forever while naming a session nobody could end. When every
 * holder is dead, the requesting holder takes the stack over in the same transaction: the stack is
 * still running, and a lease no holder retains reads as a stopped stack whose ports are free.
 */
export async function releaseDeadSessionHolders(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly successor: { readonly holderId: HolderId; readonly checkoutId: CheckoutId } & HolderProcess
    readonly now: string
    readonly observe: (pid: number) => Promise<ProcessStartObservation>
}): Promise<ReleaseDeadSessionHoldersResult> {
    const stored = await readState(input.namespace.paths.coordination(input.stackId))
    if (stored.kind === 'missing') return { kind: 'complete', released: [] }
    if (stored.kind !== 'complete') return stateRefusal(stored)
    const value = decodeCoordinationRecord(stored.value, input.stackId)
    if (!value) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', input.stackId)
    if (isDrainActive(value)) return { kind: 'complete', released: [] }
    const candidates = value.holders.filter((holder) => holder.holderId !== input.successor.holderId && holder.pid !== undefined)
    // Indexed slots keep the verdicts in holder order whatever order the probes finish in.
    const observed: ProcessStartObservation[] = new Array(candidates.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_HOLDER_PROBES, candidates.length) }, async () => {
        while (next < candidates.length) {
            const index = next++
            observed[index] = await input.observe(candidates[index]!.pid!)
        }
    }))
    const dead = candidates.filter((holder, index) => isProcessGone(holder.processStart, observed[index]!))
    if (dead.length === 0) return { kind: 'complete', released: [] }
    let committed: readonly ClaimHolder[] = []
    const result = await transactClaim<ReleaseDeadSessionHoldersResult>(input.namespace, input.stackId, input.successor.holderId, (current) => {
        const latest = decodeCoordinationRecord(current, input.stackId)
        if (!latest) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', input.stackId))
        if (isDrainActive(latest) || latest.lease === null || latest.lease.released) {
            return abortStateTransaction({ kind: 'complete', released: [] })
        }
        // Only a holder still recorded exactly as it was observed is released; one that changed
        // since is someone else's to judge.
        const released = dead.filter((holder) => latest.holders.some((candidate) => candidate.holderId === holder.holderId
            && candidate.claimedAt === holder.claimedAt && candidate.pid === holder.pid
            && candidate.processStart === holder.processStart))
        if (released.length === 0) return abortStateTransaction({ kind: 'complete', released: [] })
        committed = released
        const remaining = latest.holders.filter((holder) => !released.some(({ holderId }) => holderId === holder.holderId))
        const reduced: CoordinationRecord = { ...latest, holders: remaining, lastReleasedHolder: released.at(-1)!.holderId }
        const next = remaining.length > 0 ? reduced : addCoordinationHolder(reduced, input.successor, input.now)?.value
        if (!next) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination holder set cannot accept the successor holder', input.successor.holderId))
        return coordinationStateRecord(input.namespace, input.stackId, current, input.now, next)
    })
    if ('diagnostics' in result || 'released' in result) return result
    if (result.kind !== 'complete') return result.kind === 'missing'
        ? refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'claim transaction returned no record', result.path) : stateRefusal(result)
    return { kind: 'complete', released: committed }
}

export type ActiveStackInventoryResult =
    | { readonly kind: 'complete'; readonly value: readonly { readonly stackId: StackId; readonly record: CoordinationRecord }[] }
    | ClaimMutationRefusal

function diagnostic(
    code: EnvironmentCode,
    message: string,
    target: string,
    fix?: string,
): EnvironmentDiagnostic {
    return { severity: 'error', code, message, target, ...(fix ? { fix } : {}) }
}

function refuse(
    code: EnvironmentCode,
    message: string,
    target: string,
    fix?: string,
): ClaimMutationRefusal {
    return { kind: 'refusal', diagnostics: [diagnostic(code, message, target, fix)] }
}

export async function readActiveStackInventory(
    namespace: StateNamespace,
    options: Pick<StateTransactionOptions, 'observeHolder'> = {},
): Promise<ActiveStackInventoryResult> {
    return readCoordinationInventory(namespace, options)
}

async function readCoordinationInventory(
    namespace: StateNamespace,
    options: Pick<StateTransactionOptions, 'observeHolder'>,
    budget?: { entries: number; bytes: number },
): Promise<ActiveStackInventoryResult> {
    const ownedNamespace = snapshotStateNamespace(namespace)
    if (!ownedNamespace) return refuse(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'state namespace is malformed', 'state namespace')
    namespace = ownedNamespace
    const directory = dirname(namespace.paths.coordination(`stack:${'0'.repeat(64)}` as StackId).path)
    let inspected = false
    try {
        const before = await lstat(directory, { bigint: true })
        inspected = true
        if (!before.isDirectory() || before.isSymbolicLink()) {
            return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store is not a safe directory', directory)
        }
        const names: string[] = []
        const handle = await opendir(directory)
        try {
            for await (const entry of handle) {
                if (names.length >= STRUCTURED_INPUT_ENTRY_LIMIT) {
                    return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store exceeds its entry boundary', directory)
                }
                if (budget && ++budget.entries > STRUCTURED_INPUT_ENTRY_LIMIT) {
                    return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination inventory exceeds its aggregate entry boundary', directory)
                }
                names.push(entry.name)
            }
        } finally { await handle.close().catch(() => undefined) }
        const records: { stackId: StackId; record: CoordinationRecord }[] = []
        const observedRecords = new Map<StackId, StateRecord>()
        for (const name of names.sort()) {
            if (budget) {
                const path = join(directory, name)
                const status = await lstat(path)
                if (!status.isFile() || status.isSymbolicLink() || !Number.isSafeInteger(status.size)
                    || (budget.bytes += status.size) > SERIALIZED_RECORD_BYTE_LIMIT) {
                    return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination inventory exceeds its aggregate byte boundary or contains an unsafe entry', path)
                }
            }
            const entry = parseCoordinationStateEntry(name)
            if (entry?.kind === 'temporary') {
                const lock = await inspectStateLock(namespace, options.observeHolder)
                const residue = join(directory, name)
                const [currentResidue, afterLockInspection] = await Promise.all([
                    lstat(residue),
                    lstat(directory, { bigint: true }),
                ])
                if (!currentResidue.isFile() || currentResidue.isSymbolicLink()
                    || !afterLockInspection.isDirectory() || afterLockInspection.isSymbolicLink()
                    || afterLockInspection.dev !== before.dev || afterLockInspection.ino !== before.ino
                    || afterLockInspection.mtimeNs !== before.mtimeNs || afterLockInspection.ctimeNs !== before.ctimeNs) {
                    return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store changed during observation', directory)
                }
                if (lock.holderState === 'live') {
                    return refuse(
                        ENVIRONMENT_CODES.STATE_LOCKED,
                        'coordination publication is in progress',
                        residue,
                        'retry after the coordination transaction completes',
                    )
                }
                if (lock.holderState === 'unknown') {
                    return refuse(
                        ENVIRONMENT_CODES.STATE_LOCKED,
                        'coordination publication ownership is unverified',
                        residue,
                        lock.recovery,
                    )
                }
                return refuse(
                    ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                    'coordination store contains an orphaned unverified publication residue',
                    residue,
                    `${lock.description}; ${lock.recovery}; remove the residue only after proving that no writer owns it`,
                )
            }
            if (entry?.kind === 'executor') {
                const path = join(directory, name)
                const marker = await lstat(path, { bigint: true })
                const stored = await readState(namespace.paths.coordination(entry.stackId))
                const record = stored.kind === 'complete' ? decodeCoordinationRecord(stored.value, entry.stackId) : undefined
                const after = await lstat(path, { bigint: true })
                // The executor owns marker contents and repair. Inventory only admits a safe
                // auxiliary file for the exact independently recorded drain attempt.
                if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1n
                    || marker.uid !== BigInt(process.getuid?.() ?? -1) || (marker.mode & 0o022n) !== 0n
                    || marker.size > BigInt(SERIALIZED_RECORD_BYTE_LIMIT)
                    || !after.isFile() || after.dev !== marker.dev || after.ino !== marker.ino
                    || after.size !== marker.size || after.mtimeNs !== marker.mtimeNs || after.ctimeNs !== marker.ctimeNs
                    || after.uid !== marker.uid || after.mode !== marker.mode || after.nlink !== marker.nlink
                    || !record?.drain?.attempt || record.drain.attempt.attemptId !== entry.attemptId
                    || stored.kind !== 'complete'
                    || exactRecordFingerprint(stored.value) !== exactRecordFingerprint(observedRecords.get(entry.stackId))) {
                    return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
                        'coordination executor marker is unsafe or does not match its current drain attempt', path)
                }
                continue
            }
            if (!entry || entry.kind !== 'record') {
                return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store contains an unexpected entry', join(directory, name))
            }
            const stackId = entry.stackId
            const result = await readState(namespace.paths.coordination(stackId))
            if (result.kind !== 'complete') {
                return refuse(
                    result.kind === 'missing' ? ENVIRONMENT_CODES.STATE_RECORD_MALFORMED : result.code,
                    result.kind === 'missing' ? 'coordination record disappeared during observation' : result.message,
                    result.kind === 'missing' ? result.path : result.target,
                )
            }
            const record = decodeCoordinationRecord(result.value, stackId)
            if (!record) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', result.value.subjectId)
            observedRecords.set(stackId, result.value)
            if (record.holders.length > 0 || record.lease !== null && !record.lease.released) records.push({ stackId, record })
        }
        const after = await lstat(directory, { bigint: true })
        if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
            || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store changed during observation', directory)
        }
        return { kind: 'complete', value: records }
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return inspected
                ? refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store changed during observation', directory)
                : { kind: 'complete', value: [] }
        }
        return refuse(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'coordination store could not be inspected', directory)
    }
}

// Port leases are machine-wide, so this reads every cockpit's coordination records. `skipped` names
// each other cockpit's namespace this version cannot read; its leases are not seen, and the caller
// reports it so a person can remove it. The caller's own namespace, a contended lock and the
// shared read bounds still refuse.
export async function readRootPortInventory(
    namespace: StateNamespace,
    options: Pick<StateTransactionOptions, 'observeHolder'> = {},
): Promise<
    | { readonly kind: 'complete'; readonly value: readonly { cockpitId: CockpitId; stackId: StackId; record: CoordinationRecord }[]
        readonly skipped: readonly SkippedStateNamespace[] }
    | ClaimMutationRefusal
> {
    const result = await withStateNamespaceInventory(namespace, async (namespaces, unreadable) => {
        const records: { cockpitId: CockpitId; stackId: StackId; record: CoordinationRecord }[] = []
        const skipped = [...unreadable]
        const budget = { entries: namespaces.length, bytes: 0 }
        for (const candidate of namespaces) {
            const inventory = await readCoordinationInventory(candidate, options, budget)
            if (inventory.kind !== 'complete') {
                const diagnostic = inventory.diagnostics[0]
                if (candidate.cockpitRoot === namespace.cockpitRoot || diagnostic?.code === ENVIRONMENT_CODES.STATE_LOCKED
                    || budget.entries > STRUCTURED_INPUT_ENTRY_LIMIT || budget.bytes > SERIALIZED_RECORD_BYTE_LIMIT) return inventory
                skipped.push({ path: candidate.cockpitRoot, reason: diagnostic?.message ?? 'coordination records are unreadable' })
                continue
            }
            const cockpitId = candidate.paths.coordination(`stack:${'0'.repeat(64)}` as StackId).cockpitId
            records.push(...inventory.value.map((record) => ({ cockpitId, ...record })))
        }
        return { kind: 'complete' as const, value: records, skipped }
    })
    if (result.kind === 'complete') return result.value
    if (result.kind === 'missing') return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'state namespace inventory disappeared during observation', result.path)
    return refuse(result.code, result.message, result.target, result.recovery)
}

function validIdentity(value: string, pattern: RegExp): boolean {
    return typeof value === 'string' && pattern.test(value)
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
    try {
        const actual = Reflect.ownKeys(Object.getOwnPropertyDescriptors(value))
        return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key))
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return false
    }
}

export function decodeCoordinationRecord(record: StateRecord | null, stackId: StackId): CoordinationRecord | undefined {
    if (record === null) return { holders: [], lease: null, lastReleasedHolder: null, drain: null }
    if (record.kind !== 'coordination' || record.subjectId !== stackId) return undefined
    const parsed = CoordinationValueSchema.safeParse(record.value)
    if (!parsed.success) return undefined
    if (parsed.data.drain !== null && parsed.data.drain.stackId !== stackId) return undefined
    if (parsed.data.drain !== null) {
        const boundaryRevision = parsed.data.drain.attempt?.status === 'failed'
            ? parsed.data.drain.attempt.failedRevision
            : parsed.data.drain.attempt?.committedRevision ?? parsed.data.drain.progressRevision
        if (record.revision !== boundaryRevision) return undefined
    }
    return {
        holders: parsed.data.holders
            .map((holder) => ({
                holderId: holder.holderId as HolderId,
                checkoutId: holder.checkoutId as CheckoutId,
                claimedAt: holder.claimedAt,
                ...(holder.pid === undefined ? {} : { pid: holder.pid }),
                ...(holder.processStart === undefined ? {} : { processStart: holder.processStart }),
            }))
            .sort((left, right) => left.holderId < right.holderId ? -1 : left.holderId > right.holderId ? 1 : 0),
        lease: parsed.data.lease === null ? null : {
            offset: parsed.data.lease.offset,
            ports: { ...parsed.data.lease.ports },
            released: parsed.data.lease.released,
            declaration: {
                step: parsed.data.lease.declaration.step,
                count: parsed.data.lease.declaration.count,
                bases: { ...parsed.data.lease.declaration.bases },
            },
        },
        lastReleasedHolder: parsed.data.lastReleasedHolder as HolderId | null,
        drain: parsed.data.drain === null ? null : snapshotDrainReservation({
            ...parsed.data.drain,
            stackId: parsed.data.drain.stackId as StackId,
            holderId: parsed.data.drain.holderId as HolderId,
            requesterId: parsed.data.drain.requesterId as HolderId,
        }),
    }
}

export function addCoordinationHolder(
    value: CoordinationRecord,
    holder: { readonly holderId: HolderId; readonly checkoutId: CheckoutId } & HolderProcess,
    now: string,
): { readonly value: CoordinationRecord; readonly change: 'acquired' | 'unchanged' } | undefined {
    const existing = value.holders.find((candidate) => candidate.holderId === holder.holderId)
    if (existing && existing.checkoutId !== holder.checkoutId) return undefined
    if (existing) return { value, change: 'unchanged' }
    return {
        value: {
            ...value,
            holders: [...value.holders, { ...holder, claimedAt: now }]
                .sort((left, right) => left.holderId < right.holderId ? -1 : left.holderId > right.holderId ? 1 : 0),
            lastReleasedHolder: value.lastReleasedHolder === holder.holderId ? null : value.lastReleasedHolder,
        },
        change: 'acquired',
    }
}

export function removeExactCoordinationHolder(
    value: CoordinationRecord,
    holderId: HolderId,
): CoordinationRecord | undefined {
    try {
        if (!holderIdentity.test(holderId) || value.lease === null || value.lease.released
            || value.drain != null) return undefined
        const holders = value.holders.filter((holder) => holder.holderId !== holderId)
        if (holders.length !== value.holders.length - 1) return undefined
        return {
            ...value,
            holders,
            lastReleasedHolder: holderId,
        }
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

export function coordinationStateRecord(
    namespace: StateNamespace,
    stackId: StackId,
    current: StateRecord | null,
    now: string,
    value: CoordinationRecord,
): StateRecord {
    return {
        format: 'cockpit-state/v1',
        kind: 'coordination',
        cockpitId: namespace.paths.coordination(stackId).cockpitId,
        subjectId: stackId,
        revision: current === null ? 0 : current.revision + 1,
        updatedAt: now,
        value: {
            holders: value.holders.map((holder) => ({ ...holder })),
            lease: value.lease === null ? null : {
                ...value.lease,
                ports: { ...value.lease.ports },
                declaration: { ...value.lease.declaration, bases: { ...value.lease.declaration.bases } },
            },
            lastReleasedHolder: value.lastReleasedHolder,
            drain: value.drain == null ? null : {
                ...value.drain,
                targetIds: [...value.drain.targetIds],
                actions: value.drain.actions.map((action) => ({
                    stage: action.stage,
                    targetId: action.targetId,
                    validForMs: action.validForMs,
                    ...(action.stage === 'runtime-stop' ? {} : {
                        targetCommitment: { ...action.targetCommitment },
                    }),
                })),
                attempt: value.drain.attempt === null ? null : {
                    ...value.drain.attempt,
                    targetIds: [...value.drain.attempt.targetIds],
                },
            },
        },
    }
}

function snapshotDrainRequest(value: unknown): DrainReservationRequest | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const keys = ['purpose', 'stackId', 'holderId', 'requesterId', 'configSha256', 'planDigest', 'operationBasis', 'generation', 'targetIds', 'actions', 'expectedCoordinationRevision']
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const supplied = Reflect.ownKeys(descriptors)
        if (supplied.length !== keys.length || supplied.some((key) => typeof key !== 'string')
            || keys.some((key) => !supplied.includes(key) || !('value' in descriptors[key]!))) return undefined
        const request = Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value])) as unknown as DrainReservationRequest
        const targetIds = snapshotDrainTargets(request.targetIds)
        const actions = snapshotDrainActions(request.actions)
        if ((request.purpose !== 'sleep' && request.purpose !== 'down' && request.purpose !== 'reset')
            || !validIdentity(request.stackId, stackIdentity)
            || !validIdentity(request.holderId, holderIdentity)
            || !validIdentity(request.requesterId, holderIdentity)
            || !sha256Identity.test(request.configSha256)
            || !sha256Identity.test(request.planDigest)
            || !sha256Identity.test(request.operationBasis)
            || !sha256Identity.test(request.generation)
            || !targetIds || !actions || !validDrainActions(request.purpose, request.stackId, targetIds, actions)
            || !Number.isSafeInteger(request.expectedCoordinationRevision)
            || request.expectedCoordinationRevision < 0
            || request.expectedCoordinationRevision >= Number.MAX_SAFE_INTEGER) return undefined
        return {
            purpose: request.purpose, stackId: request.stackId, holderId: request.holderId,
            requesterId: request.requesterId, configSha256: request.configSha256,
            planDigest: request.planDigest, operationBasis: request.operationBasis,
            generation: request.generation, targetIds, actions,
            expectedCoordinationRevision: request.expectedCoordinationRevision,
        }
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

function sameDrainRequest(left: DrainReservation, right: DrainReservationRequest): boolean {
    return left.purpose === right.purpose && left.stackId === right.stackId
        && left.holderId === right.holderId && left.requesterId === right.requesterId
        && left.configSha256 === right.configSha256 && left.planDigest === right.planDigest
        && left.operationBasis === right.operationBasis
        && left.generation === right.generation && sameTargets(left.targetIds, right.targetIds)
        && sameDrainActions(left.actions, right.actions)
        && left.expectedCoordinationRevision === right.expectedCoordinationRevision
}

function sameDrainAttemptBinding(left: DrainAttempt, right: DrainAttempt): boolean {
    return left.attemptId === right.attemptId && left.reservationId === right.reservationId
        && left.purpose === right.purpose && sameTargets(left.targetIds, right.targetIds)
        && left.generation === right.generation && left.actionIndex === right.actionIndex && left.currentTarget === right.currentTarget
        && left.currentStage === right.currentStage && left.committedRevision === right.committedRevision
        && left.committedAt === right.committedAt && left.validThrough === right.validThrough
}

function sameDrainAttempt(left: DrainAttempt, right: DrainAttempt): boolean {
    return sameDrainAttemptBinding(left, right) && left.status === right.status
        && left.failedRevision === right.failedRevision && left.failedAt === right.failedAt
}

function snapshotDrainReservation(reservation: DrainReservation): DrainReservation {
    return {
        ...reservation,
        targetIds: [...reservation.targetIds],
        actions: reservation.actions.map(snapshotDrainAction),
        attempt: reservation.attempt === null ? null : {
            ...reservation.attempt,
            targetIds: [...reservation.attempt.targetIds],
        },
    }
}

function snapshotDrainAction(action: DrainAction): DrainAction {
    return action.stage === 'runtime-stop'
        ? { ...action }
        : { ...action, targetCommitment: { ...action.targetCommitment } }
}

function snapshotDrainTargets(value: unknown): readonly string[] | undefined {
    try {
        if (!Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
        const lengthValue = descriptors.length?.value
        if (typeof lengthValue !== 'number' || !Number.isSafeInteger(lengthValue)
            || lengthValue === 0 || lengthValue > STRUCTURED_INPUT_ENTRY_LIMIT) return undefined
        if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol' || key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key))) return undefined
        const targets = Array.from({ length: lengthValue }, (_, index): string => {
            const property = descriptors[String(index)]
            if (!property || !('value' in property) || typeof property.value !== 'string') throw new RefusalError('invalid target')
            return property.value
        })
        if (new Set(targets).size !== targets.length
            || targets.some((target, index) => target.length === 0 || Buffer.byteLength(target, 'utf8') > 512
                || target.includes('\0') || index > 0 && targets[index - 1]! >= target)) return undefined
        return targets
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

function snapshotDataOnly(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown | undefined {
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
        || typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'object' || depth > 16 || seen.has(value)) return undefined
    try {
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) return undefined
        seen.add(value)
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) return undefined
        if (Array.isArray(value)) {
            const lengthValue = (descriptors as Record<string, PropertyDescriptor>).length?.value
            if (typeof lengthValue !== 'number' || !Number.isSafeInteger(lengthValue)
                || lengthValue < 0 || lengthValue > STRUCTURED_INPUT_ENTRY_LIMIT) return undefined
            const keys = Object.keys(descriptors).filter((key) => key !== 'length')
            if (keys.length !== lengthValue) return undefined
            const result: unknown[] = []
            for (let index = 0; index < lengthValue; index += 1) {
                const descriptor = descriptors[String(index)]
                if (!descriptor || !('value' in descriptor)) return undefined
                const item = snapshotDataOnly(descriptor.value, seen, depth + 1)
                if (item === undefined && descriptor.value !== undefined) return undefined
                result.push(item)
            }
            return result
        }
        const result: Record<string, unknown> = {}
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (!('value' in descriptor)) return undefined
            const item = snapshotDataOnly(descriptor.value, seen, depth + 1)
            if (item === undefined && descriptor.value !== undefined) return undefined
            result[key] = item
        }
        return result
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

function snapshotDrainActions(value: unknown): readonly DrainAction[] | undefined {
    try {
        if (!Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
        const lengthValue = descriptors.length?.value
        if (typeof lengthValue !== 'number' || !Number.isSafeInteger(lengthValue)
            || lengthValue === 0 || lengthValue > STRUCTURED_INPUT_ENTRY_LIMIT) return undefined
        if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol' || key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key))) return undefined
        const actions: DrainAction[] = []
        for (let index = 0; index < lengthValue; index += 1) {
            const item = descriptors[String(index)]
            if (!item || !('value' in item) || !item.value || typeof item.value !== 'object' || Array.isArray(item.value)) return undefined
            const snapshot = snapshotDataOnly(item.value)
            const parsed = DrainActionSchema.safeParse(snapshot)
            if (!parsed.success) return undefined
            actions.push(snapshotDrainAction(parsed.data))
        }
        return actions
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

function sameDrainActions(left: readonly DrainAction[], right: readonly DrainAction[]): boolean {
    return left.length === right.length && left.every((action, index) => action.stage === right[index]?.stage
        && action.targetId === right[index]?.targetId && action.validForMs === right[index]?.validForMs
        && (action.stage === 'runtime-stop' || right[index]?.stage === 'reclaim'
            && JSON.stringify(action.targetCommitment) === JSON.stringify(right[index].targetCommitment)))
}

// Persisting the order prevents callers and executors from choosing destructive work.
function validDrainActions(
    purpose: DrainPurpose,
    stackId: string,
    targetIds: readonly string[],
    actions: readonly DrainAction[],
): boolean {
    const reclaimTargets = targetIds.filter((target) => target !== stackId)
    return actions.length === targetIds.length
        && actions[0]?.stage === 'runtime-stop' && actions[0].targetId === stackId
        && actions.slice(1).every((action, index) => action.stage === 'reclaim' && action.targetId === reclaimTargets[index])
        && sameTargets([...actions.map(({ targetId }) => targetId)].sort(), targetIds)
        && (purpose !== 'sleep' || actions.length === 1)
}

function sameTargets(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((target, index) => target === right[index])
}

function issueDrainAuthority(reservation: DrainReservation, record: StateRecord, address: StateAddress): DrainReservationAuthority {
    const authority = { reservation: snapshotDrainReservation(reservation) } as DrainReservationAuthority
    const recordFingerprint = exactRecordFingerprint(record)
    const ownedAddress = snapshotCoordinationAddress(address)
    if (recordFingerprint === undefined || ownedAddress === undefined) throw new RefusalError('drain authority provenance is malformed')
    drainAuthorities.add(authority)
    drainAuthorityRecords.set(authority, recordFingerprint)
    drainAuthorityAddresses.set(authority, ownedAddress)
    drainAuthorityEpochs.set(reservation.reservationId, drainAuthorityEpoch(reservation))
    return authority
}

function retireDrainAuthority(authority: DrainReservationAuthority, recoverable: boolean): void {
    const reservation = authority.reservation
    drainAuthorities.delete(authority)
    drainAuthorityRecords.delete(authority)
    drainAuthorityAddresses.delete(authority)
    if (recoverable && drainAuthorityEpochs.get(reservation.reservationId) === drainAuthorityEpoch(reservation)) {
        drainAuthorityEpochs.delete(reservation.reservationId)
    }
}

function exactRecordFingerprint(record: unknown): string | undefined {
    const snapshot = snapshotDataOnly(record)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
        || !hasExactKeys(snapshot, ['format', 'kind', 'cockpitId', 'subjectId', 'revision', 'updatedAt', 'value'])) return undefined
    const candidate = snapshot as Record<string, unknown>
    if (candidate.format !== 'cockpit-state/v1' || candidate.kind !== 'coordination'
        || typeof candidate.cockpitId !== 'string' || candidate.cockpitId.length === 0
        || typeof candidate.subjectId !== 'string' || candidate.subjectId.length === 0
        || typeof candidate.revision !== 'number' || !Number.isInteger(candidate.revision) || candidate.revision < 0
        || typeof candidate.updatedAt !== 'string' || !isCanonicalTimestamp(candidate.updatedAt)
        || !z.json().safeParse(candidate.value).success) return undefined
    return JSON.stringify(canonicalJsonValue(snapshot))
}

function drainAuthorityEpoch(reservation: DrainReservation): string {
    return reservation.attempt?.status === 'failed'
        ? `failed:${reservation.attempt.attemptId}:${reservation.attempt.failedRevision}`
        : `progress:${reservation.completedActionCount}:${reservation.progressRevision}`
}

export function consumeDrainReservationAuthority(authority: DrainReservationAuthority): DrainReservation | undefined {
    if (!authority || typeof authority !== 'object' || !drainAuthorities.has(authority)) return undefined
    const reservation = authority.reservation
    drainAuthorities.delete(authority)
    drainAuthorityAddresses.delete(authority)
    return reservation
}

export function discardDrainReservationAuthority(authority: DrainReservationAuthority): boolean {
    if (!authority || typeof authority !== 'object' || !drainAuthorities.has(authority)) return false
    retireDrainAuthority(authority, true)
    return true
}

export function isDrainActive(value: CoordinationRecord): boolean {
    return value.drain != null
}

export type DrainReservationResult =
    | { readonly kind: 'complete'; readonly reservation: DrainReservation; readonly authority: DrainReservationAuthority }
    | ClaimMutationRefusal

export async function reserveDrain(input: {
    readonly namespace: StateNamespace
    readonly request: DrainReservationRequest
}): Promise<DrainReservationResult> {
    let namespace: StateNamespace | undefined
    let request: DrainReservationRequest | undefined
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input) || !hasExactKeys(input, ['namespace', 'request'])) throw new RefusalError('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (!('value' in descriptors.namespace!) || !('value' in descriptors.request!)) throw new RefusalError('invalid')
        namespace = snapshotStateNamespace(descriptors.namespace!.value as StateNamespace)
        request = snapshotDrainRequest(descriptors.request!.value)
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        namespace = undefined
        request = undefined
    }
    if (!namespace || !request) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'drain reservation input is malformed', 'drain reservation')
    const reservedAt = new Date().toISOString()
    const reservationId = randomBytes(32).toString('hex')
    const reservation = {
        ...request,
        coordinationRevision: request.expectedCoordinationRevision + 1,
        completedActionCount: 0,
        progressRevision: request.expectedCoordinationRevision + 1,
        reservedAt,
        reservationId,
        attempt: null,
    } satisfies DrainReservation
    const result = await transactClaim<DrainReservationResult>(namespace, request.stackId, request.requesterId, (current) => {
        const value = decodeCoordinationRecord(current, request.stackId)
        if (!value || current === null || current.revision !== request.expectedCoordinationRevision) {
            return abortStateTransaction(refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'drain reservation requires the exact current coordination revision', request.stackId))
        }
        if (value.drain !== null) return abortStateTransaction(refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'the stack already has an exclusive mutation', request.stackId))
        if (request.holderId !== request.requesterId
            || value.holders.length !== 1
            || value.holders[0]?.holderId !== request.holderId
            || value.lease === null || value.lease.released) {
            return abortStateTransaction(refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'drain reservation requires retained holder and lease ownership', request.stackId))
        }
        return coordinationStateRecord(namespace, request.stackId, current, reservedAt, { ...value, drain: reservation })
    })
    if ('diagnostics' in result || 'reservation' in result) return result
    if (result.kind !== 'complete') {
        return result.kind === 'missing'
            ? refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'drain reservation returned no record', result.path)
            : stateRefusal(result)
    }
    const value = decodeCoordinationRecord(result.value, request.stackId)
    if (!value?.drain || !sameDrainRequest(value.drain, request) || value.drain.reservationId !== reservationId) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'published drain reservation is malformed', request.stackId)
    }
    return {
        kind: 'complete', reservation: value.drain,
        authority: issueDrainAuthority(value.drain, result.value, namespace.paths.coordination(request.stackId)),
    }
}

export type DrainAttemptResult =
    | { readonly kind: 'complete'; readonly reservation: DrainReservation; readonly attempt: DrainAttempt; readonly authority: DrainAttemptAuthority }
    | ClaimMutationRefusal

function snapshotCoordinationAddress(address: StateAddress): StateAddress | undefined {
    const owned = exactDataProperties(address, ['path', 'stateRoot', 'cockpitRoot', 'kind', 'cockpitId', 'subjectId'])
    return owned && owned.kind === 'coordination' && typeof owned.path === 'string'
        && typeof owned.stateRoot === 'string' && typeof owned.cockpitRoot === 'string'
        && typeof owned.cockpitId === 'string' && typeof owned.subjectId === 'string'
        ? owned as unknown as StateAddress
        : undefined
}

function sameCoordinationAddress(left: StateAddress, right: StateAddress): boolean {
    return left.path === right.path && left.stateRoot === right.stateRoot && left.cockpitRoot === right.cockpitRoot
        && left.kind === right.kind && left.cockpitId === right.cockpitId && left.subjectId === right.subjectId
        && left.qualifier === undefined && right.qualifier === undefined
}

function issueDrainAttemptAuthority(reservation: DrainReservation, record: StateRecord, address: StateAddress): DrainAttemptAuthority {
    if (!reservation.attempt) throw new RefusalError('drain attempt is absent')
    const ownedAddress = snapshotCoordinationAddress(address)
    if (!ownedAddress) throw new RefusalError('drain attempt address is malformed')
    const owned = snapshotDrainReservation(reservation)
    const authority = { reservation: owned, attempt: owned.attempt! } as DrainAttemptAuthority
    drainAttemptAuthorities.set(authority, {
        reservation: owned,
        attempt: owned.attempt!,
        provenance: Object.freeze({
            kind: 'coordination', cockpitId: record.cockpitId as CockpitId, subjectId: record.subjectId,
            address: ownedAddress,
        }),
    })
    return authority
}

function reduceDrainAttemptState(input: unknown, retry: boolean): CoordinationRecord | undefined {
    const owned = snapshotExactReducerInput(input, ['record', 'reservation', 'attempt'])
    if (!owned) return undefined
    const reservationResult = DrainReservationSchema.safeParse(owned.reservation)
    const attemptResult = DrainAttemptSchema.safeParse(owned.attempt)
    const record = owned.record as StateRecord
    if (!reservationResult.success || !attemptResult.success || !record || typeof record !== 'object') return undefined
    const reservation = reservationResult.data as unknown as DrainReservation
    const attempt = attemptResult.data as DrainAttempt
    const value = decodeCoordinationRecord(record, reservation.stackId)
    const currentAction = reservation.actions[reservation.completedActionCount]
    const prior = reservation.attempt
    const expectedRevision = retry ? prior?.failedRevision : reservation.progressRevision
    if (!value?.drain || !currentAction || expectedRevision === null || expectedRevision === undefined
        || record.revision !== expectedRevision || attempt.status !== 'active' || attempt.failedRevision !== null || attempt.failedAt !== null
        || attempt.reservationId !== reservation.reservationId || attempt.purpose !== reservation.purpose
        || !sameTargets(attempt.targetIds, reservation.targetIds) || attempt.generation !== reservation.generation
        || attempt.actionIndex !== reservation.completedActionCount || attempt.currentStage !== currentAction.stage
        || attempt.currentTarget !== currentAction.targetId || attempt.committedRevision !== expectedRevision + 1
        || Date.parse(attempt.validThrough) - Date.parse(attempt.committedAt) !== currentAction.validForMs
        || !sameDrainRequest(value.drain, reservation) || value.drain.reservationId !== reservation.reservationId
        || value.drain.reservedAt !== reservation.reservedAt) return undefined
    if (retry) {
        if (!prior || prior.status !== 'failed' || value.drain.attempt?.status !== 'failed'
            || !sameDrainAttempt(value.drain.attempt, prior)
            || prior.failedAt === null || Date.parse(attempt.committedAt) < Date.parse(prior.failedAt)) return undefined
    } else if (prior !== null || value.drain.attempt !== null) return undefined
    const proposed = { ...value, drain: { ...value.drain, attempt } }
    return CoordinationValueSchema.safeParse(proposed).success ? proposed : undefined
}

function reduceDrainAttemptStart(input: {
    readonly record: StateRecord
    readonly reservation: DrainReservation
    readonly attempt: DrainAttempt
}): CoordinationRecord | undefined {
    return reduceDrainAttemptState(input, false)
}

function reduceDrainAttemptRetry(input: {
    readonly record: StateRecord
    readonly reservation: DrainReservation
    readonly attempt: DrainAttempt
}): CoordinationRecord | undefined {
    return reduceDrainAttemptState(input, true)
}

export async function reserveDrainAttempt(input: {
    readonly namespace: StateNamespace
    readonly authority: DrainReservationAuthority
}): Promise<DrainAttemptResult> {
    let namespace: StateNamespace | undefined
    let reservation: DrainReservation | undefined
    let reservationAuthority: DrainReservationAuthority | undefined
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || !hasExactKeys(input, ['namespace', 'authority'])) throw new RefusalError('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) throw new RefusalError('invalid')
        reservationAuthority = descriptors.authority!.value as DrainReservationAuthority
        if (!reservationAuthority || typeof reservationAuthority !== 'object' || !drainAuthorities.has(reservationAuthority)) throw new RefusalError('invalid')
        reservation = reservationAuthority.reservation
        namespace = snapshotStateNamespace(descriptors.namespace!.value as StateNamespace)
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        namespace = undefined
        reservation = undefined
        reservationAuthority = undefined
    }
    const currentAction = reservation?.actions[reservation.completedActionCount]
    const issuedAddress = reservationAuthority && drainAuthorityAddresses.get(reservationAuthority)
    const requestedAddress = namespace && reservation ? namespace.paths.coordination(reservation.stackId) : undefined
    if (!namespace || !reservation || !currentAction || reservation.attempt?.status === 'active'
        || !issuedAddress || !requestedAddress || !sameCoordinationAddress(issuedAddress, requestedAddress)
        || reservation.attempt?.status === 'failed' && (
            currentAction.targetId !== reservation.attempt.currentTarget
            || currentAction.stage !== reservation.attempt.currentStage
            || reservation.completedActionCount !== reservation.attempt.actionIndex
        )) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'drain attempt input is malformed', 'drain attempt')
    }
    const committedAt = new Date().toISOString()
    const priorRevision = reservation.attempt?.status === 'failed'
        ? reservation.attempt.failedRevision!
        : reservation.progressRevision
    const validThrough = new Date(Date.parse(committedAt) + currentAction.validForMs).toISOString()
    const attempt = {
        attemptId: randomBytes(32).toString('hex'), reservationId: reservation.reservationId,
        purpose: reservation.purpose, targetIds: reservation.targetIds, generation: reservation.generation,
        actionIndex: reservation.completedActionCount, currentTarget: currentAction.targetId, currentStage: currentAction.stage,
        committedRevision: priorRevision + 1, committedAt, validThrough,
        status: 'active' as const, failedRevision: null, failedAt: null,
    } satisfies DrainAttempt
    const transaction = await transactClaim<DrainAttemptResult>(namespace, reservation.stackId, reservation.requesterId, (current) => {
        const reduced = current === null ? undefined : reservation!.attempt === null
            ? reduceDrainAttemptStart({ record: current, reservation: reservation!, attempt })
            : reduceDrainAttemptRetry({ record: current, reservation: reservation!, attempt })
        if (!reduced) {
            return abortStateTransaction(refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'drain attempt requires an exact unstarted or failed reservation', reservation!.stackId))
        }
        return coordinationStateRecord(namespace!, reservation!.stackId, current, committedAt, reduced)
    })
    if ('diagnostics' in transaction) {
        retireDrainAuthority(reservationAuthority!, true)
        return transaction
    }
    if ('attempt' in transaction) return transaction
    if (transaction.kind !== 'complete') {
        if (transaction.kind === 'indeterminate') {
            retireDrainAuthority(reservationAuthority!, false)
        } else {
            retireDrainAuthority(reservationAuthority!, true)
        }
        return transaction.kind === 'missing'
            ? refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'drain attempt returned no record', transaction.path)
            : stateRefusal(transaction)
    }
    retireDrainAuthority(reservationAuthority!, false)
    const value = decodeCoordinationRecord(transaction.value, reservation.stackId)
    if (!value?.drain?.attempt || value.drain.attempt.attemptId !== attempt.attemptId
        || transaction.value.revision !== attempt.committedRevision) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'published drain attempt is malformed', reservation.stackId)
    }
    const owned = snapshotDrainReservation(value.drain)
    return {
        kind: 'complete', reservation: owned, attempt: owned.attempt!,
        authority: issueDrainAttemptAuthority(owned, transaction.value, namespace.paths.coordination(reservation.stackId)),
    }
}

export function inspectDrainAttemptAuthority(authority: DrainAttemptAuthority): DrainAttemptCandidate | undefined {
    if (!authority || typeof authority !== 'object') return undefined
    const issued = drainAttemptAuthorities.get(authority)
    if (!issued) return undefined
    const candidate = { reservation: issued.reservation, attempt: issued.attempt } as DrainAttemptCandidate
    drainAttemptCandidates.set(candidate, { authority, ...issued })
    return candidate
}

function redeemDrainAttempt<Success extends RuntimeStopped | ReclaimCompleted>(
    authority: DrainAttemptAuthority,
    candidate: DrainAttemptCandidate,
    stage: DrainAction['stage'],
    planningRecord?: StateRecord,
): DrainAttemptPermit<Success> | undefined {
    if (!authority || typeof authority !== 'object' || !candidate || typeof candidate !== 'object') return undefined
    const issued = drainAttemptAuthorities.get(authority)
    const inspected = drainAttemptCandidates.get(candidate)
    if (!issued || !inspected || inspected.authority !== authority || inspected.reservation !== issued.reservation
        || inspected.attempt !== issued.attempt || issued.attempt.status !== 'active' || issued.attempt.currentStage !== stage
        || issued.reservation.attempt !== issued.attempt
        || issued.reservation.actions[issued.attempt.actionIndex]?.stage !== stage
        || issued.reservation.actions[issued.attempt.actionIndex]?.targetId !== issued.attempt.currentTarget) return undefined
    drainAttemptAuthorities.delete(authority)
    drainAttemptCandidates.delete(candidate)
    let available = true
    const sealSuccess = (success: Success): DrainAttemptSuccessAuthority | undefined => {
        const snapshot = snapshotDataOnly(success) as Success | undefined
        if (!available || !snapshot || !isExactDrainSuccess(issued.reservation, snapshot)) return undefined
        available = false
        const result = {} as DrainAttemptSuccessAuthority
        drainAttemptSuccessAuthorities.set(result, Object.freeze({
            reservation: issued.reservation, fact: Object.freeze(snapshot), provenance: issued.provenance,
        }))
        return result
    }
    const sealFailure = (failure: DrainAttemptFailure): DrainAttemptFailureAuthority | undefined => {
        const snapshot = snapshotDataOnly(failure) as DrainAttemptFailure | undefined
        if (!available || !snapshot || !hasExactKeys(snapshot, [
            'attemptId', 'reservationId', 'purpose', 'targetIds', 'generation', 'actionIndex', 'currentTarget', 'currentStage',
            'committedRevision', 'committedAt', 'validThrough', 'status', 'failedRevision', 'failedAt',
        ]) || snapshot.status !== 'active' || snapshot.failedRevision !== null || !sameDrainAttemptBinding(snapshot, issued.attempt)
            || !isCanonicalTimestamp(snapshot.failedAt) || Date.parse(snapshot.failedAt) < Date.parse(issued.attempt.committedAt)
            || Date.parse(snapshot.failedAt) > Date.now()) return undefined
        available = false
        const result = {} as DrainAttemptFailureAuthority
        drainAttemptFailureAuthorities.set(result, Object.freeze({
            reservation: issued.reservation, fact: Object.freeze(snapshot), provenance: issued.provenance,
        }))
        if (planningRecord !== undefined) {
            drainFailureProgressAuthorities.set(result, Object.freeze({
                planningRecord,
                reservation: issued.reservation,
                attempt: issued.attempt,
                failure: Object.freeze(snapshot),
            }))
        }
        return result
    }
    return { ...issued, sealSuccess, sealFailure }
}

function redeemRuntimeStopAttempt(authority: DrainAttemptAuthority, candidate: DrainAttemptCandidate): DrainAttemptPermit<RuntimeStopped> | undefined {
    return redeemDrainAttempt<RuntimeStopped>(authority, candidate, 'runtime-stop')
}

function sameSnapshot(left: unknown, right: unknown): boolean {
    const leftSnapshot = snapshotJson(left)
    const rightSnapshot = snapshotJson(right)
    return leftSnapshot !== undefined && rightSnapshot !== undefined
        && JSON.stringify(leftSnapshot) === JSON.stringify(rightSnapshot)
}

function planningRecordPrecedesAttempt(record: StateRecord, reservation: DrainReservation): StateRecord | undefined {
    const snapshot = snapshotDataOnly(record) as StateRecord | undefined
    if (!snapshot || reservation.attempt === null || snapshot.subjectId !== reservation.stackId) return undefined
    const value = decodeCoordinationRecord(snapshot, reservation.stackId)
    if (value === undefined) return undefined
    if (value.drain == null) {
        // A record from before the reservation plans only the first try of an action: once a try
        // failed, a retry must be planned from the published failure, never from the original plan.
        return reservation.expectedCoordinationRevision === snapshot.revision
            && reservation.coordinationRevision === snapshot.revision + 1
            && reservation.attempt.committedRevision === reservation.progressRevision + 1 ? snapshot : undefined
    }
    if (reservation.attempt.committedRevision !== snapshot.revision + 1) return undefined
    if (value.drain.attempt === null) {
        if (snapshot.revision !== value.drain.progressRevision
            || !sameSnapshot({ ...reservation, attempt: null }, value.drain)) return undefined
        return snapshot
    }
    const failed = value.drain.attempt
    if (failed.status !== 'failed' || failed.failedRevision !== snapshot.revision
        || failed.actionIndex !== reservation.attempt.actionIndex
        || failed.currentStage !== reservation.attempt.currentStage
        || failed.currentTarget !== reservation.attempt.currentTarget
        || failed.reservationId !== reservation.attempt.reservationId
        || failed.purpose !== reservation.attempt.purpose
        || failed.generation !== reservation.attempt.generation
        || !sameTargets(failed.targetIds, reservation.attempt.targetIds)
        || !sameSnapshot({ ...reservation, attempt: failed }, value.drain)) return undefined
    return snapshot
}

function redeemReclaimAttempt(
    authority: DrainAttemptAuthority,
    candidate: DrainAttemptCandidate,
    planningRecord: StateRecord,
): ReclaimAttemptPermit | undefined {
    const issued = drainAttemptAuthorities.get(authority)
    const predecessor = issued ? planningRecordPrecedesAttempt(planningRecord, issued.reservation) : undefined
    if (!issued || predecessor === undefined) return undefined
    const permit = redeemDrainAttempt<ReclaimCompleted>(authority, candidate, 'reclaim', predecessor)
    if (!permit) return undefined
    const progressAuthority = {} as DrainProgressAuthority
    drainProgressAuthorities.set(progressAuthority, Object.freeze({
        planningRecord: predecessor,
        reservation: permit.reservation,
        attempt: permit.attempt,
    }))
    return { ...permit, progressAuthority }
}

function exactDataProperties(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !hasExactKeys(value, keys)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (keys.some((key) => !('value' in descriptors[key]!))) return undefined
        return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]))
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

export function openRuntimeDrainExecution(input: {
    readonly authority: DrainAttemptAuthority; readonly candidate: DrainAttemptCandidate
}): RuntimeDrainExecutionAuthority | undefined {
    const owned = exactDataProperties(input, ['authority', 'candidate'])
    if (!owned) return undefined
    const permit = redeemRuntimeStopAttempt(
        owned.authority as DrainAttemptAuthority, owned.candidate as DrainAttemptCandidate,
    )
    if (!permit) return undefined
    const fence = drainExecutionFence({ attempt: permit.attempt, address: permit.provenance.address })
    if (!fence) return undefined
    const execution = {} as RuntimeDrainExecutionAuthority
    drainExecutions.set(execution, Object.freeze({ kind: 'runtime-stop', permit, fence }))
    return execution
}

function drainExecutionFence(input: { readonly attempt: DrainAttempt; readonly address: StateAddress }): ExecutionFence | undefined {
    const attemptId = input.attempt.attemptId
    const markerPath = `${input.address.path}.${attemptId}.executor.json`
    const socketRoot = join(platform() === 'darwin' ? '/private/tmp' : '/tmp', `cockpit-exec-${process.getuid?.() ?? 0}`)
    const socketPath = join(socketRoot, `${attemptId.slice(0, 24)}.sock`)
    return /^[a-f0-9]{64}$/.test(attemptId) && isAbsolute(markerPath) && normalize(markerPath) === markerPath
        && isAbsolute(socketPath) && normalize(socketPath) === socketPath && Buffer.byteLength(socketPath) <= 103
        ? { attemptId, markerPath, socketPath } : undefined
}

export function inspectDrainExecutionFence(
    authority: RuntimeDrainExecutionAuthority | ReclaimDrainExecutionAuthority,
): ExecutionFence | undefined {
    if (!authority || typeof authority !== 'object') return undefined
    const execution = drainExecutions.get(authority)
    return execution ? { ...execution.fence } : undefined
}

export function openReclaimDrainExecution(input: {
    readonly authority: DrainAttemptAuthority; readonly candidate: DrainAttemptCandidate
    readonly planningRecord: StateRecord; readonly continuation: object
}): ReclaimDrainExecutionAuthority | undefined {
    const owned = exactDataProperties(input, ['authority', 'candidate', 'planningRecord', 'continuation'])
    if (!owned) return undefined
    const continuation = owned.continuation
    if (!continuation || typeof continuation !== 'object') return undefined
    const permit = redeemReclaimAttempt(
        owned.authority as DrainAttemptAuthority, owned.candidate as DrainAttemptCandidate,
        owned.planningRecord as StateRecord,
    )
    if (!permit) return undefined
    const fence = drainExecutionFence({ attempt: permit.attempt, address: permit.provenance.address })
    if (!fence) return undefined
    const execution = {} as ReclaimDrainExecutionAuthority
    drainExecutions.set(execution, Object.freeze({ kind: 'reclaim', permit, continuation, fence }))
    drainContinuationEvidence.set(continuation, Object.freeze({
        kind: 'progress', authority: permit.progressAuthority,
    }))
    return execution
}

function settleOwnedDrainExecution(input: unknown, executionKind: 'runtime-stop' | 'reclaim', outcomeKind: 'success' | 'failure'): DrainOutcomeAuthority | undefined {
    const owned = exactDataProperties(input, ['authority', 'fact'])
    if (!owned) return undefined
    const executionAuthority = owned.authority
    if (!executionAuthority || typeof executionAuthority !== 'object') return undefined
    const execution = drainExecutions.get(executionAuthority)
    if (!execution || execution.kind !== executionKind) return undefined
    const sealed = outcomeKind === 'success'
        ? execution.permit.sealSuccess(owned.fact as never)
        : execution.permit.sealFailure(owned.fact as DrainAttemptFailure)
    if (!sealed) return undefined
    drainExecutions.delete(executionAuthority)
    const outcome = {} as DrainOutcomeAuthority
    if (outcomeKind === 'success') {
        drainOutcomes.set(outcome, Object.freeze({
            kind: 'success', authority: sealed as DrainAttemptSuccessAuthority, provenance: execution.permit.provenance,
        }))
    } else {
        const failure = sealed as DrainAttemptFailureAuthority
        drainOutcomes.set(outcome, Object.freeze({ kind: 'failure', authority: failure, provenance: execution.permit.provenance }))
        if (execution.kind === 'reclaim') {
            drainContinuationEvidence.set(execution.continuation, Object.freeze({ kind: 'failure', authority: failure }))
        }
    }
    return outcome
}

export const settleRuntimeDrainSuccess = (input: { readonly authority: RuntimeDrainExecutionAuthority; readonly fact: RuntimeStopped }) => settleOwnedDrainExecution(input, 'runtime-stop', 'success')
export const settleRuntimeDrainFailure = (input: { readonly authority: RuntimeDrainExecutionAuthority; readonly fact: DrainAttemptFailure }) => settleOwnedDrainExecution(input, 'runtime-stop', 'failure')
export const settleReclaimDrainSuccess = (input: { readonly authority: ReclaimDrainExecutionAuthority; readonly fact: ReclaimCompleted }) => settleOwnedDrainExecution(input, 'reclaim', 'success')
export const settleReclaimDrainFailure = (input: { readonly authority: ReclaimDrainExecutionAuthority; readonly fact: DrainAttemptFailure }) => settleOwnedDrainExecution(input, 'reclaim', 'failure')

function reduceOwnedDrainOutcome(authority: DrainOutcomeAuthority, record: StateRecord): CoordinationRecord | undefined {
    const outcome = drainOutcomes.get(authority)
    if (!outcome) return undefined
    const reduced = outcome.kind === 'failure'
        ? reduceDrainAttemptFailure({ record, authority: outcome.authority })
        : (() => {
            const issued = drainAttemptSuccessAuthorities.get(outcome.authority)
            const final = issued !== undefined && issued.reservation.attempt !== null
                && issued.reservation.attempt.actionIndex === issued.reservation.actions.length - 1
            return final
                ? reduceDrain({ record, authority: outcome.authority })
                : reduceDrainAttemptSuccess({ record, authority: outcome.authority })
        })()
    const value = reduced === undefined ? undefined : snapshotJson(reduced)
    if (reduced === undefined || value === undefined) return undefined
    return reduced
}

export function reduceDrainOutcome(input: { readonly authority: DrainOutcomeAuthority; readonly record: StateRecord }): CoordinationRecord | undefined {
    const reduction = exactDataProperties(input, ['authority', 'record'])
    const authority = reduction?.authority
    return authority && typeof authority === 'object'
        ? reduceOwnedDrainOutcome(authority as DrainOutcomeAuthority, reduction.record as StateRecord)
        : undefined
}

function prepareDrainOutcomeRecord(input: {
    readonly authority: DrainOutcomeAuthority
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly current: StateRecord | null
}): StateRecord | StateTransactionAbort<ClaimMutationRefusal> {
    const preparation = exactDataProperties(input, ['authority', 'namespace', 'stackId', 'current'])
    const authority = preparation?.authority
    const outcome = authority && typeof authority === 'object' ? drainOutcomes.get(authority) : undefined
    const namespace = preparation ? snapshotStateNamespace(preparation.namespace as StateNamespace) : undefined
    const stackId = preparation?.stackId
    const current = preparation?.current === null
        ? null
        : snapshotDataOnly(preparation?.current) as StateRecord | undefined
    const observedTime = Date.now()
    let updatedAt: string | undefined
    try {
        const candidate = Number.isFinite(observedTime) ? new Date(observedTime).toISOString() : undefined
        updatedAt = candidate && isCanonicalTimestamp(candidate) ? candidate : undefined
    } catch {
        // A clock that cannot yield a canonical timestamp leaves updatedAt undefined, which the caller refuses.
        updatedAt = undefined
    }
    const notBefore = outcome?.kind === 'failure'
        ? drainAttemptFailureAuthorities.get(outcome.authority)?.fact.failedAt
        : outcome?.kind === 'success'
            ? drainAttemptSuccessAuthorities.get(outcome.authority)?.fact.observedAt
            : undefined
    if (!outcome || !namespace || typeof stackId !== 'string' || !/^stack:[a-f0-9]{64}$/.test(stackId)
        || !current || typeof current !== 'object' || !updatedAt || !notBefore
        || Date.parse(updatedAt) < Date.parse(notBefore)
        || namespace.paths.coordination(stackId as StackId).cockpitId !== outcome.provenance.cockpitId
        || stackId !== outcome.provenance.subjectId
        || !sameCoordinationAddress(namespace.paths.coordination(stackId as StackId), outcome.provenance.address)
        || current.kind !== outcome.provenance.kind
        || current.cockpitId !== outcome.provenance.cockpitId
        || current.subjectId !== outcome.provenance.subjectId) {
        return abortStateTransaction(refuse(
            ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            'drain outcome publication requires an exact current record and a non-regressive observation time',
            typeof stackId === 'string' ? stackId : 'drain outcome publication',
        ))
    }
    const value = reduceOwnedDrainOutcome(authority as DrainOutcomeAuthority, current)
    if (!value) {
        return abortStateTransaction(refuse(
            ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            'drain outcome publication no longer matches the current coordination record',
            stackId,
        ))
    }
    const snapshot = snapshotJson(value)
    if (snapshot === undefined) {
        return abortStateTransaction(refuse(
            ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            'drain outcome publication no longer matches the current coordination record',
            stackId,
        ))
    }
    return coordinationStateRecord(namespace, stackId as StackId, current, updatedAt, value)
}

/**
 * Publishes a settled drain outcome to the coordination record and, once it is durable, retires the
 * outcome so it cannot be published again. An indeterminate publication keeps the outcome for repair.
 */
export async function commitDrainOutcome(input: {
    readonly authority: DrainOutcomeAuthority
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly beforePublish?: StateTransactionOptions['beforePublish']
}): Promise<StateResult<StateRecord> | ClaimMutationRefusal> {
    const { authority, stackId, beforePublish } = input
    const outcome = drainOutcomes.get(authority)
    const namespace = snapshotStateNamespace(input.namespace)
    const sealed = outcome?.kind === 'failure'
        ? drainAttemptFailureAuthorities.get(outcome.authority)
        : outcome?.kind === 'success'
            ? drainAttemptSuccessAuthorities.get(outcome.authority)
            : undefined
    const sealedReservation = sealed?.reservation
    const ownerId = sealedReservation?.requesterId === sealedReservation?.holderId
        ? sealedReservation?.requesterId
        : undefined
    const address = namespace && typeof stackId === 'string' && /^stack:[a-f0-9]{64}$/.test(stackId)
        ? namespace.paths.coordination(stackId as StackId)
        : undefined
    const notBefore = outcome?.kind === 'failure'
        ? drainAttemptFailureAuthorities.get(outcome.authority)?.fact.failedAt
        : outcome?.kind === 'success'
            ? drainAttemptSuccessAuthorities.get(outcome.authority)?.fact.observedAt
            : undefined
    if (!outcome || !namespace || !address || !notBefore || !isCanonicalTimestamp(notBefore)
        || typeof ownerId !== 'string' || !holderIdentity.test(ownerId)
        || beforePublish !== undefined && typeof beforePublish !== 'function'
        || !sameCoordinationAddress(address, outcome.provenance.address)) {
        return refuse(
            ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            'drain outcome publication requires exact coordination authority and ownership',
            typeof stackId === 'string' ? stackId : 'drain outcome publication',
        )
    }
    let preparedAt: string | undefined
    const publication = await transactState(
        namespace,
        address,
        {
            ownerId: ownerId as HolderId,
            contentionTimeoutMs: 2_000,
            ...(beforePublish ? { beforePublish: beforePublish as StateTransactionOptions['beforePublish'] } : {}),
            beforeCommit: () => {
                const now = Date.now()
                return !Number.isFinite(now) || !preparedAt || now < Date.parse(notBefore) || now < Date.parse(preparedAt)
                    ? abortStateTransaction(refuse(
                        ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
                        'drain outcome publication clock changed before commit',
                        stackId as StackId,
                    ))
                    : undefined
            },
        },
        (current) => {
            const proposal = prepareDrainOutcomeRecord({
                authority: authority as DrainOutcomeAuthority, namespace, stackId: stackId as StackId, current,
            })
            if (!('aborted' in proposal)) preparedAt = proposal.updatedAt
            return proposal
        },
    )
    if ('aborted' in publication) return publication.value as ClaimMutationRefusal
    if (publication.kind === 'complete') {
        drainOutcomes.delete(authority as DrainOutcomeAuthority)
        finalizeDrainAttemptOutcome(outcome.authority)
    }
    return publication
}

export function matchReclaimDrainContinuation(input: { readonly continuation: object; readonly record: StateRecord }): 'progressed' | 'failed' | 'unmatched' {
    const matching = exactDataProperties(input, ['continuation', 'record'])
    if (!matching) return 'unmatched'
    const continuation = matching.continuation
    if (!continuation || typeof continuation !== 'object') return 'unmatched'
    const evidence = drainContinuationEvidence.get(continuation)
    if (!evidence) return 'unmatched'
    const record = matching.record as StateRecord
    if (evidence.kind === 'progress') {
        return matchesDrainProgress(evidence.authority, record) ? 'progressed' : 'unmatched'
    }
    return matchesDrainFailure(evidence.authority, record) ? 'failed' : 'unmatched'
}

function matchesDrainProgress(authority: DrainProgressAuthority, record: StateRecord): boolean {
    if (!authority || typeof authority !== 'object') return false
    const issued = drainProgressAuthorities.get(authority)
    const snapshot = snapshotDataOnly(record) as StateRecord | undefined
    if (!issued || !snapshot || snapshot.format !== issued.planningRecord.format
        || snapshot.kind !== issued.planningRecord.kind || snapshot.cockpitId !== issued.planningRecord.cockpitId
        || snapshot.subjectId !== issued.planningRecord.subjectId
        || snapshot.revision !== issued.attempt.committedRevision + 1
        || !isCanonicalTimestamp(snapshot.updatedAt)
        || Date.parse(snapshot.updatedAt) < Date.parse(issued.attempt.committedAt)
        || Date.parse(snapshot.updatedAt) > Date.now()) return false
    const predecessor = decodeCoordinationRecord(issued.planningRecord, issued.reservation.stackId)
    const value = decodeCoordinationRecord(snapshot, issued.reservation.stackId)
    if (!predecessor || !value?.drain
        || !sameSnapshot(value.holders, predecessor.holders)
        || !sameSnapshot(value.lease, predecessor.lease)
        || value.lastReleasedHolder !== predecessor.lastReleasedHolder) return false
    const expectedDrain = {
        ...issued.reservation,
        completedActionCount: issued.attempt.actionIndex + 1,
        progressRevision: issued.attempt.committedRevision + 1,
        attempt: null,
    }
    return sameSnapshot(value.drain, expectedDrain)
}

function matchesDrainFailure(authority: DrainAttemptFailureAuthority, record: StateRecord): boolean {
    if (!authority || typeof authority !== 'object') return false
    const issued = drainFailureProgressAuthorities.get(authority)
    const snapshot = snapshotDataOnly(record) as StateRecord | undefined
    if (!issued || !snapshot || snapshot.format !== issued.planningRecord.format
        || snapshot.kind !== issued.planningRecord.kind || snapshot.cockpitId !== issued.planningRecord.cockpitId
        || snapshot.subjectId !== issued.planningRecord.subjectId
        || snapshot.revision !== issued.attempt.committedRevision + 1
        || !isCanonicalTimestamp(snapshot.updatedAt)
        || Date.parse(snapshot.updatedAt) < Date.parse(issued.failure.failedAt)
        || Date.parse(snapshot.updatedAt) > Date.now()) return false
    const predecessor = decodeCoordinationRecord(issued.planningRecord, issued.reservation.stackId)
    const value = decodeCoordinationRecord(snapshot, issued.reservation.stackId)
    if (!predecessor || !value?.drain
        || !sameSnapshot(value.holders, predecessor.holders)
        || !sameSnapshot(value.lease, predecessor.lease)
        || value.lastReleasedHolder !== predecessor.lastReleasedHolder) return false
    const expectedDrain = {
        ...issued.reservation,
        attempt: {
            ...issued.attempt,
            status: 'failed' as const,
            failedRevision: issued.attempt.committedRevision + 1,
            failedAt: issued.failure.failedAt,
        },
    }
    return sameSnapshot(value.drain, expectedDrain)
}

export interface DrainAttemptFailure extends DrainAttempt {
    readonly failedAt: string
}

function reduceDrainAttemptFailure(input: {
    readonly record: StateRecord
    readonly authority: DrainAttemptFailureAuthority
}): CoordinationRecord | undefined {
    const owned = snapshotExactReducerInput(input, ['record', 'authority'])
    if (!owned) return undefined
    const record = owned.record as StateRecord
    const authority = Object.getOwnPropertyDescriptor(input, 'authority')?.value as object
    const issued = authority && typeof authority === 'object' ? drainAttemptFailureAuthorities.get(authority) : undefined
    const reservation = issued?.reservation
    const failure = issued?.fact
    if (!reservation?.attempt || reservation.attempt.status !== 'active'
        || !record || typeof record !== 'object' || record.revision !== reservation.attempt.committedRevision
        || !failure
        || !hasExactKeys(failure, ['attemptId', 'reservationId', 'purpose', 'targetIds', 'generation', 'actionIndex', 'currentTarget', 'currentStage', 'committedRevision', 'committedAt', 'validThrough', 'status', 'failedRevision', 'failedAt'])
        || failure.status !== 'active' || failure.failedRevision !== null || !isCanonicalTimestamp(failure.failedAt)
        || Date.parse(failure.failedAt) < Date.parse(reservation.attempt.committedAt)
        || Date.parse(failure.failedAt) > Date.now()) return undefined
    const value = decodeCoordinationRecord(record, reservation.stackId)
    const attempt = value?.drain?.attempt
    if (!value?.drain || !attempt || attempt.status !== 'active'
        || value.drain.reservationId !== reservation.reservationId
        || !sameDrainAttempt(attempt, reservation.attempt)
        || !sameDrainAttemptBinding(failure, attempt)) return undefined
    return {
        ...value,
        drain: {
            ...value.drain,
            attempt: { ...attempt, status: 'failed' as const,
                failedRevision: attempt.committedRevision + 1, failedAt: failure.failedAt },
        },
    }
}

export type SleepDrainRecoveryInspection =
    | { readonly kind: 'none' }
    | { readonly kind: 'repairable'; readonly fence: ExecutionFence; readonly authority: DrainRepairAuthority }
    | {
          readonly kind: 'recoverable'
          readonly generation: string
          readonly runtimeStopValidForMs: number
          readonly authority: SleepDrainRecoveryAuthority
      }
    | ClaimMutationRefusal

export type DestructiveDrainRecoveryInspection =
    | { readonly kind: 'none' }
    | { readonly kind: 'repairable'; readonly fence: ExecutionFence; readonly authority: DrainRepairAuthority }
    | { readonly kind: 'recoverable'; readonly request: DrainReservationRequest }
    | ClaimMutationRefusal

declare const drainRepairAuthorityBrand: unique symbol
export interface DrainRepairAuthority { readonly [drainRepairAuthorityBrand]: true }
const drainRepairs = new WeakMap<object, {
    readonly namespace: StateNamespace
    readonly address: StateAddress
    readonly recordFingerprint: string
    readonly reservation: DrainReservation
    readonly fence: ExecutionFence
}>()

function issueDrainRepair(namespace: StateNamespace, address: StateAddress, record: StateRecord, reservation: DrainReservation):
    Extract<SleepDrainRecoveryInspection, { kind: 'repairable' }> | undefined {
    if (!reservation.attempt || reservation.attempt.status !== 'active') return undefined
    const fence = drainExecutionFence({ attempt: reservation.attempt, address })
    const recordFingerprint = exactRecordFingerprint(record)
    if (!fence || !recordFingerprint) return undefined
    const authority = {} as DrainRepairAuthority
    drainRepairs.set(authority, { namespace, address: Object.freeze({ ...address }), recordFingerprint,
        reservation: snapshotDrainReservation(reservation), fence })
    return { kind: 'repairable', fence, authority }
}

export async function settleInterruptedDrainRepair(input: {
    readonly authority: DrainRepairAuthority
    readonly evidence: FencedExecutionTermination
}): Promise<StateResult<StateRecord> | ClaimMutationRefusal> {
    const owned = exactDataProperties(input, ['authority', 'evidence'])
    const authority = owned?.authority as DrainRepairAuthority | undefined
    const repair = authority && typeof authority === 'object' ? drainRepairs.get(authority) : undefined
    if (!repair || !consumeFencedExecutionTermination(owned!.evidence as FencedExecutionTermination, repair.fence)) {
        return refuse(ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED, 'interrupted drain termination evidence is unavailable', 'drain repair')
    }
    drainRepairs.delete(authority!)
    const failedAt = new Date().toISOString()
    return transactClaim(repair.namespace, repair.reservation.stackId, repair.reservation.holderId, current => {
        const value = decodeCoordinationRecord(current, repair.reservation.stackId)
        const attempt = value?.drain?.attempt
        if (!current || exactRecordFingerprint(current) !== repair.recordFingerprint || !value?.drain || !attempt
            || attempt.status !== 'active' || !sameDrainAttempt(attempt, repair.reservation.attempt!)) {
            return abortStateTransaction(refuse(ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED,
                'interrupted drain changed before executor termination could be recorded', repair.reservation.stackId))
        }
        return coordinationStateRecord(repair.namespace, repair.reservation.stackId, current, failedAt, {
            ...value,
            drain: { ...value.drain, attempt: { ...attempt, status: 'failed' as const,
                failedRevision: current.revision + 1, failedAt } },
        })
    })
}

export async function inspectDestructiveDrainRecovery(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly purpose: 'down' | 'reset'
}): Promise<DestructiveDrainRecoveryInspection> {
    let namespace: StateNamespace | undefined
    let stackId: StackId | undefined
    let holderId: HolderId | undefined
    let purpose: 'down' | 'reset' | undefined
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || !hasExactKeys(input, ['namespace', 'stackId', 'holderId', 'purpose'])) throw new RefusalError('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (!('value' in descriptors.namespace!) || !('value' in descriptors.stackId!)
            || !('value' in descriptors.holderId!) || !('value' in descriptors.purpose!)) throw new RefusalError('invalid')
        namespace = authenticateStateNamespace(descriptors.namespace!.value)
        const suppliedStackId = descriptors.stackId!.value
        const suppliedHolderId = descriptors.holderId!.value
        const suppliedPurpose = descriptors.purpose!.value
        if (typeof suppliedStackId !== 'string' || typeof suppliedHolderId !== 'string'
            || !validIdentity(suppliedStackId, stackIdentity) || !validIdentity(suppliedHolderId, holderIdentity)
            || suppliedPurpose !== 'down' && suppliedPurpose !== 'reset') throw new RefusalError('invalid')
        stackId = suppliedStackId as StackId
        holderId = suppliedHolderId as HolderId
        purpose = suppliedPurpose
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        namespace = undefined
    }
    if (!namespace || !stackId || !holderId || !purpose) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'destructive drain recovery inspection input is malformed', 'destructive drain recovery')
    }
    const address = namespace.paths.coordination(stackId)
    const stored = await readState(address)
    if (stored.kind === 'missing') {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'destructive recovery requires current coordination state', address.path)
    }
    if (stored.kind !== 'complete') return stateRefusal(stored)
    const record = stored.value
    const value = decodeCoordinationRecord(record, stackId)
    if (!value) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', address.path)
    if (value.drain == null) {
        const others = value.holders.filter((holder) => holder.holderId !== holderId)
        if (others.length > 0 && value.holders.some((holder) => holder.holderId === holderId)) {
            return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, liveHolderMessage(others), stackId)
        }
        if (value.holders.length !== 1 || value.holders[0]?.holderId !== holderId
            || value.lease === null || value.lease.released) {
            return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'destructive recovery requires exact retained holder and lease ownership', stackId)
        }
        return { kind: 'none' }
    }
    const reservation = value.drain
    if (reservation.holderId !== holderId || reservation.requesterId !== holderId) {
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'persisted drain belongs to another holder', stackId)
    }
    if (reservation.purpose !== purpose) {
        return refuse(ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED, 'persisted drain requires explicit repair', stackId)
    }
    if (reservation.attempt?.status === 'active') {
        return issueDrainRepair(namespace, address, record, reservation)
            ?? refuse(ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED,
                'the interrupted destructive executor has no repairable execution fence', stackId)
    }
    const request = snapshotDrainRequest({
        purpose: reservation.purpose,
        stackId: reservation.stackId,
        holderId: reservation.holderId,
        requesterId: reservation.requesterId,
        configSha256: reservation.configSha256,
        planDigest: reservation.planDigest,
        operationBasis: reservation.operationBasis,
        generation: reservation.generation,
        targetIds: reservation.targetIds,
        actions: reservation.actions,
        expectedCoordinationRevision: reservation.expectedCoordinationRevision,
    })
    return request ? { kind: 'recoverable', request }
        : refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'persisted destructive drain is malformed', address.path)
}

export async function inspectSleepDrainRecovery(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
}): Promise<SleepDrainRecoveryInspection> {
    let namespace: StateNamespace | undefined
    let stackId: StackId | undefined
    let holderId: HolderId | undefined
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || !hasExactKeys(input, ['namespace', 'stackId', 'holderId'])) throw new RefusalError('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (!('value' in descriptors.namespace!) || !('value' in descriptors.stackId!)
            || !('value' in descriptors.holderId!)) throw new RefusalError('invalid')
        namespace = authenticateStateNamespace(descriptors.namespace!.value)
        const suppliedStackId = descriptors.stackId!.value
        const suppliedHolderId = descriptors.holderId!.value
        if (typeof suppliedStackId !== 'string' || typeof suppliedHolderId !== 'string'
            || !validIdentity(suppliedStackId, stackIdentity) || !validIdentity(suppliedHolderId, holderIdentity)) throw new RefusalError('invalid')
        stackId = suppliedStackId as StackId
        holderId = suppliedHolderId as HolderId
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        namespace = undefined
    }
    if (!namespace || !stackId || !holderId) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'sleep drain recovery inspection input is malformed', 'sleep drain recovery')
    }
    const address = namespace.paths.coordination(stackId)
    const stored = await readState(address)
    if (stored.kind === 'missing') return { kind: 'none' }
    if (stored.kind !== 'complete') return stateRefusal(stored)
    const record = stored.value
    const value = decodeCoordinationRecord(record, stackId)
    if (!value) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', address.path)
    if (value.drain == null) return { kind: 'none' }
    const reservation = value.drain
    if (reservation.holderId !== holderId || reservation.requesterId !== holderId) {
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'persisted drain belongs to another holder', stackId)
    }
    if (reservation.purpose !== 'sleep') {
        return refuse(ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED, 'persisted drain requires explicit repair', stackId)
    }
    if (reservation.attempt?.status === 'active') {
        return issueDrainRepair(namespace, address, record, reservation)
            ?? refuse(ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED,
                'the interrupted sleep executor has no repairable execution fence', stackId)
    }
    const runtimeStop = reservation.actions[0]
    const fingerprint = exactRecordFingerprint(record)
    if (!runtimeStop || runtimeStop.stage !== 'runtime-stop' || runtimeStop.targetId !== stackId || fingerprint === undefined) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'persisted sleep drain is malformed', address.path)
    }
    if (drainAuthorityEpochs.get(reservation.reservationId) === drainAuthorityEpoch(reservation)) {
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'persisted drain already has authority for its current state', stackId)
    }
    const authority = {} as SleepDrainRecoveryAuthority
    sleepDrainRecoveries.set(authority, {
        namespace,
        address: Object.freeze({ ...address }),
        recordFingerprint: fingerprint,
        reservation: snapshotDrainReservation(reservation),
    })
    return {
        kind: 'recoverable',
        generation: reservation.generation,
        runtimeStopValidForMs: runtimeStop.validForMs,
        authority,
    }
}

export async function recoverSleepDrainReservation(input: {
    readonly namespace: StateNamespace
    readonly authority: SleepDrainRecoveryAuthority
    readonly request: DrainReservationRequest
}): Promise<DrainReservationResult> {
    let namespace: StateNamespace | undefined
    let authority: SleepDrainRecoveryAuthority | undefined
    let request: DrainReservationRequest | undefined
    let issued: SleepDrainRecoveryRecord | undefined
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RefusalError('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if ('value' in descriptors.authority!) {
            authority = descriptors.authority!.value as SleepDrainRecoveryAuthority
            issued = authority && typeof authority === 'object' ? sleepDrainRecoveries.get(authority) : undefined
            if (issued) sleepDrainRecoveries.delete(authority)
        }
        if (!hasExactKeys(input, ['namespace', 'authority', 'request'])
            || !('value' in descriptors.namespace!) || !('value' in descriptors.authority!)
            || !('value' in descriptors.request!)) throw new RefusalError('invalid')
        namespace = authenticateStateNamespace(descriptors.namespace!.value)
        request = snapshotDrainRequest(descriptors.request!.value)
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        namespace = undefined
    }
    if (!namespace || !authority || !request || !issued) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'sleep drain recovery input is malformed', 'sleep drain recovery')
    }
    if (namespace !== issued.namespace) {
        return refuse(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED, 'sleep drain recovery namespace changed', issued.address.path)
    }
    const stored = await readState(issued.address)
    if (stored.kind !== 'complete') {
        return stored.kind === 'missing'
            ? refuse(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED, 'persisted sleep drain disappeared', stored.path)
            : stateRefusal(stored)
    }
    if (exactRecordFingerprint(stored.value) !== issued.recordFingerprint) {
        return refuse(ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED, 'persisted sleep drain changed before recovery', issued.address.path)
    }
    const value = decodeCoordinationRecord(stored.value, issued.reservation.stackId)
    if (!value?.drain || !sameSnapshot(value.drain, issued.reservation)) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'persisted sleep drain is malformed', issued.address.path)
    }
    if (request.expectedCoordinationRevision !== stored.value.revision) {
        return refuse(
            ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
            'fresh sleep drain planning evidence does not name the current coordination revision',
            issued.address.path,
        )
    }
    const persistedRequest = {
        ...request,
        expectedCoordinationRevision: issued.reservation.expectedCoordinationRevision,
    }
    if (request.purpose !== 'sleep' || !sameDrainRequest(issued.reservation, persistedRequest)) {
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'persisted sleep drain does not match fresh planning evidence', issued.reservation.stackId)
    }
    const epoch = drainAuthorityEpoch(issued.reservation)
    if (drainAuthorityEpochs.get(issued.reservation.reservationId) === epoch) {
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'persisted drain already has authority for its current state', issued.reservation.stackId)
    }
    return {
        kind: 'complete',
        reservation: issued.reservation,
        authority: issueDrainAuthority(issued.reservation, stored.value, issued.address),
    }
}

export async function recoverDrainReservation(input: {
    readonly namespace: StateNamespace
    readonly request: DrainReservationRequest
}): Promise<DrainReservationResult> {
    let namespace: StateNamespace | undefined
    let request: DrainReservationRequest | undefined
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input) || !hasExactKeys(input, ['namespace', 'request'])) throw new RefusalError('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (!('value' in descriptors.namespace!) || !('value' in descriptors.request!)) throw new RefusalError('invalid')
        namespace = snapshotStateNamespace(descriptors.namespace!.value as StateNamespace)
        request = snapshotDrainRequest(descriptors.request!.value)
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        namespace = undefined
        request = undefined
    }
    if (!namespace || !request) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'drain recovery input is malformed', 'drain recovery')
    const stored = await readState(namespace.paths.coordination(request.stackId))
    if (stored.kind !== 'complete') {
        return stored.kind === 'missing'
            ? refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'drain recovery found no coordination record', stored.path)
            : stateRefusal(stored)
    }
    const value = decodeCoordinationRecord(stored.value, request.stackId)
    if (!value?.drain || !sameDrainRequest(value.drain, request)) {
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'persisted drain does not match the recovery request', request.stackId)
    }
    if (value.drain.attempt?.status === 'active') {
        return refuse(ENVIRONMENT_CODES.DRAIN_ATTEMPT_REPAIR_REQUIRED, 'the active destructive attempt requires explicit repair', request.stackId)
    }
    const expectedRevision = value.drain.attempt?.failedRevision ?? value.drain.progressRevision
    const epoch = drainAuthorityEpoch(value.drain)
    if (stored.value.revision !== expectedRevision || drainAuthorityEpochs.get(value.drain.reservationId) === epoch) {
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'persisted drain already has authority for its current state', request.stackId)
    }
    return {
        kind: 'complete', reservation: value.drain,
        authority: issueDrainAuthority(value.drain, stored.value, namespace.paths.coordination(request.stackId)),
    }
}

function failedReclaimRecoveryTarget(action: Extract<DrainAction, { readonly stage: 'reclaim' }>): FailedReclaimRecoveryTarget {
    return {
        targetId: action.targetId,
        targetCommitment: { ...action.targetCommitment },
    }
}

export function inspectFailedReclaimRecovery(input: {
    readonly authority: DrainReservationAuthority
    readonly record: StateRecord
}): FailedReclaimRecoveryAuthority | undefined {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = Reflect.ownKeys(descriptors)
        if (keys.length !== 2 || keys.some((key) => typeof key !== 'string')
            || !keys.includes('authority') || !keys.includes('record')) return undefined
        if (!('value' in descriptors.authority!) || !('value' in descriptors.record!)) return undefined
        const authority = descriptors.authority!.value as DrainReservationAuthority
        const record = snapshotDataOnly(descriptors.record!.value) as StateRecord | undefined
        if (!authority || typeof authority !== 'object' || !drainAuthorities.has(authority) || !record) return undefined
        const boundRecord = drainAuthorityRecords.get(authority)
        if (boundRecord === undefined || exactRecordFingerprint(record) !== boundRecord) return undefined
        const reservation = authority.reservation
        const value = decodeCoordinationRecord(record, reservation.stackId)
        if (!value?.drain || !sameSnapshot(value.drain, reservation)) return undefined
        const attempt = reservation.attempt
        const action = attempt && reservation.actions[attempt.actionIndex]
        if (!attempt || attempt.status !== 'failed' || attempt.currentStage !== 'reclaim'
            || reservation.purpose !== 'down' && reservation.purpose !== 'reset'
            || record.revision !== attempt.failedRevision || !isCanonicalTimestamp(record.updatedAt)
            || Date.parse(record.updatedAt) < Date.parse(attempt.failedAt!) || Date.parse(record.updatedAt) > Date.now()
            || Date.parse(reservation.reservedAt) > Date.parse(attempt.committedAt)
            || reservation.progressRevision !== attempt.committedRevision - 1
            || attempt.failedRevision !== attempt.committedRevision + 1
            || reservation.completedActionCount !== attempt.actionIndex
            || !action || action.stage !== 'reclaim' || action.targetId !== attempt.currentTarget
            || !action.targetCommitment
            || !validDrainActions(reservation.purpose, reservation.stackId, reservation.targetIds, reservation.actions)) return undefined
        const reclaimActions = reservation.actions.filter((candidate): candidate is Extract<DrainAction, { readonly stage: 'reclaim' }> => candidate.stage === 'reclaim')
        const currentIndex = attempt.actionIndex - 1
        if (currentIndex < 0 || reclaimActions[currentIndex] !== action) return undefined
        const recovery = {
            purpose: reservation.purpose,
            stackId: reservation.stackId,
            configSha256: reservation.configSha256,
            planDigest: reservation.planDigest,
            freshAfter: record.updatedAt,
            completed: reclaimActions.slice(0, currentIndex).map(failedReclaimRecoveryTarget),
            current: failedReclaimRecoveryTarget(action),
            pending: reclaimActions.slice(currentIndex + 1).map(failedReclaimRecoveryTarget),
        } satisfies FailedReclaimRecovery
        const candidateAuthority = {} as FailedReclaimRecoveryAuthority
        failedReclaimRecoveries.set(candidateAuthority, recovery)
        return candidateAuthority
    } catch {
        // Any failure leaves the authority unminted; the caller refuses a missing authority.
        return undefined
    }
}

export function consumeFailedReclaimRecovery(authority: FailedReclaimRecoveryAuthority): FailedReclaimRecovery | undefined {
    if (!authority || typeof authority !== 'object') return undefined
    const recovery = failedReclaimRecoveries.get(authority)
    if (!recovery) return undefined
    failedReclaimRecoveries.delete(authority)
    return recovery
}

function sameDrainFact(reservation: DrainReservation, fact: RuntimeStopped): boolean {
    return reservation.attempt !== null && fact.purpose === reservation.purpose && fact.stackId === reservation.stackId
        && fact.configSha256 === reservation.configSha256 && fact.planDigest === reservation.planDigest
        && fact.operationBasis === reservation.operationBasis
        && fact.coordinationRevision === reservation.coordinationRevision
        && fact.reservationId === reservation.reservationId && fact.reservedAt === reservation.reservedAt
        && fact.generation === reservation.attempt.generation && isCanonicalTimestamp(fact.observedAt)
        && fact.attemptId === reservation.attempt.attemptId
        && fact.attemptRevision === reservation.attempt.committedRevision
        && fact.attemptCommittedAt === reservation.attempt.committedAt
        && fact.validThrough === reservation.attempt.validThrough
        && fact.actionIndex === reservation.attempt.actionIndex
        && fact.currentTarget === reservation.attempt.currentTarget
        && fact.currentStage === reservation.attempt.currentStage
        && Date.parse(fact.observedAt) >= Date.parse(reservation.attempt.committedAt)
        && Date.parse(fact.observedAt) <= Date.parse(reservation.attempt.validThrough)
        && Date.parse(fact.observedAt) <= Date.now()
}

const runtimeStoppedKeys = [
    'purpose', 'stackId', 'configSha256', 'planDigest', 'operationBasis', 'coordinationRevision',
    'reservationId', 'reservedAt', 'generation', 'attemptId', 'attemptRevision', 'attemptCommittedAt',
    'validThrough', 'actionIndex', 'currentTarget', 'currentStage', 'observedAt',
] as const

function isExactDrainSuccess(reservation: DrainReservation, fact: unknown): fact is RuntimeStopped | ReclaimCompleted {
    if (!fact || typeof fact !== 'object' || !reservation.attempt) return false
    if (reservation.attempt.currentStage === 'runtime-stop') {
        return hasExactKeys(fact, runtimeStoppedKeys) && sameDrainFact(reservation, fact as RuntimeStopped)
    }
    if (!hasExactKeys(fact, [...runtimeStoppedKeys, 'remainingTargetIds'])) return false
    const reclaim = fact as ReclaimCompleted
    const remaining = snapshotDrainTargetsAllowEmpty(reclaim.remainingTargetIds)
    const expected = reservation.actions.slice(reservation.attempt.actionIndex + 1).map(({ targetId }) => targetId)
    return sameDrainFact(reservation, reclaim) && remaining !== undefined && sameTargets(remaining, expected)
}

function snapshotDrainTargetsAllowEmpty(value: unknown): readonly string[] | undefined {
    if (Array.isArray(value) && value.length === 0) return []
    return snapshotDrainTargets(value)
}

function reduceDrainAttemptSuccess(input: {
    readonly record: StateRecord
    readonly authority: DrainAttemptSuccessAuthority
}): CoordinationRecord | undefined {
    const owned = snapshotExactReducerInput(input, ['record', 'authority'])
    if (!owned) return undefined
    const record = owned.record as StateRecord
    const authority = Object.getOwnPropertyDescriptor(input, 'authority')?.value as object
    const issued = authority && typeof authority === 'object' ? drainAttemptSuccessAuthorities.get(authority) : undefined
    const reservation = issued?.reservation
    const success = issued?.fact
    if (!reservation?.attempt || reservation.attempt.status !== 'active'
        || reservation.attempt.actionIndex >= reservation.actions.length - 1
        || !record || record.revision !== reservation.attempt.committedRevision
        || !success || !isExactDrainSuccess(reservation, success)) return undefined
    const value = decodeCoordinationRecord(record, reservation.stackId)
    if (!value?.drain?.attempt || !sameDrainRequest(value.drain, reservation)
        || value.drain.reservationId !== reservation.reservationId
        || !sameDrainAttempt(value.drain.attempt, reservation.attempt)) return undefined
    return {
        ...value,
        drain: {
            ...value.drain,
            completedActionCount: value.drain.completedActionCount + 1,
            progressRevision: value.drain.attempt.committedRevision + 1,
            attempt: null,
        },
    }
}

function snapshotExactReducerInput(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !hasExactKeys(value, keys)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (keys.some((key) => !('value' in descriptors[key]!))) return undefined
        const result: Record<string, unknown> = {}
        for (const key of keys) {
            const snapshot = snapshotDataOnly(descriptors[key]!.value)
            if (snapshot === undefined) return undefined
            result[key] = snapshot
        }
        return result
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

// CAS callbacks may retry; burn outcome authority only after publication is definite.
function finalizeDrainAttemptOutcome(authority: DrainAttemptSuccessAuthority | DrainAttemptFailureAuthority): boolean {
    if (!authority || typeof authority !== 'object') return false
    if (drainAttemptSuccessAuthorities.delete(authority)) return true
    return drainAttemptFailureAuthorities.delete(authority)
}

function reduceDrain(input: {
    readonly record: StateRecord
    readonly authority: DrainAttemptSuccessAuthority
}): CoordinationRecord | undefined {
    const owned = snapshotExactReducerInput(input, ['record', 'authority'])
    if (!owned) return undefined
    const record = owned.record as unknown as StateRecord
    const authority = Object.getOwnPropertyDescriptor(input, 'authority')?.value as object
    const issued = authority && typeof authority === 'object' ? drainAttemptSuccessAuthorities.get(authority) : undefined
    const reservation = issued?.reservation
    const success = issued?.fact
    if (!reservation?.attempt || !record || typeof record !== 'object'
        || reservation.attempt.actionIndex !== reservation.actions.length - 1
        || reservation.completedActionCount !== reservation.actions.length - 1
        || !Number.isSafeInteger(record.revision) || record.revision !== reservation.attempt.committedRevision
        || !success || !isExactDrainSuccess(reservation, success)) return undefined
    const value = decodeCoordinationRecord(record, reservation.stackId)
    if (!value?.drain || !sameDrainRequest(value.drain, reservation)
        || value.drain.coordinationRevision !== reservation.coordinationRevision
        || value.drain.reservationId !== reservation.reservationId
        || value.drain.reservedAt !== reservation.reservedAt
        || !value.drain.attempt || !sameDrainAttempt(value.drain.attempt, reservation.attempt)
        || value.drain.attempt.status !== 'active') return undefined
    return {
        holders: [],
        lease: value.lease === null ? null : { ...value.lease, released: true },
        lastReleasedHolder: value.drain.holderId,
        drain: null,
    }
}

function stateRefusal(result: Exclude<StateResult<StateRecord>, { kind: 'complete' | 'missing' }>): ClaimMutationRefusal {
    return refuse(
        result.code,
        result.message,
        result.target,
        'recovery' in result ? result.recovery : undefined,
    )
}

async function transactClaim<T>(
    namespace: StateNamespace,
    stackId: StackId,
    ownerId: HolderId,
    update: (current: StateRecord | null) => StateRecord | StateTransactionAbort<T>,
    beforeCommit?: () => StateTransactionAbort<T> | undefined,
): Promise<StateResult<StateRecord> | T> {
    const result = await transactState(
        namespace,
        namespace.paths.coordination(stackId),
        { ownerId, contentionTimeoutMs: 2_000, beforeCommit },
        update,
    )
    const aborted = result as StateTransactionAbort<T>
    return aborted.aborted === true ? aborted.value : result as StateResult<StateRecord>
}

export async function releaseClaim(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly requesterId: HolderId
    readonly holderId: HolderId
    readonly now: string
}): Promise<ReleaseClaimResult> {
    let request: {
        readonly namespace: StateNamespace
        readonly stackId: StackId
        readonly requesterId: HolderId
        readonly holderId: HolderId
        readonly now: string
    }
    try {
        const namespaceProperty = Object.getOwnPropertyDescriptor(input, 'namespace')
        if (!namespaceProperty || !('value' in namespaceProperty)) throw new RefusalError('invalid namespace property')
        const stableNamespace = snapshotStateNamespace(namespaceProperty.value as StateNamespace)
        if (!stableNamespace) throw new RefusalError('invalid namespace')
        request = {
            namespace: stableNamespace,
            stackId: input.stackId,
            requesterId: input.requesterId,
            holderId: input.holderId,
            now: input.now,
        }
    } catch (error) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, `claim release input could not be read safely: ${errorCause(error)}`, 'claim release input')
    }
    if (
        !validIdentity(request.stackId, stackIdentity)
        || !validIdentity(request.requesterId, holderIdentity)
        || !validIdentity(request.holderId, holderIdentity)
        || !isCanonicalTimestamp(request.now)
    ) {
        return refuse(
            ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
            'claim release requires canonical stack, holder, and timestamp values',
            String(request.stackId ?? ''),
        )
    }
    // A holder whose session is gone is released by `releaseDeadSessionHolders`, which proves the
    // death itself; no other holder's claim is this function's to drop.
    if (request.requesterId !== request.holderId) {
        return refuse(
            ENVIRONMENT_CODES.CLAIM_CO_TENANT,
            'a holder can release only its own claim',
            request.holderId,
        )
    }

    const result = await transactClaim<ReleaseClaimResult>(
        request.namespace,
        request.stackId,
        request.requesterId,
        (current) => {
            const value = decodeCoordinationRecord(current, request.stackId)
            if (!value) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', request.stackId))
            if (isDrainActive(value)) return abortStateTransaction(refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'claim release is blocked while the stack has an exclusive mutation', request.stackId))
            const holders = value.holders.filter((holder) => holder.holderId !== request.holderId)
            if (holders.length === value.holders.length) {
                if (holders.length === 0) {
                    return abortStateTransaction(refuse(
                        ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                        'claim release requires an active non-final holder',
                        request.stackId,
                    ))
                }
                return abortStateTransaction({
                    kind: 'complete', change: 'unchanged', decision: 'retain',
                    remaining: holders.map((holder) => holder.holderId),
                })
            }
            if (holders.length === 0) {
                return abortStateTransaction(refuse(
                    ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                    'the final holder must reserve and complete a drain before releasing the stack',
                    request.stackId,
                ))
            }
            return coordinationStateRecord(request.namespace, request.stackId, current, new Date().toISOString(), {
                holders,
                lease: value.lease,
                lastReleasedHolder: request.holderId,
                drain: value.drain,
            })
        },
    )
    if ('diagnostics' in result || 'remaining' in result) return result
    if (result.kind === 'missing') {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'claim transaction returned no record', result.path)
    }
    if (result.kind !== 'complete') return stateRefusal(result)
    const value = decodeCoordinationRecord(result.value, request.stackId)
    if (!value) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'published claim record is malformed', result.value.subjectId)
    }
    const remaining = value.holders.map((holder) => holder.holderId)
    return {
        kind: 'complete',
        change: 'released',
        decision: remaining.length === 0 ? 'stop' : 'retain',
        remaining,
    }
}
