import { createConnection } from 'node:net'
import { z } from 'zod'
import { isEntrypointKind, type EntrypointKind } from '../entrypoint-kinds.js'
import { EntrypointDerivative, STRUCTURED_INPUT_ENTRY_LIMIT } from '../schema.js'
import {
    addCoordinationHolder,
    coordinationStateRecord,
    decodeCoordinationRecord,
    isDrainActive,
    removeExactCoordinationHolder,
    releaseClaim,
    readRootPortInventory,
    type HolderProcess,
    type HolderReleaseAuthority,
    type PortLeaseRecord,
} from './claims.js'
import {
    ENVIRONMENT_CODES,
    OBSERVATION_PRODUCER_BYTE_LIMIT,
    OBSERVATION_REASON_BYTE_LIMIT,
    REFUSAL_CODES,
    isCanonicalTimestamp,
    snapshotEnvironmentObservation,
    type EnvironmentCode,
    type EnvironmentDiagnostic,
    type EnvironmentObservation,
    type HolderId,
    type Observation,
    type StackId,
} from './contract.js'
import {
    SERIALIZED_RECORD_BYTE_LIMIT,
    abortStateTransaction,
    authenticateStateNamespace,
    readState,
    snapshotStateNamespace,
    transactState,
    withStateRootPortLock,
    type StateNamespace,
    type StateRecord,
    type StateResult,
    type StateTransactionAbort,
} from './state.js'

export const mechanism = {
    id: 'environment-port-coordination',
    module: 'packages/cockpit/src/environment/ports.ts',
    exports: ['leasePortFamily', 'acquirePortProjection', 'observeRetainedPortFamily', 'inspectRecordedPortDeclaration', 'projectRetainedPortFamilyResult', 'inspectPortLeaseProjection', 'revalidatePortLeaseProjection', 'inspectPortLeaseTransfer', 'compensateAcquiredPortHolder', 'releasePortFamily', 'deriveEntrypoints', 'projectPortLeaseResult', 'consumePortLeaseProjection', 'observePortFamily', 'observePortListeners', 'isPortObservation'],
} as const

const issuedObservations = new WeakMap<object, number>()
const issuedLeaseResults = new WeakMap<object, {
    readonly result: Extract<LeasePortFamilyResult, { kind: 'complete' }>
    readonly observedAt: string
    readonly holderIds: readonly HolderId[]
    readonly address: ReturnType<StateNamespace['paths']['coordination']>
    readonly compensation?: Readonly<{
        readonly address: ReturnType<StateNamespace['paths']['coordination']>
        readonly recordBody: string
    }>
}>()
const availableCompensations = new WeakSet<object>()
const reservedCompensations = new WeakSet<object>()
const issuedEntrypointResults = new WeakMap<object, { readonly stackId: StackId; readonly ports: Readonly<Record<string, number>> }>()
const issuedLeaseProjections = new WeakMap<object, Readonly<{
    available: boolean
    address: ReturnType<StateNamespace['paths']['coordination']>
}>>()
const issuedRetainedPortFamilies = new WeakMap<object, {
    readonly address: ReturnType<StateNamespace['paths']['coordination']>
    readonly recordFingerprint: string
    readonly holderIds: readonly HolderId[]
}>()
const availableRetainedPortFamilies = new WeakSet<object>()

function issueObservation(value: EnvironmentObservation): EnvironmentObservation {
    const snapshot = snapshotEnvironmentObservation(value)
    if (!snapshot || snapshot.owner !== mechanism.id) throw new TypeError('port observation is malformed')
    issuedObservations.set(snapshot, Date.now())
    return snapshot
}

export function isPortObservation(value: unknown): value is import('./contract.js').EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedObservations.has(value)
}

export async function observePortFamily(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly observedAt: string
    readonly leaseEvidence?: LeasePortFamilyResult
}): Promise<EnvironmentObservation> {
    const namespace = authenticateStateNamespace(snapshotStateNamespace(input.namespace))
    if (!namespace || !/^stack:[a-f0-9]{64}$/.test(input.stackId) || !isCanonicalTimestamp(input.observedAt)) {
        throw new TypeError('port observation input is malformed')
    }
    const inventory = await readRootPortInventory(namespace)
    const refusal = inventory.kind === 'refusal' ? inventory.diagnostics[0] : undefined
    const cockpitId = namespace.paths.coordination(input.stackId).cockpitId
    const record = inventory.kind === 'complete' ? inventory.value.find((item) => item.cockpitId === cockpitId && item.stackId === input.stackId)?.record : undefined
    const occupied = new Set<number>()
    let collision = false
    if (inventory.kind === 'complete') {
        for (const item of inventory.value) {
            if (!item.record.lease || item.record.lease.released) continue
            for (const port of Object.values(item.record.lease.ports)) {
                if (occupied.has(port)) collision = true
                occupied.add(port)
            }
        }
    }
    const leaseAuthority = input.leaseEvidence && issuedLeaseResults.get(input.leaseEvidence)
    const listenerEvidenceCurrent = input.leaseEvidence?.kind === 'complete'
        && leaseAuthority?.result.lease.stackId === input.stackId && leaseAuthority.observedAt === input.observedAt
        && record?.lease !== null && record?.lease !== undefined && !record.lease.released
        && sameValues(record.lease.ports, input.leaseEvidence.lease.ports)
    return issueObservation({
        code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION,
        owner: mechanism.id,
        stackId: input.stackId,
        source: namespace.paths.coordination(input.stackId).path,
        observed: refusal
            ? { state: 'failed', reason: refusal.message, observedAt: input.observedAt }
            : collision
                ? { state: 'available', value: false, observedAt: input.observedAt }
                : listenerEvidenceCurrent
                    ? { state: 'available', value: true, observedAt: input.observedAt }
                    : { state: 'unavailable', reason: record?.lease && !record.lease.released
                        ? 'current host-listener evidence is unavailable'
                        : 'the stack has no active port-family lease', observedAt: input.observedAt },
        expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'environment' },
        freshness: { state: 'current' },
        remedy: 'lease the declared port family before starting the stack',
    })
}

const stackIdentity = /^stack:[a-f0-9]{64}$/
const holderIdentity = /^holder:[a-f0-9]{64}:session$/
const portKey = /^[A-Z][A-Z0-9_]*$/
const DerivativeInputSchema = z.object({
    lease: z.object({
        stackId: z.string(),
        offset: z.number(),
        ports: z.record(z.string(), z.number()).refine(
            (ports) => Object.keys(ports).length <= STRUCTURED_INPUT_ENTRY_LIMIT,
        ),
    }).strict().nullable(),
    declarations: z.array(z.object({
        name: z.string(),
        kind: z.string(),
        port: z.string(),
        path: z.string(),
        hostname: EntrypointDerivative.shape.hostname,
        scheme: EntrypointDerivative.shape.scheme,
    }).strict()).max(STRUCTURED_INPUT_ENTRY_LIMIT),
    declaredValues: z.record(z.string(), z.string()).refine(
        (values) => Object.keys(values).length <= STRUCTURED_INPUT_ENTRY_LIMIT,
    ).optional(),
}).strict()

export interface PortFamilyConfig {
    readonly step: number
    readonly count: number
    readonly bases: Readonly<Record<string, number>>
}

export interface PortListenerEvidenceInput {
    readonly ports: readonly number[]
    readonly observation: Observation<readonly number[]>
}

export type PortListenerHost = '127.0.0.1' | '::1' | '0.0.0.0' | '::'

export interface PortListenerBinding {
    readonly hostIp: PortListenerHost
    readonly port: number
    readonly expected: 'listening' | 'free'
}

export type PortListenerObservation =
    | Readonly<{
          kind: 'complete'
          rows: readonly Readonly<{
              hostIp: PortListenerHost
              probeHost: '127.0.0.1' | '::1'
              port: number
              listening: boolean
          }>[]
          observedAt: string
      }>
    | Readonly<{ kind: 'unavailable'; reason: string }>

export interface PortLease {
    readonly stackId: StackId
    readonly offset: number
    readonly ports: Readonly<Record<string, number>>
}

type PortRefusal = { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

export type LeasePortFamilyResult =
    | { readonly kind: 'complete'; readonly change: 'acquired' | 'unchanged'; readonly holderId: HolderId; readonly recordRevision: number; readonly lease: PortLease; readonly observation: 'resolved-listener-evidence-accepted' }
    | PortRefusal

function issueLeaseResult(
    result: Extract<LeasePortFamilyResult, { kind: 'complete' }>,
    observedAt: string,
    holderIds: readonly HolderId[],
    namespace: StateNamespace,
    record: StateRecord,
): LeasePortFamilyResult {
    const snapshot = Object.freeze({
        ...result,
        lease: Object.freeze({ ...result.lease, ports: Object.freeze({ ...result.lease.ports }) }),
    })
    const address = Object.freeze({ ...namespace.paths.coordination(result.lease.stackId) })
    const compensation = result.change === 'acquired'
        ? Object.freeze({
              address,
              recordBody: JSON.stringify(record),
          })
        : undefined
    issuedLeaseResults.set(snapshot, {
        result: snapshot,
        observedAt,
        holderIds: Object.freeze([...holderIds].sort()),
        address,
        ...(compensation ? { compensation } : {}),
    })
    if (compensation) availableCompensations.add(snapshot)
    return snapshot
}

export type ReleasePortFamilyResult =
    | { readonly kind: 'complete'; readonly change: 'released' | 'retained' | 'unchanged' }
    | PortRefusal

export interface DerivedEntrypoint {
    readonly name: string
    readonly kind: EntrypointKind
    readonly port: string
    readonly value: string
}

export type DeriveEntrypointsResult =
    | {
          readonly kind: 'complete'
          readonly values: readonly DerivedEntrypoint[]
          readonly diagnostics: readonly EnvironmentDiagnostic[]
      }
    | PortRefusal

export interface PortLeaseProjection {
    readonly lease: PortLease
    readonly ownership: Readonly<{
        change: 'acquired' | 'unchanged'
        holderId: HolderId
        recordRevision: number
        holderCount: number
        holderIds: readonly HolderId[]
    }>
    readonly entrypoints: readonly DerivedEntrypoint[]
}

function issuePortLeaseProjection(input: {
    readonly lease: PortLease
    readonly change: 'acquired' | 'unchanged'
    readonly holderId: HolderId
    readonly recordRevision: number
    readonly holderIds: readonly HolderId[]
    readonly entrypoints: readonly DerivedEntrypoint[]
    readonly address: ReturnType<StateNamespace['paths']['coordination']>
}): PortLeaseProjection {
    const projection = Object.freeze({
        lease: Object.freeze({ ...input.lease, ports: Object.freeze({ ...input.lease.ports }) }),
        ownership: Object.freeze({
            change: input.change,
            holderId: input.holderId,
            recordRevision: input.recordRevision,
            holderCount: input.holderIds.length,
            holderIds: Object.freeze([...input.holderIds]),
        }),
        entrypoints: Object.freeze(input.entrypoints.map((entrypoint) => Object.freeze({ ...entrypoint }))),
    })
    issuedLeaseProjections.set(projection, Object.freeze({ available: true, address: input.address }))
    return projection
}

export function projectPortLeaseResult(input: {
    readonly leaseResult: LeasePortFamilyResult
    readonly entrypointResult: DeriveEntrypointsResult
}): PortLeaseProjection | undefined {
    try {
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 2 || !('value' in descriptors.leaseResult!) || !('value' in descriptors.entrypointResult!)) return undefined
        const leaseResult = descriptors.leaseResult!.value as LeasePortFamilyResult
        const entrypointResult = descriptors.entrypointResult!.value as DeriveEntrypointsResult
        const leaseEvidence = leaseResult && typeof leaseResult === 'object' ? issuedLeaseResults.get(leaseResult) : undefined
        const entrypointEvidence = entrypointResult && typeof entrypointResult === 'object' ? issuedEntrypointResults.get(entrypointResult) : undefined
        if (!leaseEvidence || leaseResult.kind !== 'complete' || !entrypointEvidence || entrypointResult.kind !== 'complete'
            || leaseEvidence.result !== leaseResult || entrypointEvidence.stackId !== leaseEvidence.result.lease.stackId
            || !sameValues(entrypointEvidence.ports, leaseEvidence.result.lease.ports)) return undefined
        const issued = leaseEvidence.result
        return issuePortLeaseProjection({
            lease: issued.lease,
            change: issued.change,
            holderId: issued.holderId,
            recordRevision: issued.recordRevision,
            holderIds: leaseEvidence.holderIds,
            entrypoints: entrypointResult.values,
            address: leaseEvidence.address,
        })
    } catch { return undefined }
}

export type RetainedPortFamilyResult =
    | Readonly<{
          readonly kind: 'complete'
          readonly holderId: HolderId
          readonly recordRevision: number
          readonly lease: PortLease
      }>
    | PortRefusal

// `config: 'recorded'` is for the commands that stop or remove a stack. The lease belongs to the
// stack, and its containers publish the ports it was started with, so editing [ports.bases] while it
// runs must not strand it: comparing against the edited declaration made sleep and down refuse the
// very stack the recovery tells the operator to remove.
export async function observeRetainedPortFamily(supplied: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly checkoutId: import('./contract.js').CheckoutId
    readonly config: PortFamilyConfig | 'recorded'
}): Promise<RetainedPortFamilyResult> {
    let namespace: StateNamespace | undefined
    let stackId: StackId | undefined
    let holderId: HolderId | undefined
    let checkoutId: import('./contract.js').CheckoutId | undefined
    let config: PortFamilyConfig | 'recorded' | undefined
    try {
        if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('invalid input')
        const descriptors = Object.getOwnPropertyDescriptors(supplied)
        const keys = ['namespace', 'stackId', 'holderId', 'checkoutId', 'config']
        if (Reflect.ownKeys(descriptors).length !== keys.length
            || keys.some((key) => !descriptors[key] || !('value' in descriptors[key]!))) throw new Error('invalid input')
        namespace = authenticateStateNamespace(descriptors.namespace!.value)
        stackId = descriptors.stackId!.value as StackId
        holderId = descriptors.holderId!.value as HolderId
        checkoutId = descriptors.checkoutId!.value as import('./contract.js').CheckoutId
        const configSnapshot = descriptors.config!.value === 'recorded' ? 'recorded' : snapshotPortConfig(descriptors.config!.value)
        if (typeof configSnapshot === 'string' && configSnapshot !== 'recorded') throw new Error(configSnapshot)
        config = configSnapshot
    } catch {
        return refuse(ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, 'retained port-family input is malformed', 'retained port family')
    }
    if (!namespace || !stackId || !holderId || !checkoutId || !config
        || !stackIdentity.test(stackId) || !holderIdentity.test(holderId)
        || !/^checkout:[a-f0-9]{64}$/.test(checkoutId)) {
        return refuse(ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, 'retained port-family input is malformed', String(stackId ?? ''))
    }
    const address = namespace.paths.coordination(stackId)
    const stored = await readState(address)
    if (stored.kind !== 'complete') {
        return stored.kind === 'missing'
            ? refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'retained port-family observation found no coordination record', stored.path)
            : stateRefusal(stored)
    }
    const value = decodeCoordinationRecord(stored.value, stackId)
    if (!value) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', address.path)
    const holder = value.holders.find((candidate) => candidate.holderId === holderId)
    if (!holder || holder.checkoutId !== checkoutId || value.lease === null || value.lease.released) {
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'retained port-family observation requires the exact current holder and active lease', stackId)
    }
    if (config !== 'recorded' && !sameDeclaration(value.lease.declaration, config)) {
        return refuse(ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION, 'active port lease declaration changed during execution', stackId)
    }
    const inventory = await readRootPortInventory(namespace)
    if (inventory.kind !== 'complete') return inventory
    const cockpitId = address.cockpitId
    const ports = new Set(Object.values(value.lease.ports))
    if (inventory.value.some((item) => (item.cockpitId !== cockpitId || item.stackId !== stackId)
        && item.record.lease !== null && !item.record.lease.released
        && Object.values(item.record.lease.ports).some((port) => ports.has(port)))) {
        return refuse(ENVIRONMENT_CODES.PORT_FAMILY_COLLISION, 'retained port family intersects another active state-root reservation', stackId,
            'stop and release the conflicting stack through its owning cockpit before retrying')
    }
    const result = Object.freeze({
        kind: 'complete' as const,
        holderId,
        recordRevision: stored.value.revision,
        lease: Object.freeze({ stackId, offset: value.lease.offset, ports: Object.freeze({ ...value.lease.ports }) }),
    })
    issuedRetainedPortFamilies.set(result, Object.freeze({
        address: Object.freeze({ ...address }),
        recordFingerprint: JSON.stringify(stored.value),
        holderIds: Object.freeze(value.holders.map(({ holderId }) => holderId)),
    }))
    availableRetainedPortFamilies.add(result)
    return result
}

// Whether the stack still holds a lease taken under a different [ports] declaration. `up` asks
// before leasing so that editing the port family of a recorded stack meets the same down-then-up
// recovery as any other runtime change, instead of the lease's mid-execution refusal.
export async function inspectRecordedPortDeclaration(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly config: PortFamilyConfig
}): Promise<Readonly<{ kind: 'complete'; changed: boolean }> | PortRefusal> {
    const address = input.namespace.paths.coordination(input.stackId)
    const stored = await readState(address)
    if (stored.kind === 'missing') return Object.freeze({ kind: 'complete', changed: false })
    if (stored.kind !== 'complete') return stateRefusal(stored)
    const value = decodeCoordinationRecord(stored.value, input.stackId)
    if (!value) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', address.path)
    const lease = value.lease
    return Object.freeze({ kind: 'complete', changed: lease !== null && !lease.released && !sameDeclaration(lease.declaration, input.config) })
}

export async function projectRetainedPortFamilyResult(input: {
    readonly retainedResult: RetainedPortFamilyResult
    readonly entrypointResult: DeriveEntrypointsResult
}): Promise<PortLeaseProjection | undefined> {
    try {
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 2
            || !('value' in descriptors.retainedResult!) || !('value' in descriptors.entrypointResult!)) return undefined
        const retainedResult = descriptors.retainedResult!.value as RetainedPortFamilyResult
        const entrypointResult = descriptors.entrypointResult!.value as DeriveEntrypointsResult
        const retained = retainedResult && typeof retainedResult === 'object'
            ? issuedRetainedPortFamilies.get(retainedResult)
            : undefined
        const entrypoints = entrypointResult && typeof entrypointResult === 'object'
            ? issuedEntrypointResults.get(entrypointResult)
            : undefined
        if (!retained || retainedResult.kind !== 'complete'
            || !availableRetainedPortFamilies.has(retainedResult)
            || !entrypoints || entrypointResult.kind !== 'complete'
            || entrypoints.stackId !== retainedResult.lease.stackId
            || !sameValues(entrypoints.ports, retainedResult.lease.ports)) return undefined
        availableRetainedPortFamilies.delete(retainedResult)
        const current = await readState(retained.address)
        if (current.kind !== 'complete' || current.value.revision !== retainedResult.recordRevision
            || JSON.stringify(current.value) !== retained.recordFingerprint) return undefined
        return issuePortLeaseProjection({
            lease: retainedResult.lease,
            change: 'unchanged',
            holderId: retainedResult.holderId,
            recordRevision: retainedResult.recordRevision,
            holderIds: retained.holderIds,
            entrypoints: entrypointResult.values,
            address: retained.address,
        })
    } catch {
        return undefined
    }
}

export function consumePortLeaseProjection(projection: PortLeaseProjection): PortLeaseProjection | undefined {
    const issued = projection && typeof projection === 'object' ? issuedLeaseProjections.get(projection) : undefined
    if (!issued?.available) return undefined
    issuedLeaseProjections.set(projection, Object.freeze({ ...issued, available: false }))
    return projection
}

export function inspectPortLeaseProjection(projection: PortLeaseProjection, namespace?: StateNamespace): PortLeaseProjection | undefined {
    const issued = projection && typeof projection === 'object' ? issuedLeaseProjections.get(projection) : undefined
    if (!issued) return undefined
    if (namespace === undefined) return issued.available ? projection : undefined
    // Lifecycle admission consumes the projection before data work checks its coordination origin.
    const authenticated = authenticateStateNamespace(namespace)
    return authenticated?.paths.coordination(projection.lease.stackId).path === issued.address.path ? projection : undefined
}

export async function revalidatePortLeaseProjection(input: {
    readonly projection: PortLeaseProjection
    readonly namespace: StateNamespace
}): Promise<boolean> {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return false
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 2
            || !('value' in (descriptors.projection ?? {})) || !('value' in (descriptors.namespace ?? {}))) return false
        const projection = descriptors.projection!.value as PortLeaseProjection
        const issued = projection && typeof projection === 'object' ? issuedLeaseProjections.get(projection) : undefined
        const namespace = authenticateStateNamespace(snapshotStateNamespace(descriptors.namespace!.value as StateNamespace))
        if (!issued || !namespace) return false
        const address = namespace.paths.coordination(projection.lease.stackId)
        if (!sameCoordinationAddress(address, issued.address)) return false
        const current = await readState(address)
        if (current.kind !== 'complete' || current.value.revision !== projection.ownership.recordRevision) return false
        const value = decodeCoordinationRecord(current.value, projection.lease.stackId)
        if (!value?.lease || value.lease.released || value.lease.offset !== projection.lease.offset
            || !sameValues(value.lease.ports, projection.lease.ports)) return false
        const holderIds = value.holders.map(({ holderId }) => holderId).sort()
        return holderIds.includes(projection.ownership.holderId)
            && projection.ownership.holderCount === holderIds.length
            && JSON.stringify(projection.ownership.holderIds) === JSON.stringify(holderIds)
    } catch {
        return false
    }
}

export type PortLeaseTransferInspection = Readonly<{ readonly kind: 'complete' }> | PortRefusal

export async function inspectPortLeaseTransfer(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly checkoutId: import('./contract.js').CheckoutId
    readonly previousHolderId: HolderId
    readonly projection: PortLeaseProjection
}): Promise<PortLeaseTransferInspection> {
    let namespace: StateNamespace | undefined
    let stackId: StackId | undefined
    let holderId: HolderId | undefined
    let checkoutId: import('./contract.js').CheckoutId | undefined
    let previousHolderId: HolderId | undefined
    let projection: PortLeaseProjection | undefined
    try {
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 6
            || !['namespace', 'stackId', 'holderId', 'checkoutId', 'previousHolderId', 'projection']
                .every((key) => descriptors[key] && 'value' in descriptors[key]!)) throw new Error('invalid input')
        namespace = authenticateStateNamespace(descriptors.namespace!.value)
        stackId = descriptors.stackId!.value as StackId
        holderId = descriptors.holderId!.value as HolderId
        checkoutId = descriptors.checkoutId!.value as import('./contract.js').CheckoutId
        previousHolderId = descriptors.previousHolderId!.value as HolderId
        const candidate = descriptors.projection!.value as PortLeaseProjection
        projection = candidate && typeof candidate === 'object' && candidate.lease && candidate.ownership
            ? Object.freeze({
                  ...candidate,
                  lease: Object.freeze({ ...candidate.lease, ports: Object.freeze({ ...candidate.lease.ports }) }),
                  ownership: Object.freeze({ ...candidate.ownership, holderIds: Object.freeze([...candidate.ownership.holderIds]) }),
              })
            : undefined
    } catch {
        return refuse(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'port lease transfer input is malformed', 'port lease transfer')
    }
    if (!namespace || !stackId || !holderId || !checkoutId || !previousHolderId || !projection
        || !stackIdentity.test(stackId) || !holderIdentity.test(holderId) || !holderIdentity.test(previousHolderId)
        || !/^checkout:[a-f0-9]{64}$/.test(checkoutId) || previousHolderId === holderId
        || projection.lease.stackId !== stackId || projection.ownership.holderId !== holderId
        || !Number.isSafeInteger(projection.lease.offset) || projection.lease.offset < 0
        || !Number.isSafeInteger(projection.ownership.recordRevision) || projection.ownership.recordRevision < 0
        || projection.ownership.holderCount !== projection.ownership.holderIds.length) {
        return refuse(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'port lease transfer input is malformed', String(stackId ?? 'port lease transfer'))
    }
    const stored = await readState(namespace.paths.coordination(stackId))
    if (stored.kind !== 'complete') {
        return stored.kind === 'missing'
            ? refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'port lease transfer found no coordination record', stored.path)
            : stateRefusal(stored)
    }
    const current = decodeCoordinationRecord(stored.value, stackId)
    if (!current) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', stored.value.subjectId)
    const holder = current.holders.find((candidate) => candidate.holderId === holderId)
    const currentHolderIds = current.holders.map((candidate) => candidate.holderId).sort()
    const projectedHolderIds = [...projection.ownership.holderIds].sort()
    if (stored.value.revision !== projection.ownership.recordRevision
        || !holder || holder.checkoutId !== checkoutId
        || current.holders.some((candidate) => candidate.holderId === previousHolderId)
        || currentHolderIds.length !== projectedHolderIds.length
        || currentHolderIds.some((candidate, index) => candidate !== projectedHolderIds[index])
        || current.lease === null || current.lease.released || current.lease.offset !== projection.lease.offset
        || !sameValues(current.lease.ports, projection.lease.ports)) {
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'lifecycle progress belongs to an active or replaced holder', stackId)
    }
    return Object.freeze({ kind: 'complete' })
}

function diagnostic(
    severity: EnvironmentDiagnostic['severity'],
    code: EnvironmentCode,
    message: string,
    target: string,
    fix?: string,
): EnvironmentDiagnostic {
    return { severity, code, message, target, ...(fix ? { fix } : {}) }
}

function refuse(code: EnvironmentCode, message: string, target: string, fix?: string): PortRefusal {
    return { kind: 'refusal', diagnostics: [diagnostic('error', code, message, target, fix)] }
}

function stateRefusal(result: Exclude<StateResult<unknown>, { kind: 'complete' | 'missing' }>): PortRefusal {
    return refuse(result.code, result.message, result.target, 'recovery' in result ? result.recovery : undefined)
}

function sameValues(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

function sameDeclaration(recorded: PortFamilyConfig, declared: PortFamilyConfig): boolean {
    return recorded.step === declared.step && recorded.count === declared.count && sameValues(recorded.bases, declared.bases)
}

function validateConfig(config: PortFamilyConfig): string | undefined {
    if (
        !config
        || !Number.isSafeInteger(config.step)
        || config.step < 1
        || !Number.isSafeInteger(config.count)
        || config.count < 1
        || !config.bases
        || Object.keys(config.bases).length === 0
    ) return 'port family count, step, and bases must be positive safe integers'
    const memberCount = config.count * Object.keys(config.bases).length
    if (!Number.isSafeInteger(memberCount) || memberCount > STRUCTURED_INPUT_ENTRY_LIMIT) {
        return `port family candidate members must not exceed the shared input structure budget of ${STRUCTURED_INPUT_ENTRY_LIMIT}`
    }
    for (const [key, base] of Object.entries(config.bases)) {
        if (!portKey.test(key) || !Number.isSafeInteger(base) || base < 1 || base > 65535) {
            return `port family base ${key} is outside the supported range`
        }
    }
    if (new Set(Object.values(config.bases)).size !== Object.keys(config.bases).length) {
        return 'port family bases must not overlap'
    }
    const familyMembers = new Set<number>()
    for (let index = 0; index < config.count; index += 1) {
        const offset = index * config.step
        for (const base of Object.values(config.bases)) {
            const port = base + offset
            if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
                return 'configured port family exceeds the safe host port range'
            }
            if (familyMembers.has(port)) return 'declared candidate port families overlap'
            familyMembers.add(port)
        }
    }
    return undefined
}

function snapshotPortConfig(value: unknown): PortFamilyConfig | string {
    try {
        if (!value || typeof value !== 'object') return 'port family config is invalid'
        const step = (value as { step?: unknown }).step
        const count = (value as { count?: unknown }).count
        const rawBases = (value as { bases?: unknown }).bases
        if (!rawBases || typeof rawBases !== 'object' || Array.isArray(rawBases)) return 'port family bases are invalid'
        const keys = Object.keys(rawBases)
        if (keys.length < 1 || keys.length > STRUCTURED_INPUT_ENTRY_LIMIT) return 'port family bases exceed the shared input structure budget'
        const bases: Record<string, number> = {}
        let byteBudget = 2
        for (const key of keys) {
            const base = (rawBases as Record<string, unknown>)[key]
            byteBudget += Buffer.byteLength(key, 'utf8') + 16
            if (byteBudget > SERIALIZED_RECORD_BYTE_LIMIT) return 'port family bases exceed the state record byte budget'
            bases[key] = base as number
        }
        const snapshot = Object.freeze({ step: step as number, count: count as number, bases: Object.freeze(bases) })
        return validateConfig(snapshot) ?? snapshot
    } catch {
        return 'port family config is invalid'
    }
}

async function transactLease<T>(
    namespace: StateNamespace,
    stackId: StackId,
    holderId: HolderId,
    update: (current: StateRecord | null) => Promise<StateRecord | StateTransactionAbort<T>> | StateRecord | StateTransactionAbort<T>,
): Promise<StateResult<StateRecord> | T> {
    const result = await transactState(
        namespace,
        namespace.paths.coordination(stackId),
        { ownerId: holderId, contentionTimeoutMs: 2_000 },
        update,
    )
    const aborted = result as StateTransactionAbort<T>
    return aborted.aborted === true ? aborted.value : result as StateResult<StateRecord>
}

interface ListenerEvidence {
    readonly offset: number
    readonly ports: Readonly<Record<string, number>>
    readonly result:
        | {
              readonly kind: 'complete'
              readonly occupied: readonly number[]
              readonly observedAt: string
              readonly producer: string
          }
        | { readonly kind: 'refusal'; readonly refusal: PortRefusal }
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort()
    const expected = [...keys].sort()
    return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function boundedArrayLength(value: unknown, maximum: number): number | undefined {
    try {
        if (!Array.isArray(value)) return undefined
        const descriptor = Object.getOwnPropertyDescriptor(value, 'length')
        if (
            !descriptor
            || !('value' in descriptor)
            || !Number.isSafeInteger(descriptor.value)
            || descriptor.value < 0
            || descriptor.value > maximum
        ) return undefined
        return descriptor.value
    } catch {
        return undefined
    }
}

function boundedText(value: unknown, maximumBytes: number): value is string {
    return typeof value === 'string'
        && value.length > 0
        && Buffer.byteLength(value, 'utf8') <= maximumBytes
}

function snapshotListenerEvidence(
    value: unknown,
    config: PortFamilyConfig,
): readonly PortListenerEvidenceInput[] | undefined {
    const entryCount = boundedArrayLength(value, config.count)
    if (entryCount === undefined) return undefined
    const snapshots: PortListenerEvidenceInput[] = []
    let byteBudget = 2
    try {
        for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
            if (!Object.hasOwn(value as object, entryIndex)) return undefined
            const rawEntry = (value as readonly unknown[])[entryIndex]
            if (!rawEntry || typeof rawEntry !== 'object' || !hasExactKeys(rawEntry, ['ports', 'observation'])) return undefined
            const rawPorts = (rawEntry as { ports?: unknown }).ports
            const rawObservation = (rawEntry as { observation?: unknown }).observation
            const portCount = boundedArrayLength(rawPorts, Object.keys(config.bases).length)
            if (portCount === undefined || portCount !== Object.keys(config.bases).length) return undefined
            const ports: number[] = []
            for (let portIndex = 0; portIndex < portCount; portIndex += 1) {
                if (!Object.hasOwn(rawPorts as object, portIndex)) return undefined
                const rawPort = (rawPorts as readonly unknown[])[portIndex]
                if (!Number.isSafeInteger(rawPort) || (rawPort as number) < 1 || (rawPort as number) > 65535) return undefined
                ports.push(rawPort as number)
                byteBudget += 8
            }
            if (new Set(ports).size !== ports.length || !rawObservation || typeof rawObservation !== 'object') return undefined
            const state = (rawObservation as { state?: unknown }).state
            let observation: Observation<readonly number[]>
            if (state === 'available') {
                if (!hasExactKeys(rawObservation, ['state', 'value', 'observedAt', 'producer'])) return undefined
                const rawOccupied = (rawObservation as { value?: unknown }).value
                const occupiedCount = boundedArrayLength(rawOccupied, ports.length)
                const observedAt = (rawObservation as { observedAt?: unknown }).observedAt
                const producer = (rawObservation as { producer?: unknown }).producer
                if (occupiedCount === undefined || typeof observedAt !== 'string' || !boundedText(producer, OBSERVATION_PRODUCER_BYTE_LIMIT)) return undefined
                const occupied: number[] = []
                for (let occupiedIndex = 0; occupiedIndex < occupiedCount; occupiedIndex += 1) {
                    if (!Object.hasOwn(rawOccupied as object, occupiedIndex)) return undefined
                    const rawPort = (rawOccupied as readonly unknown[])[occupiedIndex]
                    if (!Number.isSafeInteger(rawPort)) return undefined
                    occupied.push(rawPort as number)
                    byteBudget += 8
                }
                byteBudget += Buffer.byteLength(observedAt, 'utf8') + Buffer.byteLength(producer, 'utf8')
                observation = { state, value: Object.freeze(occupied), observedAt, producer }
            } else if (state === 'unavailable') {
                if (!hasExactKeys(rawObservation, ['state', 'reason', 'producer'])) return undefined
                const reason = (rawObservation as { reason?: unknown }).reason
                const producer = (rawObservation as { producer?: unknown }).producer
                if (!boundedText(reason, OBSERVATION_REASON_BYTE_LIMIT) || !boundedText(producer, OBSERVATION_PRODUCER_BYTE_LIMIT)) return undefined
                byteBudget += Buffer.byteLength(reason, 'utf8') + Buffer.byteLength(producer, 'utf8')
                observation = { state, reason, producer }
            } else if (state === 'failed') {
                if (!hasExactKeys(rawObservation, ['state', 'code', 'reason', 'producer'])) return undefined
                const code = (rawObservation as { code?: unknown }).code
                const reason = (rawObservation as { reason?: unknown }).reason
                const producer = (rawObservation as { producer?: unknown }).producer
                if (
                    !REFUSAL_CODES.includes(code as never)
                    || !boundedText(reason, OBSERVATION_REASON_BYTE_LIMIT)
                    || !boundedText(producer, OBSERVATION_PRODUCER_BYTE_LIMIT)
                ) return undefined
                byteBudget += Buffer.byteLength(reason, 'utf8') + Buffer.byteLength(producer, 'utf8')
                observation = { state, code: code as typeof REFUSAL_CODES[number], reason, producer }
            } else return undefined
            if (byteBudget > SERIALIZED_RECORD_BYTE_LIMIT) return undefined
            snapshots.push(Object.freeze({ ports: Object.freeze(ports), observation: Object.freeze(observation) }))
        }
    } catch {
        return undefined
    }
    return Object.freeze(snapshots)
}

interface ListenerEvidenceResult {
    readonly evidence: readonly ListenerEvidence[]
    readonly refusal?: PortRefusal
}

async function probeLoopbackPort(port: number, timeoutMs: number, host: '127.0.0.1' | '::1' = '127.0.0.1'): Promise<boolean | undefined> {
    return new Promise((resolveProbe) => {
        const socket = createConnection({ host, port })
        let settled = false
        const finish = (value: boolean | undefined) => {
            if (settled) return
            settled = true
            socket.destroy()
            resolveProbe(value)
        }
        socket.setTimeout(timeoutMs, () => finish(undefined))
        socket.once('connect', () => finish(true))
        socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' ? false : undefined))
    })
}

async function probeListenerFamily(ports: readonly number[], timeoutMs: number): Promise<readonly number[] | undefined> {
    const probes = await Promise.all(ports.map(async (port) => [port, await probeLoopbackPort(port, timeoutMs)] as const))
    if (probes.some(([, occupied]) => occupied === undefined)) return undefined
    return probes.filter(([, occupied]) => occupied).map(([port]) => port)
}

export async function observePortListeners(input: {
    readonly bindings: readonly PortListenerBinding[]
    readonly timeoutMs: number
}): Promise<PortListenerObservation> {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            return Object.freeze({ kind: 'unavailable', reason: 'listener observation input is malformed' })
        }
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 2
            || !('value' in (descriptors.bindings ?? {})) || !('value' in (descriptors.timeoutMs ?? {}))) {
            return Object.freeze({ kind: 'unavailable', reason: 'listener observation input is malformed' })
        }
        const bindings = descriptors.bindings!.value
        const timeoutMs = descriptors.timeoutMs!.value as unknown
        if (!Array.isArray(bindings) || bindings.length === 0 || bindings.length > STRUCTURED_INPUT_ENTRY_LIMIT
            || !Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 30_000) {
            return Object.freeze({ kind: 'unavailable', reason: 'listener observation input is outside its declared bounds' })
        }
        const rows: { hostIp: PortListenerHost; probeHost: '127.0.0.1' | '::1'; port: number; expected: 'listening' | 'free' }[] = []
        const identities = new Set<string>()
        for (const binding of bindings) {
            if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
                return Object.freeze({ kind: 'unavailable', reason: 'listener binding is malformed' })
            }
            const captured = Object.getOwnPropertyDescriptors(binding)
            if (Reflect.ownKeys(captured).length !== 3
                || !('value' in (captured.hostIp ?? {})) || !('value' in (captured.port ?? {}))
                || !('value' in (captured.expected ?? {}))) {
                return Object.freeze({ kind: 'unavailable', reason: 'listener binding is malformed' })
            }
            const hostIp = captured.hostIp!.value
            const port = captured.port!.value
            const expected = captured.expected!.value
            if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(hostIp)
                || !Number.isSafeInteger(port) || port < 1 || port > 65_535
                || expected !== 'listening' && expected !== 'free') {
                return Object.freeze({ kind: 'unavailable', reason: 'listener binding is outside its declared bounds' })
            }
            const probeHost = hostIp === '::1' || hostIp === '::' ? '::1' as const : '127.0.0.1' as const
            const identity = `${probeHost}\0${port}`
            if (identities.has(identity)) {
                return Object.freeze({ kind: 'unavailable', reason: 'listener observation contains a duplicate address' })
            }
            identities.add(identity)
            rows.push({ hostIp: hostIp as PortListenerHost, probeHost, port, expected })
        }
        const probed = await Promise.all(rows.map(async (row) => Object.freeze({
            hostIp: row.hostIp,
            probeHost: row.probeHost,
            port: row.port,
            listening: await probeLoopbackPort(row.port, timeoutMs as number, row.probeHost),
        })))
        if (probed.some(({ listening }) => listening === undefined)) {
            return Object.freeze({ kind: 'unavailable', reason: 'bounded host listener probe did not produce current evidence' })
        }
        return Object.freeze({
            kind: 'complete',
            rows: Object.freeze(probed.map((row) => Object.freeze({ ...row, listening: row.listening as boolean }))),
            observedAt: new Date().toISOString(),
        })
    } catch (error) {
        return Object.freeze({
            kind: 'unavailable',
            reason: `listener observation failed: ${error instanceof Error ? error.message : String(error)}`,
        })
    }
}

function observePortFamilies(input: {
    readonly config: PortFamilyConfig
    readonly requestedAt: string
    readonly timeoutMs: number
    readonly supplied: readonly PortListenerEvidenceInput[]
    readonly offsets?: ReadonlySet<number>
}): ListenerEvidenceResult {
    const declaredCandidates: { offset: number; ports: Record<string, number> }[] = []
    for (let index = 0; index < input.config.count; index += 1) {
        const offset = index * input.config.step
        const ports = Object.fromEntries(Object.entries(input.config.bases).map(([key, base]) => [key, base + offset]))
        declaredCandidates.push({ offset, ports })
    }
    const selectedOffsets = input.offsets
    const candidates = selectedOffsets
        ? declaredCandidates.filter(({ offset }) => selectedOffsets.has(offset))
        : declaredCandidates
    const supplied = new Map<string, Observation<readonly number[]>>()
    for (const entry of input.supplied) {
        if (
            !entry
            || !hasExactKeys(entry, ['ports', 'observation'])
            || !Array.isArray(entry.ports)
            || entry.ports.length === 0
            || entry.ports.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65535)
            || new Set(entry.ports).size !== entry.ports.length
        ) {
            return { evidence: [], refusal: refuse(ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID, 'host listener evidence does not cover the requested families exactly once', '') }
        }
        const key = [...entry.ports].sort((left, right) => left - right).join(',')
        if (supplied.has(key)) {
            return { evidence: [], refusal: refuse(ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID, 'host listener evidence does not cover the requested families exactly once', key) }
        }
        supplied.set(key, entry.observation)
    }
    const candidateKeys = candidates.map(({ ports }) => Object.values(ports).sort((left, right) => left - right).join(','))
    const declaredKeys = declaredCandidates.map(({ ports }) => Object.values(ports).sort((left, right) => left - right).join(','))
    const selectedExact = supplied.size === candidateKeys.length && candidateKeys.every((key) => supplied.has(key))
    const declaredExact = supplied.size === declaredKeys.length && declaredKeys.every((key) => supplied.has(key))
    if (candidateKeys.length === 0 || !selectedExact && !declaredExact) {
        return { evidence: [], refusal: refuse(ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID, 'host listener evidence does not cover the requested families exactly once', '') }
    }
    const evidence: ListenerEvidence[] = []
    for (const candidate of candidates) {
        const target = Object.values(candidate.ports).join(',')
        const malformed = (): ListenerEvidence => ({
            ...candidate,
            result: {
                kind: 'refusal',
                refusal: refuse(
                    ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID,
                    'host listener evidence is malformed',
                    target,
                    'restore the named listener probe and retry',
                ),
            },
        })
        const observation = supplied.get([...Object.values(candidate.ports)].sort((left, right) => left - right).join(','))
        if (observation === null || typeof observation !== 'object') {
            evidence.push(malformed())
            continue
        }
        if (observation.state === 'unavailable') {
            if (
                !hasExactKeys(observation, ['state', 'reason', 'producer'])
                || typeof observation.reason !== 'string'
                || observation.reason.length === 0
                || typeof observation.producer !== 'string'
                || observation.producer.length === 0
            ) {
                evidence.push(malformed())
                continue
            }
            evidence.push({
                ...candidate,
                result: { kind: 'refusal', refusal: refuse(ENVIRONMENT_CODES.PORT_FAMILY_COLLISION, 'host listener availability could not be established', target, 'restore the named listener probe and retry') },
            })
            continue
        }
        if (observation.state === 'failed') {
            if (
                !hasExactKeys(observation, ['state', 'code', 'reason', 'producer'])
                || !REFUSAL_CODES.includes(observation.code)
                || typeof observation.reason !== 'string'
                || observation.reason.length === 0
                || typeof observation.producer !== 'string'
                || observation.producer.length === 0
            ) {
                evidence.push(malformed())
                continue
            }
            evidence.push({
                ...candidate,
                result: { kind: 'refusal', refusal: refuse(ENVIRONMENT_CODES.PORT_FAMILY_COLLISION, 'host listener observation failed', target, 'restore the named listener probe and retry') },
            })
            continue
        }
        const ports = Object.values(candidate.ports)
        const observedAt = isCanonicalTimestamp(observation.observedAt)
            ? Date.parse(observation.observedAt)
            : Number.NaN
        const requestedAt = Date.parse(input.requestedAt)
        if (
            observation.state !== 'available'
            || !hasExactKeys(observation, ['state', 'value', 'observedAt', 'producer'])
            || !Array.isArray(observation.value)
            || new Set(observation.value).size !== observation.value.length
            || !Number.isFinite(observedAt)
            || observedAt < requestedAt
            || observedAt > requestedAt + input.timeoutMs
            || typeof observation.producer !== 'string'
            || observation.producer.length === 0
            || observation.value.some((port) => !Number.isSafeInteger(port) || !ports.includes(port))
        ) {
            evidence.push(malformed())
            continue
        }
        evidence.push({
            ...candidate,
            result: {
                kind: 'complete',
                occupied: [...observation.value],
                observedAt: observation.observedAt,
                producer: observation.producer,
            },
        })
    }
    return { evidence }
}

export async function leasePortFamily(supplied: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly checkoutId: import('./contract.js').CheckoutId
    readonly config: PortFamilyConfig
    readonly now: string
    readonly listenerTimeoutMs: number
    readonly listenerEvidence: readonly PortListenerEvidenceInput[]
    readonly holderProcess?: HolderProcess
}): Promise<LeasePortFamilyResult> {
    let input: Omit<typeof supplied, 'listenerEvidence'> & { readonly listenerEvidence: readonly PortListenerEvidenceInput[] }
    try {
        const namespaceProperty = Object.getOwnPropertyDescriptor(supplied, 'namespace')
        if (!namespaceProperty || !('value' in namespaceProperty)) throw new Error('invalid namespace property')
        const namespace = authenticateStateNamespace(snapshotStateNamespace(namespaceProperty.value as StateNamespace))
        if (!namespace) throw new Error('invalid namespace')
        const stackId = supplied.stackId
        const holderId = supplied.holderId
        const checkoutId = supplied.checkoutId
        const config = snapshotPortConfig(supplied.config)
        const now = supplied.now
        const listenerTimeoutMs = supplied.listenerTimeoutMs
        const holderProcess = supplied.holderProcess === undefined ? undefined : Object.freeze({
            ...(supplied.holderProcess.pid === undefined ? {} : { pid: supplied.holderProcess.pid }),
            ...(supplied.holderProcess.processStart === undefined ? {} : { processStart: supplied.holderProcess.processStart }),
        })
        if (typeof config === 'string') {
            return refuse(ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, config, String(stackId ?? ''))
        }
        const snapshot = Object.freeze({
            namespace,
            stackId,
            holderId,
            checkoutId,
            config,
            now,
            listenerTimeoutMs,
            ...(holderProcess === undefined ? {} : { holderProcess }),
        })
        const suppliedEvidence = supplied.listenerEvidence
        const listenerEvidence = snapshotListenerEvidence(suppliedEvidence, config)
        if (!listenerEvidence) {
            return refuse(
                ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID,
                `host listener evidence must contain no more than ${snapshot.config.count} bounded candidate families within the state record byte budget`,
                String(snapshot.stackId ?? ''),
            )
        }
        input = Object.freeze({ ...snapshot, listenerEvidence })
    } catch {
        return refuse(ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, 'port lease input is invalid', '')
    }
    const invalid = validateConfig(input?.config)
    if (
        invalid
        || !stackIdentity.test(input?.stackId)
        || !holderIdentity.test(input?.holderId)
        || !/^checkout:[a-f0-9]{64}$/.test(input?.checkoutId)
        || !isCanonicalTimestamp(input?.now)
        || !Number.isSafeInteger(input?.listenerTimeoutMs)
        || input.listenerTimeoutMs < 1
        || input.listenerTimeoutMs > 30_000
        || !Array.isArray(input?.listenerEvidence)
    ) {
        return refuse(ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, invalid ?? 'port lease input is invalid', String(input?.stackId ?? ''))
    }

    const priorResult = await readState(input.namespace.paths.coordination(input.stackId))
    if (priorResult.kind !== 'complete' && priorResult.kind !== 'missing') return stateRefusal(priorResult)
    const prior = decodeCoordinationRecord(priorResult.kind === 'complete' ? priorResult.value : null, input.stackId)
    if (!prior) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', input.stackId)
    if (isDrainActive(prior)) return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'port leasing is blocked while the stack is draining', input.stackId)
    const observed = observePortFamilies({
        config: input.config,
        requestedAt: input.now,
        timeoutMs: input.listenerTimeoutMs,
        supplied: input.listenerEvidence,
        ...(prior.lease && !prior.lease.released ? { offsets: new Set([prior.lease.offset]) } : {}),
    })
    if (observed.refusal) return observed.refusal
    type LeaseTransactionComplete = Readonly<{
        leaseResult: Extract<LeasePortFamilyResult, { kind: 'complete' }>
        holderIds: readonly HolderId[]
        record: StateRecord
    }>
    const allocateFamily = () => transactLease<PortRefusal | LeaseTransactionComplete>(input.namespace, input.stackId, input.holderId, async (current) => {
        const currentValue = decodeCoordinationRecord(current, input.stackId)
        if (!currentValue) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination record is malformed', input.stackId))
        if (isDrainActive(currentValue)) return abortStateTransaction(refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'port leasing is blocked while the stack is draining', input.stackId))
        const added = addCoordinationHolder(currentValue, { holderId: input.holderId, checkoutId: input.checkoutId, ...input.holderProcess }, input.now)
        if (!added) return abortStateTransaction(refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'coordination holder set cannot accept the requested holder', input.holderId))
        const currentLease = currentValue.lease

        const inventoryResult = await readRootPortInventory(input.namespace)
        if (inventoryResult.kind !== 'complete') return abortStateTransaction(inventoryResult)
        const cockpitId = input.namespace.paths.coordination(input.stackId).cockpitId
        const active = inventoryResult.value
            .filter((item) => item.cockpitId !== cockpitId || item.stackId !== input.stackId)
            .flatMap((item) => item.record.lease !== null && !item.record.lease.released
                ? [{ cockpitId: item.cockpitId, lease: item.record.lease }] : [])
        if ((!currentLease || currentLease.released) && active.filter((item) => item.cockpitId === cockpitId).length >= input.config.count) {
            return abortStateTransaction(refuse(
                ENVIRONMENT_CODES.PORT_LEASE_EXHAUSTED,
                `maximum ${input.config.count} concurrent stacks is already active`,
                input.stackId,
                'release an inactive stack or extend the declared port-family count after checking host capacity',
            ))
        }

        if (currentLease && !currentLease.released) {
            if (!sameDeclaration(currentLease.declaration, input.config)) {
                return abortStateTransaction(refuse(
                    ENVIRONMENT_CODES.CONFIG_CHANGED_DURING_EXECUTION,
                    'active port lease declaration changed during execution',
                    input.stackId,
                    'release the active stack before changing its port family declaration',
                ))
            }
        }
        const occupied = new Set(active.flatMap(({ lease }) => Object.values(lease.ports)))
        // While a holder retains the lease, its ports are published by the stack's own runtime, so a
        // listener there is the stack itself. Probing them refused every repeated `up` and every
        // co-tenant joining a running stack with PORT_FAMILY_COLLISION on its own ports. A lease no
        // holder retains belongs to a stopped stack, and a listener there is someone else's.
        const retained = currentLease !== null && !currentLease.released && currentValue.holders.length > 0
        let sawListenerCollision = false
        const occupiedFamilies: string[] = []
        for (const evidence of observed.evidence) {
            const { offset, ports: portMap } = evidence
            const ports = Object.values(portMap)
            if (currentLease && !currentLease.released) {
                if (offset !== currentLease.offset || !sameValues(portMap, currentLease.ports)) continue
            }
            if (ports.some((port) => occupied.has(port))) {
                occupiedFamilies.push(ports.join(','))
                continue
            }
            if (evidence.result.kind === 'refusal') return abortStateTransaction(evidence.result.refusal)
            const loopbackOccupied = retained ? [] : await probeListenerFamily(ports, input.listenerTimeoutMs)
            if (!loopbackOccupied) return abortStateTransaction(refuse(
                ENVIRONMENT_CODES.PORT_LISTENER_EVIDENCE_INVALID,
                'bounded host listener probe did not produce current evidence',
                input.stackId,
                'restore loopback listener access and retry',
            ))
            if (!retained && (evidence.result.occupied.length > 0 || loopbackOccupied.length > 0)) {
                sawListenerCollision = true
                occupiedFamilies.push(ports.join(','))
                continue
            }
            const value: PortLeaseRecord = {
                offset,
                ports: portMap,
                released: false,
                declaration: { step: input.config.step, count: input.config.count, bases: { ...input.config.bases } },
            }
            const complete: Extract<LeasePortFamilyResult, { kind: 'complete' }> = {
                kind: 'complete',
                change: added.change,
                holderId: input.holderId,
                recordRevision: current?.revision ?? 0,
                lease: { stackId: input.stackId, offset, ports: value.ports },
                observation: 'resolved-listener-evidence-accepted',
            }
            if (currentLease && !currentLease.released && added.change === 'unchanged') {
                return abortStateTransaction(Object.freeze({
                    leaseResult: complete,
                    holderIds: Object.freeze(added.value.holders.map(({ holderId }) => holderId).sort()),
                    record: current!,
                }))
            }
            return coordinationStateRecord(input.namespace, input.stackId, current, input.now, { ...added.value, lease: value })
        }
        return abortStateTransaction(refuse(
            sawListenerCollision ? ENVIRONMENT_CODES.PORT_FAMILY_COLLISION : ENVIRONMENT_CODES.PORT_LEASE_EXHAUSTED,
            `no complete port family is free; occupied candidates: ${occupiedFamilies.join('; ') || 'all declared candidates'}`,
            input.stackId,
            'release an inactive stack, stop the named host listener, or extend the declared candidate range',
        ))
    })
    const locked = await withStateRootPortLock(input.namespace, { ownerId: input.holderId, contentionTimeoutMs: 2_000 }, allocateFamily)
    if (locked.kind === 'missing') return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'root port transaction returned no result', locked.path)
    if (locked.kind !== 'complete') return stateRefusal(locked)
    const transaction = locked.value

    if ('leaseResult' in transaction) return issueLeaseResult(transaction.leaseResult, input.now, transaction.holderIds, input.namespace, transaction.record)
    if ('diagnostics' in transaction) return transaction
    if (transaction.kind === 'missing') return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'lease transaction returned no record', transaction.path)
    if (transaction.kind !== 'complete') return stateRefusal(transaction)
    const value = decodeCoordinationRecord(transaction.value, input.stackId)
    if (!value?.lease) return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'published coordination record is malformed', transaction.value.subjectId)
    return issueLeaseResult({ kind: 'complete', change: 'acquired', holderId: input.holderId, recordRevision: transaction.value.revision, lease: { stackId: input.stackId, offset: value.lease.offset, ports: value.lease.ports }, observation: 'resolved-listener-evidence-accepted' }, input.now, value.holders.map(({ holderId }) => holderId), input.namespace, transaction.value)
}

export type CompensateAcquiredPortHolderResult =
    | Readonly<{
          readonly kind: 'complete'
          readonly change: 'compensated'
          readonly recordRevision: number
          readonly remainingHolderIds: readonly HolderId[]
      }>
    | PortRefusal

function sameCoordinationAddress(
    left: ReturnType<StateNamespace['paths']['coordination']>,
    right: ReturnType<StateNamespace['paths']['coordination']>,
): boolean {
    return left.path === right.path && left.stateRoot === right.stateRoot && left.cockpitRoot === right.cockpitRoot
        && left.kind === right.kind && left.cockpitId === right.cockpitId && left.subjectId === right.subjectId
        && left.qualifier === undefined && right.qualifier === undefined
}

export async function compensateAcquiredPortHolder(input: {
    readonly namespace: StateNamespace
    readonly leaseResult: LeasePortFamilyResult
    readonly now: string
}): Promise<CompensateAcquiredPortHolderResult> {
    let namespace: StateNamespace | undefined
    let suppliedLeaseResult: unknown
    let now: string | undefined
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid input')
        const descriptors = Object.getOwnPropertyDescriptors(input)
        if (Reflect.ownKeys(descriptors).length !== 3
            || !['namespace', 'leaseResult', 'now'].every((key) => descriptors[key] && 'value' in descriptors[key]!)) {
            throw new Error('invalid input')
        }
        namespace = authenticateStateNamespace(descriptors.namespace!.value)
        suppliedLeaseResult = descriptors.leaseResult!.value
        now = descriptors.now!.value as string
    } catch {
        return refuse(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'acquired port-holder compensation input is malformed', 'port-holder compensation')
    }
    const issuance = suppliedLeaseResult !== null && typeof suppliedLeaseResult === 'object'
        ? issuedLeaseResults.get(suppliedLeaseResult)
        : undefined
    const compensation = issuance?.compensation
    if (!namespace || !issuance || issuance.result !== suppliedLeaseResult || issuance.result.change !== 'acquired'
        || !compensation || !availableCompensations.has(issuance.result)
        || reservedCompensations.has(issuance.result) || !isCanonicalTimestamp(now)) {
        return refuse(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'an exact unused acquired lease result is required for compensation', 'port-holder compensation')
    }
    const leaseResult = issuance.result
    const address = namespace.paths.coordination(leaseResult.lease.stackId)
    if (!sameCoordinationAddress(address, compensation.address)) {
        return refuse(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'acquired lease authority belongs to another state namespace', leaseResult.lease.stackId)
    }

    reservedCompensations.add(leaseResult)
    const preserveAuthority = () => reservedCompensations.delete(leaseResult)
    const consumeAuthority = () => {
        reservedCompensations.delete(leaseResult)
        availableCompensations.delete(leaseResult)
    }
    const transaction = await transactLease<PortRefusal>(
        namespace,
        leaseResult.lease.stackId,
        leaseResult.holderId,
        (current) => {
            const value = decodeCoordinationRecord(current, leaseResult.lease.stackId)
            if (!current || !value || current.revision !== leaseResult.recordRevision
                || JSON.stringify(current) !== compensation.recordBody) {
                return abortStateTransaction(refuse(
                    ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                    'acquired holder compensation requires the exact current coordination record',
                    leaseResult.lease.stackId,
                ))
            }
            const reduced = removeExactCoordinationHolder(value, leaseResult.holderId)
            if (!reduced) {
                return abortStateTransaction(refuse(
                    ENVIRONMENT_CODES.CLAIM_CO_TENANT,
                    'acquired holder compensation requires the exact current holder',
                    leaseResult.holderId,
                ))
            }
            return coordinationStateRecord(namespace!, leaseResult.lease.stackId, current, now!, reduced)
        },
    )
    if ('diagnostics' in transaction) {
        preserveAuthority()
        return transaction
    }
    if (transaction.kind === 'missing') {
        preserveAuthority()
        return refuse(ENVIRONMENT_CODES.CLAIM_CO_TENANT, 'acquired holder coordination record is no longer current', leaseResult.lease.stackId)
    }
    if (transaction.kind !== 'complete') {
        if (transaction.kind === 'indeterminate') consumeAuthority()
        else preserveAuthority()
        return stateRefusal(transaction)
    }
    consumeAuthority()
    const value = decodeCoordinationRecord(transaction.value, leaseResult.lease.stackId)
    if (!value) {
        return refuse(ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, 'published coordination record is malformed', leaseResult.lease.stackId)
    }
    return Object.freeze({
        kind: 'complete',
        change: 'compensated',
        recordRevision: transaction.value.revision,
        remainingHolderIds: Object.freeze(value.holders.map(({ holderId }) => holderId)),
    })
}

export type AcquirePortProjectionResult =
    | Readonly<{ kind: 'complete'; leaseResult: LeasePortFamilyResult; projection: PortLeaseProjection }>
    | PortRefusal
    | Readonly<{ kind: 'unavailable' }>

/**
 * Lease the port family and project its entrypoints as one step. A caller only ever receives a
 * lease together with its projection, so when derivation or projection fails after this call added
 * a holder, nobody downstream could release it: give exactly that holder back here.
 */
export async function acquirePortProjection(input: Parameters<typeof leasePortFamily>[0] & {
    readonly declarations: readonly EntrypointDerivative[]
}): Promise<AcquirePortProjectionResult> {
    const { declarations, ...lease } = input
    const leaseResult = await leasePortFamily(lease)
    if (leaseResult.kind !== 'complete') return leaseResult
    const giveBack = async (): Promise<readonly EnvironmentDiagnostic[]> => {
        if (leaseResult.change !== 'acquired') return []
        const released = await compensateAcquiredPortHolder({ namespace: lease.namespace, leaseResult, now: new Date().toISOString() })
        return released.kind === 'complete' ? [] : released.diagnostics
    }
    const entrypoints = deriveEntrypoints({ lease: leaseResult.lease, declarations })
    if (entrypoints.kind !== 'complete') {
        return Object.freeze({ kind: 'refusal' as const, diagnostics: Object.freeze([...entrypoints.diagnostics, ...await giveBack()]) })
    }
    const projection = projectPortLeaseResult({ leaseResult, entrypointResult: entrypoints })
    if (!projection) {
        const residue = await giveBack()
        return residue.length > 0 ? Object.freeze({ kind: 'refusal' as const, diagnostics: Object.freeze(residue) }) : Object.freeze({ kind: 'unavailable' as const })
    }
    return Object.freeze({ kind: 'complete' as const, leaseResult, projection })
}

export async function releasePortFamily(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly requesterId: HolderId
    readonly holderId: HolderId
    readonly authority?: HolderReleaseAuthority
    readonly now: string
}): Promise<ReleasePortFamilyResult> {
    let request: Parameters<typeof releaseClaim>[0]
    try {
        const namespaceProperty = Object.getOwnPropertyDescriptor(input, 'namespace')
        if (!namespaceProperty || !('value' in namespaceProperty)) throw new Error('invalid namespace property')
        const namespace = snapshotStateNamespace(namespaceProperty.value as StateNamespace)
        if (!namespace) throw new Error('invalid namespace')
        request = Object.freeze({
            namespace,
            stackId: input.stackId,
            requesterId: input.requesterId,
            holderId: input.holderId,
            authority: input.authority,
            now: input.now,
        })
    } catch {
        return refuse(ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, 'port lease release input could not be read safely', 'port lease release input')
    }
    if (
        !stackIdentity.test(request.stackId)
        || !holderIdentity.test(request.requesterId)
        || !holderIdentity.test(request.holderId)
        || !isCanonicalTimestamp(request.now)
    ) {
        return refuse(ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, 'port lease release input is invalid', String(request.stackId ?? ''))
    }
    const result = await releaseClaim(request)
    if (result.kind === 'refusal') return result
    return {
        kind: 'complete',
        change: result.change === 'unchanged' ? 'unchanged' : result.decision === 'stop' ? 'released' : 'retained',
    }
}

function isLoopback(value: string): boolean {
    try {
        const hostname = new URL(value).hostname
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
            || EntrypointDerivative.shape.hostname.safeParse(hostname).success
    } catch {
        return false
    }
}

function snapshotDerivativeInput(value: unknown): {
    readonly lease: PortLease | null
    readonly declarations: readonly EntrypointDerivative[]
    readonly declaredValues?: Readonly<Record<string, string>>
} | undefined {
    try {
        const parsed = DerivativeInputSchema.safeParse(value)
        if (!parsed.success) return undefined
        const lease = parsed.data.lease === null ? null : Object.freeze({
            stackId: parsed.data.lease.stackId as StackId,
            offset: parsed.data.lease.offset,
            ports: Object.freeze(parsed.data.lease.ports),
        })
        const declarations = Object.freeze(parsed.data.declarations.map((entry) => Object.freeze({
            ...entry,
            kind: entry.kind as EntrypointKind,
        })))
        const declaredValues = parsed.data.declaredValues === undefined
            ? undefined
            : Object.freeze(parsed.data.declaredValues)
        return Object.freeze({ lease, declarations, ...(declaredValues ? { declaredValues } : {}) })
    } catch {
        return undefined
    }
}

export function deriveEntrypoints(input: {
    readonly lease: PortLease | null
    readonly declarations: readonly EntrypointDerivative[]
    readonly declaredValues?: Readonly<Record<string, string>>
}): DeriveEntrypointsResult {
    const snapshot = snapshotDerivativeInput(input)
    if (
        !snapshot?.lease
        || !stackIdentity.test(snapshot.lease.stackId)
        || !Number.isSafeInteger(snapshot.lease.offset)
        || snapshot.lease.offset < 0
        || Object.keys(snapshot.lease.ports).length === 0
        || Object.entries(snapshot.lease.ports).some(([key, value]) => (
            !portKey.test(key) || !Number.isSafeInteger(value) || value < 1 || value > 65535
        ))
        || new Set(Object.values(snapshot.lease.ports)).size !== Object.keys(snapshot.lease.ports).length
    ) {
        return refuse(ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, 'an accepted port lease is required before deriving local addresses', '')
    }
    const values: DerivedEntrypoint[] = Object.entries(snapshot.lease.ports).map(([port, value]) => ({
        name: port.toLowerCase().replaceAll('_', '-'), kind: 'entrypoint', port,
        value: `http://127.0.0.1:${value}/`,
    }))
    const names = new Set(values.map(({ name }) => name))
    const diagnostics: EnvironmentDiagnostic[] = []
    for (const declaration of snapshot.declarations) {
        if (!isEntrypointKind(declaration.kind) || !EntrypointDerivative.safeParse(declaration).success) {
            return refuse(ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, 'entrypoint declaration is malformed', declaration.name)
        }
        if (names.has(declaration.name)) {
            return refuse(ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, 'entrypoint declaration duplicates a rendered name', declaration.name)
        }
        names.add(declaration.name)
        const port = snapshot.lease.ports[declaration.port]
        if (!Number.isSafeInteger(port) || port === undefined || port < 1 || port > 65535) {
            return refuse(ENVIRONMENT_CODES.PORT_FAMILY_OUT_OF_RANGE, 'entrypoint references a port absent from the accepted lease', declaration.port)
        }
        const value = `${declaration.scheme ?? 'http'}://${declaration.hostname ?? '127.0.0.1'}:${port}${declaration.path}`
        values.push({ name: declaration.name, kind: declaration.kind, port: declaration.port, value })
        const declared = snapshot.declaredValues?.[declaration.name]
        if (declared !== undefined && declared !== value) {
            diagnostics.push(isLoopback(declared)
                ? diagnostic('warning', ENVIRONMENT_CODES.PORT_LOCAL_VALUE_CORRECTED, 'stale loopback value was replaced from the accepted lease', declaration.name, `use ${value}`)
                : diagnostic('info', ENVIRONMENT_CODES.PORT_EXTERNAL_REGISTRATION_GAP, 'external registration cannot be updated by cockpit', declaration.name, `update the external registration to ${value}`))
        }
    }
    const result = Object.freeze({
        kind: 'complete' as const,
        values: Object.freeze(values.map((entrypoint) => Object.freeze({ ...entrypoint }))),
        diagnostics: Object.freeze(diagnostics.map((item) => Object.freeze({ ...item }))),
    })
    issuedEntrypointResults.set(result, { stackId: snapshot.lease.stackId, ports: Object.freeze({ ...snapshot.lease.ports }) })
    return result
}
