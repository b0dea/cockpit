import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { loadCockpitConfig, consumeLoadedConfigProjection, type ConsumedLoadedConfig } from '../config/load.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import {
    decodeLifecycleRecord,
    type RuntimeEvidenceObservation,
    type LogObservation,
    type LogsCommandAdapters,
    type ReadinessRefusal,
} from './application.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { deriveEntrypoints, observeRetainedPortFamily, projectRetainedPortFamilyResult, type PortLeaseProjection } from './ports.js'
import { DOCKER_CLIENT_ENVIRONMENT, ENVIRONMENT_CODES, type ExecutionStep, type HolderId, type LifecycleProgress, type StackId, RefusalError } from './contract.js'
import { DeclarationRefusalError, runtimeNotDeclared, serviceNotDeclared } from './declaration.js'
import {
    admitRuntimeServiceHealth,
    admitRuntimeServiceObservation,
    admitRuntimeServiceRevalidation,
    admitRuntimeServiceRevalidationStatus,
    createRuntimeServiceRevalidationPlan,
    type ComposeArtifact,
    type RuntimeServiceEvidence,
    type RuntimeTopologyEvidence,
    type RuntimeMeasurementProbeAuthority,
    type RuntimeAdapterAuthority,
} from './runtime.js'
import { resolveDockerExecutable } from './executable.js'
import {
    STABILITY_CAPTURE_OUTPUT_LIMIT_BYTES,
    authenticateStabilityCapture,
    captureRuntimeEvidence,
    createEnvironmentSnapshot,
    createStabilityCapturePlan,
    type JsonValue,
} from './evidence.js'
import { readState, type StateNamespace, type StateRecord } from './state.js'

const COMPOSE_BYTE_LIMIT = 1_048_576
const DEFAULT_OUTPUT_LIMIT = 1_048_576

export interface ReadCommandCompositionInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly sessionId: string
    readonly timeoutMs: number
    readonly outputLimitBytes?: number
    readonly signal?: AbortSignal
    readonly runtimeMeasurementProbeAuthority?: RuntimeMeasurementProbeAuthority
}

export interface ReadCommandAdapterComposition {
    readonly logs: LogsCommandAdapters
    readonly environment: Readonly<{ observe: (input: { readonly configPath: string }) => Promise<RuntimeEvidenceObservation> }>
}

type Executor = (
    step: ExecutionStep,
    options?: { readonly signal?: AbortSignal },
) => Promise<ExecuteProbeOutcome>

interface CapturedInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly sessionId: string
    readonly timeoutMs: number
    readonly outputLimitBytes: number
    readonly signal?: AbortSignal
    readonly runtimeMeasurementProbeAuthority?: RuntimeMeasurementProbeAuthority
}

interface LifecycleRecordValue extends LifecycleProgress {
    readonly holderId: string
}

interface StableReadContext {
    readonly ownComposeAuthority?: Extract<RuntimeAdapterAuthority, { ownComposeFiles: true }>
    readonly configuration: ConsumedLoadedConfig
    readonly namespace: StateNamespace
    readonly cockpitId: string
    readonly stackId: StackId
    readonly holderId: HolderId
    readonly topology: RuntimeTopologyEvidence
    readonly lifecycleRecord: StateRecord
    readonly lifecycle: LifecycleRecordValue
    readonly executable: Awaited<ReturnType<typeof resolveDockerExecutable>> & { readonly state: 'available' }
    readonly composeFiles: readonly ComposeArtifact[]
    readonly env: Readonly<Record<string, string>>
}

function freezeJson(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(freezeJson)
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeJson(child)]))
    }
    return value
}

function captureInput(value: ReadCommandCompositionInput): CapturedInput | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const required = ['configPath', 'env', 'sessionId', 'timeoutMs']
        const optional = ['outputLimitBytes', 'signal', 'runtimeMeasurementProbeAuthority']
        const keys = Reflect.ownKeys(descriptors)
        if (keys.some((key) => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))
            || required.some((key) => !descriptors[key] || !('value' in descriptors[key]!))
            || keys.some((key) => typeof key === 'string' && !('value' in descriptors[key]!))) return undefined
        const configPath = descriptors.configPath!.value
        const rawEnvironment = descriptors.env!.value
        const sessionId = descriptors.sessionId!.value
        const timeoutMs = descriptors.timeoutMs!.value
        const outputLimitBytes = descriptors.outputLimitBytes?.value ?? DEFAULT_OUTPUT_LIMIT
        const signal = descriptors.signal?.value
        const runtimeMeasurementProbeAuthority = descriptors.runtimeMeasurementProbeAuthority?.value
        if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0')
            || typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.includes('\0')
            || typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
            || typeof outputLimitBytes !== 'number' || !Number.isSafeInteger(outputLimitBytes) || outputLimitBytes < 1 || outputLimitBytes > 16_777_216
            || signal !== undefined && !(signal instanceof AbortSignal)
            || !rawEnvironment || typeof rawEnvironment !== 'object' || Array.isArray(rawEnvironment)) return undefined
        const env: Record<string, string | undefined> = {}
        for (const [name, entry] of Object.entries(rawEnvironment as Record<string, unknown>)) {
            if (name.length === 0 || name.includes('\0') || name.includes('=')
                || entry !== undefined && (typeof entry !== 'string' || entry.includes('\0'))) return undefined
            env[name] = entry
        }
        return {
            configPath: resolve(configPath),
            env,
            sessionId,
            timeoutMs,
            outputLimitBytes,
            ...(signal ? { signal } : {}),
            ...(runtimeMeasurementProbeAuthority === undefined ? {} : { runtimeMeasurementProbeAuthority }),
        }
    } catch { // A throwing accessor or proxy trap makes the input malformed; the caller refuses it.
        return undefined
    }
}

function runtimeEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
    return Object.fromEntries(Object.entries(env)
        .filter((entry): entry is [string, string] => DOCKER_CLIENT_ENVIRONMENT.has(entry[0]) && typeof entry[1] === 'string'))
}

function confined(root: string, path: string): boolean {
    const relation = relative(root, path)
    return relation === '' || relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

async function composeArtifact(root: string, reference: string): Promise<ComposeArtifact | undefined> {
    if (typeof reference !== 'string' || reference.length === 0 || reference.includes('\0')) return undefined
    const expected = resolve(root, reference)
    if (!confined(root, expected)) return undefined
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        const canonicalPath = await realpath(expected)
        if (canonicalPath !== expected) return undefined
        const before = await lstat(canonicalPath)
        if (!before.isFile() || before.isSymbolicLink() || before.size > COMPOSE_BYTE_LIMIT) return undefined
        handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > COMPOSE_BYTE_LIMIT) return undefined
        const bytes = await handle.readFile()
        const after = await handle.stat()
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return undefined
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return {
            reference,
            canonicalPath,
            source,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        }
    } catch {
        // An artifact that cannot be read carries no authority; callers refuse it as unavailable compose artifacts.
        return undefined
    } finally {
        try { await handle?.close() } catch { /* An unreadable artifact carries no authority. */ }
    }
}

async function composeArtifacts(root: string, references: readonly string[]): Promise<readonly ComposeArtifact[] | undefined> {
    const artifacts: ComposeArtifact[] = []
    for (const reference of references) {
        const artifact = await composeArtifact(root, reference)
        if (!artifact) return undefined
        artifacts.push(artifact)
    }
    return artifacts.length > 0 ? artifacts : undefined
}

function sameSource(left: { readonly path: string; readonly byteLength: number; readonly sha256: string }, right: typeof left): boolean {
    return left.path === right.path && left.byteLength === right.byteLength && left.sha256 === right.sha256
}

async function authenticateService(
    topology: RuntimeTopologyEvidence,
    service: string,
    containerId: string,
    execute: Executor,
    signal?: AbortSignal,
): Promise<RuntimeServiceEvidence | undefined> {
    const plan = createRuntimeServiceRevalidationPlan({ topology, service, expectedContainerId: containerId })
    if (plan.kind !== 'planned') return undefined
    const status = await execute(plan.status, signal ? { signal } : undefined)
    if (admitRuntimeServiceRevalidationStatus({ plan, outcome: status }).kind !== 'admitted') return undefined
    const identity = await execute(plan.identity, signal ? { signal } : undefined)
    const revalidated = admitRuntimeServiceRevalidation({ plan, outcome: status, identityOutcome: identity })
    if (revalidated.kind !== 'planned') return undefined
    const inspected = admitRuntimeServiceObservation({
        plan: revalidated.plan,
        outcome: await execute(revalidated.plan.step, signal ? { signal } : undefined),
    })
    if (inspected.kind !== 'complete') return undefined
    const healthy = admitRuntimeServiceHealth({ observation: inspected.observation })
    return healthy.kind === 'complete' ? healthy.evidence : undefined
}

function exactCompletedTopology(context: StableReadContext): boolean {
    const topologyServices = context.topology.services.map(({ id }) => id).sort()
    const completedServices = context.lifecycle.completedServices.map(({ service }) => service).sort()
    return topologyServices.length === completedServices.length
        && topologyServices.every((service, index) => service === completedServices[index])
}

export function createReadCommandAdapters(
    rawInput: ReadCommandCompositionInput,
    execute: Executor,
): ReadCommandAdapterComposition {
    const input = captureInput(rawInput)

    // `refuse` receives the lifecycle's own refusal, such as an unmeasured runtime, so a caller can
    // report it instead of a generic unavailable context.
    const prepare = async (signal?: AbortSignal, refuse?: ReadinessRefusal<never>): Promise<StableReadContext> => {
        if (!input || typeof execute !== 'function') throw new RefusalError('read command composition is unavailable')
        const lifecycle = createLifecycleCommandAdapters({
            configPath: input.configPath,
            env: input.env,
            sessionId: input.sessionId,
            timeoutMs: input.timeoutMs,
            ...(input.runtimeMeasurementProbeAuthority === undefined ? {} : {
                runtimeMeasurementProbeAuthority: input.runtimeMeasurementProbeAuthority,
            }),
        }, (step) => execute(step, signal ? { signal } : undefined))
        const loaded = await lifecycle.load({ configPath: input.configPath })
        if (loaded.kind === 'refusal' && loaded.diagnostics.some(({ code }) => code === ENVIRONMENT_CODES.ENVIRONMENT_NOT_DECLARED)) {
            throw new DeclarationRefusalError(runtimeNotDeclared(input.configPath))
        }
        if (loaded.kind !== 'complete') {
            if (refuse && loaded.diagnostics.length > 0) refuse(loaded.diagnostics)
            throw new RefusalError('authenticated lifecycle context is unavailable')
        }
        const context = loaded.result
        const configurationResult = await loadCockpitConfig(input.configPath)
        if (configurationResult.kind !== 'complete') throw new RefusalError('configuration projection is unavailable')
        const configuration = consumeLoadedConfigProjection(configurationResult.result)
        if (!configuration || !sameSource(context.source, configuration.source)) {
            throw new RefusalError('configuration authority does not match')
        }
        const checkoutRoot = dirname(configuration.source.path)
        const references = configuration.config.environment.compose_files
        const composeFiles = await composeArtifacts(checkoutRoot, references)
        if (!composeFiles) throw new RefusalError('compose artifacts are unavailable')
        const retained = await observeRetainedPortFamily({ namespace: context.namespace, stackId: context.stackId,
            holderId: context.holderId, checkoutId: context.checkoutId, config: context.ports })
        if (retained.kind !== 'complete') throw new RefusalError('retained port authority is unavailable')
        const entrypoints = deriveEntrypoints({ lease: retained.lease, declarations: context.entrypointDerivatives })
        const ports: PortLeaseProjection | undefined = await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })
        if (!ports) throw new RefusalError('retained port projection is unavailable')
        const readiness = await lifecycle.withRuntimeReadiness(context, async (value) => value, ports, refuse)
        if (!readiness) throw new RefusalError('authenticated runtime topology is unavailable')
        if (readiness.topology.cwd !== checkoutRoot
            || readiness.topology.stackId !== context.stackId
            || readiness.topology.configSha256 !== context.runtimeSha256) {
            throw new RefusalError('configuration and runtime authority do not match')
        }
        const lifecycleRead = await readState(context.namespace.paths.lifecycle(context.stackId))
        if (lifecycleRead.kind !== 'complete') throw new RefusalError('lifecycle state is unavailable')
        const lifecycleValue = decodeLifecycleRecord(lifecycleRead.value, context)?.value
        if (!lifecycleValue || lifecycleValue.completedServices.length === 0) throw new RefusalError('lifecycle state is malformed')
        if (lifecycleValue.holderId !== context.holderId) throw new RefusalError('lifecycle holder authority changed')
        const env = runtimeEnvironment(input.env)
        const executable = await resolveDockerExecutable(input.env)
        if (executable.state !== 'available') {
            throw new RefusalError(`runtime executable authority changed: ${executable.reason}`)
        }
        if (executable.value.sha256 !== readiness.topology.executableSha256) {
            throw new RefusalError('runtime executable authority changed')
        }
        const confirmedComposeFiles = await composeArtifacts(checkoutRoot, references)
        if (!confirmedComposeFiles || JSON.stringify(confirmedComposeFiles) !== JSON.stringify(composeFiles)) {
            throw new RefusalError('compose artifacts changed during runtime observation')
        }
        const ownComposeAuthority = {
            ownComposeFiles: true as const,
            cockpitId: context.cockpitId,
            stackId: context.stackId,
            portLeaseProjection: ports,
            siblingDirectories: Object.fromEntries(configuration.config.sibling.map((sibling) => [
                sibling.var,
                resolve(checkoutRoot, configuration.config.cockpit.siblings_root, sibling.dir),
            ])),
        }
        return {
            ownComposeAuthority,
            configuration,
            namespace: context.namespace,
            cockpitId: context.cockpitId,
            stackId: context.stackId,
            holderId: context.holderId,
            topology: readiness.topology,
            lifecycleRecord: lifecycleRead.value,
            lifecycle: lifecycleValue,
            executable,
            composeFiles,
            env,
        }
    }

    const observeLogs = async (request: { readonly configPath: string; readonly service: string }): Promise<LogObservation> => {
        if (!input || resolve(request.configPath) !== input.configPath) throw new RefusalError('log configuration path does not match')
        const context = await prepare(input.signal, (diagnostics) => { throw new DeclarationRefusalError(diagnostics[0]!) })
        const declared = context.topology.services.map(({ id }) => id)
        if (!declared.includes(request.service)) throw new DeclarationRefusalError(serviceNotDeclared(request.service, declared))
        const completed = context.lifecycle.completedServices.find(({ service }) => service === request.service)
        if (!completed) {
            throw new RefusalError('requested service is not in the selected running stack')
        }
        const evidence = await authenticateService(context.topology, completed.service, completed.containerId, execute, input.signal)
        if (!evidence) throw new RefusalError('requested service identity is unavailable')
        const after = await readState(context.namespace.paths.lifecycle(context.stackId))
        if (after.kind !== 'complete' || JSON.stringify(after.value) !== JSON.stringify(context.lifecycleRecord)) {
            throw new RefusalError('lifecycle state changed during log observation')
        }
        return {
            ownComposeAuthority: context.ownComposeAuthority,
            request: {
                runtime: 'docker-compose' as const,
                executable: context.executable.value,
                cwd: context.topology.cwd,
                stackId: context.stackId,
                configSha256: context.configuration.runtimeSha256,
                batchId: context.topology.batchId,
                containerId: evidence.containerId,
                runtimeVersion: context.topology.runtimeVersion,
                composeVersion: context.topology.composeVersion,
                projectName: context.topology.projectName,
                composeFiles: context.composeFiles,
                services: context.topology.services.map(({ id }) => id),
                service: request.service,
                timeoutMs: input.timeoutMs,
                outputLimitBytes: input.outputLimitBytes,
                env: context.env,
            },
        }
    }

    const observeEnvironment = async (request: { readonly configPath: string }): Promise<RuntimeEvidenceObservation> => {
        if (!input || resolve(request.configPath) !== input.configPath) throw new RefusalError('environment configuration path does not match')
        const context = await prepare()
        if (!exactCompletedTopology(context)) {
            throw new RefusalError('a complete stable runtime cohort is unavailable')
        }
        let evidenceSubject: RuntimeServiceEvidence | undefined
        for (const completed of context.lifecycle.completedServices) {
            const service = await authenticateService(context.topology, completed.service, completed.containerId, execute)
            if (!service) throw new RefusalError('runtime service cohort changed')
            evidenceSubject = service
        }
        if (!evidenceSubject) throw new RefusalError('runtime evidence subject is unavailable')
        const createdAt = new Date().toISOString()
        const capturePlan = createStabilityCapturePlan({
            stackId: context.stackId,
            configSha256: context.configuration.runtimeSha256,
            runtimeExecutable: context.executable.value,
            cwd: context.topology.cwd,
            env: Object.fromEntries(Object.entries(context.env).filter(([name]) => name === 'PATH')),
            containerId: evidenceSubject.containerId,
            batchId: context.topology.batchId,
            runtime: { name: 'docker', version: context.topology.runtimeVersion },
            contentPaths: ['/proc/1/exe'],
            timeoutMs: input.timeoutMs,
            outputLimitBytes: STABILITY_CAPTURE_OUTPUT_LIMIT_BYTES,
        })
        if (capturePlan.kind !== 'preview' || capturePlan.plan.steps.length !== 2) {
            const reason = capturePlan.diagnostics.map(({ message }) => message).join('; ')
            throw new RefusalError(`runtime evidence capture plan is unavailable: ${reason || 'the plan does not hold two capture steps'}`)
        }
        const results = []
        for (const step of capturePlan.plan.steps) results.push(await execute(step))
        const authenticated = authenticateStabilityCapture({
            plan: capturePlan,
            results: results as [ExecuteProbeOutcome, ExecuteProbeOutcome],
        })
        if ('state' in authenticated) {
            throw new RefusalError(`runtime evidence capture is unavailable: ${authenticated.reason} (${authenticated.code})`)
        }
        const evidence = captureRuntimeEvidence({ capture: authenticated })
        if (evidence.state !== 'available') throw new RefusalError(`runtime evidence is unavailable: ${evidence.reason}`)
        const after = await readState(context.namespace.paths.lifecycle(context.stackId))
        if (after.kind !== 'complete' || JSON.stringify(after.value) !== JSON.stringify(context.lifecycleRecord)) {
            throw new RefusalError('lifecycle state changed during environment observation')
        }
        const snapshot = createEnvironmentSnapshot({
            stackId: context.stackId,
            configSha256: context.configuration.runtimeSha256,
            createdAt,
            creationSource: 'resolved-config',
            intendedState: context.configuration.config as unknown as JsonValue,
        })
        const ownedSnapshot = { ...snapshot, intendedState: freezeJson(snapshot.intendedState) }
        const ownedEvidence = {
            ...evidence,
            runtime: { ...evidence.runtime },
            command: {
                ...evidence.command,
                stepIds: [...evidence.command.stepIds] as unknown as readonly [string, string],
            },
            observedBytes: { ...evidence.observedBytes },
            stability: { ...evidence.stability },
        }
        return { snapshot: ownedSnapshot, evidence: ownedEvidence }
    }

    const logs: LogsCommandAdapters = {
        observe: observeLogs,
        execute: (step: ExecutionStep, options: { readonly signal?: AbortSignal }) => execute(step, options),
        ...(input?.signal ? { signal: input.signal } : {}),
    }
    return { logs, environment: { observe: observeEnvironment } }
}
