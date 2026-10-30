import { z } from 'zod'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { isProxy } from 'node:util/types'
import {
    ENVIRONMENT_CODES,
    isCanonicalTimestamp,
    snapshotJson,
    snapshotEnvironmentObservation,
    type CockpitId,
    type EnvironmentDiagnostic,
    type EnvironmentObservation,
    type HolderId,
    type LifecycleProgress,
    type ObservationLifecycleStage,
    type StackId,
} from './contract.js'
import {
    abortStateTransaction,
    authenticateStateNamespace,
    lifecycleHistoryAddress,
    readState,
    transactState,
    type StateNamespace,
    type StateRecord,
    type StateResult,
    type StateTransactionAbort,
} from './state.js'

export const mechanism = {
    id: 'lifecycle-stage',
    module: 'packages/cockpit/src/environment/lifecycle-stage.ts',
    exports: [
        'recordLifecycleStarted', 'recordLifecycleSeeded', 'resolveLifecycleStage',
        'observeStateSeed', 'isLifecycleStageObservation', 'authenticateLifecycleStageAuthority',
        'projectLifecycleStage', 'consumeLifecycleStageProjection',
        'decodeLifecycleRecord',
        'observationDeclarations',
    ],
} as const

export const observationDeclarations = Object.freeze([{
    id: 'state-seed',
    owner: mechanism.id,
    postures: ['environment'],
    stages: [
        { stage: 'bootstrap', disposition: 'not-applicable', reason: 'the first seed has not completed' },
        { stage: 'steady', disposition: 'required' },
    ],
    code: ENVIRONMENT_CODES.STATE_UNSEEDED,
    isIssued: isLifecycleStageObservation,
    issuedAt: observationIssuedAt,
}] as const)

const HistoryValue = z.object({ status: z.enum(['started', 'seeded']) }).strict()
const STACK_ID = /^stack:[a-f0-9]{64}$/
const HOLDER_ID = /^holder:[a-f0-9]{64}:session$/
const AUTHORITY_LIFETIME_MS = 30_000
const issuedObservations = new WeakMap<object, number>()
const issuedAuthorities = new WeakMap<object, LifecycleAuthorityBinding>()
const issuedLifecycleStageProjections = new WeakMap<object, LifecycleStageEvidence>()

export interface GeneratedLifecycleReplay {
    readonly sourceSha256: string
    readonly generation: string
    readonly profiles: readonly string[]
    readonly mounts: readonly string[]
}

export interface GeneratedLifecycleProgress {
    readonly applied: readonly string[]
    readonly notApplied: readonly string[]
    readonly attempted?: readonly string[]
}

export interface LifecycleRecordValue extends LifecycleProgress {
    readonly holderId: HolderId
    readonly generatedReplay?: GeneratedLifecycleReplay
    readonly generatedProgress?: GeneratedLifecycleProgress
    readonly teardownComplete?: true
}

export interface CurrentLifecycleRecord {
    readonly record: StateRecord
    readonly value: LifecycleRecordValue
}

const lifecycleDigest = /^[a-f0-9]{64}$/
const lifecycleService = /^[a-z0-9][a-z0-9_.-]*$/

export function decodeLifecycleRecord(
    record: StateRecord,
    context: Readonly<{ cockpitId: CockpitId; stackId: StackId }>,
): CurrentLifecycleRecord | undefined {
    const value = snapshotJson(record.value)
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== ['completedServices', ...(Object.hasOwn(value, 'generatedProgress') ? ['generatedProgress'] : []), ...(Object.hasOwn(value, 'generatedReplay') ? ['generatedReplay'] : []), 'holderId', 'operationGeneration', ...(Object.hasOwn(value, 'teardownComplete') ? ['teardownComplete'] : []), 'workBasisSha256'].join('\0')
        || record.format !== 'cockpit-state/v1' || record.kind !== 'lifecycle'
        || record.cockpitId !== context.cockpitId || record.subjectId !== context.stackId) return undefined
    const candidate = value as Record<string, unknown>
    if (typeof candidate.holderId !== 'string' || !HOLDER_ID.test(candidate.holderId)
        || typeof candidate.workBasisSha256 !== 'string' || !lifecycleDigest.test(candidate.workBasisSha256)
        || typeof candidate.operationGeneration !== 'string' || !lifecycleDigest.test(candidate.operationGeneration)
        || !Array.isArray(candidate.completedServices) || candidate.completedServices.length > 4_096) return undefined
    const teardownComplete = Object.hasOwn(candidate, 'teardownComplete')
    if (teardownComplete && (candidate.teardownComplete !== true || candidate.completedServices.length !== 0
        || Object.hasOwn(candidate, 'generatedReplay') || Object.hasOwn(candidate, 'generatedProgress'))) return undefined
    let replay: GeneratedLifecycleReplay | undefined
    if (Object.hasOwn(candidate, 'generatedReplay')) {
        const value = candidate.generatedReplay
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).sort().join('\0') !== ['generation', 'mounts', 'profiles', 'sourceSha256'].join('\0')) return undefined
        const record = value as Record<string, unknown>
        if (typeof record.sourceSha256 !== 'string' || !lifecycleDigest.test(record.sourceSha256)
            || typeof record.generation !== 'string' || !lifecycleDigest.test(record.generation)
            || !Array.isArray(record.profiles) || !Array.isArray(record.mounts)
            || record.profiles.length > 4_096 || record.mounts.length > 4_096
            || [...record.profiles, ...record.mounts].some((item) => typeof item !== 'string' || item.length === 0 || item.includes('\0'))) return undefined
        replay = Object.freeze({ sourceSha256: record.sourceSha256, generation: record.generation,
            profiles: Object.freeze([...record.profiles]), mounts: Object.freeze([...record.mounts]) })
    }
    let progress: GeneratedLifecycleProgress | undefined
    if (Object.hasOwn(candidate, 'generatedProgress')) {
        const value = candidate.generatedProgress
        if (!replay || !value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).sort().join('\0') !== ['applied', ...(Object.hasOwn(value, 'attempted') ? ['attempted'] : []), 'notApplied'].join('\0')) return undefined
        const row = value as Record<string, unknown>
        const attempted = Object.hasOwn(row, 'attempted') ? row.attempted : []
        if (!Array.isArray(row.applied) || !Array.isArray(row.notApplied) || !Array.isArray(attempted)) return undefined
        if (row.applied.length + row.notApplied.length + attempted.length > 16_384
            || [...row.applied, ...row.notApplied, ...attempted].some((item) => typeof item !== 'string'
                || item.length === 0 || item.length > 1_024 || item.includes('\0'))
            || new Set([...row.applied, ...row.notApplied, ...attempted]).size !== row.applied.length + row.notApplied.length + attempted.length) return undefined
        progress = Object.freeze({ applied: Object.freeze([...row.applied]), notApplied: Object.freeze([...row.notApplied]),
            ...(attempted.length ? { attempted: Object.freeze([...attempted]) } : {}) })
    }
    const completed = candidate.completedServices.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).sort().join('\0') !== ['containerId', 'service'].join('\0')) return undefined
        const service = (item as Record<string, unknown>).service
        const containerId = (item as Record<string, unknown>).containerId
        return typeof service === 'string' && lifecycleService.test(service)
            && typeof containerId === 'string' && lifecycleDigest.test(containerId)
            ? Object.freeze({ service, containerId })
            : undefined
    })
    if (completed.some((item) => item === undefined)) return undefined
    return Object.freeze({
        record,
        value: Object.freeze({
            holderId: candidate.holderId as HolderId,
            ...(replay ? { generatedReplay: replay } : {}),
            ...(progress ? { generatedProgress: progress } : {}),
            ...(teardownComplete ? { teardownComplete: true as const } : {}),
            workBasisSha256: candidate.workBasisSha256,
            operationGeneration: candidate.operationGeneration,
            completedServices: Object.freeze(completed as LifecycleProgress['completedServices']),
        }),
    })
}

interface FileIdentity {
    readonly state: 'directory' | 'file' | 'missing' | 'other' | 'symlink'
    readonly identity?: string
}

interface LifecycleAuthorityBinding {
    readonly cockpitId: string
    readonly namespace: StateNamespace
    readonly historyPath: string
    readonly historyIdentity: readonly FileIdentity[]
    readonly lifecyclePath: string
    readonly lifecycleIdentity: readonly FileIdentity[]
}

export interface LifecycleStageAuthority {
    readonly stackId: StackId
    readonly stage: ObservationLifecycleStage
    readonly observedAt: string
    readonly validThrough: string
}

declare const lifecycleStageProjectionBrand: unique symbol
export interface LifecycleStageProjection {
    readonly [lifecycleStageProjectionBrand]: true
}

export interface LifecycleStageEvidence {
    readonly stackId: StackId
    readonly stage: ObservationLifecycleStage
}

export type LifecycleStageResolution =
    | { readonly kind: 'complete'; readonly authority: LifecycleStageAuthority; readonly observation: EnvironmentObservation }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

export type LifecycleHistoryTransition =
    | { readonly kind: 'complete' | 'unchanged'; readonly record: StateRecord }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

interface StableInput {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly observedAt: string
}

function refusal(message: string, target: string): Extract<LifecycleStageResolution, { kind: 'refusal' }> {
    return Object.freeze({
        kind: 'refusal',
        diagnostics: Object.freeze([{
            severity: 'error' as const,
            code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
            message,
            target,
            fix: 'inspect lifecycle state and history before explicit recovery or adoption',
        }]),
    })
}

function stableInput(value: unknown): StableInput | undefined {
    try {
        if (isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Reflect.ownKeys(descriptors).length !== 3
            || !('value' in (descriptors.namespace ?? {}))
            || !('value' in (descriptors.stackId ?? {}))
            || !('value' in (descriptors.observedAt ?? {}))) return undefined
        const namespace = authenticateStateNamespace(descriptors.namespace!.value)
        const stackId = descriptors.stackId!.value
        const observedAt = descriptors.observedAt!.value
        const observedMillis = typeof observedAt === 'string' ? Date.parse(observedAt) : Number.NaN
        const now = Date.now()
        if (!namespace || typeof stackId !== 'string' || !STACK_ID.test(stackId)
            || !isCanonicalTimestamp(observedAt) || observedMillis > now || now - observedMillis > AUTHORITY_LIFETIME_MS) return undefined
        return Object.freeze({ namespace, stackId: stackId as StackId, observedAt })
    } catch {
        return undefined
    }
}

function stableTransitionInput(value: unknown): (StableInput & { readonly holderId: HolderId }) | undefined {
    try {
        if (isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Reflect.ownKeys(descriptors).length !== 4 || !('value' in (descriptors.holderId ?? {}))) return undefined
        const base = stableInput(Object.freeze({
            namespace: descriptors.namespace && 'value' in descriptors.namespace ? descriptors.namespace.value : undefined,
            stackId: descriptors.stackId && 'value' in descriptors.stackId ? descriptors.stackId.value : undefined,
            observedAt: descriptors.observedAt && 'value' in descriptors.observedAt ? descriptors.observedAt.value : undefined,
        }))
        const holderId = descriptors.holderId!.value
        return base && typeof holderId === 'string' && HOLDER_ID.test(holderId)
            ? Object.freeze({ ...base, holderId: holderId as HolderId })
            : undefined
    } catch {
        return undefined
    }
}

function historyStatus(record: StateRecord): 'started' | 'seeded' | undefined {
    return record.kind === 'lifecycle-history' ? HistoryValue.safeParse(record.value).data?.status : undefined
}

function sameResult(left: StateResult<StateRecord>, right: StateResult<StateRecord>): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

function fileIdentity(path: string): FileIdentity | undefined {
    try {
        const status = lstatSync(path, { bigint: true })
        const state = status.isSymbolicLink() ? 'symlink'
            : status.isFile() ? 'file'
            : status.isDirectory() ? 'directory'
            : 'other'
        const identity = state === 'directory'
            ? [status.dev, status.ino]
            : [status.dev, status.ino, status.mode, status.size, status.mtimeNs, status.ctimeNs]
        return Object.freeze({ state, identity: identity.map(String).join(':') })
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? Object.freeze({ state: 'missing' })
            : undefined
    }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return left.state === right.state && left.identity === right.identity
}

function pathIdentity(root: string, path: string): readonly FileIdentity[] | undefined {
    const relation = relative(root, path)
    if (!isAbsolute(root) || !isAbsolute(path) || relation === '' || isAbsolute(relation)
        || relation === '..' || relation.startsWith(`..${sep}`)) return undefined
    const chain: string[] = []
    let cursor = path
    while (true) {
        chain.push(cursor)
        const parent = dirname(cursor)
        if (parent === cursor) break
        cursor = parent
    }
    const identities: FileIdentity[] = []
    for (const candidate of chain.reverse()) {
        const identity = fileIdentity(candidate)
        if (!identity) return undefined
        identities.push(identity)
    }
    return Object.freeze(identities)
}

function samePathIdentity(left: readonly FileIdentity[], right: readonly FileIdentity[]): boolean {
    return left.length === right.length && left.every((identity, index) => sameIdentity(identity, right[index]!))
}

function lifecycleBinding(
    namespace: StateNamespace,
    cockpitId: string,
    historyPath: string,
    lifecyclePath: string,
): LifecycleAuthorityBinding | undefined {
    const historyIdentity = pathIdentity(namespace.root, historyPath)
    const lifecycleIdentity = pathIdentity(namespace.root, lifecyclePath)
    return historyIdentity && lifecycleIdentity
        ? Object.freeze({
            cockpitId,
            namespace,
            historyPath,
            historyIdentity,
            lifecyclePath,
            lifecycleIdentity,
        })
        : undefined
}

function sameBinding(left: LifecycleAuthorityBinding, right: LifecycleAuthorityBinding): boolean {
    return left.historyPath === right.historyPath
        && left.lifecyclePath === right.lifecyclePath
        && left.cockpitId === right.cockpitId
        && samePathIdentity(left.historyIdentity, right.historyIdentity)
        && samePathIdentity(left.lifecycleIdentity, right.lifecycleIdentity)
}

function issueObservation(value: EnvironmentObservation): EnvironmentObservation {
    const snapshot = snapshotEnvironmentObservation(value)
    if (!snapshot || snapshot.owner !== mechanism.id) throw new TypeError('lifecycle stage observation is malformed')
    issuedObservations.set(snapshot, Date.now())
    return snapshot
}

export function isLifecycleStageObservation(value: unknown): value is EnvironmentObservation {
    return value !== null && typeof value === 'object' && issuedObservations.has(value)
}

function observationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedObservations.get(value) : undefined
}

async function inspect(input: StableInput): Promise<LifecycleStageResolution> {
    const historyAddress = lifecycleHistoryAddress(input.namespace, input.stackId)
    const lifecycleAddress = input.namespace.paths.lifecycle(input.stackId)
    if (!historyAddress) return refusal('lifecycle history address is unavailable', lifecycleAddress.path)
    if (historyAddress.cockpitId !== lifecycleAddress.cockpitId) {
        return refusal('lifecycle state addresses disagree on cockpit identity', historyAddress.path)
    }
    const bindingBefore = lifecycleBinding(input.namespace, historyAddress.cockpitId, historyAddress.path, lifecycleAddress.path)
    if (!bindingBefore) return refusal('lifecycle state identity is unavailable', historyAddress.path)
    const historyBefore = await readState(historyAddress)
    const lifecycleBefore = await readState(lifecycleAddress)
    const historyAfter = await readState(historyAddress)
    const lifecycleAfter = await readState(lifecycleAddress)
    const bindingAfter = lifecycleBinding(input.namespace, historyAddress.cockpitId, historyAddress.path, lifecycleAddress.path)
    if (!bindingAfter || !sameBinding(bindingBefore, bindingAfter)
        || !sameResult(historyBefore, historyAfter) || !sameResult(lifecycleBefore, lifecycleAfter)) {
        return refusal('lifecycle state changed while its stage was observed', historyAddress.path)
    }
    if (historyBefore.kind === 'refusal' || historyBefore.kind === 'indeterminate') {
        return refusal(historyBefore.message, historyAddress.path)
    }
    if (lifecycleBefore.kind === 'refusal' || lifecycleBefore.kind === 'indeterminate') {
        return refusal(lifecycleBefore.message, lifecycleAddress.path)
    }
    const status = historyBefore.kind === 'complete' ? historyStatus(historyBefore.value) : undefined
    if (historyBefore.kind === 'complete' && !status) return refusal('lifecycle history is malformed', historyAddress.path)
    if (historyBefore.kind === 'missing' && lifecycleBefore.kind === 'complete') {
        return refusal('lifecycle data exists without durable lifecycle history', lifecycleAddress.path)
    }
    const stage: ObservationLifecycleStage = status === 'seeded' ? 'steady' : 'bootstrap'
    const seeded = lifecycleBefore.kind === 'complete'
    const issuedAt = Date.now()
    const authority = Object.freeze({
        stackId: input.stackId,
        stage,
        observedAt: input.observedAt,
        validThrough: new Date(issuedAt + AUTHORITY_LIFETIME_MS).toISOString(),
    })
    issuedAuthorities.set(authority, bindingAfter)
    const observation = issueObservation({
        code: ENVIRONMENT_CODES.STATE_UNSEEDED,
        owner: mechanism.id,
        stackId: input.stackId,
        source: lifecycleAddress.path,
        observed: { state: 'available', value: seeded, observedAt: input.observedAt },
        expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'environment' },
        freshness: { state: 'current' },
        remedy: 'restore or seed lifecycle state without deleting its durable history',
    })
    return Object.freeze({ kind: 'complete', authority, observation })
}

export async function resolveLifecycleStage(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly observedAt: string
}): Promise<LifecycleStageResolution> {
    const stable = stableInput(input)
    return stable ? inspect(stable) : refusal('lifecycle stage input is malformed', 'lifecycle stage input')
}

export async function observeStateSeed(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly observedAt: string
}): Promise<EnvironmentObservation> {
    const result = await resolveLifecycleStage(input)
    if (result.kind !== 'complete') throw new TypeError(result.diagnostics[0]?.message ?? 'lifecycle stage is unavailable')
    return result.observation
}

interface LifecycleAuthorityExpectation {
    readonly stackId: StackId
    readonly cockpitId: string
    readonly earliest: number
    readonly latest: number
    readonly evaluatedAt: number
}

function validAuthorityExpectation(value: LifecycleAuthorityExpectation): boolean {
    return Number.isSafeInteger(value.earliest)
        && Number.isSafeInteger(value.latest)
        && Number.isSafeInteger(value.evaluatedAt)
        && value.earliest <= value.evaluatedAt
        && value.evaluatedAt <= value.latest
}

function consumeLifecycleStageAuthority(
    value: unknown,
    expected: LifecycleAuthorityExpectation,
    trustedCurrentTime: number,
): ObservationLifecycleStage | undefined {
    if (value === null || typeof value !== 'object' || !validAuthorityExpectation(expected)
        || !Number.isSafeInteger(trustedCurrentTime) || expected.evaluatedAt > trustedCurrentTime) return undefined
    const binding = issuedAuthorities.get(value)
    if (!binding || binding.cockpitId !== expected.cockpitId) return undefined
    const authority = value as LifecycleStageAuthority
    const observedAt = Date.parse(authority.observedAt)
    const validThrough = Date.parse(authority.validThrough)
    if (authority.stackId !== expected.stackId || !Number.isFinite(observedAt) || !Number.isFinite(validThrough)
        || observedAt < expected.earliest || observedAt > expected.latest
        || observedAt > expected.evaluatedAt || trustedCurrentTime > validThrough) return undefined
    const namespace = authenticateStateNamespace(binding.namespace)
    const currentBinding = namespace
        ? lifecycleBinding(namespace, binding.cockpitId, binding.historyPath, binding.lifecyclePath)
        : undefined
    if (!currentBinding || !sameBinding(binding, currentBinding)) return undefined
    issuedAuthorities.delete(value)
    return authority.stage
}

export function authenticateLifecycleStageAuthority(
    value: unknown,
    stackId: StackId,
    cockpitId: string,
    earliest: number,
    latest: number,
    evaluatedAt: number,
): ObservationLifecycleStage | undefined {
    return consumeLifecycleStageAuthority(value, { stackId, cockpitId, earliest, latest, evaluatedAt }, evaluatedAt)
}

export function projectLifecycleStage(input: {
    readonly authority: LifecycleStageAuthority
    readonly stackId: StackId
    readonly cockpitId: CockpitId
    readonly earliest: number
    readonly latest: number
    readonly evaluatedAt: number
}): LifecycleStageProjection | undefined {
    try {
        const trustedCurrentTime = Date.now()
        if (isProxy(input) || input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(input)
        const keys = ['authority', 'stackId', 'cockpitId', 'earliest', 'latest', 'evaluatedAt'] as const
        if (Reflect.ownKeys(descriptors).length !== keys.length
            || keys.some((key) => !('value' in (descriptors[key] ?? {})))) return undefined
        const expected = Object.freeze({
            stackId: descriptors.stackId!.value as StackId,
            cockpitId: descriptors.cockpitId!.value as string,
            earliest: descriptors.earliest!.value as number,
            latest: descriptors.latest!.value as number,
            evaluatedAt: descriptors.evaluatedAt!.value as number,
        })
        const stage = consumeLifecycleStageAuthority(descriptors.authority!.value, expected, trustedCurrentTime)
        if (!stage) return undefined
        const projection = Object.freeze({}) as LifecycleStageProjection
        issuedLifecycleStageProjections.set(projection, Object.freeze({ stackId: expected.stackId, stage }))
        return projection
    } catch {
        return undefined
    }
}

export function consumeLifecycleStageProjection(
    projection: LifecycleStageProjection,
): LifecycleStageEvidence | undefined {
    try {
        if (projection === null || typeof projection !== 'object') return undefined
        const evidence = issuedLifecycleStageProjections.get(projection)
        if (!evidence) return undefined
        issuedLifecycleStageProjections.delete(projection)
        return evidence
    } catch {
        return undefined
    }
}

async function transition(
    value: unknown,
    requested: 'started' | 'seeded',
): Promise<LifecycleHistoryTransition> {
    const input = stableTransitionInput(value)
    if (!input) return refusal('lifecycle history transition input is malformed', 'lifecycle history input')
    const address = lifecycleHistoryAddress(input.namespace, input.stackId)
    if (!address) return refusal('lifecycle history address is unavailable', input.stackId)
    const result = await transactState<LifecycleHistoryTransition>(input.namespace, address, { ownerId: input.holderId }, (current) => {
        const currentStatus = current ? historyStatus(current) : undefined
        if (current && !currentStatus) return abortStateTransaction(refusal('lifecycle history is malformed', address.path))
        if (requested === 'seeded' && currentStatus === undefined) {
            return abortStateTransaction(refusal('lifecycle history must be started before it is seeded', address.path))
        }
        // Seeded history already records its start, so a later `started` (setup acquiring a
        // sibling added after the stack has run) leaves it seeded. Refusing it deadlocked setup.
        if (currentStatus === requested || currentStatus === 'seeded') {
            return abortStateTransaction(Object.freeze({ kind: 'unchanged' as const, record: current! }))
        }
        return {
            format: 'cockpit-state/v1' as const,
            kind: 'lifecycle-history' as const,
            cockpitId: address.cockpitId,
            subjectId: input.stackId,
            revision: (current?.revision ?? -1) + 1,
            updatedAt: input.observedAt,
            value: { status: requested },
        }
    })
    const aborted = result as StateTransactionAbort<LifecycleHistoryTransition>
    if (aborted.aborted === true) return aborted.value
    const stateResult = result as StateResult<StateRecord>
    if (stateResult.kind === 'complete') return Object.freeze({ kind: 'complete', record: stateResult.value })
    const message = stateResult.kind === 'refusal' || stateResult.kind === 'indeterminate'
        ? stateResult.message
        : 'lifecycle history transition failed'
    return refusal(message, address.path)
}

export function recordLifecycleStarted(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly observedAt: string
}): Promise<LifecycleHistoryTransition> {
    return transition(input, 'started')
}

export function recordLifecycleSeeded(input: {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly observedAt: string
}): Promise<LifecycleHistoryTransition> {
    return transition(input, 'seeded')
}
