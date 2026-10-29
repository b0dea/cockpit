import { z } from 'zod'
import { lstatSync } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { platform } from 'node:os'
import { STRUCTURED_INPUT_ENTRY_LIMIT } from '../schema.js'
import {
    ENVIRONMENT_CODES,
    OBSERVATION_PRODUCER_BYTE_LIMIT,
    OBSERVATION_REASON_BYTE_LIMIT,
    REFUSAL_CODES,
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
    type Observation,
    type EnvironmentCommandOutcome,
    type ExecutionPlan,
    type ExecutionStep,
    type ExecutionFence,
    type JsonSnapshot,
    type StackId,
} from './contract.js'
import { authenticatedExecutionOutcome, consumeFencedExecutionTermination, type ExecuteProbeOutcome, type FencedExecutionTermination } from '../environment-exec/execute.js'
import { resolvedExecutable, type ResolvedExecutable } from './executable.js'
import { observeConfigSource } from '../config/load.js'
import { checkoutId as deriveCheckoutId } from './identity.js'
import {
    abortStateTransaction,
    authenticateStateNamespace,
    authenticateStatePublication,
    inspectStateLock,
    parseCoordinationStateEntry,
    readState,
    SERIALIZED_RECORD_BYTE_LIMIT,
    snapshotStateNamespace,
    transactState,
    withStateNamespaceInventory,
    type StateNamespace,
    type StateAddress,
    type StateRecord,
    type StateResult,
    type StateTransactionAbort,
    type StateTransactionOptions,
} from './state.js'

export const mechanism = {
    id: 'environment-claims',
    module: 'packages/cockpit/src/environment/claims.ts',
    exports: [
        'acquireClaim', 'releaseClaim', 'createHolderProcessProbePlan', 'collectHolderProcessProbe', 'observeHolderCheckouts', 'classifyHolders', 'decodeCoordinationRecord',
        'addCoordinationHolder', 'removeExactCoordinationHolder', 'coordinationStateRecord', 'readActiveStackInventory', 'readRootPortInventory', 'observeClaimState', 'isClaimObservation', 'observationDeclarations',
        'reserveDrain', 'recoverDrainReservation', 'inspectSleepDrainRecovery', 'inspectDestructiveDrainRecovery', 'settleInterruptedDrainRepair', 'recoverSleepDrainReservation', 'consumeDrainReservationAuthority', 'discardDrainReservationAuthority', 'inspectFailedReclaimRecovery', 'consumeFailedReclaimRecovery', 'inspectDrainAttemptAuthority', 'reserveDrainAttempt', 'openRuntimeDrainExecution', 'inspectDrainExecutionFence', 'settleRuntimeDrainSuccess', 'settleRuntimeDrainFailure', 'openReclaimDrainExecution', 'settleReclaimDrainSuccess', 'settleReclaimDrainFailure', 'matchReclaimDrainContinuation', 'reduceDrainOutcome', 'prepareDrainOutcomePublication', 'finalizeDrainOutcome', 'isDrainActive', 'issueRestoreExecutionAuthority', 'consumeRestoreExecutionAuthority', 'settleRestoreExecutionAuthority',
    ],
} as const

export const observationDeclarations = Object.freeze([
    { id: 'claim-state', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'not-applicable', reason: 'claims do not exist before the first seed' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.CLAIM_STATE_UNHEALTHY, isIssued: isClaimObservation, issuedAt: observationIssuedAt },
] as const)

const issuedObservations = new WeakMap<object, number>()

function issueObservation(value: EnvironmentObservation): EnvironmentObservation {
    const snapshot = snapshotEnvironmentObservation(value)
    if (!snapshot || snapshot.owner !== mechanism.id) throw new TypeError('claim observation is malformed')
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
        throw new TypeError('claim observation input is malformed')
    }
    const inventory = await readActiveStackInventory(namespace)
    const refusal = inventory.kind === 'refusal' ? inventory.diagnostics[0] : undefined
    return issueObservation({
        code: ENVIRONMENT_CODES.CLAIM_STATE_UNHEALTHY,
        owner: mechanism.id,
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
}).strict()

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

const RestoreReservationSchema = z.object({
    reservationId: z.string().regex(sha256Identity),
    stackId: z.string().regex(stackIdentity),
    holderId: z.string().regex(holderIdentity),
    requesterId: z.string().regex(holderIdentity),
    configPath: z.string().min(1).max(4096).refine(isAbsolute),
    configSha256: z.string().regex(sha256Identity),
    stepSha256: z.string().regex(sha256Identity),
    reservedAt: z.string().refine(isCanonicalTimestamp),
}).strict().refine((value) => value.holderId === value.requesterId)

const CoordinationValueSchema = z.object({
    holders: z.array(ClaimHolderSchema).max(STRUCTURED_INPUT_ENTRY_LIMIT),
    lease: PortLeaseRecordSchema.nullable(),
    lastReleasedHolder: z.string().regex(holderIdentity).nullable().optional().default(null),
    drain: DrainReservationSchema.nullable().optional().default(null),
    restore: RestoreReservationSchema.nullable().optional().default(null),
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
        || value.restore !== null && (
            value.drain !== null
            || value.holders.length !== 1
            || value.lease === null
            || value.lease.released
            || value.restore.holderId !== value.restore.requesterId
            || value.holders[0]?.holderId !== value.restore.holderId
        )
    ) {
        context.addIssue({ code: 'custom', message: 'coordination invariants are inconsistent' })
    }
})

const HolderLivenessEvidenceSchema = z.discriminatedUnion('state', [
    z.object({ state: z.literal('live') }).strict(),
    z.object({ state: z.literal('dead'), evidence: z.enum(['process-absent', 'checkout-missing']) }).strict(),
])

const HolderObservationSchema = z.discriminatedUnion('state', [
    z.object({
        state: z.literal('available'),
        value: HolderLivenessEvidenceSchema,
        observedAt: z.string().refine(isCanonicalTimestamp),
        producer: z.string().min(1),
    }).strict(),
    z.object({ state: z.literal('unavailable'), reason: z.string().min(1), producer: z.string().min(1) }).strict(),
    z.object({
        state: z.literal('failed'),
        code: z.enum(REFUSAL_CODES),
        reason: z.string().min(1),
        producer: z.string().min(1),
    }).strict(),
])

export interface ClaimHolder {
    readonly holderId: HolderId
    readonly checkoutId: CheckoutId
    readonly claimedAt: string
    readonly pid?: number
}

export interface ClaimRecord {
    readonly holders: readonly ClaimHolder[]
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
    readonly restore?: RestoreReservation | null
}

declare const restoreExecutionAuthorityBrand: unique symbol
export interface RestoreExecutionAuthority {
    readonly [restoreExecutionAuthorityBrand]: true
}

interface RestoreExecutionContract {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly requesterId: HolderId
    readonly configPath: string
    readonly configSha256: string
    readonly stepSha256: string
    readonly revision: number
    readonly reservationId: string
}

const restoreExecutionAuthorities = new WeakMap<object, RestoreExecutionContract>()
const restoreExecutionLeases = new WeakMap<object, RestoreExecutionContract>()

interface RestoreReservation {
    readonly reservationId: string
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly requesterId: HolderId
    readonly configPath: string
    readonly configSha256: string
    readonly stepSha256: string
    readonly reservedAt: string
}

declare const restoreExecutionLeaseBrand: unique symbol
export interface RestoreExecutionLease {
    readonly [restoreExecutionLeaseBrand]: true
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
const drainOutcomePublications = new WeakMap<object, {
    readonly revision: number
    readonly value: JsonSnapshot
    readonly kind: 'coordination'
    readonly cockpitId: CockpitId
    readonly subjectId: string
    readonly notBefore: string
    readonly updatedAt: string
    readonly address: StateAddress
}>()
const drainContinuationEvidence = new WeakMap<object,
    | { readonly kind: 'progress'; readonly authority: DrainProgressAuthority }
    | { readonly kind: 'failure'; readonly authority: DrainAttemptFailureAuthority }>()

declare const releaseAuthorityBrand: unique symbol

export interface HolderReleaseAuthority {
    readonly [releaseAuthorityBrand]: true
    readonly stackId: StackId
    readonly requesterId: HolderId
    readonly holderId: HolderId
    readonly claimedAt: string
    readonly recordRevision: number
    readonly requestedAt: string
    readonly observedAt: string
    readonly validThrough: string
    readonly producer: string
}

const releaseAuthorities = new WeakSet<object>()
const reservedReleaseAuthorities = new WeakSet<object>()
const releaseAuthorityCheckoutPaths = new WeakMap<object, string>()
const issuedHolderObservations = new WeakMap<object, {
    readonly subjectId: StackId
    readonly revision: number
    readonly requestedAt: string
    readonly timeoutMs: number
    readonly checkoutPaths?: ReadonlyMap<HolderId, string>
}>()

type ClaimMutationRefusal = {
    readonly kind: 'refusal'
    readonly diagnostics: readonly EnvironmentDiagnostic[]
}

export type AcquireClaimResult =
    | {
          readonly kind: 'complete'
          readonly change: 'acquired' | 'unchanged'
          readonly holders: readonly HolderId[]
          readonly ownership: Readonly<{ stackId: StackId; holderId: HolderId; recordRevision: number; change: 'acquired' | 'unchanged' }>
      }
    | ClaimMutationRefusal

export type ReleaseClaimResult =
    | {
          readonly kind: 'complete'
          readonly change: 'released' | 'unchanged'
          readonly decision: 'stop' | 'retain'
          readonly remaining: readonly HolderId[]
      }
    | ClaimMutationRefusal

export type HolderLivenessEvidence =
    | { readonly state: 'live' }
    | { readonly state: 'dead'; readonly evidence: 'process-absent' | 'checkout-missing' }

export interface HolderObservationInput {
    readonly holderId: HolderId
    readonly observation: Observation<HolderLivenessEvidence>
}

export interface HolderProcessProbe {
    readonly requestedAt: string
    readonly observations: readonly HolderObservationInput[]
}

export interface HolderCheckoutProbe extends HolderProcessProbe {
    readonly timeoutMs: number
}

const issuedHolderProbePlans = new WeakMap<object, {
    readonly subjectId: StackId
    readonly revision: number
    readonly timeoutMs: number
    readonly holderIds: readonly HolderId[]
}>()

const HOLDER_PROCESS_PROBE = "const p=Number(process.argv[1]);const c=()=>{try{process.kill(p,0);return'live'}catch(e){return e&&e.code==='ESRCH'?'absent':'unavailable'}};const a=c(),b=c();process.stdout.write(a===b?a:'unavailable')"

export async function createHolderProcessProbePlan(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly executable: ResolvedExecutable
    readonly timeoutMs: number
}): Promise<EnvironmentCommandOutcome<null>> {
    if (!input || typeof input !== 'object' || !hasExactKeys(input, ['namespace', 'stackId', 'executable', 'timeoutMs'])) {
        throw new TypeError('holder process probe input is malformed')
    }
    const namespace = snapshotStateNamespace(input?.namespace)
    if (!namespace || !validIdentity(input?.stackId, stackIdentity)) throw new TypeError('holder process probe input is malformed')
    const stored = await readState(namespace.paths.coordination(input.stackId))
    if (stored.kind !== 'complete') throw new TypeError('holder process probe coordination is unavailable')
    const record = stored.value
    const value = decodeCoordinationRecord(record, input.stackId)
    const executable = resolvedExecutable(input?.executable)
    if (!value || !Number.isSafeInteger(record.revision) || !Number.isSafeInteger(input.timeoutMs)
        || input.timeoutMs < 1 || input.timeoutMs > 30_000 || !executable
        || executable.canonicalPath !== process.execPath
        || executable.invocationPath !== executable.canonicalPath
        || executable.executionMode !== 'verified-path'
        || value.holders.some(({ pid }) => !Number.isSafeInteger(pid) || pid! < 1 || pid! > 2_147_483_647)) {
        throw new TypeError('holder process probe input is malformed')
    }
    const steps = value.holders.map(({ holderId, pid }): ExecutionStep => Object.freeze({
        id: `holder:probe:${holderId.slice(7, 19)}`,
        argv: Object.freeze([executable.canonicalPath, '-e', HOLDER_PROCESS_PROBE, String(pid)] as const),
        argv0: executable.invocationPath, cwd: dirname(executable.canonicalPath), env: Object.freeze({}), timeoutMs: input.timeoutMs,
        stdoutLimitBytes: 1_024, stderrLimitBytes: 1_024, paths: Object.freeze([]), ports: Object.freeze([]),
        labels: Object.freeze({ holderId }), expected: Object.freeze([]),
        consumedFiles: Object.freeze([Object.freeze({ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912, argvIndexes: Object.freeze([0]), executable: true, executionMode: executable.executionMode })]),
        filesystemChecks: Object.freeze([]), compensation: Object.freeze([]),
    }))
    const plan = snapshotExecutionPlan({ steps })
    if (!plan) throw new TypeError('holder process probe input is malformed')
    issuedHolderProbePlans.set(plan, Object.freeze({
        subjectId: record.subjectId as StackId,
        revision: record.revision,
        timeoutMs: input.timeoutMs,
        holderIds: Object.freeze(value.holders.map(({ holderId }) => holderId)),
    }))
    return { kind: 'preview', status: 0, diagnostics: [], result: null, plan }
}

export function collectHolderProcessProbe(plan: ExecutionPlan, outcomes: readonly ExecuteProbeOutcome[]): HolderProcessProbe | undefined {
    const contract = issuedHolderProbePlans.get(plan)
    if (!contract || outcomes.length !== contract.holderIds.length || plan.steps.length !== contract.holderIds.length) return undefined
    const authenticated = outcomes.map((outcome, index) => authenticatedExecutionOutcome(outcome, plan.steps[index]!))
    if (authenticated.some((outcome) => !outcome?.receipt || outcome.kind !== 'complete')) return undefined
    const requestedAt = authenticated.map((outcome) => outcome!.receipt!.startedAt).sort()[0]!
    const observations: HolderObservationInput[] = []
    for (const [index, outcome] of authenticated.entries()) {
        let result: string
        try { result = new TextDecoder('utf-8', { fatal: true }).decode(outcome!.stdout) } catch { return undefined }
        if (result !== 'live' && result !== 'absent' && result !== 'unavailable') return undefined
        observations.push(Object.freeze({
            holderId: contract.holderIds[index]!,
            observation: Object.freeze({
                state: 'unavailable' as const,
                reason: 'process liveness has no issued long-lived holder association',
                producer: 'bounded-process-probe',
            }),
        }))
    }
    const ownedObservations = Object.freeze(observations)
    return Object.freeze({ requestedAt, observations: ownedObservations })
}

export async function observeHolderCheckouts(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly timeoutMs: number
    readonly checkouts: readonly { readonly checkoutId: CheckoutId; readonly path: string }[]
}): Promise<HolderCheckoutProbe> {
    let owned: { namespace: unknown; stackId: unknown; timeoutMs: unknown; checkouts: unknown }
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid input')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = Reflect.ownKeys(descriptors)
        const expected = ['checkouts', 'namespace', 'stackId', 'timeoutMs']
        if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) throw new Error('invalid input')
        if (expected.some((key) => !('value' in descriptors[key]!))) throw new Error('invalid input')
        owned = {
            namespace: descriptors.namespace!.value,
            stackId: descriptors.stackId!.value,
            timeoutMs: descriptors.timeoutMs!.value,
            checkouts: descriptors.checkouts!.value,
        }
    } catch { throw new TypeError('holder checkout probe input is malformed') }
    const namespace = snapshotStateNamespace(owned.namespace as StateNamespace)
    const checkouts: { readonly checkoutId: CheckoutId; readonly path: string }[] = []
    try {
        if (!Array.isArray(owned.checkouts)) throw new Error('invalid checkouts')
        const descriptors = Object.getOwnPropertyDescriptors(owned.checkouts) as unknown as Record<PropertyKey, PropertyDescriptor>
        const length = descriptors.length
        const count = length && 'value' in length ? length.value : undefined
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0
            || count > STRUCTURED_INPUT_ENTRY_LIMIT || Reflect.ownKeys(descriptors).length !== count + 1) {
            throw new Error('invalid checkouts')
        }
        for (let index = 0; index < count; index += 1) {
            const indexed = descriptors[String(index)]
            if (!indexed || !('value' in indexed) || !indexed.value || typeof indexed.value !== 'object' || Array.isArray(indexed.value)) {
                throw new Error('invalid checkout')
            }
            const entry = Object.getOwnPropertyDescriptors(indexed.value)
            const entryKeys = Reflect.ownKeys(entry)
            if (entryKeys.length !== 2 || !entryKeys.includes('checkoutId') || !entryKeys.includes('path')
                || !('value' in entry.checkoutId!) || !('value' in entry.path!)) throw new Error('invalid checkout')
            checkouts.push(Object.freeze({ checkoutId: entry.checkoutId.value, path: entry.path.value }))
        }
    } catch { throw new TypeError('holder checkout probe input is malformed') }
    const stackId = owned.stackId as StackId
    const timeoutMs = owned.timeoutMs as number
    if (!namespace || !validIdentity(stackId, stackIdentity) || !Number.isSafeInteger(timeoutMs)
        || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError('holder checkout probe input is malformed')
    const paths = new Map<CheckoutId, string>()
    try {
        for (const checkout of checkouts) {
            if (!validIdentity(checkout.checkoutId, checkoutIdentity) || typeof checkout.path !== 'string'
                || !isAbsolute(checkout.path) || normalize(checkout.path) !== checkout.path
                || deriveCheckoutId({ checkoutPath: checkout.path }) !== checkout.checkoutId || paths.has(checkout.checkoutId)) {
                throw new Error('invalid checkout')
            }
            paths.set(checkout.checkoutId, checkout.path)
        }
    } catch { throw new TypeError('holder checkout probe input is malformed') }
    const stored = await readState(namespace.paths.coordination(stackId))
    if (stored.kind !== 'complete') throw new TypeError('holder checkout probe coordination is unavailable')
    const record = decodeCoordinationRecord(stored.value, stackId)
    const requiredCheckouts = new Set(record?.holders.map(({ checkoutId }) => checkoutId))
    if (!record || requiredCheckouts.size !== paths.size || [...requiredCheckouts].some((checkoutId) => !paths.has(checkoutId))) {
        throw new TypeError('holder checkout probe input is malformed')
    }
    const requestedAt = new Date().toISOString()
    const observations: HolderObservationInput[] = []
    for (const holder of record.holders) {
        const path = paths.get(holder.checkoutId)!
        let observation: Observation<HolderLivenessEvidence>
        try {
            const status = await lstat(path)
            observation = status.isDirectory() && !status.isSymbolicLink()
                ? { state: 'available', value: { state: 'live' }, observedAt: new Date().toISOString(), producer: 'bounded-checkout-probe' }
                : { state: 'unavailable', reason: 'checkout path is not a directory', producer: 'bounded-checkout-probe' }
        } catch (error) {
            observation = (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? { state: 'available', value: { state: 'dead', evidence: 'checkout-missing' }, observedAt: new Date().toISOString(), producer: 'bounded-checkout-probe' }
                : { state: 'unavailable', reason: 'checkout presence could not be established', producer: 'bounded-checkout-probe' }
        }
        observations.push(Object.freeze({ holderId: holder.holderId, observation: Object.freeze(observation) }))
    }
    const ownedObservations = Object.freeze(observations)
    issuedHolderObservations.set(ownedObservations, Object.freeze({
        subjectId: stored.value.subjectId as StackId,
        revision: stored.value.revision,
        requestedAt,
        timeoutMs,
        checkoutPaths: new Map(record.holders.map((holder) => [holder.holderId, paths.get(holder.checkoutId)!])),
    }))
    return Object.freeze({ requestedAt, timeoutMs, observations: ownedObservations })
}

export interface ClassifiedHolder {
    readonly holderId: HolderId
    readonly checkoutId: CheckoutId
    readonly state: 'live' | 'dead' | 'checkout-missing'
}

export type HolderClassificationResult =
    | {
          readonly kind: 'complete'
          readonly classifications: readonly ClassifiedHolder[]
          readonly authorities: readonly HolderReleaseAuthority[]
      }
    | ClaimMutationRefusal

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
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return inspected
                ? refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination store changed during observation', directory)
                : { kind: 'complete', value: [] }
        }
        return refuse(ENVIRONMENT_CODES.STATE_ROOT_UNAVAILABLE, 'coordination store could not be inspected', directory)
    }
}

export async function readRootPortInventory(
    namespace: StateNamespace,
    options: Pick<StateTransactionOptions, 'observeHolder'> = {},
): Promise<
    | { readonly kind: 'complete'; readonly value: readonly { cockpitId: CockpitId; stackId: StackId; record: CoordinationRecord }[] }
    | ClaimMutationRefusal
> {
    const result = await withStateNamespaceInventory(namespace, async (namespaces) => {
        const records: { cockpitId: CockpitId; stackId: StackId; record: CoordinationRecord }[] = []
        const budget = { entries: namespaces.length, bytes: 0 }
        for (const candidate of namespaces) {
            const inventory = await readCoordinationInventory(candidate, options, budget)
            if (inventory.kind !== 'complete') return inventory
            const cockpitId = candidate.paths.coordination(`stack:${'0'.repeat(64)}` as StackId).cockpitId
            records.push(...inventory.value.map((record) => ({ cockpitId, ...record })))
        }
        return { kind: 'complete' as const, value: records }
    })
    if (result.kind === 'complete') return result.value
    if (result.kind === 'missing') return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'state namespace inventory disappeared during observation', result.path)
    return refuse(result.code, result.message, result.target, result.recovery)
}

function validIdentity(value: string, pattern: RegExp): boolean {
    return typeof value === 'string' && pattern.test(value)
}

function exactArrayLength(value: unknown, expected: number): number | undefined {
    try {
        if (!Array.isArray(value)) return undefined
        const descriptor = Object.getOwnPropertyDescriptor(value, 'length')
        if (
            !descriptor
            || !('value' in descriptor)
            || !Number.isSafeInteger(descriptor.value)
            || descriptor.value < 0
            || descriptor.value !== expected
        ) return undefined
        return descriptor.value
    } catch {
        return undefined
    }
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
    try {
        const actual = Reflect.ownKeys(Object.getOwnPropertyDescriptors(value))
        return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key))
    } catch { return false }
}

function snapshotHolderObservations(
    value: unknown,
    expected: number,
): readonly HolderObservationInput[] | undefined {
    const length = exactArrayLength(value, expected)
    if (length === undefined) return undefined
    const snapshots: HolderObservationInput[] = []
    try {
        for (let index = 0; index < length; index += 1) {
            if (!Object.hasOwn(value as object, index)) return undefined
            const rawEntry = (value as readonly unknown[])[index]
            if (!rawEntry || typeof rawEntry !== 'object' || !hasExactKeys(rawEntry, ['holderId', 'observation'])) return undefined
            const holderId = (rawEntry as { holderId?: unknown }).holderId
            const rawObservation = (rawEntry as { observation?: unknown }).observation
            if (!validIdentity(holderId as string, holderIdentity) || !rawObservation || typeof rawObservation !== 'object') return undefined
            const state = (rawObservation as { state?: unknown }).state
            let observation: Observation<HolderLivenessEvidence>
            if (state === 'available') {
                if (!hasExactKeys(rawObservation, ['state', 'value', 'observedAt', 'producer'])) return undefined
                const rawEvidence = (rawObservation as { value?: unknown }).value
                const observedAt = (rawObservation as { observedAt?: unknown }).observedAt
                const producer = (rawObservation as { producer?: unknown }).producer
                if (
                    !rawEvidence || typeof rawEvidence !== 'object'
                    || typeof observedAt !== 'string'
                    || typeof producer !== 'string'
                    || producer.length < 1
                    || Buffer.byteLength(producer, 'utf8') > OBSERVATION_PRODUCER_BYTE_LIMIT
                ) return undefined
                const evidenceState = (rawEvidence as { state?: unknown }).state
                const evidence = (rawEvidence as { evidence?: unknown }).evidence
                if (evidenceState === 'live' && hasExactKeys(rawEvidence, ['state'])) {
                    observation = { state, value: { state: 'live' }, observedAt, producer }
                } else if (
                    evidenceState === 'dead'
                    && (evidence === 'process-absent' || evidence === 'checkout-missing')
                    && hasExactKeys(rawEvidence, ['state', 'evidence'])
                ) {
                    observation = { state, value: { state: 'dead', evidence }, observedAt, producer }
                } else return undefined
            } else if (state === 'unavailable') {
                if (!hasExactKeys(rawObservation, ['state', 'reason', 'producer'])) return undefined
                const reason = (rawObservation as { reason?: unknown }).reason
                const producer = (rawObservation as { producer?: unknown }).producer
                if (
                    typeof reason !== 'string' || reason.length < 1 || Buffer.byteLength(reason, 'utf8') > OBSERVATION_REASON_BYTE_LIMIT
                    || typeof producer !== 'string' || producer.length < 1 || Buffer.byteLength(producer, 'utf8') > OBSERVATION_PRODUCER_BYTE_LIMIT
                ) return undefined
                observation = { state, reason, producer }
            } else if (state === 'failed') {
                if (!hasExactKeys(rawObservation, ['state', 'code', 'reason', 'producer'])) return undefined
                const code = (rawObservation as { code?: unknown }).code
                const reason = (rawObservation as { reason?: unknown }).reason
                const producer = (rawObservation as { producer?: unknown }).producer
                if (
                    !REFUSAL_CODES.includes(code as never)
                    || typeof reason !== 'string' || reason.length < 1 || Buffer.byteLength(reason, 'utf8') > OBSERVATION_REASON_BYTE_LIMIT
                    || typeof producer !== 'string' || producer.length < 1 || Buffer.byteLength(producer, 'utf8') > OBSERVATION_PRODUCER_BYTE_LIMIT
                ) return undefined
                observation = { state, code: code as typeof REFUSAL_CODES[number], reason, producer }
            } else return undefined
            snapshots.push(Object.freeze({ holderId: holderId as HolderId, observation: Object.freeze(observation) }))
        }
    } catch {
        return undefined
    }
    return Object.freeze(snapshots)
}

export function decodeCoordinationRecord(record: StateRecord | null, stackId: StackId): CoordinationRecord | undefined {
    if (record === null) return { holders: [], lease: null, lastReleasedHolder: null, drain: null }
    if (record.kind !== 'coordination' || record.subjectId !== stackId) return undefined
    const parsed = CoordinationValueSchema.safeParse(record.value)
    if (!parsed.success || parsed.data.restore !== null && parsed.data.restore.stackId !== stackId) return undefined
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
        restore: parsed.data.restore === null ? null : Object.freeze({
            ...parsed.data.restore,
            stackId: parsed.data.restore.stackId as StackId,
            holderId: parsed.data.restore.holderId as HolderId,
            requesterId: parsed.data.restore.requesterId as HolderId,
        }),
    }
}

export function addCoordinationHolder(
    value: CoordinationRecord,
    holder: { readonly holderId: HolderId; readonly checkoutId: CheckoutId },
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
            || value.drain != null || value.restore != null) return undefined
        const holders = value.holders.filter((holder) => holder.holderId !== holderId)
        if (holders.length !== value.holders.length - 1) return undefined
        return {
            ...value,
            holders,
            lastReleasedHolder: holderId,
        }
    } catch {
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
            restore: value.restore == null ? null : { ...value.restore },
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
        return Object.freeze({
            purpose: request.purpose, stackId: request.stackId, holderId: request.holderId,
            requesterId: request.requesterId, configSha256: request.configSha256,
            planDigest: request.planDigest, operationBasis: request.operationBasis,
            generation: request.generation, targetIds, actions,
            expectedCoordinationRevision: request.expectedCoordinationRevision,
        })
    } catch { return undefined }
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
    return Object.freeze({
        ...reservation,
        targetIds: Object.freeze([...reservation.targetIds]),
        actions: Object.freeze(reservation.actions.map(snapshotDrainAction)),
        attempt: reservation.attempt === null ? null : Object.freeze({
            ...reservation.attempt,
            targetIds: Object.freeze([...reservation.attempt.targetIds]),
        }),
    })
}

function snapshotDrainAction(action: DrainAction): DrainAction {
    return action.stage === 'runtime-stop'
        ? Object.freeze({ ...action })
        : Object.freeze({ ...action, targetCommitment: Object.freeze({ ...action.targetCommitment }) })
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
            if (!property || !('value' in property) || typeof property.value !== 'string') throw new TypeError('invalid target')
            return property.value
        })
        if (new Set(targets).size !== targets.length
            || targets.some((target, index) => target.length === 0 || Buffer.byteLength(target, 'utf8') > 512
                || target.includes('\0') || index > 0 && targets[index - 1]! >= target)) return undefined
        return Object.freeze(targets)
    } catch { return undefined }
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
    } catch { return undefined }
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
        return Object.freeze(actions)
    } catch { return undefined }
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
    const authority = Object.freeze({ reservation: snapshotDrainReservation(reservation) }) as DrainReservationAuthority
    const recordFingerprint = exactRecordFingerprint(record)
    const ownedAddress = snapshotCoordinationAddress(address)
    if (recordFingerprint === undefined || ownedAddress === undefined) throw new TypeError('drain authority provenance is malformed')
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

function isRestoreActive(value: CoordinationRecord): boolean {
    return value.restore != null
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
        if (!input || typeof input !== 'object' || Array.isArray(input) || !hasExactKeys(input, ['namespace', 'request'])) throw new Error('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (!('value' in descriptors.namespace!) || !('value' in descriptors.request!)) throw new Error('invalid')
        namespace = snapshotStateNamespace(descriptors.namespace!.value as StateNamespace)
        request = snapshotDrainRequest(descriptors.request!.value)
    } catch {
        namespace = undefined
        request = undefined
    }
    if (!namespace || !request) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'drain reservation input is malformed', 'drain reservation')
    const reservedAt = new Date().toISOString()
    const reservationId = randomBytes(32).toString('hex')
    const reservation = Object.freeze({
        ...request,
        coordinationRevision: request.expectedCoordinationRevision + 1,
        completedActionCount: 0,
        progressRevision: request.expectedCoordinationRevision + 1,
        reservedAt,
        reservationId,
        attempt: null,
    }) satisfies DrainReservation
    const result = await transactClaim<DrainReservationResult>(namespace, request.stackId, request.requesterId, (current) => {
        const value = decodeCoordinationRecord(current, request.stackId)
        if (!value || current === null || current.revision !== request.expectedCoordinationRevision) {
            return abortStateTransaction(refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'drain reservation requires the exact current coordination revision', request.stackId))
        }
        if (value.drain !== null || value.restore !== null) return abortStateTransaction(refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'the stack already has an exclusive mutation', request.stackId))
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
        ? Object.freeze(owned) as unknown as StateAddress
        : undefined
}

function sameCoordinationAddress(left: StateAddress, right: StateAddress): boolean {
    return left.path === right.path && left.stateRoot === right.stateRoot && left.cockpitRoot === right.cockpitRoot
        && left.kind === right.kind && left.cockpitId === right.cockpitId && left.subjectId === right.subjectId
        && left.qualifier === undefined && right.qualifier === undefined
}

function issueDrainAttemptAuthority(reservation: DrainReservation, record: StateRecord, address: StateAddress): DrainAttemptAuthority {
    if (!reservation.attempt) throw new TypeError('drain attempt is absent')
    const ownedAddress = snapshotCoordinationAddress(address)
    if (!ownedAddress) throw new TypeError('drain attempt address is malformed')
    const owned = snapshotDrainReservation(reservation)
    const authority = Object.freeze({ reservation: owned, attempt: owned.attempt! }) as DrainAttemptAuthority
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
    const proposed = Object.freeze({ ...value, drain: Object.freeze({ ...value.drain, attempt }) })
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
            || !hasExactKeys(input, ['namespace', 'authority'])) throw new Error('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) throw new Error('invalid')
        reservationAuthority = descriptors.authority!.value as DrainReservationAuthority
        if (!reservationAuthority || typeof reservationAuthority !== 'object' || !drainAuthorities.has(reservationAuthority)) throw new Error('invalid')
        reservation = reservationAuthority.reservation
        namespace = snapshotStateNamespace(descriptors.namespace!.value as StateNamespace)
    } catch {
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
    const attempt = Object.freeze({
        attemptId: randomBytes(32).toString('hex'), reservationId: reservation.reservationId,
        purpose: reservation.purpose, targetIds: reservation.targetIds, generation: reservation.generation,
        actionIndex: reservation.completedActionCount, currentTarget: currentAction.targetId, currentStage: currentAction.stage,
        committedRevision: priorRevision + 1, committedAt, validThrough,
        status: 'active' as const, failedRevision: null, failedAt: null,
    }) satisfies DrainAttempt
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
    const candidate = Object.freeze({ reservation: issued.reservation, attempt: issued.attempt }) as DrainAttemptCandidate
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
        const result = Object.freeze({}) as DrainAttemptSuccessAuthority
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
        const result = Object.freeze({}) as DrainAttemptFailureAuthority
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
    return Object.freeze({ ...issued, sealSuccess, sealFailure })
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
        return reservation.expectedCoordinationRevision === snapshot.revision
            && reservation.coordinationRevision === snapshot.revision + 1 ? snapshot : undefined
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
    const progressAuthority = Object.freeze({}) as DrainProgressAuthority
    drainProgressAuthorities.set(progressAuthority, Object.freeze({
        planningRecord: predecessor,
        reservation: permit.reservation,
        attempt: permit.attempt,
    }))
    return Object.freeze({ ...permit, progressAuthority })
}

function exactDataProperties(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !hasExactKeys(value, keys)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (keys.some((key) => !('value' in descriptors[key]!))) return undefined
        return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value])))
    } catch { return undefined }
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
    const execution = Object.freeze({}) as RuntimeDrainExecutionAuthority
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
        ? Object.freeze({ attemptId, markerPath, socketPath }) : undefined
}

export function inspectDrainExecutionFence(
    authority: RuntimeDrainExecutionAuthority | ReclaimDrainExecutionAuthority,
): ExecutionFence | undefined {
    if (!authority || typeof authority !== 'object') return undefined
    const execution = drainExecutions.get(authority)
    return execution ? Object.freeze({ ...execution.fence }) : undefined
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
    const execution = Object.freeze({}) as ReclaimDrainExecutionAuthority
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
    const outcome = Object.freeze({}) as DrainOutcomeAuthority
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

export async function prepareDrainOutcomePublication(input: {
    readonly authority: DrainOutcomeAuthority
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly beforePublish?: StateTransactionOptions['beforePublish']
}): Promise<StateResult<StateRecord> | ClaimMutationRefusal> {
    let inputKeys: readonly string[] = []
    try {
        inputKeys = [
            'authority', 'namespace', 'stackId',
            ...(Object.getOwnPropertyDescriptor(input, 'beforePublish') ? ['beforePublish'] : []),
        ]
    } catch { /* malformed input is refused below */ }
    const preparation = exactDataProperties(input, inputKeys)
    const authority = preparation?.authority
    const outcome = authority && typeof authority === 'object' ? drainOutcomes.get(authority) : undefined
    const namespace = preparation ? snapshotStateNamespace(preparation.namespace as StateNamespace) : undefined
    const stackId = preparation?.stackId
    const beforePublish = preparation?.beforePublish
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
    if (publication.kind === 'complete' || publication.kind === 'indeterminate') {
        const value = snapshotJson(publication.value.value)
        if (value === undefined) {
            return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'published drain outcome is malformed', address.path)
        }
        drainOutcomePublications.set(authority as DrainOutcomeAuthority, Object.freeze({
            revision: publication.value.revision,
            value,
            kind: outcome.provenance.kind,
            cockpitId: outcome.provenance.cockpitId,
            subjectId: outcome.provenance.subjectId,
            notBefore,
            updatedAt: publication.value.updatedAt,
            address: outcome.provenance.address,
        }))
    }
    return publication
}

export function finalizeDrainOutcome(input: {
    readonly authority: DrainOutcomeAuthority
    readonly publication: StateResult<StateRecord>
    readonly address: StateAddress
}): boolean {
    const finalization = exactDataProperties(input, ['authority', 'publication', 'address'])
    if (finalization) {
        const authority = finalization.authority
        if (!authority || typeof authority !== 'object') return false
        const outcome = drainOutcomes.get(authority)
        const expected = drainOutcomePublications.get(authority)
        if (!outcome || !expected) return false
        const address = snapshotCoordinationAddress(finalization.address as StateAddress)
        if (!address || !sameCoordinationAddress(address, expected.address)) return false
        const publication = authenticateStatePublication({
            publication: finalization.publication as StateResult<StateRecord>,
            address: finalization.address as StateAddress,
        })
        const record = publication?.record
        if (!record || record.revision !== expected.revision || record.kind !== expected.kind
            || record.cockpitId !== expected.cockpitId || record.subjectId !== expected.subjectId
            || record.updatedAt !== expected.updatedAt
            || Date.parse(record.updatedAt) < Date.parse(expected.notBefore) || Date.parse(record.updatedAt) > Date.now()
            || JSON.stringify(canonicalJsonValue(record.value)) !== JSON.stringify(canonicalJsonValue(expected.value))) return false
        drainOutcomes.delete(authority)
        drainOutcomePublications.delete(authority)
        return finalizeDrainAttemptOutcome(outcome.authority)
    }
    return false
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
    const expectedDrain = Object.freeze({
        ...issued.reservation,
        completedActionCount: issued.attempt.actionIndex + 1,
        progressRevision: issued.attempt.committedRevision + 1,
        attempt: null,
    })
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
    const expectedDrain = Object.freeze({
        ...issued.reservation,
        attempt: Object.freeze({
            ...issued.attempt,
            status: 'failed' as const,
            failedRevision: issued.attempt.committedRevision + 1,
            failedAt: issued.failure.failedAt,
        }),
    })
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
    return Object.freeze({
        ...value,
        drain: Object.freeze({
            ...value.drain,
            attempt: Object.freeze({ ...attempt, status: 'failed' as const,
                failedRevision: attempt.committedRevision + 1, failedAt: failure.failedAt }),
        }),
    })
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
    const authority = Object.freeze({}) as DrainRepairAuthority
    drainRepairs.set(authority, { namespace, address: Object.freeze({ ...address }), recordFingerprint,
        reservation: snapshotDrainReservation(reservation), fence })
    return Object.freeze({ kind: 'repairable', fence, authority })
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
        return coordinationStateRecord(repair.namespace, repair.reservation.stackId, current, failedAt, Object.freeze({
            ...value,
            drain: Object.freeze({ ...value.drain, attempt: Object.freeze({ ...attempt, status: 'failed' as const,
                failedRevision: current.revision + 1, failedAt }) }),
        }))
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
            || !hasExactKeys(input, ['namespace', 'stackId', 'holderId', 'purpose'])) throw new Error('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (!('value' in descriptors.namespace!) || !('value' in descriptors.stackId!)
            || !('value' in descriptors.holderId!) || !('value' in descriptors.purpose!)) throw new Error('invalid')
        namespace = authenticateStateNamespace(descriptors.namespace!.value)
        const suppliedStackId = descriptors.stackId!.value
        const suppliedHolderId = descriptors.holderId!.value
        const suppliedPurpose = descriptors.purpose!.value
        if (typeof suppliedStackId !== 'string' || typeof suppliedHolderId !== 'string'
            || !validIdentity(suppliedStackId, stackIdentity) || !validIdentity(suppliedHolderId, holderIdentity)
            || suppliedPurpose !== 'down' && suppliedPurpose !== 'reset') throw new Error('invalid')
        stackId = suppliedStackId as StackId
        holderId = suppliedHolderId as HolderId
        purpose = suppliedPurpose
    } catch {
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
        if (value.holders.length !== 1 || value.holders[0]?.holderId !== holderId
            || value.lease === null || value.lease.released) {
            return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'destructive recovery requires exact retained holder and lease ownership', stackId)
        }
        return Object.freeze({ kind: 'none' })
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
    return request ? Object.freeze({ kind: 'recoverable', request })
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
            || !hasExactKeys(input, ['namespace', 'stackId', 'holderId'])) throw new Error('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (!('value' in descriptors.namespace!) || !('value' in descriptors.stackId!)
            || !('value' in descriptors.holderId!)) throw new Error('invalid')
        namespace = authenticateStateNamespace(descriptors.namespace!.value)
        const suppliedStackId = descriptors.stackId!.value
        const suppliedHolderId = descriptors.holderId!.value
        if (typeof suppliedStackId !== 'string' || typeof suppliedHolderId !== 'string'
            || !validIdentity(suppliedStackId, stackIdentity) || !validIdentity(suppliedHolderId, holderIdentity)) throw new Error('invalid')
        stackId = suppliedStackId as StackId
        holderId = suppliedHolderId as HolderId
    } catch {
        namespace = undefined
    }
    if (!namespace || !stackId || !holderId) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'sleep drain recovery inspection input is malformed', 'sleep drain recovery')
    }
    const address = namespace.paths.coordination(stackId)
    const stored = await readState(address)
    if (stored.kind === 'missing') return Object.freeze({ kind: 'none' })
    if (stored.kind !== 'complete') return stateRefusal(stored)
    const record = stored.value
    const value = decodeCoordinationRecord(record, stackId)
    if (!value) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', address.path)
    if (value.drain == null) return Object.freeze({ kind: 'none' })
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
    const authority = Object.freeze({}) as SleepDrainRecoveryAuthority
    sleepDrainRecoveries.set(authority, {
        namespace,
        address: Object.freeze({ ...address }),
        recordFingerprint: fingerprint,
        reservation: snapshotDrainReservation(reservation),
    })
    return Object.freeze({
        kind: 'recoverable',
        generation: reservation.generation,
        runtimeStopValidForMs: runtimeStop.validForMs,
        authority,
    })
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
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if ('value' in descriptors.authority!) {
            authority = descriptors.authority!.value as SleepDrainRecoveryAuthority
            issued = authority && typeof authority === 'object' ? sleepDrainRecoveries.get(authority) : undefined
            if (issued) sleepDrainRecoveries.delete(authority)
        }
        if (!hasExactKeys(input, ['namespace', 'authority', 'request'])
            || !('value' in descriptors.namespace!) || !('value' in descriptors.authority!)
            || !('value' in descriptors.request!)) throw new Error('invalid')
        namespace = authenticateStateNamespace(descriptors.namespace!.value)
        request = snapshotDrainRequest(descriptors.request!.value)
    } catch {
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
    const persistedRequest = Object.freeze({
        ...request,
        expectedCoordinationRevision: issued.reservation.expectedCoordinationRevision,
    })
    if (request.purpose !== 'sleep' || !sameDrainRequest(issued.reservation, persistedRequest)) {
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'persisted sleep drain does not match fresh planning evidence', issued.reservation.stackId)
    }
    const epoch = drainAuthorityEpoch(issued.reservation)
    if (drainAuthorityEpochs.get(issued.reservation.reservationId) === epoch) {
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'persisted drain already has authority for its current state', issued.reservation.stackId)
    }
    return Object.freeze({
        kind: 'complete',
        reservation: issued.reservation,
        authority: issueDrainAuthority(issued.reservation, stored.value, issued.address),
    })
}

export async function recoverDrainReservation(input: {
    readonly namespace: StateNamespace
    readonly request: DrainReservationRequest
}): Promise<DrainReservationResult> {
    let namespace: StateNamespace | undefined
    let request: DrainReservationRequest | undefined
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input) || !hasExactKeys(input, ['namespace', 'request'])) throw new Error('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (!('value' in descriptors.namespace!) || !('value' in descriptors.request!)) throw new Error('invalid')
        namespace = snapshotStateNamespace(descriptors.namespace!.value as StateNamespace)
        request = snapshotDrainRequest(descriptors.request!.value)
    } catch {
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
    return Object.freeze({
        targetId: action.targetId,
        targetCommitment: Object.freeze({ ...action.targetCommitment }),
    })
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
        const recovery = Object.freeze({
            purpose: reservation.purpose,
            stackId: reservation.stackId,
            configSha256: reservation.configSha256,
            planDigest: reservation.planDigest,
            freshAfter: record.updatedAt,
            completed: Object.freeze(reclaimActions.slice(0, currentIndex).map(failedReclaimRecoveryTarget)),
            current: failedReclaimRecoveryTarget(action),
            pending: Object.freeze(reclaimActions.slice(currentIndex + 1).map(failedReclaimRecoveryTarget)),
        }) satisfies FailedReclaimRecovery
        const candidateAuthority = Object.freeze({}) as FailedReclaimRecoveryAuthority
        failedReclaimRecoveries.set(candidateAuthority, recovery)
        return candidateAuthority
    } catch {
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
    if (Array.isArray(value) && value.length === 0) return Object.freeze([])
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
    return Object.freeze({
        ...value,
        drain: Object.freeze({
            ...value.drain,
            completedActionCount: value.drain.completedActionCount + 1,
            progressRevision: value.drain.attempt.committedRevision + 1,
            attempt: null,
        }),
    })
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
        return Object.freeze(result)
    } catch { return undefined }
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
    return Object.freeze({
        holders: Object.freeze([]),
        lease: value.lease === null ? null : Object.freeze({ ...value.lease, released: true }),
        lastReleasedHolder: value.drain.holderId,
        drain: null,
    })
}

function stateRefusal(result: Exclude<StateResult<StateRecord>, { kind: 'complete' | 'missing' }>): ClaimMutationRefusal {
    return refuse(
        result.code,
        result.message,
        result.target,
        'recovery' in result ? result.recovery : undefined,
    )
}

type RestoreExecutionAuthorityResult =
    | { readonly kind: 'complete'; readonly authority: RestoreExecutionAuthority }
    | ClaimMutationRefusal

function restoreAuthorityRefusal(message: string, target: string): ClaimMutationRefusal {
    return refuse(
        ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED,
        message,
        target,
        'retry only after this stack has one current holder and no drain is active',
    )
}

function restoreAuthorityInput(input: unknown): Omit<RestoreExecutionContract, 'revision' | 'reservationId'> | undefined {
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const expected = ['namespace', 'stackId', 'holderId', 'requesterId', 'configPath', 'configSha256', 'stepSha256']
        if (Reflect.ownKeys(descriptors).length !== expected.length
            || expected.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]!))) return undefined
        const namespace = authenticateStateNamespace(descriptors.namespace!.value)
        const stackId = descriptors.stackId!.value as StackId
        const holderId = descriptors.holderId!.value as HolderId
        const requesterId = descriptors.requesterId!.value as HolderId
        const configPath = descriptors.configPath!.value as string
        const configSha256 = descriptors.configSha256!.value as string
        const stepSha256 = descriptors.stepSha256!.value as string
        if (!namespace || !validIdentity(stackId, stackIdentity) || !validIdentity(holderId, holderIdentity)
            || requesterId !== holderId || typeof configPath !== 'string' || !isAbsolute(configPath)
            || !validIdentity(configSha256, sha256Identity) || !validIdentity(stepSha256, sha256Identity)) return undefined
        return Object.freeze({ namespace, stackId, holderId, requesterId, configPath, configSha256, stepSha256 })
    } catch {
        return undefined
    }
}

function isSoleRestoreHolder(record: CoordinationRecord, holderId: HolderId): boolean {
    return record.holders.length === 1 && record.holders[0]?.holderId === holderId
        && record.lease !== null && !record.lease.released && record.drain == null
}

export async function issueRestoreExecutionAuthority(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly requesterId: HolderId
    readonly configPath: string
    readonly configSha256: string
    readonly stepSha256: string
}): Promise<RestoreExecutionAuthorityResult> {
    const request = restoreAuthorityInput(input)
    if (!request) return restoreAuthorityRefusal('restore authority input is malformed', 'restore authority input')
    const source = await observeConfigSource(request.configPath)
    if (source.state !== 'available' || source.sha256 !== request.configSha256) {
        return restoreAuthorityRefusal('restore configuration is no longer current', request.configPath)
    }
    const reservationId = randomBytes(32).toString('hex')
    const reservedAt = new Date().toISOString()
    const result = await transactClaim<ClaimMutationRefusal>(
        request.namespace, request.stackId, request.requesterId,
        (current) => {
            const coordination = decodeCoordinationRecord(current, request.stackId)
            if (!coordination || !isSoleRestoreHolder(coordination, request.holderId) || coordination.restore !== null) {
                return abortStateTransaction(restoreAuthorityRefusal('restore requires the exact sole current holder', request.stackId))
            }
            return coordinationStateRecord(request.namespace, request.stackId, current, reservedAt, {
                ...coordination,
                restore: Object.freeze({
                    reservationId, stackId: request.stackId, holderId: request.holderId,
                    requesterId: request.requesterId, configPath: request.configPath,
                    configSha256: request.configSha256, stepSha256: request.stepSha256, reservedAt,
                }),
            })
        },
    )
    if ('diagnostics' in result) return result
    if (result.kind !== 'complete') return result.kind === 'missing'
        ? restoreAuthorityRefusal('restore requires a current coordination record', result.path)
        : stateRefusal(result)
    const coordination = decodeCoordinationRecord(result.value, request.stackId)
    if (!coordination?.restore || coordination.restore.reservationId !== reservationId) {
        return restoreAuthorityRefusal('restore reservation publication is malformed', request.stackId)
    }
    const authority = Object.freeze({}) as RestoreExecutionAuthority
    restoreExecutionAuthorities.set(authority, Object.freeze({ ...request, revision: result.value.revision, reservationId }))
    return Object.freeze({ kind: 'complete', authority })
}

export async function consumeRestoreExecutionAuthority(input: {
    readonly namespace: StateNamespace
    readonly authority: RestoreExecutionAuthority
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly requesterId: HolderId
    readonly configPath: string
    readonly configSha256: string
    readonly stepSha256: string
}): Promise<{ readonly kind: 'complete'; readonly lease: RestoreExecutionLease } | ClaimMutationRefusal> {
    let authority: RestoreExecutionAuthority | undefined
    let request: Omit<RestoreExecutionContract, 'revision' | 'reservationId'> | undefined
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid input')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const expected = ['namespace', 'authority', 'stackId', 'holderId', 'requesterId', 'configPath', 'configSha256', 'stepSha256']
        if (Reflect.ownKeys(descriptors).length !== expected.length
            || expected.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]!))) throw new Error('invalid input')
        authority = descriptors.authority!.value as RestoreExecutionAuthority
        request = restoreAuthorityInput({
            namespace: descriptors.namespace!.value,
            stackId: descriptors.stackId!.value,
            holderId: descriptors.holderId!.value,
            requesterId: descriptors.requesterId!.value,
            configPath: descriptors.configPath!.value,
            configSha256: descriptors.configSha256!.value,
            stepSha256: descriptors.stepSha256!.value,
        })
    } catch {
        // The exact owner must retry with the original token; malformed envelopes cannot authorize releasing its reservation.
        return restoreAuthorityRefusal('restore authority consumption input is malformed', 'restore authority input')
    }
    const contract = authority && restoreExecutionAuthorities.get(authority)
    if (!contract) return restoreAuthorityRefusal('restore authority is absent or already consumed', 'restore authority')
    restoreExecutionAuthorities.delete(authority!)
    const refuseAndRelease = async (refusal: ClaimMutationRefusal): Promise<ClaimMutationRefusal> => {
        const released = await releaseRestoreReservation(contract)
        return released.kind === 'complete' ? refusal : released
    }
    if (!request) return refuseAndRelease(restoreAuthorityRefusal('restore authority consumption input is malformed', 'restore authority input'))
    const requestAddress = request.namespace.paths.coordination(request.stackId)
    const contractAddress = contract.namespace.paths.coordination(contract.stackId)
    if (requestAddress.path !== contractAddress.path || requestAddress.cockpitId !== contractAddress.cockpitId
        || request.stackId !== contract.stackId || request.holderId !== contract.holderId
        || request.requesterId !== contract.requesterId || request.configPath !== contract.configPath
        || request.configSha256 !== contract.configSha256 || request.stepSha256 !== contract.stepSha256) {
        return refuseAndRelease(restoreAuthorityRefusal('restore authority does not match the requested execution step', requestAddress.path))
    }
    const current = await readState(requestAddress)
    if (current.kind !== 'complete') {
        return refuseAndRelease(current.kind === 'missing'
            ? restoreAuthorityRefusal('restore coordination disappeared before execution', current.path)
            : stateRefusal(current))
    }
    const source = await observeConfigSource(request.configPath)
    const coordination = decodeCoordinationRecord(current.value, request.stackId)
    if (source.state !== 'available' || source.sha256 !== contract.configSha256
        || current.value.revision !== contract.revision || !coordination || !isSoleRestoreHolder(coordination, request.holderId)
        || coordination.restore?.reservationId !== contract.reservationId) {
        return refuseAndRelease(restoreAuthorityRefusal('restore coordination changed before execution', current.value.subjectId))
    }
    const lease = Object.freeze({}) as RestoreExecutionLease
    restoreExecutionLeases.set(lease, contract)
    return Object.freeze({ kind: 'complete', lease })
}

async function releaseRestoreReservation(
    contract: RestoreExecutionContract,
): Promise<{ readonly kind: 'complete' } | ClaimMutationRefusal> {
    const result = await transactClaim<ClaimMutationRefusal>(
        contract.namespace, contract.stackId, contract.requesterId,
        (current) => {
            const coordination = decodeCoordinationRecord(current, contract.stackId)
            if (!coordination?.restore || coordination.restore.reservationId !== contract.reservationId
                || !isSoleRestoreHolder(coordination, contract.holderId)) {
                return abortStateTransaction(restoreAuthorityRefusal('restore reservation changed before release', contract.stackId))
            }
            return coordinationStateRecord(contract.namespace, contract.stackId, current, new Date().toISOString(), {
                ...coordination, restore: null,
            })
        },
    )
    if ('diagnostics' in result) return result
    if (result.kind !== 'complete') return result.kind === 'missing'
        ? restoreAuthorityRefusal('restore reservation disappeared before release', result.path)
        : stateRefusal(result)
    return Object.freeze({ kind: 'complete' })
}

export async function settleRestoreExecutionAuthority(input: {
    readonly namespace: StateNamespace
    readonly lease: RestoreExecutionLease
}): Promise<{ readonly kind: 'complete' } | ClaimMutationRefusal> {
    let namespace: StateNamespace | undefined
    let lease: RestoreExecutionLease | undefined
    try {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = Reflect.ownKeys(descriptors)
        if (keys.length !== 2 || !Object.hasOwn(descriptors, 'namespace') || !Object.hasOwn(descriptors, 'lease')
            || !('value' in descriptors.namespace!) || !('value' in descriptors.lease!)) throw new Error('invalid')
        namespace = authenticateStateNamespace(descriptors.namespace.value)
        lease = descriptors.lease.value as RestoreExecutionLease
    } catch {
        namespace = undefined
        lease = undefined
    }
    const contract = lease && typeof lease === 'object' ? restoreExecutionLeases.get(lease) : undefined
    if (!namespace || !lease || !contract) return restoreAuthorityRefusal('restore execution lease is absent or already settled', 'restore execution lease')
    if (namespace !== contract.namespace) return restoreAuthorityRefusal('restore execution lease namespace changed', contract.stackId)
    const released = await releaseRestoreReservation(contract)
    if (released.kind === 'complete') restoreExecutionLeases.delete(lease)
    return released
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

export async function acquireClaim(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holder: { readonly holderId: HolderId; readonly checkoutId: CheckoutId }
    readonly now: string
}): Promise<AcquireClaimResult> {
    let request: {
        readonly namespace: StateNamespace
        readonly stackId: StackId
        readonly holder: { readonly holderId: HolderId; readonly checkoutId: CheckoutId }
        readonly now: string
    }
    try {
        const namespaceProperty = Object.getOwnPropertyDescriptor(input, 'namespace')
        if (!namespaceProperty || !('value' in namespaceProperty)) throw new Error('invalid namespace property')
        const stableNamespace = snapshotStateNamespace(namespaceProperty.value as StateNamespace)
        if (!stableNamespace) throw new Error('invalid namespace')
        request = Object.freeze({
            namespace: stableNamespace,
            stackId: input.stackId,
            holder: Object.freeze({ holderId: input.holder.holderId, checkoutId: input.holder.checkoutId }),
            now: input.now,
        })
    } catch {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'claim acquisition input could not be read safely', 'claim acquisition input')
    }
    if (
        !validIdentity(request.stackId, stackIdentity)
        || !validIdentity(request.holder.holderId, holderIdentity)
        || !validIdentity(request.holder.checkoutId, checkoutIdentity)
        || !isCanonicalTimestamp(request.now)
    ) {
        return refuse(
            ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
            'claim acquisition requires canonical stack, holder, checkout, and timestamp values',
            String(request.stackId ?? ''),
        )
    }

    const result = await transactClaim<AcquireClaimResult>(
        request.namespace,
        request.stackId,
        request.holder.holderId,
        (current) => {
            const value = decodeCoordinationRecord(current, request.stackId)
            if (!value) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', request.stackId))
            if (isDrainActive(value) || isRestoreActive(value)) return abortStateTransaction(refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'claim acquisition is blocked while the stack has an exclusive mutation', request.stackId))
            if (current === null || value.lease === null || value.lease.released) {
                return abortStateTransaction(refuse(
                    ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN,
                    'an initial holder must acquire its port lease in the same coordination transaction',
                    request.stackId,
                ))
            }
            const added = addCoordinationHolder(value, request.holder, request.now)
            if (!added) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination holder set cannot accept the requested holder', request.holder.holderId))
            const complete: AcquireClaimResult = {
                kind: 'complete', change: added.change, holders: added.value.holders.map((holder) => holder.holderId),
                ownership: { stackId: request.stackId, holderId: request.holder.holderId, recordRevision: current?.revision ?? 0, change: added.change },
            }
            return added.change === 'unchanged'
                ? abortStateTransaction(complete)
                : coordinationStateRecord(request.namespace, request.stackId, current, request.now, added.value)
        },
    )
    if ('diagnostics' in result || 'holders' in result) return result
    if (result.kind === 'missing') {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'claim transaction returned no record', result.path)
    }
    if (result.kind !== 'complete') return stateRefusal(result)
    const value = decodeCoordinationRecord(result.value, request.stackId)
    if (!value) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'published claim record is malformed', result.value.subjectId)
    }
    return {
        kind: 'complete', change: 'acquired', holders: value.holders.map((holder) => holder.holderId),
        ownership: { stackId: request.stackId, holderId: request.holder.holderId, recordRevision: result.value.revision, change: 'acquired' },
    }
}

export async function releaseClaim(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly requesterId: HolderId
    readonly holderId: HolderId
    readonly authority?: HolderReleaseAuthority
    readonly now: string
}): Promise<ReleaseClaimResult> {
    let authorityToken: HolderReleaseAuthority | undefined
    let request: {
        readonly namespace: StateNamespace
        readonly stackId: StackId
        readonly requesterId: HolderId
        readonly holderId: HolderId
        readonly authority?: Omit<HolderReleaseAuthority, typeof releaseAuthorityBrand>
        readonly now: string
    }
    try {
        const namespaceProperty = Object.getOwnPropertyDescriptor(input, 'namespace')
        if (!namespaceProperty || !('value' in namespaceProperty)) throw new Error('invalid namespace property')
        const stableNamespace = snapshotStateNamespace(namespaceProperty.value as StateNamespace)
        if (!stableNamespace) throw new Error('invalid namespace')
        authorityToken = input.authority
        const authority = authorityToken === undefined ? undefined : Object.freeze({
            stackId: authorityToken.stackId,
            requesterId: authorityToken.requesterId,
            holderId: authorityToken.holderId,
            claimedAt: authorityToken.claimedAt,
            recordRevision: authorityToken.recordRevision,
            requestedAt: authorityToken.requestedAt,
            observedAt: authorityToken.observedAt,
            validThrough: authorityToken.validThrough,
            producer: authorityToken.producer,
        })
        request = Object.freeze({
            namespace: stableNamespace,
            stackId: input.stackId,
            requesterId: input.requesterId,
            holderId: input.holderId,
            ...(authority ? { authority } : {}),
            now: input.now,
        })
    } catch {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'claim release input could not be read safely', 'claim release input')
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

    const crossHolder = request.requesterId !== request.holderId
    const authorityIssued = authorityToken !== undefined
        && releaseAuthorities.has(authorityToken)
        && !reservedReleaseAuthorities.has(authorityToken)
    if (authorityIssued && authorityToken) reservedReleaseAuthorities.add(authorityToken)
    const preserveAuthority = () => {
        if (authorityIssued && authorityToken) reservedReleaseAuthorities.delete(authorityToken)
    }
    const consumeAuthority = () => {
        if (authorityIssued && authorityToken) {
            reservedReleaseAuthorities.delete(authorityToken)
            releaseAuthorities.delete(authorityToken)
            releaseAuthorityCheckoutPaths.delete(authorityToken)
        }
    }
    const checkoutPath = crossHolder && authorityToken ? releaseAuthorityCheckoutPaths.get(authorityToken) : undefined
    if (checkoutPath !== undefined) {
        try {
            await lstat(checkoutPath)
            preserveAuthority()
            return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'checkout is present; absence authority is no longer current', request.holderId)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                preserveAuthority()
                return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'checkout absence could not be confirmed', request.holderId)
            }
        }
    }

    const result = await transactClaim<ReleaseClaimResult>(
        request.namespace,
        request.stackId,
        request.requesterId,
        (current) => {
            const observedNow = new Date().toISOString()
            if (checkoutPath !== undefined) {
                try {
                    lstatSync(checkoutPath)
                    return abortStateTransaction(refuse(
                        ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                        'checkout is present; absence authority is no longer current',
                        request.holderId,
                    ))
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        return abortStateTransaction(refuse(
                            ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                            'checkout absence could not be confirmed',
                            request.holderId,
                        ))
                    }
                }
            }
            const value = decodeCoordinationRecord(current, request.stackId)
            if (!value) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', request.stackId))
            if (isDrainActive(value) || isRestoreActive(value)) return abortStateTransaction(refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'claim release is blocked while the stack has an exclusive mutation', request.stackId))
            const target = value.holders.find((holder) => holder.holderId === request.holderId)
            if (request.requesterId !== request.holderId) {
                const authority = request.authority
                if (
                    !authorityIssued
                    || !authority
                    || authority.stackId !== request.stackId
                    || authority.requesterId !== request.requesterId
                    || authority.holderId !== request.holderId
                    || authority.claimedAt !== target?.claimedAt
                    || authority.recordRevision !== current?.revision
                    || !isCanonicalTimestamp(authority.observedAt)
                    || !isCanonicalTimestamp(authority.validThrough)
                    || Date.parse(authority.observedAt) > Date.parse(observedNow)
                    || Date.parse(observedNow) > Date.parse(authority.validThrough)
                ) {
                    return abortStateTransaction(refuse(
                        ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                        'requester has no positive-evidence authority to release the target holder',
                        request.holderId,
                    ))
                }
            }
            const holders = value.holders.filter((holder) => holder.holderId !== request.holderId)
            if (holders.length === value.holders.length) {
                if (request.requesterId === request.holderId) {
                    if (holders.length === 0) {
                        return abortStateTransaction(refuse(
                            ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                            'claim release requires an active non-final holder',
                            request.stackId,
                        ))
                    }
                    return abortStateTransaction({
                        kind: 'complete', change: 'unchanged',
                        decision: holders.length === 0 && value.lease?.released ? 'stop' : 'retain',
                        remaining: holders.map((holder) => holder.holderId),
                    })
                }
                return abortStateTransaction(refuse(
                    ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN,
                    'holder does not own a claim on the target stack',
                    request.stackId,
                ))
            }
            if (holders.length === 0) {
                return abortStateTransaction(refuse(
                    ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                    'the final holder must reserve and complete a drain before releasing the stack',
                    request.stackId,
                ))
            }
            return coordinationStateRecord(request.namespace, request.stackId, current, observedNow, {
                holders,
                lease: value.lease,
                lastReleasedHolder: request.holderId,
                drain: value.drain,
                restore: value.restore,
            })
        },
        crossHolder
            ? () => {
                  if (request.requesterId !== request.holderId && request.authority
                      && Date.now() > Date.parse(request.authority.validThrough)) {
                      return abortStateTransaction(refuse(
                          ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                          'holder release authority expired before claim release commit',
                          request.holderId,
                      ))
                  }
                  if (checkoutPath === undefined) return undefined
                  try {
                      lstatSync(checkoutPath)
                      return abortStateTransaction(refuse(
                          ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                          'checkout appeared before its claim release could be committed',
                          request.holderId,
                      ))
                  } catch (error) {
                      return (error as NodeJS.ErrnoException).code === 'ENOENT'
                          ? undefined
                          : abortStateTransaction(refuse(
                                ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                                'checkout absence could not be confirmed before claim release commit',
                                request.holderId,
                            ))
                  }
              }
            : undefined,
    ).catch((error: unknown) => {
        preserveAuthority()
        throw error
    })
    if ('diagnostics' in result || 'remaining' in result) {
        preserveAuthority()
        return result
    }
    if (result.kind === 'missing') {
        preserveAuthority()
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'claim transaction returned no record', result.path)
    }
    if (result.kind !== 'complete') {
        if (result.kind === 'indeterminate') consumeAuthority()
        else preserveAuthority()
        return stateRefusal(result)
    }
    consumeAuthority()
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

export async function classifyHolders(input: {
    readonly record: StateRecord | null
    readonly requester: HolderId
    readonly requestedAt: string
    readonly timeoutMs: number
    readonly observations: readonly HolderObservationInput[]
}): Promise<HolderClassificationResult> {
    let record: StateRecord | null
    let requester: HolderId
    let requestedAt: string
    let timeoutMs: number
    try {
        record = input.record
        requester = input.requester
        requestedAt = input.requestedAt
        timeoutMs = input.timeoutMs
    } catch {
        return refuse(ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN, 'holder classification input could not be read safely', 'holder classification input')
    }
    let stack: string
    let revision: number | undefined
    let value: CoordinationRecord | undefined
    try {
        stack = record?.subjectId ?? ''
        revision = record?.revision
        value = decodeCoordinationRecord(record, stack as StackId)
    } catch {
        return refuse(ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN, 'holder classification record could not be read safely', 'holder classification record')
    }
    let suppliedObservations: readonly HolderObservationInput[]
    try {
        suppliedObservations = input.observations
    } catch {
        return refuse(ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN, 'holder classification input could not be read safely', 'holder classification input')
    }
    const probeContract = issuedHolderObservations.get(suppliedObservations)
    if (!value || !Number.isSafeInteger(revision) || revision! < 0) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'claim holder record is malformed', stack)
    }
    const observations = snapshotHolderObservations(suppliedObservations, value.holders.length)
    if (!observations) {
        return refuse(
            ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN,
            'holder classification requires exactly one bounded resolved observation for each holder',
            stack,
        )
    }
    if (
        !validIdentity(requester, holderIdentity)
        || !isCanonicalTimestamp(requestedAt)
        || !Number.isSafeInteger(timeoutMs)
        || timeoutMs < 1
        || timeoutMs > 30_000
        || !Array.isArray(observations)
    ) {
        return refuse(
            ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN,
            'holder classification requires bounded resolved positive evidence',
            String(requester ?? ''),
            'provide a holder observation budget between 1 and 30000 milliseconds',
        )
    }
    const releaseEvidenceAuthentic = probeContract?.subjectId === stack
        && probeContract.revision === revision
        && probeContract.requestedAt === requestedAt
        && probeContract.timeoutMs === timeoutMs
    if (probeContract !== undefined && !releaseEvidenceAuthentic) {
        return refuse(
            ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN,
            'holder observations do not match their issued coordination and evidence window',
            stack,
        )
    }
    const observationsByHolder = new Map<HolderId, Observation<HolderLivenessEvidence>>()
    for (const entry of observations) {
        if (
            !entry
            || Object.keys(entry).sort().join(',') !== 'holderId,observation'
            || !validIdentity(entry.holderId, holderIdentity)
            || observationsByHolder.has(entry.holderId)
        ) {
            return refuse(
                ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN,
                'holder observations do not cover the coordination record exactly once',
                stack,
            )
        }
        observationsByHolder.set(entry.holderId, entry.observation)
    }
    if (
        observationsByHolder.size !== value.holders.length
        || value.holders.some((holder) => !observationsByHolder.has(holder.holderId))
    ) {
        return refuse(
            ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN,
            'holder observations do not cover the coordination record exactly once',
            stack,
        )
    }

    const classifications: ClassifiedHolder[] = []
    const authorities: HolderReleaseAuthority[] = []
    const releasable: {
        readonly holder: ClaimHolder
        readonly evidence: 'process-absent' | 'checkout-missing'
        readonly observedAt: string
        readonly producer: string
    }[] = []
    for (const holder of value.holders) {
        let observation = observationsByHolder.get(holder.holderId)
        const parsedObservation = HolderObservationSchema.safeParse(observation)
        if (!parsedObservation.success) {
            return refuse(
                ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN,
                'holder liveness observation is malformed',
                holder.holderId,
                'restore the named bounded liveness probe and retry',
            )
        }
        observation = parsedObservation.data as Observation<HolderLivenessEvidence>
        if (observation.state !== 'available') {
            return refuse(
                ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN,
                'holder liveness is unknown; elapsed age grants no authority',
                holder.holderId,
                'inspect the named holder and retry with positive process or checkout evidence',
            )
        }
        const observedAt = Date.parse(observation.observedAt)
        const windowStart = Date.parse(requestedAt)
        if (observedAt < windowStart || observedAt > windowStart + timeoutMs) {
            return refuse(
                ENVIRONMENT_CODES.CLAIM_LIVENESS_UNKNOWN,
                'holder liveness observation is outside the requested evidence window',
                holder.holderId,
                'retry with fresh positive process or checkout evidence',
            )
        }
        if (observation.value.state === 'live') {
            classifications.push({ holderId: holder.holderId, checkoutId: holder.checkoutId, state: 'live' })
        } else {
            const evidence = observation.value.evidence
            classifications.push({
                holderId: holder.holderId,
                checkoutId: holder.checkoutId,
                state: evidence === 'checkout-missing' ? 'checkout-missing' : 'dead',
            })
            releasable.push({ holder, evidence, observedAt: observation.observedAt, producer: observation.producer })
        }
    }

    const peer = classifications.find((holder) => holder.holderId !== requester && holder.state === 'live')
    if (peer) {
        return refuse(
            ENVIRONMENT_CODES.CLAIM_CO_TENANT,
            'another live holder shares this stack',
            peer.holderId,
            'ask the named holder to release the stack before down or reset',
        )
    }
    if (releaseEvidenceAuthentic && releasable.length > 0) {
        issuedHolderObservations.delete(suppliedObservations)
        for (const { holder, evidence, observedAt, producer } of releasable) {
            const authority = Object.freeze({
                stackId: stack as StackId,
                requesterId: requester,
                holderId: holder.holderId,
                claimedAt: holder.claimedAt,
                recordRevision: revision!,
                requestedAt,
                observedAt,
                validThrough: new Date(Date.parse(requestedAt) + timeoutMs).toISOString(),
                producer,
            }) as HolderReleaseAuthority
            releaseAuthorities.add(authority)
            if (evidence === 'checkout-missing') {
                const checkoutPath = probeContract?.checkoutPaths?.get(holder.holderId)
                if (checkoutPath !== undefined) releaseAuthorityCheckoutPaths.set(authority, checkoutPath)
            }
            authorities.push(authority)
        }
    }
    return { kind: 'complete', classifications, authorities }
}
