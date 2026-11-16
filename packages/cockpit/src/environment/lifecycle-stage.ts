import { exactKeys } from '../exact-keys.js'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import {
    hasErrorCode,
    RefusalError,
    ENVIRONMENT_CODES,
    isCanonicalTimestamp,
    snapshotJson,
    type CheckoutId,
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
    readState,
    transactState,
    type StateNamespace,
    type StateRecord,
    type StateResult,
    type StateTransactionAbort,
    withStateNamespaceInventory,
} from './state.js'
import { stackId as deriveStackId } from './identity.js'
import { cockpitCommand } from '../fix-catalogue.js'

const OWNER = 'lifecycle-stage'

export const observationDeclarations = Object.freeze([{
    id: 'state-seed',
    owner: OWNER,
    postures: ['environment'],
    stages: [
        { stage: 'bootstrap', disposition: 'not-applicable', reason: 'the first seed has not completed' },
        { stage: 'steady', disposition: 'required' },
    ],
    code: ENVIRONMENT_CODES.STATE_UNSEEDED,
}] as const)

const STACK_ID = /^stack:[a-f0-9]{64}$/
const HOLDER_ID = /^holder:[a-f0-9]{64}:session$/
const AUTHORITY_LIFETIME_MS = 30_000
const issuedLifecycleStageProjections = new WeakMap<object, LifecycleStageEvidence>()

export interface LifecycleRecordValue extends LifecycleProgress {
    readonly holderId: HolderId
    readonly teardownComplete?: true
    /**
     * The digest of each file the running stack was started from, by the name a person edits, so a
     * refused declaration change can say which one changed.
     */
    readonly runtimeInputs?: RuntimeInputs
    /**
     * The Compose profiles the stack was started with, sorted, when it runs with any: every later
     * command on the stack activates the same set, so down removes the profile services too.
     */
    readonly activeProfiles?: readonly string[]
    /** Set once an `up` has completed; later commands then check the stack as running, and down keeps it. */
    readonly steady?: true
    /** When `environment.seed` last succeeded, so the next `up` seeds again only into volumes created since. */
    readonly seededAt?: string
}

export type RuntimeInputs = Readonly<Record<string, string>>

export interface CurrentLifecycleRecord {
    readonly record: StateRecord
    readonly value: LifecycleRecordValue
}

const lifecycleDigest = /^[a-f0-9]{64}$/
const lifecycleService = /^[a-z0-9][a-z0-9_.-]*$/

type EarlierNameResult =
    | Readonly<{ kind: 'complete'; name: string | undefined }>
    | Readonly<{ kind: 'refusal'; code: EnvironmentDiagnostic['code']; message: string; target: string }>

// A stack keeps the cockpit identity it started under, and that identity carries `cockpit.name`.
// After a rename this checkout's stack is still recorded under the earlier name, where sync, up and
// down no longer look: down reported nothing to act on while the containers kept running. This
// returns that earlier name while such a stack is recorded and not torn down, so they can refuse
// with the recovery instead.
export async function findStackUnderEarlierName(input: Readonly<{
    namespace: StateNamespace
    cockpitId: CockpitId
    checkoutId: CheckoutId
}>): Promise<EarlierNameResult> {
    const [, currentName, checkoutDigest] = input.cockpitId.split(':')
    const placeholder = `stack:${'0'.repeat(64)}` as StackId
    const found = await withStateNamespaceInventory(input.namespace, async (namespaces): Promise<EarlierNameResult> => {
        for (const candidate of namespaces) {
            const cockpitId = candidate.paths.lifecycle(placeholder).cockpitId
            const [, name, digest] = cockpitId.split(':')
            if (digest !== checkoutDigest || name === currentName || name === undefined) continue
            const stack = deriveStackId({ cockpitId, checkoutId: input.checkoutId, variant: { kind: 'shared' } })
            const address = candidate.paths.lifecycle(stack)
            const stored = await readState(address)
            if (stored.kind === 'missing') continue
            if (stored.kind !== 'complete') return { kind: 'refusal', code: stored.code, message: stored.message, target: stored.target }
            const lifecycle = decodeLifecycleRecord(stored.value, { cockpitId, stackId: stack })
            if (!lifecycle) return { kind: 'refusal', code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED, message: 'lifecycle progress record is malformed', target: address.path }
            if (lifecycle.value.teardownComplete !== true) return { kind: 'complete', name }
        }
        return { kind: 'complete', name: undefined }
    })
    if (found.kind === 'complete') return found.value
    if (found.kind === 'missing') return { kind: 'complete', name: undefined }
    return { kind: 'refusal', code: found.code, message: found.message, target: found.target }
}

export function earlierNameRefusalMessage(configPath: string, earlierName: string): string {
    return `cockpit.name was changed from "${earlierName}" while a stack started under that name is still recorded; the stack keeps the earlier name, so only down run under that name removes its containers — fix: set name = "${earlierName}" in ${configPath} again, run \`${cockpitCommand('down', { config: configPath })}\`, then rename the cockpit and run \`${cockpitCommand('sync', { config: configPath })}\``
}

export function decodeLifecycleRecord(
    record: StateRecord,
    context: Readonly<{ cockpitId: CockpitId; stackId: StackId }>,
): CurrentLifecycleRecord | undefined {
    const value = snapshotJson(record.value)
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !exactKeys(value, ['completedServices', 'holderId', 'operationGeneration', 'workBasisSha256'], ['activeProfiles', 'runtimeInputs', 'seededAt', 'steady', 'teardownComplete'])
        || record.format !== 'cockpit-state/v1' || record.kind !== 'lifecycle'
        || record.cockpitId !== context.cockpitId || record.subjectId !== context.stackId) return undefined
    const candidate = value as Record<string, unknown>
    if (typeof candidate.holderId !== 'string' || !HOLDER_ID.test(candidate.holderId)
        || typeof candidate.workBasisSha256 !== 'string' || !lifecycleDigest.test(candidate.workBasisSha256)
        || typeof candidate.operationGeneration !== 'string' || !lifecycleDigest.test(candidate.operationGeneration)
        || !Array.isArray(candidate.completedServices) || candidate.completedServices.length > 4_096) return undefined
    if (Object.hasOwn(candidate, 'steady') && candidate.steady !== true
        || Object.hasOwn(candidate, 'seededAt') && !isCanonicalTimestamp(candidate.seededAt)) return undefined
    const teardownComplete = Object.hasOwn(candidate, 'teardownComplete')
    if (teardownComplete && (candidate.teardownComplete !== true || candidate.completedServices.length !== 0)) return undefined
    let runtimeInputs: RuntimeInputs | undefined
    if (Object.hasOwn(candidate, 'runtimeInputs')) {
        const value = candidate.runtimeInputs
        if (teardownComplete || !value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const entries = Object.entries(value)
        if (entries.length === 0 || entries.length > 64 || entries.some(([name, digest]) => name.length === 0 || name.length > 1_024
            || name.includes('\0') || typeof digest !== 'string' || !lifecycleDigest.test(digest))) return undefined
        runtimeInputs = Object.fromEntries(entries)
    }
    let activeProfiles: readonly string[] | undefined
    if (Object.hasOwn(candidate, 'activeProfiles')) {
        const value = candidate.activeProfiles
        if (teardownComplete || !Array.isArray(value) || value.length === 0 || value.length > 64
            || value.some((profile, index) => typeof profile !== 'string' || !lifecycleService.test(profile)
                || index > 0 && value[index - 1]! >= profile)) return undefined
        activeProfiles = value as string[]
    }
    const completed = candidate.completedServices.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || !exactKeys(item, ['containerId', 'service'])) return undefined
        const service = (item as Record<string, unknown>).service
        const containerId = (item as Record<string, unknown>).containerId
        return typeof service === 'string' && lifecycleService.test(service)
            && typeof containerId === 'string' && lifecycleDigest.test(containerId)
            ? { service, containerId }
            : undefined
    })
    if (completed.some((item) => item === undefined)) return undefined
    return {
        record,
        value: {
            holderId: candidate.holderId as HolderId,
            ...(teardownComplete ? { teardownComplete: true as const } : {}),
            ...(runtimeInputs ? { runtimeInputs } : {}),
            ...(activeProfiles ? { activeProfiles } : {}),
            ...(candidate.steady === true ? { steady: true as const } : {}),
            ...(typeof candidate.seededAt === 'string' ? { seededAt: candidate.seededAt } : {}),
            workBasisSha256: candidate.workBasisSha256,
            operationGeneration: candidate.operationGeneration,
            completedServices: completed as LifecycleProgress['completedServices'],
        },
    }
}

interface FileIdentity {
    readonly state: 'directory' | 'file' | 'missing' | 'other' | 'symlink'
    readonly identity?: string
}

interface LifecycleAuthorityBinding {
    readonly cockpitId: string
    readonly namespace: StateNamespace
    readonly lifecyclePath: string
    readonly lifecycleIdentity: readonly FileIdentity[]
}

export interface LifecycleStageAuthority {
    readonly stackId: StackId
    readonly stage: ObservationLifecycleStage
    readonly observedAt: string
    readonly validThrough: string
    /** The lifecycle file the stage was read from, re-checked on disk before the stage is used. */
    readonly binding: LifecycleAuthorityBinding
}

declare const lifecycleStageProjectionBrand: unique symbol
export interface LifecycleStageProjection {
    readonly [lifecycleStageProjectionBrand]: true
}

interface LifecycleStageEvidence {
    readonly stackId: StackId
    readonly stage: ObservationLifecycleStage
}

type LifecycleStageResolution =
    | { readonly kind: 'complete'; readonly authority: LifecycleStageAuthority; readonly observation: EnvironmentObservation }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

export type LifecycleStageTransition =
    | { readonly kind: 'complete' | 'unchanged'; readonly record: StateRecord }
    | { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

interface StableInput {
    readonly namespace: StateNamespace
    readonly stackId: StackId
    readonly observedAt: string
}

function refusal(message: string, target: string): Extract<LifecycleStageResolution, { kind: 'refusal' }> {
    return {
        kind: 'refusal',
        diagnostics: [{
            severity: 'error' as const,
            code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED,
            message,
            target,
            fix: 'inspect the lifecycle record; once no cockpit command runs for this stack, run down and up to start it afresh',
        }],
    }
}

function stableInput(value: unknown): StableInput | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const { namespace: rawNamespace, stackId, observedAt } = value as Record<string, unknown>
    const namespace = authenticateStateNamespace(rawNamespace)
    const observedMillis = typeof observedAt === 'string' ? Date.parse(observedAt) : Number.NaN
    const now = Date.now()
    if (!namespace || typeof stackId !== 'string' || !STACK_ID.test(stackId)
        || !isCanonicalTimestamp(observedAt) || observedMillis > now || now - observedMillis > AUTHORITY_LIFETIME_MS) return undefined
    return { namespace, stackId: stackId as StackId, observedAt }
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
        return { state, identity: identity.map(String).join(':') }
    } catch (error) {
        return hasErrorCode(error, 'ENOENT')
            ? { state: 'missing' }
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
    return identities
}

function samePathIdentity(left: readonly FileIdentity[], right: readonly FileIdentity[]): boolean {
    return left.length === right.length && left.every((identity, index) => sameIdentity(identity, right[index]!))
}

function lifecycleBinding(namespace: StateNamespace, cockpitId: string, lifecyclePath: string): LifecycleAuthorityBinding | undefined {
    const lifecycleIdentity = pathIdentity(namespace.root, lifecyclePath)
    return lifecycleIdentity ? { cockpitId, namespace, lifecyclePath, lifecycleIdentity } : undefined
}

function sameBinding(left: LifecycleAuthorityBinding, right: LifecycleAuthorityBinding): boolean {
    return left.lifecyclePath === right.lifecyclePath
        && left.cockpitId === right.cockpitId
        && samePathIdentity(left.lifecycleIdentity, right.lifecycleIdentity)
}

async function inspect(input: StableInput): Promise<LifecycleStageResolution> {
    const lifecycleAddress = input.namespace.paths.lifecycle(input.stackId)
    const bindingBefore = lifecycleBinding(input.namespace, lifecycleAddress.cockpitId, lifecycleAddress.path)
    if (!bindingBefore) return refusal('lifecycle state identity is unavailable', lifecycleAddress.path)
    const lifecycleBefore = await readState(lifecycleAddress)
    const lifecycleAfter = await readState(lifecycleAddress)
    const bindingAfter = lifecycleBinding(input.namespace, lifecycleAddress.cockpitId, lifecycleAddress.path)
    if (!bindingAfter || !sameBinding(bindingBefore, bindingAfter) || !sameResult(lifecycleBefore, lifecycleAfter)) {
        return refusal('lifecycle state changed while its stage was observed', lifecycleAddress.path)
    }
    if (lifecycleBefore.kind === 'refusal' || lifecycleBefore.kind === 'indeterminate') {
        return refusal(lifecycleBefore.message, lifecycleAddress.path)
    }
    const lifecycle = lifecycleBefore.kind === 'complete'
        ? decodeLifecycleRecord(lifecycleBefore.value, { cockpitId: lifecycleAddress.cockpitId, stackId: input.stackId })
        : undefined
    if (lifecycleBefore.kind === 'complete' && !lifecycle) return refusal('lifecycle progress record is malformed', lifecycleAddress.path)
    const stage: ObservationLifecycleStage = lifecycle?.value.steady ? 'steady' : 'bootstrap'
    const seeded = lifecycleBefore.kind === 'complete'
    const issuedAt = Date.now()
    const authority = {
        stackId: input.stackId,
        stage,
        observedAt: input.observedAt,
        validThrough: new Date(issuedAt + AUTHORITY_LIFETIME_MS).toISOString(),
        binding: bindingAfter,
    }
    const observation: EnvironmentObservation = {
        code: ENVIRONMENT_CODES.STATE_UNSEEDED,
        owner: OWNER,
        stackId: input.stackId,
        source: lifecycleAddress.path,
        observed: { state: 'available', value: seeded, observedAt: input.observedAt },
        expectation: { kind: 'equal', value: true },
        applicability: { state: 'required', posture: 'environment' },
        freshness: { state: 'current' },
        remedy: 'run up to bring the stack up',
    }
    return { kind: 'complete', authority, observation }
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
    if (result.kind !== 'complete') throw new RefusalError(result.diagnostics[0]?.message ?? 'lifecycle stage is unavailable')
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
    authority: LifecycleStageAuthority,
    expected: LifecycleAuthorityExpectation,
    trustedCurrentTime: number,
): ObservationLifecycleStage | undefined {
    if (!validAuthorityExpectation(expected)
        || !Number.isSafeInteger(trustedCurrentTime) || expected.evaluatedAt > trustedCurrentTime) return undefined
    const binding = authority.binding
    if (binding.cockpitId !== expected.cockpitId) return undefined
    const observedAt = Date.parse(authority.observedAt)
    const validThrough = Date.parse(authority.validThrough)
    if (authority.stackId !== expected.stackId || !Number.isFinite(observedAt) || !Number.isFinite(validThrough)
        || observedAt < expected.earliest || observedAt > expected.latest
        || observedAt > expected.evaluatedAt || trustedCurrentTime > validThrough) return undefined
    const namespace = authenticateStateNamespace(binding.namespace)
    const currentBinding = namespace
        ? lifecycleBinding(namespace, binding.cockpitId, binding.lifecyclePath)
        : undefined
    if (!currentBinding || !sameBinding(binding, currentBinding)) return undefined
    return authority.stage
}

export function authenticateLifecycleStageAuthority(
    value: LifecycleStageAuthority,
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
    const expected = { stackId: input.stackId, cockpitId: input.cockpitId, earliest: input.earliest, latest: input.latest, evaluatedAt: input.evaluatedAt }
    const stage = consumeLifecycleStageAuthority(input.authority, expected, Date.now())
    if (!stage) return undefined
    const projection = {} as LifecycleStageProjection
    issuedLifecycleStageProjections.set(projection, Object.freeze({ stackId: expected.stackId, stage }))
    return projection
}

export function consumeLifecycleStageProjection(
    projection: LifecycleStageProjection,
): LifecycleStageEvidence | undefined {
    const evidence = issuedLifecycleStageProjections.get(projection)
    if (!evidence) return undefined
    issuedLifecycleStageProjections.delete(projection)
    return evidence
}

/**
 * Adds `steady` or `seededAt` to the stack's lifecycle record, which `up` writes before it starts a
 * service, so a stack without one has nothing to mark.
 */
export async function updateLifecycleRecord(input: Readonly<{
    namespace: StateNamespace
    stackId: StackId
    holderId: HolderId
    change: Readonly<{ steady: true } | { seededAt: string }>
}>): Promise<LifecycleStageTransition> {
    const address = input.namespace.paths.lifecycle(input.stackId)
    const context = { cockpitId: address.cockpitId, stackId: input.stackId }
    const result = await transactState<LifecycleStageTransition>(input.namespace, address, { ownerId: input.holderId }, (current) => {
        const decoded = current ? decodeLifecycleRecord(current, context) : undefined
        if (!current || !decoded) return abortStateTransaction(refusal(
            current ? 'lifecycle progress record is malformed' : 'the stack has no lifecycle record to update', address.path))
        const value = { ...decoded.value, ...input.change }
        if (JSON.stringify(value) === JSON.stringify(decoded.value)) return abortStateTransaction({ kind: 'unchanged' as const, record: current })
        return { ...current, revision: current.revision + 1, updatedAt: new Date().toISOString(), value: snapshotJson(value)! as StateRecord['value'] }
    })
    const aborted = result as StateTransactionAbort<LifecycleStageTransition>
    if (aborted.aborted === true) return aborted.value
    const stateResult = result as StateResult<StateRecord>
    if (stateResult.kind === 'complete') return { kind: 'complete', record: stateResult.value }
    return refusal(stateResult.kind === 'missing' ? 'lifecycle record update returned no record' : stateResult.message, address.path)
}

/** Marks the stack steady once an `up` completed. */
export function recordLifecycleSeeded(input: Readonly<{
    namespace: StateNamespace
    stackId: StackId
    holderId: HolderId
}>): Promise<LifecycleStageTransition> {
    return updateLifecycleRecord({ ...input, change: { steady: true } })
}
