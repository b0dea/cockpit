import { randomUUID } from 'node:crypto'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isProxy } from 'node:util/types'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { authenticatedExecutionOutcome } from '../environment-exec/execute.js'
import { GeneratedEnvironment } from '../schema.js'
import { ENVIRONMENT_CODES, isCanonicalTimestamp, snapshotEnvironmentObservation, snapshotExecutionStep, snapshotGeneratedJson, type EnvironmentObservation, type ExecutionFailureCode, type ExecutionStep, type StackId } from './contract.js'
import { resolvedDockerExecutable, resolvedExecutable, type ResolvedExecutable } from './executable.js'
import {
    admitRuntimeServiceHealth,
    admitRuntimeServiceObservation,
    admitRuntimeServiceRevalidation,
    admitRuntimeServiceRevalidationStatus,
    createRuntimeServiceRevalidationPlan,
    isRuntimeServiceEvidence,
    isRuntimeTopologyEvidence,
    type RuntimeServiceEvidence,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import type { ExternalDependencyTemplateFragments } from './templates.js'
import { inspectGeneratedRuntimeAuthority, type GeneratedRuntimeAuthority } from './generated-stack.js'

export const mechanism = {
    id: 'external-dependency-boundary',
    module: 'packages/cockpit/src/environment/external-dependencies.ts',
    exports: ['planExternalDependency', 'verifyExternalDependency', 'projectExternalDependencyProgress', 'observeExternalDependency', 'isExternalDependencyObservationProjection', 'observeExternalDependencies', 'isExternalDependencyObservation', 'observationDeclarations'],
} as const

export const observationDeclarations = Object.freeze([
    { id: 'external-dependencies', owner: mechanism.id, postures: ['external-dependencies'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.EXTERNAL_DEPENDENCIES_UNAVAILABLE, isIssued: isExternalDependencyObservation, issuedAt: externalDependencyObservationIssuedAt },
] as const)

const VendorDeclaration = GeneratedEnvironment.shape.vendors.unwrap().element
type Vendor = typeof VendorDeclaration._output
type Operation = Vendor['loader_probe']
const SAFE_RUNTIME_ENV = new Set(['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])
const HOST_PROCESS_CONTROL_ENV = /^(?:DOCKER_|COMPOSE_|LD_|DYLD_|LIBPATH$|SHLIB_PATH$|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|PATH$|IFS$)/

export interface ExternalDependencyRuntime {
    readonly root: string
    readonly executable: ResolvedExecutable
    readonly composeFiles: readonly Readonly<{ path: string; sha256: string }>[]
    readonly projectName: string
    readonly publicEnv: Readonly<Record<string, string>>
    readonly stdoutLimitBytes: number
    readonly stderrLimitBytes: number
    readonly hostExecutables?: Readonly<Record<string, ResolvedExecutable>>
    readonly serviceAuthority?: Readonly<{ topology: RuntimeTopologyEvidence; evidence: RuntimeServiceEvidence }>
}

export type ExternalDependencyCode =
    | 'EXTERNAL_DEPENDENCY_DECLARATION_INVALID'
    | 'EXTERNAL_DEPENDENCY_TEMPLATE_MISMATCH'
    | 'EXTERNAL_DEPENDENCY_SHADOW_UNAVAILABLE'
    | 'EXTERNAL_DEPENDENCY_EXPIRED'
    | 'EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE'
    | 'EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE'

type DependencySummary = Readonly<{
    id: string
    posture: Vendor['posture']
    reason: string
    measurement: 'pending' | 'measured' | 'unmeasured'
    callback: Readonly<{ reachable: boolean; alternative: string; reason: string }>
}>

export type ExternalDependencyRefusal = Readonly<{
    kind: 'unmeasured'
    code: ExternalDependencyCode
    message: string
    dependency?: DependencySummary
}>

export type ExternalDependencyStep = Readonly<{ role: string; step: ExecutionStep }>

const planAuthority = new WeakMap<object, Readonly<{
    declaration: Vendor
    steps: readonly ExternalDependencyStep[]
    purpose: 'startup' | 'health'
    generatedAuthority?: GeneratedRuntimeAuthority
    expectedIds?: readonly string[]
    stackId?: StackId
    serviceAuthority?: Readonly<{ topology: RuntimeTopologyEvidence; evidence: RuntimeServiceEvidence }>
    issuedAtMs: number
    expiresAtMs: number
}>>()
const consumedPlans = new WeakSet<object>()

export type ExternalDependencyPlan = Readonly<{
    kind: 'complete'
    dependency: DependencySummary
    steps: readonly ExternalDependencyStep[]
}>

export type ExternalDependencyVerification = Readonly<{
    kind: 'complete'
    dependency: DependencySummary
    completedRoles: readonly string[]
}> | Readonly<{
    kind: 'refusal'
    dependency: DependencySummary
    failedRole: string
    code: ExecutionFailureCode
    completedRoles: readonly string[]
}> | ExternalDependencyRefusal

const issuedEvidence = new WeakMap<object, Readonly<{
    observedAt: string
    purpose: 'startup' | 'health'
    plannedRoles: readonly string[]
    completedRoles: readonly string[]
    attemptedRoles: readonly string[]
    generatedAuthority?: GeneratedRuntimeAuthority
    expectedIds?: readonly string[]
    stackId?: StackId
}>>()
const consumedEvidence = new WeakSet<object>()
const issuedObservations = new WeakMap<object, Readonly<{
    rendered: object
    topology: RuntimeTopologyEvidence
    sourceSha256: string
    generation: string
    purpose: 'startup' | 'health'
    plannedRoles: readonly string[]
    completedRoles: readonly string[]
    attemptedRoles: readonly string[]
}>>()
const consumedObservations = new WeakSet<object>()
const issuedAggregateObservations = new WeakMap<object, Readonly<{
    issuedAt: number
    purpose: 'startup' | 'health'
}>>()

function externalDependencyObservationIssuedAt(value: unknown): number | undefined {
    return value !== null && typeof value === 'object' ? issuedAggregateObservations.get(value)?.issuedAt : undefined
}

export type ExternalDependencyObservation = Readonly<{
    kind: 'external-dependency-observation'
    stackId: StackId
    observedAt: string
    state: 'available' | 'failed' | 'unavailable'
    dependency?: DependencySummary
    completedRoles: readonly string[]
    reason: string
}>

function issueEvidence<T extends ExternalDependencyVerification | ExternalDependencyRefusal>(value: T, purpose: 'startup' | 'health', progress: Readonly<{
    plannedRoles: readonly string[]
    completedRoles: readonly string[]
    attemptedRoles: readonly string[]
}>, authority?: Readonly<{
    generatedAuthority: GeneratedRuntimeAuthority
    expectedIds: readonly string[]
    stackId: StackId
}>): T {
    issuedEvidence.set(value, Object.freeze({
        observedAt: new Date().toISOString(), purpose,
        plannedRoles: Object.freeze([...progress.plannedRoles]),
        completedRoles: Object.freeze([...progress.completedRoles]),
        attemptedRoles: Object.freeze([...progress.attemptedRoles]),
        ...authority,
    }))
    return value
}

function unmeasured(code: ExternalDependencyCode, message: string, dependency?: DependencySummary): ExternalDependencyRefusal {
    return Object.freeze({ kind: 'unmeasured', code, message, ...(dependency === undefined ? {} : { dependency: Object.freeze({ ...dependency, measurement: 'unmeasured' as const }) }) })
}

function summary(declaration: Vendor, measurement: DependencySummary['measurement']): DependencySummary {
    return Object.freeze({
        id: declaration.id, posture: declaration.posture, reason: declaration.reason, measurement,
        callback: Object.freeze({ ...declaration.callback_reachability }),
    })
}

function exactFragments(declaration: Vendor, fragments: ExternalDependencyTemplateFragments): boolean {
    if (fragments.kind !== 'complete' || fragments.dependencyId !== declaration.id
        || fragments.normalizeExportedEmpties !== true || fragments.placeholder !== declaration.placeholder
        || fragments.runtime.length !== declaration.endpoints.length || fragments.secretsTemplate.length !== declaration.endpoints.length
        || fragments.shadowFiles.length !== (declaration.shadow_files?.length ?? 0)
        || fragments.nonempty.length !== (declaration.nonempty_variables?.length ?? 0)) return false
    return declaration.endpoints.every((endpoint, index) => {
        const runtime = fragments.runtime[index]
        const template = fragments.secretsTemplate[index]
        return runtime?.variable === endpoint.variable && runtime.value === endpoint.sink && runtime.service === endpoint.runtime_service
            && template?.variable === endpoint.variable && template.value === endpoint.sink
            && template.sibling === endpoint.supplier.sibling && template.template === endpoint.supplier.template
    }) && (declaration.shadow_files ?? []).every(({ sibling, instance }, index) => {
        const shadow = fragments.shadowFiles[index]
        return shadow?.sibling === sibling && shadow.instance === instance
    }) && (declaration.nonempty_variables ?? []).every((variable, index) => {
        const nonempty = fragments.nonempty[index]
        return nonempty?.variable === variable && nonempty.value === declaration.placeholder
    })
}

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function sandboxDeadline(declaration: Vendor): string | undefined {
    return declaration.expiry === undefined ? undefined : `${declaration.expiry.expires_on}T23:59:59.999Z`
}

function confined(root: string, candidate: string): string | undefined {
    const target = resolve(root, candidate)
    const fromRoot = relative(root, target)
    return fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) ? undefined : target
}

function composeStep(
    runtime: ExternalDependencyRuntime,
    dependencyId: string,
    role: string,
    operation: Operation,
    spawnNotAfter?: string,
    fixture?: Readonly<{ path: string; sha256: string }>,
    processEnvironment?: Readonly<{ name: string; value: string }>,
    planId?: string,
    allowedRuntimeEnv: ReadonlySet<string> = SAFE_RUNTIME_ENV,
): ExecutionStep | undefined {
    const docker = resolvedDockerExecutable(runtime.executable)
    if (docker === undefined || !isAbsolute(runtime.root) || normalize(runtime.root) !== runtime.root
        || !/^[a-z0-9][a-z0-9_-]*$/.test(runtime.projectName)
        || Object.entries(runtime.publicEnv).some(([name, value]) => !allowedRuntimeEnv.has(name) || typeof value !== 'string' || value.includes('\0'))
        || !boundedInteger(runtime.stdoutLimitBytes, 0, 16_777_216) || !boundedInteger(runtime.stderrLimitBytes, 0, 16_777_216)
        || runtime.composeFiles.length === 0 || runtime.composeFiles.some((file) => !isAbsolute(file.path) || normalize(file.path) !== file.path || !/^[a-f0-9]{64}$/.test(file.sha256))) return undefined
    const cwd = confined(runtime.root, operation.cwd)
    const fixturePath = fixture === undefined ? undefined : confined(runtime.root, fixture.path)
    if (cwd === undefined || fixture !== undefined && fixturePath === undefined) return undefined
    let argv: readonly [string, ...string[]]
    let argv0: string
    let consumedFiles: ExecutionStep['consumedFiles']
    if (operation.location === 'host') {
        const executable = resolvedExecutable(runtime.hostExecutables?.[operation.argv[0]])
        if (executable === undefined) return undefined
        argv = Object.freeze([executable.canonicalPath, ...operation.argv.slice(1)]) as readonly [string, ...string[]]
        argv0 = executable.invocationPath
        consumedFiles = Object.freeze([{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912, argvIndexes: Object.freeze([0]), executable: true, executionMode: executable.executionMode }])
    } else {
        const fileArgs = runtime.composeFiles.flatMap(({ path }) => ['--file', path])
        argv = Object.freeze([
            docker.canonicalPath, 'compose', '--project-directory', runtime.root, ...fileArgs,
            '--project-name', runtime.projectName, 'exec',
            ...(processEnvironment === undefined ? [] : ['--env', `${processEnvironment.name}=${processEnvironment.value}`]),
            '--workdir', operation.cwd, '-T', operation.service!, ...operation.argv,
        ]) as readonly [string, ...string[]]
        argv0 = docker.invocationPath
        consumedFiles = Object.freeze([
            { path: docker.canonicalPath, sha256: docker.sha256, maxBytes: 536_870_912, argvIndexes: Object.freeze([0]), executable: true, executionMode: docker.executionMode },
            ...runtime.composeFiles.map(({ path, sha256 }, index) => ({ path, sha256, maxBytes: 1_048_576, argvIndexes: Object.freeze([5 + index * 2]), executable: false as const })),
        ])
    }
    return snapshotExecutionStep({
        id: `external:${dependencyId}:${role}`, argv, argv0, cwd,
        env: Object.freeze({ ...runtime.publicEnv }), timeoutMs: operation.timeout_seconds * 1000,
        ...(spawnNotAfter === undefined ? {} : { spawnNotAfter }),
        stdoutLimitBytes: runtime.stdoutLimitBytes, stderrLimitBytes: runtime.stderrLimitBytes,
        paths: Object.freeze([...runtime.composeFiles.map(({ path }) => path), ...(fixturePath === undefined ? [] : [fixturePath])]), ports: Object.freeze([]),
        labels: Object.freeze({
            dependency: dependencyId, role, location: operation.location,
            ...(operation.service === undefined ? {} : { service: operation.service }),
            ...(planId === undefined ? {} : { externalPlanId: planId }),
        }),
        expected: Object.freeze([]), consumedFiles,
        filesystemChecks: Object.freeze(fixturePath === undefined ? [] : [{ path: fixturePath, expected: 'file' as const, sha256: fixture!.sha256, maxBytes: 16_777_216 }]),
        compensation: Object.freeze([]),
    })
}

function orderedOperations(declaration: Vendor, issuedAt: number, purpose: 'startup' | 'health'): readonly Readonly<{ role: string; operation: Operation; spawnNotAfter?: string; fixture?: Readonly<{ path: string; sha256: string }> }>[] {
    const values: { role: string; operation: Operation; spawnNotAfter?: string; fixture?: Readonly<{ path: string; sha256: string }> }[] = [
        ...(declaration.tls === undefined ? [] : [
            { role: 'tls-generate', operation: declaration.tls.generate_at_start },
            { role: 'tls-trust', operation: declaration.tls.append_trust_probe },
            { role: 'tls-hostname', operation: declaration.tls.hostname_probe },
        ]),
        { role: 'loader', operation: declaration.loader_probe },
        { role: 'route', operation: declaration.route_probe },
        ...(declaration.shadow_files ?? []).map(({ sibling, instance, probe }) => ({ role: `shadow:${sibling}:${instance}`, operation: probe })),
        ...(declaration.expiry === undefined ? [] : [{ role: 'sandbox-expiry', operation: declaration.expiry.probe }]),
        { role: 'egress', operation: declaration.egress_probe },
    ]
    if (declaration.callback !== undefined) {
        const deadline = new Date(issuedAt + declaration.callback.fresh_window_seconds * 1000).toISOString()
        const fixture = declaration.callback.fixture
        values.push(
            { role: 'callback-enable', operation: declaration.callback.enable, spawnNotAfter: deadline },
            { role: 'callback-timestamp', operation: declaration.callback.timestamp_source, spawnNotAfter: deadline },
            { role: 'callback-sign', operation: declaration.callback.sign, spawnNotAfter: deadline, fixture },
            { role: 'callback-dispatch', operation: declaration.callback.dispatch, spawnNotAfter: deadline, fixture },
            { role: 'callback-controls', operation: declaration.callback.tamper_probe, spawnNotAfter: deadline, fixture },
        )
    }
    if (declaration.stub !== undefined) values.push(
        { role: 'stub-rejection', operation: declaration.stub.rejection_probe },
        { role: 'stub-outage', operation: declaration.stub.outage_probe },
    )
    const selected = purpose === 'startup' ? values : values.filter(({ role }) =>
        role === 'tls-trust' || role === 'tls-hostname' || role === 'loader' || role === 'route'
        || role.startsWith('shadow:') || role === 'sandbox-expiry' || role === 'egress' || role === 'callback-controls')
    const expiry = sandboxDeadline(declaration)
    return Object.freeze(selected.map((value) => {
        const spawnNotAfter = expiry === undefined ? value.spawnNotAfter
            : value.spawnNotAfter === undefined || Date.parse(expiry) < Date.parse(value.spawnNotAfter) ? expiry : value.spawnNotAfter
        return Object.freeze({ ...value, ...(spawnNotAfter === undefined ? {} : { spawnNotAfter }) })
    }))
}

export function planExternalDependency(input: {
    readonly authority?: GeneratedRuntimeAuthority
    readonly purpose?: 'startup' | 'health'
    readonly declaration: unknown
    readonly fragments: ExternalDependencyTemplateFragments
    readonly runtime: ExternalDependencyRuntime
    readonly observedAt: string
    readonly presentShadowFiles: readonly Readonly<{ sibling: string; instance: string }>[]
}): ExternalDependencyPlan | ExternalDependencyRefusal {
    const purpose = input.purpose ?? 'startup'
    const generated = input.authority === undefined ? undefined : inspectGeneratedRuntimeAuthority(input.authority)
    const parsed = VendorDeclaration.safeParse(input.declaration)
    if (input.authority !== undefined && !generated || !parsed.success || !isCanonicalTimestamp(input.observedAt)) return unmeasured('EXTERNAL_DEPENDENCY_DECLARATION_INVALID', 'external dependency declaration or observation clock is invalid')
    const declaration = parsed.data as Vendor
    const configured = generated?.declaration.vendors.find(({ id }) => id === declaration.id)
    const configuredSnapshot = configured === undefined ? undefined : snapshotGeneratedJson(configured)
    const declarationSnapshot = snapshotGeneratedJson(declaration)
    if (generated && (!configuredSnapshot || !declarationSnapshot || !isDeepStrictEqual(configuredSnapshot, declarationSnapshot))) return unmeasured('EXTERNAL_DEPENDENCY_DECLARATION_INVALID', 'external dependency declaration is not bound to the generated runtime authority')
    const runtime = generated?.runtime as ExternalDependencyRuntime | undefined ?? input.runtime
    if (generated && (runtime.root !== input.runtime.root || runtime.projectName !== input.runtime.projectName
        || !isDeepStrictEqual(runtime.executable, input.runtime.executable) || !isDeepStrictEqual(runtime.composeFiles, input.runtime.composeFiles)
        || !isDeepStrictEqual(runtime.publicEnv, input.runtime.publicEnv))) {
        return unmeasured('EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE', 'external dependency runtime does not match the generated runtime authority')
    }
    const expectedIds = generated === undefined ? undefined : Object.freeze(generated.declaration.vendors.map(({ id }) => id).sort())
    const dependency = summary(declaration, 'unmeasured')
    const issuedAt = Date.now()
    const planId = randomUUID()
    if (!exactFragments(declaration, input.fragments)) return unmeasured('EXTERNAL_DEPENDENCY_TEMPLATE_MISMATCH', 'runtime and secrets-template endpoint pins do not match the declaration', dependency)
    const present = new Set(input.presentShadowFiles.map(({ sibling, instance }) => `${sibling}\0${instance}`))
    const absent = (declaration.shadow_files ?? []).find(({ sibling, instance }) => !present.has(`${sibling}\0${instance}`))
    if (absent !== undefined) return unmeasured('EXTERNAL_DEPENDENCY_SHADOW_UNAVAILABLE', 'a declared product environment shadow is absent', dependency)
    const expiresAt = sandboxDeadline(declaration)
    if (expiresAt !== undefined && issuedAt > Date.parse(expiresAt)) {
        return unmeasured('EXTERNAL_DEPENDENCY_EXPIRED', 'vendor sandbox evidence is past its declared expiry', dependency)
    }
    const serviceAuthority = runtime.serviceAuthority
    if (declaration.egress_guard !== undefined) {
        if (declaration.egress_probe.location !== 'in-stack' || declaration.egress_probe.service !== declaration.egress_guard.local_service) {
            return unmeasured('EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE', 'egress guard must target its authenticated local service', dependency)
        }
        const topology = serviceAuthority?.topology
        const evidence = serviceAuthority?.evidence
        if (!topology || !evidence || !isRuntimeTopologyEvidence(topology) || !isRuntimeServiceEvidence(evidence)
            || topology.stackId !== evidence.stackId || topology.configSha256 !== evidence.configSha256
            || topology.batchId !== evidence.batchId || topology.projectName !== runtime.projectName
            || topology.executableSha256 !== runtime.executable.sha256 || topology.cwd !== runtime.root
            || evidence.projectName !== runtime.projectName || evidence.executableSha256 !== runtime.executable.sha256
            || evidence.service !== declaration.egress_guard.local_service) {
            return unmeasured('EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE', 'egress guard requires matching authenticated local service evidence', dependency)
        }
    }
    if (generated?.declaration.services.some(({ ports }) => ports.some(({ host_variable }) => HOST_PROCESS_CONTROL_ENV.test(host_variable)))) {
        return unmeasured('EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE', 'generated port variables must not control host processes', dependency)
    }
    const allowedRuntimeEnv = generated ? new Set([...SAFE_RUNTIME_ENV,
        ...generated.declaration.services.flatMap(({ ports }) => ports.map(({ host_variable }) => host_variable))]) : SAFE_RUNTIME_ENV
    const steps: ExternalDependencyStep[] = []
    for (const item of orderedOperations(declaration, issuedAt, purpose)) {
        const processEnvironment = item.role === 'egress' && declaration.egress_guard !== undefined
            ? { name: declaration.egress_guard.flag, value: declaration.egress_guard.enabled_value }
            : undefined
        const step = composeStep(runtime, declaration.id, item.role, item.operation, item.spawnNotAfter, item.fixture, processEnvironment, planId, allowedRuntimeEnv)
        if (step === undefined) return unmeasured('EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE', `execution is unavailable for ${item.role}`, dependency)
        steps.push(Object.freeze({ role: item.role, step }))
    }
    const plan = Object.freeze({ kind: 'complete' as const, dependency: summary(declaration, 'pending'), steps: Object.freeze(steps) })
    planAuthority.set(plan, Object.freeze({
        declaration, steps: plan.steps, purpose, issuedAtMs: issuedAt,
        expiresAtMs: Math.min(issuedAt + 300_000, expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(expiresAt)),
        ...(generated === undefined ? {} : { generatedAuthority: input.authority, expectedIds, stackId: generated.stackId }),
        ...(serviceAuthority === undefined ? {} : { serviceAuthority }),
    }))
    return plan
}

async function revalidateLocalService(
    authority: Readonly<{ topology: RuntimeTopologyEvidence; evidence: RuntimeServiceEvidence }>,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<boolean> {
    if (!isRuntimeTopologyEvidence(authority.topology) || !isRuntimeServiceEvidence(authority.evidence)) return false
    const plan = createRuntimeServiceRevalidationPlan({
        topology: authority.topology,
        service: authority.evidence.service,
        expectedContainerId: authority.evidence.containerId,
    })
    if (plan.kind !== 'planned') return false
    try {
        const statusOutcome = await execute(plan.status)
        if (admitRuntimeServiceRevalidationStatus({ plan, outcome: statusOutcome }).kind !== 'admitted') return false
        const identityOutcome = await execute(plan.identity)
        const revalidated = admitRuntimeServiceRevalidation({ plan, outcome: statusOutcome, identityOutcome })
        if (revalidated.kind !== 'planned') return false
        const observed = admitRuntimeServiceObservation({ plan: revalidated.plan, outcome: await execute(revalidated.plan.step) })
        if (observed.kind !== 'complete') return false
        const current = admitRuntimeServiceHealth({ observation: observed.observation })
        return current.kind === 'complete' && isRuntimeServiceEvidence(current.evidence)
            && current.evidence.stackId === authority.evidence.stackId
            && current.evidence.configSha256 === authority.evidence.configSha256
            && current.evidence.batchId === authority.evidence.batchId
            && current.evidence.projectName === authority.evidence.projectName
            && current.evidence.executableSha256 === authority.evidence.executableSha256
            && current.evidence.service === authority.evidence.service
            && current.evidence.containerId === authority.evidence.containerId
    } catch {
        return false
    }
}

export async function verifyExternalDependency(plan: ExternalDependencyPlan, options: {
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
}): Promise<ExternalDependencyVerification> {
    const authority = planAuthority.get(plan)
    if (authority === undefined || consumedPlans.has(plan) || authority.steps !== plan.steps) {
        return unmeasured('EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE', 'external dependency plan is not authentic or was already consumed', plan.dependency)
    }
    consumedPlans.add(plan)
    const evidenceAuthority = authority.generatedAuthority && authority.expectedIds && authority.stackId ? {
        generatedAuthority: authority.generatedAuthority, expectedIds: authority.expectedIds, stackId: authority.stackId,
    } : undefined
    const plannedRoles = Object.freeze(authority.steps.map(({ role }) => role))
    const completedRoles: string[] = []
    const attemptedRoles: string[] = []
    const unavailable = (code: ExternalDependencyCode, message: string) =>
        issueEvidence(unmeasured(code, message, plan.dependency), authority.purpose, {
            plannedRoles, completedRoles, attemptedRoles,
        }, evidenceAuthority)
    const expiresAt = sandboxDeadline(authority.declaration)
    for (const planned of authority.steps) {
        if (Date.now() > authority.expiresAtMs || expiresAt !== undefined && Date.now() > Date.parse(expiresAt)) {
            return unavailable('EXTERNAL_DEPENDENCY_EXPIRED', 'vendor sandbox evidence expired before execution')
        }
        if (planned.role === 'egress' && authority.declaration.egress_guard !== undefined) {
            if (authority.serviceAuthority === undefined || !await revalidateLocalService(authority.serviceAuthority, options.execute)) {
                return unavailable('EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE', 'local service evidence changed before the egress probe')
            }
        }
        let outcome: ExecuteProbeOutcome
        try { outcome = await options.execute(planned.step) } catch {
            return unavailable('EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE', `executor evidence is unavailable for ${planned.role}`)
        }
        const authenticated = authenticatedExecutionOutcome(outcome, planned.step)
        if (authenticated === undefined) return unavailable('EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE', `executor evidence is not authentic for ${planned.role}`)
        const startedAt = authenticated.receipt && Date.parse(authenticated.receipt.startedAt)
        const finishedAt = authenticated.receipt && Date.parse(authenticated.receipt.finishedAt)
        const now = Date.now()
        if (authenticated.receipt === undefined || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt)
            || startedAt! < authority.issuedAtMs || finishedAt! < startedAt! || finishedAt! > now
            || finishedAt! > authority.expiresAtMs) {
            return unavailable('EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE', `executor evidence is stale or outside the plan window for ${planned.role}`)
        }
        if (authenticated.kind === 'refusal') {
            if (authenticated.execution.started && authenticated.receipt) attemptedRoles.push(planned.role)
            return issueEvidence(Object.freeze({
                kind: 'refusal', dependency: summary(authority.declaration, 'measured'), failedRole: planned.role,
                code: authenticated.code, completedRoles: Object.freeze(completedRoles),
            }), authority.purpose, { plannedRoles, completedRoles, attemptedRoles }, evidenceAuthority)
        }
        completedRoles.push(planned.role)
    }
    return issueEvidence(Object.freeze({ kind: 'complete', dependency: summary(authority.declaration, 'measured'), completedRoles: Object.freeze(completedRoles) }), authority.purpose,
        { plannedRoles, completedRoles, attemptedRoles }, evidenceAuthority)
}

export function projectExternalDependencyProgress(evidence: unknown): Readonly<{
    applied: readonly string[]
    notApplied: readonly string[]
    attempted?: readonly string[]
}> | undefined {
    if (evidence === null || typeof evidence !== 'object') return undefined
    const issued = issuedEvidence.get(evidence) ?? issuedObservations.get(evidence)
    if (!issued) return undefined
    const completed = new Set(issued.completedRoles)
    const attempted = new Set(issued.attemptedRoles)
    return Object.freeze({
        applied: issued.completedRoles,
        notApplied: Object.freeze(issued.plannedRoles.filter((role) => !completed.has(role) && !attempted.has(role))),
        ...(issued.attemptedRoles.length ? { attempted: issued.attemptedRoles } : {}),
    })
}

export function observeExternalDependency(input: {
    readonly evidence: ExternalDependencyVerification
    readonly authority: GeneratedRuntimeAuthority
}): ExternalDependencyObservation | undefined {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return undefined
    let descriptors: PropertyDescriptorMap
    try { descriptors = Object.getOwnPropertyDescriptors(input) } catch { return undefined }
    const keys = ['authority', 'evidence']
    if (Reflect.ownKeys(descriptors).length !== keys.length
        || keys.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]!))) return undefined
    const evidence = descriptors.evidence!.value
    const authority = descriptors.authority?.value
    const envelope = authority && typeof authority === 'object' ? inspectGeneratedRuntimeAuthority(authority as GeneratedRuntimeAuthority) : undefined
    const issued = evidence && typeof evidence === 'object' ? issuedEvidence.get(evidence) : undefined
    if (!evidence || typeof evidence !== 'object' || !issued?.generatedAuthority || issued.generatedAuthority !== authority
        || !envelope || issued.stackId !== envelope.stackId || consumedEvidence.has(evidence)) return undefined
    consumedEvidence.add(evidence)
    const state = evidence.kind === 'complete' ? 'available' : evidence.kind === 'refusal' ? 'failed' : 'unavailable'
    const observation = Object.freeze({
        kind: 'external-dependency-observation' as const,
        stackId: envelope.stackId,
        observedAt: issued.observedAt,
        state,
        ...(evidence.dependency === undefined ? {} : { dependency: evidence.dependency }),
        completedRoles: issued.completedRoles,
        reason: evidence.kind === 'complete' ? 'declared external dependency probes completed'
            : evidence.kind === 'refusal' ? `external dependency probe failed at ${evidence.failedRole}: ${evidence.code}`
            : evidence.message,
    })
    issuedObservations.set(observation, Object.freeze({
        rendered: envelope.rendered,
        topology: envelope.topology,
        sourceSha256: envelope.sourceSha256,
        generation: envelope.generation,
        purpose: issued.purpose,
        plannedRoles: issued.plannedRoles,
        completedRoles: issued.completedRoles,
        attemptedRoles: issued.attemptedRoles,
    }))
    return observation
}

function captureExternalDependencyObservationExpectation(value: unknown): Readonly<{
    stackId: StackId
    sourceSha256: string
    generation: string
    purpose: 'startup' | 'health'
    dependencyId: string
}> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = ['dependencyId', 'generation', 'purpose', 'sourceSha256', 'stackId']
    if (Object.keys(descriptors).sort().join('\0') !== keys.join('\0')
        || Object.values(descriptors).some((descriptor) => !('value' in descriptor) || !descriptor.enumerable)) return undefined
    const dependencyId = descriptors.dependencyId!.value
    const generation = descriptors.generation!.value
    const purpose = descriptors.purpose!.value
    const sourceSha256 = descriptors.sourceSha256!.value
    const stackId = descriptors.stackId!.value
    if (typeof dependencyId !== 'string' || dependencyId.length > 128 || !/^[a-z0-9][a-z0-9-]*$/.test(dependencyId)
        || typeof generation !== 'string' || !/^[a-f0-9]{64}$/.test(generation)
        || purpose !== 'startup' && purpose !== 'health'
        || typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)
        || typeof stackId !== 'string' || !/^stack:[a-f0-9]{64}$/.test(stackId)) return undefined
    return Object.freeze({ dependencyId, generation, purpose, sourceSha256, stackId: stackId as StackId })
}

export function isExternalDependencyObservationProjection(value: unknown, expected?: Readonly<{
    stackId: StackId
    sourceSha256: string
    generation: string
    purpose: 'startup' | 'health'
    dependencyId: string
}>): value is ExternalDependencyObservation {
    if (value === null || typeof value !== 'object') return false
    const issued = issuedObservations.get(value)
    if (!issued) return false
    if (expected === undefined) return true
    const captured = captureExternalDependencyObservationExpectation(expected)
    return captured !== undefined
        && issued.rendered !== null && typeof issued.rendered === 'object'
        && isRuntimeTopologyEvidence(issued.topology)
        && issued.topology.stackId === captured.stackId
        && issued.sourceSha256 === captured.sourceSha256
        && issued.generation === captured.generation
        && issued.purpose === captured.purpose
        && (value as ExternalDependencyObservation).stackId === captured.stackId
        && (value as ExternalDependencyObservation).dependency?.id === captured.dependencyId
}

export function observeExternalDependencies(input: {
    readonly authority: GeneratedRuntimeAuthority
    readonly observations: readonly ExternalDependencyObservation[]
    readonly purpose: 'startup' | 'health'
}): EnvironmentObservation | undefined {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return undefined
    let descriptors: PropertyDescriptorMap
    try { descriptors = Object.getOwnPropertyDescriptors(input) } catch { return undefined }
    const keys = ['authority', 'observations', 'purpose']
    if (Reflect.ownKeys(descriptors).length !== keys.length
        || keys.some((key) => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]!))
        || !Array.isArray(descriptors.observations!.value)) return undefined
    const authority = descriptors.authority!.value
    const purpose = descriptors.purpose!.value
    const envelope = authority && typeof authority === 'object' ? inspectGeneratedRuntimeAuthority(authority as GeneratedRuntimeAuthority) : undefined
    const observations = descriptors.observations!.value as readonly ExternalDependencyObservation[]
    if (!envelope || purpose !== 'startup' && purpose !== 'health'
        || observations.length === 0 || observations.length > 1_024 || new Set(observations).size !== observations.length
        || observations.some((observation) => {
            const issued = issuedObservations.get(observation)
            return !issued || consumedObservations.has(observation) || observation.dependency === undefined
                || issued.rendered !== envelope.rendered || issued.topology !== envelope.topology
                || issued.sourceSha256 !== envelope.sourceSha256 || issued.generation !== envelope.generation
        })) return undefined
    const stackId = observations[0]!.stackId
    const observedIds = observations.map(({ dependency }) => dependency!.id).sort()
    const expectedIds = envelope.declaration.vendors.map(({ id }) => id).sort()
    const purposes = new Set(observations.map((observation) => issuedObservations.get(observation)!.purpose))
    if (stackId !== envelope.stackId || observations.some(({ stackId: candidate }) => candidate !== stackId)
        || purposes.size !== 1 || !purposes.has(purpose) || new Set(observedIds).size !== observations.length
        || JSON.stringify(observedIds) !== JSON.stringify(expectedIds)) return undefined
    observations.forEach((observation) => consumedObservations.add(observation))
    const failed = observations.filter(({ state }) => state === 'failed')
    const unavailable = observations.filter(({ state }) => state === 'unavailable')
    const observedAt = observations.map(({ observedAt }) => observedAt).sort().at(-1)!
    const result = snapshotEnvironmentObservation({
        code: ENVIRONMENT_CODES.EXTERNAL_DEPENDENCIES_UNAVAILABLE,
        owner: mechanism.id,
        stackId,
        source: 'declared external dependencies',
        observed: failed.length > 0
            ? { state: 'failed', reason: failed.map(({ dependency, reason }) => `${dependency!.id}: ${reason}`).join('; '), observedAt }
            : unavailable.length > 0
                ? { state: 'unavailable', reason: unavailable.map(({ dependency, reason }) => `${dependency!.id}: ${reason}`).join('; '), observedAt }
                : { state: 'available', value: observations.map(({ dependency, completedRoles }) => ({ id: dependency!.id, completedRoles })), observedAt },
        expectation: { kind: 'present' },
        applicability: { state: 'required', posture: 'external-dependencies' },
        freshness: { state: 'current' },
        remedy: 'run every declared external dependency verifier against the current stack',
    })
    if (!result) return undefined
    issuedAggregateObservations.set(result, Object.freeze({ issuedAt: Date.now(), purpose }))
    return result
}

export function isExternalDependencyObservation(
    value: unknown,
    purpose?: 'startup' | 'health',
): value is EnvironmentObservation {
    const issued = value !== null && typeof value === 'object' ? issuedAggregateObservations.get(value) : undefined
    return issued !== undefined && (purpose === undefined || issued.purpose === purpose)
}
