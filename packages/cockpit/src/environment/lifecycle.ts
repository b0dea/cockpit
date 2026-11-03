import { createHash } from 'node:crypto'
import {
    ENVIRONMENT_CODES,
    snapshotLifecyclePlan,
    type EnvironmentDiagnostic,
    type LifecyclePlan,
    type LifecycleProgress,
} from './contract.js'
import { consumeLifecycleStageProjection, type LifecycleStageProjection } from './lifecycle-stage.js'
import { consumePortLeaseProjection, type PortLeaseProjection } from './ports.js'
import type { ReclaimTargetEnvelope } from './reclaim.js'
import {
    isRuntimeTopologyEvidence,
    isRuntimeServiceEvidence,
    type RuntimeLifecycleExecutionSemantics,
    type RuntimeLifecycleProjection,
    type RuntimeLifecycleSemantics,
    type RuntimeServiceEvidence,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import type { DrainReservationRequest } from './claims.js'

const SHA256 = /^[a-f0-9]{64}$/
const SERVICE_ID = /^[a-z0-9][a-z0-9_.-]*$/
const MAX_BASIS_BYTES = 1_048_576
const MAX_SERVICES = 4_096
const MAX_EDGES = 16_384
const MAX_VALIDITY_MS = 300_000
const DOMAIN = 'cockpit-lifecycle-work-basis/v1'

type PortOwnership = PortLeaseProjection['ownership']

export interface LifecycleIssuance {
    readonly topology: RuntimeTopologyEvidence
    readonly firstIncompleteServiceIndex: number
    readonly portOwnership: PortOwnership
    readonly drainRequest: DrainReservationRequest | null
    readonly reclaim: ReclaimTargetEnvelope | null
}

export type UpLifecycleResult =
    | { readonly kind: 'execute'; readonly mode: 'start' | 'resume'; readonly plan: LifecyclePlan }
    | { readonly kind: 'noop'; readonly plan: LifecyclePlan }
    | LifecycleRefusal

export type SleepLifecycleResult =
    | { readonly kind: 'release-only'; readonly plan: LifecyclePlan }
    | { readonly kind: 'drain'; readonly plan: LifecyclePlan; readonly request: DrainReservationRequest }
    | LifecycleRefusal

export type DestructiveLifecycleResult =
    | { readonly kind: 'drain'; readonly plan: LifecyclePlan; readonly request: DrainReservationRequest }
    | LifecycleRefusal

type LifecycleRefusal = { readonly kind: 'refusal'; readonly diagnostics: readonly EnvironmentDiagnostic[] }

interface PlannerEvidence {
    readonly runtime: RuntimeLifecycleProjection
    readonly ports: PortLeaseProjection
}

interface WorkBasisContext {
    readonly reclaim?: ReclaimTargetEnvelope
}

declare const upPlanningAuthorityBrand: unique symbol
export interface UpPlanningAuthority {
    readonly [upPlanningAuthorityBrand]: true
}

interface UpPlanningRecord extends PlannerEvidence {
    readonly progress: LifecycleProgress
    readonly mode: 'start' | 'resume'
}

const admittedUpPlans = new WeakMap<object, UpPlanningRecord>()
const issuedPlans = new WeakMap<object, LifecycleIssuance>()

function refusal(code: EnvironmentDiagnostic['code'], message: string, target: string): LifecycleRefusal {
    return {
        kind: 'refusal',
        diagnostics: [{ severity: 'error' as const, code, message, target }],
    }
}

function codePointCompare(left: string, right: string): number {
    const a = Array.from(left, (value) => value.codePointAt(0)!)
    const b = Array.from(right, (value) => value.codePointAt(0)!)
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) return a[index]! - b[index]!
    }
    return a.length - b.length
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue)
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => codePointCompare(left, right))
            .map(([key, item]) => [key, canonicalValue(item)]))
    }
    return value
}

function unique<Value>(values: readonly Value[], key: (value: Value) => string): boolean {
    return new Set(values.map(key)).size === values.length
}

function canonicalSet<Value>(values: readonly Value[], key: (value: Value) => string): readonly Value[] | undefined {
    if (!unique(values, key)) return undefined
    return [...values].sort((left, right) => codePointCompare(key(left), key(right)))
}

function canonicalExecution(value: RuntimeLifecycleExecutionSemantics): unknown | undefined {
    const paths = canonicalSet(value.paths, String)
    const ports = unique(value.ports, String) ? [...value.ports].sort((left, right) => left - right) : undefined
    const consumedFiles = canonicalSet(value.consumedFiles, (item) => item.path)
    const expected = canonicalSet(value.expected, (item) => JSON.stringify(canonicalValue(item)))
    const filesystemChecks = canonicalSet(value.filesystemChecks, (item) => item.path)
    if (!paths || !ports || !expected || !consumedFiles || !filesystemChecks) return undefined
    const compensation = value.compensation.map(canonicalExecution)
    if (compensation.some((item) => item === undefined)) return undefined
    return {
        argv: [...value.argv], argv0: value.argv0, cwd: value.cwd, env: { ...value.env },
        stdoutLimitBytes: value.stdoutLimitBytes,
        stderrLimitBytes: value.stderrLimitBytes, paths, ports, expected: expected.map((item) => ({ ...item })),
        consumedFiles: consumedFiles.map((item) => ({ ...item, argvIndexes: [...item.argvIndexes] })),
        filesystemChecks: filesystemChecks.map((item) => ({ ...item })), compensation,
    }
}

function workBasis(
    verb: LifecyclePlan['verb'],
    semantics: RuntimeLifecycleSemantics,
    ports: PortLeaseProjection,
    context: WorkBasisContext = {},
): string | undefined {
    const order = [...semantics.topology.order]
    if (order.length > MAX_SERVICES || !unique(order, String) || order.some((service) => !SERVICE_ID.test(service))
        || semantics.topology.services.length !== order.length || semantics.services.length !== order.length) return undefined
    const serviceIds = new Set(order)
    if (!unique(semantics.topology.services, ({ id }) => id)
        || semantics.topology.services.some(({ id }) => !serviceIds.has(id))) return undefined
    const topologyById = new Map(semantics.topology.services.map((service) => [service.id, service]))
    let edgeCount = 0
    const topologyServices = []
    const serviceSemantics = []
    for (let index = 0; index < order.length; index += 1) {
        const service = topologyById.get(order[index]!)
        const runtimeService = semantics.services[index]
        if (!service || !runtimeService || service.id !== order[index] || runtimeService.id !== order[index]
            || service.dependsOn.some((dependency) => !serviceIds.has(dependency))) return undefined
        const dependencies = canonicalSet(service.dependsOn, String)
        const mounts = canonicalSet(service.bindMountSources, String)
        if (!dependencies || !mounts) return undefined
        edgeCount += dependencies.length
        if (edgeCount > MAX_EDGES) return undefined
        const start = canonicalExecution(runtimeService.start)
        const status = canonicalExecution(runtimeService.status)
        const identity = canonicalExecution(runtimeService.identity)
        const inspect = canonicalExecution(runtimeService.inspect)
        if (!start || !status || !identity || !inspect) return undefined
        topologyServices.push({ id: service.id, dependsOn: dependencies, bindMountSources: mounts, healthcheck: service.healthcheck })
        serviceSemantics.push({ id: runtimeService.id, start, status, identity, inspect, healthAcceptance: { ...runtimeService.healthAcceptance } })
    }
    const expectedMountSources = canonicalSet(semantics.runtimeChecks.expectedMountSources, String)
    if (!expectedMountSources || ports.lease.stackId !== semantics.stackId
        || !unique(ports.entrypoints, (entrypoint) => entrypoint.name)) return undefined
    // The basis names the work, so saved progress stays valid while the work is the same. Budgets
    // (cold start, step timeouts) and the lifecycle stage are left out: the first `up` itself moves
    // the stage to steady, and the next `up` read that as different work, re-ran every start as a
    // no-op and reported a fresh start with an invented cold-start time. The leased ports stand in
    // for the entrypoint URLs derived from them, which only name those ports.
    const basis = canonicalValue({
        domain: DOMAIN, verb, stackId: semantics.stackId, configSha256: semantics.configSha256,
        runtimeVersion: semantics.runtimeVersion, composeVersion: semantics.composeVersion,
        projectName: semantics.projectName,
        runtimeChecks: { expectedMountSources },
        topology: { order, services: topologyServices }, services: serviceSemantics,
        ports: { ...ports.lease.ports },
        ...(context.reclaim === undefined ? {} : {
            reclaim: {
                planDigest: context.reclaim.planDigest,
                commitments: context.reclaim.commitments.map(({ targetId, format, sha256, body }) => ({
                    targetId, format, sha256, body,
                })),
            },
        }),
    })
    const serialized = JSON.stringify(basis)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BASIS_BYTES) return undefined
    return createHash('sha256').update(Buffer.from(serialized, 'utf8')).digest('hex')
}

function consumePlannerEvidence(runtimeProjection: RuntimeLifecycleProjection, portProjection: PortLeaseProjection): PlannerEvidence | undefined {
    const runtime = isRuntimeTopologyEvidence(runtimeProjection.topology) ? runtimeProjection : undefined
    const ports = consumePortLeaseProjection(portProjection)
    if (!runtime || !ports || runtime.semantics.stackId !== ports.lease.stackId
        || !Number.isSafeInteger(ports.ownership.holderCount) || ports.ownership.holderCount < 0
        || ports.ownership.holderIds.length !== ports.ownership.holderCount
        || !unique(ports.ownership.holderIds, String)
        || !ports.ownership.holderIds.includes(ports.ownership.holderId)) return undefined
    return { runtime, ports }
}

function validProgress(progress: LifecycleProgress | null): boolean {
    return progress === null || SHA256.test(progress.workBasisSha256) && SHA256.test(progress.operationGeneration)
        && progress.completedServices.length <= MAX_SERVICES
        && progress.completedServices.every((item) => SERVICE_ID.test(item.service) && SHA256.test(item.containerId))
}

function completedPrefix(
    evidence: readonly RuntimeServiceEvidence[],
    progress: LifecycleProgress,
    runtime: RuntimeLifecycleProjection,
): readonly RuntimeServiceEvidence[] | undefined {
    if (evidence.length !== progress.completedServices.length) return undefined
    for (let index = 0; index < evidence.length; index += 1) {
        const item = evidence[index]
        const completed = progress.completedServices[index]
        const service = runtime.semantics.services[index]
        if (!item || !completed || !service
            || item.stackId !== runtime.semantics.stackId || item.configSha256 !== runtime.semantics.configSha256
            || item.batchId !== runtime.topology.batchId || item.executableSha256 !== runtime.topology.executableSha256
            || item.runtimeVersion !== runtime.semantics.runtimeVersion || item.composeVersion !== runtime.semantics.composeVersion
            || item.projectName !== runtime.semantics.projectName || item.service !== service.id
            || item.service !== completed.service || item.containerId !== completed.containerId
            || item.state !== service.healthAcceptance.state || item.health !== service.healthAcceptance.health) return undefined
    }
    return evidence
}

function lifecyclePlan(
    verb: LifecyclePlan['verb'],
    workBasisSha256: string,
    operationGeneration: string,
    completedServices: LifecycleProgress['completedServices'],
    steps: LifecyclePlan['steps'],
    completedStepCount: number,
    compensation: LifecyclePlan['compensation'],
): LifecyclePlan | undefined {
    const plan = snapshotLifecyclePlan({
        verb,
        progress: { workBasisSha256, operationGeneration, completedServices },
        steps,
        resumeBoundary: {
            completedStepIds: steps.slice(0, completedStepCount).map(({ id }) => id),
            nextStepId: steps[completedStepCount]?.id ?? null,
        },
        compensation,
        diagnostics: [],
    })
    return plan
}

function issue(plan: LifecyclePlan, issuance: LifecycleIssuance): LifecyclePlan {
    issuedPlans.set(plan, issuance)
    return plan
}

export function consumeLifecycleIssuance(plan: LifecyclePlan): LifecycleIssuance | undefined {
    if (!plan || typeof plan !== 'object') return undefined
    const issuance = issuedPlans.get(plan)
    if (!issuance) return undefined
    issuedPlans.delete(plan)
    return issuance
}

export function admitUpProgress(input: {
    readonly lifecycleStage: LifecycleStageProjection
    readonly runtime: RuntimeLifecycleProjection
    readonly ports: PortLeaseProjection
    readonly progress: LifecycleProgress | null
    readonly operationGeneration: string
}): { readonly kind: 'admitted'; readonly authority: UpPlanningAuthority } | LifecycleRefusal {
    if (!SHA256.test(input.operationGeneration)) {
        return refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'lifecycle planning evidence is invalid', 'up')
    }
    const stage = consumeLifecycleStageProjection(input.lifecycleStage)
    const evidence = consumePlannerEvidence(input.runtime, input.ports)
    if (!stage || !evidence || stage.stackId !== evidence.runtime.semantics.stackId) {
        return refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'lifecycle planning evidence is invalid', 'up')
    }
    const basis = workBasis('up', evidence.runtime.semantics, evidence.ports)
    if (!basis) return refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'lifecycle work evidence is invalid', 'up')
    const prior = input.progress
    if (!validProgress(prior) || prior !== null && (prior.workBasisSha256 !== basis
        || prior.operationGeneration !== input.operationGeneration)) {
        return refusal(ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID, 'lifecycle progress does not match the current work', 'up-progress')
    }
    const progress = prior ?? {
        workBasisSha256: basis,
        operationGeneration: input.operationGeneration,
        completedServices: [],
    }
    const authority = {} as UpPlanningAuthority
    admittedUpPlans.set(authority, { ...evidence, progress, mode: prior === null ? 'start' : 'resume' })
    return { kind: 'admitted', authority }
}

export function planAdmittedUp(input: {
    readonly authority: UpPlanningAuthority
    readonly completedServices: readonly RuntimeServiceEvidence[]
}): UpLifecycleResult {
    const evidence = admittedUpPlans.get(input.authority)
    admittedUpPlans.delete(input.authority)
    const now = Date.now()
    const window = evidence?.runtime.topology.observationWindow
    if (!evidence || !window
        || !Number.isFinite(Date.parse(window.startedAt)) || !Number.isFinite(Date.parse(window.expiresAt))
        || now < Date.parse(window.startedAt) || now > Date.parse(window.expiresAt)) {
        return refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'lifecycle planning authority is unavailable or expired', 'up')
    }
    const { progress } = evidence
    const completedEvidence = input.completedServices
    if (completedEvidence.length > MAX_SERVICES || !completedEvidence.every((item) => isRuntimeServiceEvidence(item))) {
        return refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            'completed service evidence is invalid', 'up-evidence')
    }
    const completed = completedPrefix(completedEvidence, progress, evidence.runtime)
    const order = evidence.runtime.semantics.topology.order
    if (!completed || completed.length > order.length
        || completed.some((item, index) => item.service !== order[index])) {
        return refusal(ENVIRONMENT_CODES.LIFECYCLE_PROGRESS_INVALID, 'completed services are not the current dependency prefix', 'up-progress')
    }
    const steps: LifecyclePlan['steps'] = [
        { id: 'lifecycle:preflight', kind: 'preflight' as const },
        { id: 'lifecycle:claim:acquire', kind: 'claim' as const, action: 'acquire' as const },
        ...order.map((service) => ({ id: `lifecycle:service:${service}`, kind: 'service' as const, service })),
        {
            id: 'lifecycle:entrypoints', kind: 'publish-entrypoints' as const,
            values: evidence.ports.entrypoints.map((entrypoint) => ({ ...entrypoint })),
        },
    ]
    const compensation: LifecyclePlan['compensation'] = evidence.ports.ownership.change === 'acquired'
        ? [{
            step: { id: 'lifecycle:claim:release', kind: 'claim' as const, action: 'release' as const },
            ownership: {
                stackId: evidence.ports.lease.stackId, holderId: evidence.ports.ownership.holderId,
                recordRevision: evidence.ports.ownership.recordRevision, change: 'acquired' as const,
            },
        }] : []
    const complete = completed.length === order.length && evidence.mode === 'resume'
    const completedStepCount = complete ? steps.length : 2 + completed.length
    const plan = lifecyclePlan('up', progress.workBasisSha256, progress.operationGeneration, progress.completedServices, steps, completedStepCount, compensation)
    if (!plan) return refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'lifecycle plan could not be represented', 'up')
    issue(plan, {
        topology: evidence.runtime.topology, firstIncompleteServiceIndex: completed.length,
        portOwnership: evidence.ports.ownership, drainRequest: null, reclaim: null,
    })
    if (complete) return { kind: 'noop', plan }
    return { kind: 'execute', mode: evidence.mode, plan }
}

function validDrainInputs(generation: string, runtimeStopValidForMs: number, reclaimValidForMs?: number): boolean {
    const validity = (ms: number) => Number.isSafeInteger(ms) && ms >= 1 && ms <= MAX_VALIDITY_MS
    return SHA256.test(generation) && validity(runtimeStopValidForMs)
        && (reclaimValidForMs === undefined || validity(reclaimValidForMs))
}

function drainRequest(
    purpose: 'sleep' | 'down' | 'reset',
    evidence: PlannerEvidence,
    generation: string,
    runtimeStopValidForMs: number,
    reclaimValidForMs?: number,
    reclaim?: ReclaimTargetEnvelope,
): DrainReservationRequest {
    const operationBasis = workBasis(purpose, evidence.runtime.semantics, evidence.ports,
        reclaim === undefined ? {} : { reclaim })!
    const targetIds = [
        evidence.runtime.semantics.stackId,
        ...(reclaim?.commitments.map(({ targetId }) => targetId) ?? []),
    ].sort()
    const actions = [
        { stage: 'runtime-stop' as const, targetId: evidence.runtime.semantics.stackId, validForMs: runtimeStopValidForMs },
        ...(reclaim?.commitments.map(({ targetId, ...targetCommitment }) => ({
            stage: 'reclaim' as const, targetId, validForMs: reclaimValidForMs!, targetCommitment: { ...targetCommitment },
        })) ?? []),
    ]
    return {
        purpose, stackId: evidence.runtime.semantics.stackId,
        holderId: evidence.ports.ownership.holderId, requesterId: evidence.ports.ownership.holderId,
        configSha256: evidence.runtime.semantics.configSha256,
        planDigest: reclaim?.planDigest ?? operationBasis,
        operationBasis, generation,
        targetIds, actions, expectedCoordinationRevision: evidence.ports.ownership.recordRevision,
    }
}

function passivePlan(
    verb: 'sleep' | 'down' | 'reset', evidence: PlannerEvidence, generation: string,
    steps: LifecyclePlan['steps'], request: DrainReservationRequest | null, reclaim: ReclaimTargetEnvelope | null,
): LifecyclePlan | undefined {
    const basis = workBasis(verb, evidence.runtime.semantics, evidence.ports,
        reclaim === null ? {} : { reclaim })
    if (!basis) return undefined
    const plan = lifecyclePlan(verb, basis, generation, [], steps, 0, [])
    if (!plan) return undefined
    return issue(plan, {
        topology: evidence.runtime.topology, firstIncompleteServiceIndex: 0,
        portOwnership: evidence.ports.ownership, drainRequest: request, reclaim,
    })
}

export function planSleep(input: {
    readonly runtime: RuntimeLifecycleProjection
    readonly ports: PortLeaseProjection
    readonly operationGeneration: string
    readonly runtimeStopValidForMs: number
}): SleepLifecycleResult {
    if (!validDrainInputs(input.operationGeneration, input.runtimeStopValidForMs)) {
        return refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'sleep planning evidence is invalid', 'sleep')
    }
    const evidence = consumePlannerEvidence(input.runtime, input.ports)
    if (!evidence) return refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'sleep planning evidence is invalid', 'sleep')
    if (evidence.ports.ownership.holderCount > 1) {
        const steps = [{ id: 'lifecycle:claim:release', kind: 'claim' as const, action: 'release' as const }]
        const plan = passivePlan('sleep', evidence, input.operationGeneration, steps, null, null)
        return plan ? { kind: 'release-only', plan }
            : refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'sleep plan could not be represented', 'sleep')
    }
    const request = drainRequest('sleep', evidence, input.operationGeneration, input.runtimeStopValidForMs)
    const plan = passivePlan('sleep', evidence, input.operationGeneration,
        [{ id: 'lifecycle:preflight', kind: 'preflight' as const }], request, null)
    return plan ? { kind: 'drain', plan, request }
        : refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, 'sleep plan could not be represented', 'sleep')
}

function planDestructive(
    verb: 'down' | 'reset',
    input: DestructivePlanningInput,
): DestructiveLifecycleResult {
    if (!validDrainInputs(input.operationGeneration, input.runtimeStopValidForMs, input.reclaimValidForMs)) {
        return refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, `${verb} planning evidence is invalid`, verb)
    }
    const evidence = consumePlannerEvidence(input.runtime, input.ports)
    const reclaim = input.reclaim
    if (!evidence || reclaim.purpose !== verb || reclaim.stackId !== evidence.runtime.semantics.stackId
        || reclaim.configSha256 !== evidence.runtime.semantics.configSha256
        || verb === 'reset' && reclaim.commitments.length === 0
        || !unique(reclaim.commitments, ({ targetId }) => targetId)
        || reclaim.commitments.some(({ targetId }, index) => index > 0
            && reclaim.commitments[index - 1]!.targetId >= targetId)
        || reclaim.commitments.some(({ targetId }) => targetId === evidence.runtime.semantics.stackId)) {
        return refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            `${verb} requires valid runtime, port, and reclaim evidence`, verb)
    }
    if (evidence.ports.ownership.holderCount !== 1) {
        return refusal(ENVIRONMENT_CODES.CLAIM_CO_TENANT, `${verb} requires exact exclusive ownership`, verb)
    }
    const request = drainRequest(
        verb, evidence, input.operationGeneration, input.runtimeStopValidForMs,
        input.reclaimValidForMs, reclaim,
    )
    const plan = passivePlan(verb, evidence, input.operationGeneration,
        [{ id: 'lifecycle:preflight', kind: 'preflight' as const }], request, reclaim)
    return plan ? { kind: 'drain', plan, request }
        : refusal(ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID, `${verb} plan could not be represented`, verb)
}

interface DestructivePlanningInput {
    readonly runtime: RuntimeLifecycleProjection
    readonly ports: PortLeaseProjection
    readonly reclaim: ReclaimTargetEnvelope
    readonly operationGeneration: string
    readonly runtimeStopValidForMs: number
    readonly reclaimValidForMs: number
}

export function planDown(input: DestructivePlanningInput): DestructiveLifecycleResult {
    return planDestructive('down', input)
}

export function planResetLifecycle(input: DestructivePlanningInput): DestructiveLifecycleResult {
    return planDestructive('reset', input)
}
