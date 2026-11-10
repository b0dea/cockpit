import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { loadCockpitConfig, consumeLoadedConfigProjection, type ConsumedLoadedConfig } from '../config/load.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { type RuntimeEvidenceObservation } from './application/health.js'
import { decodeLifecycleRecord } from './application/lifecycle.js'
import { type ReadinessRefusal } from './application/lifecycle-context.js'
import { type LogObservation, type LogsCommandAdapters } from './application/logs.js'
import { publishLifecycleRecord } from './application/lifecycle-state.js'
import type { LifecycleRunContext } from './application/lifecycle-context.js'
import { type ServiceCommandAdapters, type ServiceObservation } from './application/services.js'
import type { ForegroundProcessInput, ForegroundProcessOutcome } from '../environment-exec/execute.js'
import type { LifecycleRecordValue } from './lifecycle-stage.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { deriveEntrypoints, observeRetainedPortFamily, projectRetainedPortFamilyResult, type PortLeaseProjection } from './ports.js'
import { DOCKER_CLIENT_ENVIRONMENT, ENVIRONMENT_CODES, type ExecutionStep, type LifecycleProgress, type StackId, RefusalError } from './contract.js'
import { loadServedSiblings, servedSiblingVariables } from './sibling-checkouts.js'
import { DeclarationRefusalError, runtimeNotDeclared, serviceNotDeclared } from './declaration.js'
import {
    admitRuntimeServiceHealth,
    revalidateRuntimeService,
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
import { readBoundedFile } from '../bounded-read.js'

const COMPOSE_BYTE_LIMIT = 1_048_576
const DEFAULT_OUTPUT_LIMIT = 1_048_576

interface ReadCommandCompositionInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly sessionId: string
    readonly timeoutMs: number
    readonly outputLimitBytes?: number
    readonly signal?: AbortSignal
    readonly runtimeMeasurementProbeAuthority?: RuntimeMeasurementProbeAuthority
}

interface ReadCommandAdapterComposition {
    readonly logs: LogsCommandAdapters
    readonly services: ServiceCommandAdapters
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

interface StableReadContext {
    readonly run: LifecycleRunContext
    readonly ownComposeAuthority?: Extract<RuntimeAdapterAuthority, { ownComposeFiles: true }>
    readonly configuration: ConsumedLoadedConfig
    readonly namespace: StateNamespace
    readonly cockpitId: string
    readonly stackId: StackId
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
    try {
        const canonicalPath = await realpath(expected)
        if (canonicalPath !== expected) return undefined
        const read = readBoundedFile(canonicalPath, COMPOSE_BYTE_LIMIT)
        if (read.kind !== 'complete') return undefined
        const bytes = read.bytes
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
    const revalidated = await revalidateRuntimeService({
        topology, service, expectedContainerId: containerId,
        execute: (step) => execute(step, signal ? { signal } : undefined),
    })
    return revalidated.kind === 'observed' ? admitRuntimeServiceHealth(revalidated.observation) : undefined
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
    executeForeground?: (input: ForegroundProcessInput, options: { readonly signal?: AbortSignal }) => Promise<ForegroundProcessOutcome>,
): ReadCommandAdapterComposition {
    const input = captureInput(rawInput)

    // `refuse` receives the lifecycle's own refusal, such as an unmeasured runtime, so a caller can
    // report it instead of a generic unavailable context.
    // A service verb may act on a stack whose start stopped part-way: rebuilding the service that
    // failed is how its fixed code gets running. Every other reader needs a started service.
    const prepare = async (signal?: AbortSignal, refuse?: ReadinessRefusal<never>, partial = false): Promise<StableReadContext> => {
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
        const lifecycleRead = await readState(context.namespace.paths.lifecycle(context.stackId))
        if (lifecycleRead.kind !== 'complete') throw new RefusalError('lifecycle state is unavailable')
        const lifecycleValue = decodeLifecycleRecord(lifecycleRead.value, context)?.value
        if (!lifecycleValue) throw new RefusalError('lifecycle state is malformed')
        if (lifecycleValue.teardownComplete) throw new RefusalError('down removed the stack')
        if (lifecycleValue.completedServices.length === 0 && !partial) throw new RefusalError('lifecycle state is malformed')
        // A reader runs as its own command under its own session identity, and the stack belongs to
        // the holder that started it: a gate run after a plain `up` claimed a holder no lease named
        // and saw no stack. So the ports are read as the holder the stack's record names. The
        // retained observation admits that holder only while it holds this checkout's active lease,
        // so a released holder, or one recorded for another checkout, still grants nothing.
        const retained = await observeRetainedPortFamily({ namespace: context.namespace, stackId: context.stackId,
            holderId: lifecycleValue.holderId, checkoutId: context.checkoutId, config: context.ports })
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
        // The record named the holder before the readiness calls; a `down` that marked teardown meanwhile is caught here.
        const confirmedLifecycle = await readState(context.namespace.paths.lifecycle(context.stackId))
        if (confirmedLifecycle.kind !== 'complete' || JSON.stringify(confirmedLifecycle.value) !== JSON.stringify(lifecycleRead.value)) {
            throw new RefusalError('lifecycle state changed during runtime observation')
        }
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
        // The stack interpolates the checkout `use` recorded, so reading it must name the same one.
        const served = await loadServedSiblings(checkoutRoot, configuration.config)
        if (served.kind === 'refusal') throw new RefusalError(served.diagnostic.message)
        const ownComposeAuthority = {
            ownComposeFiles: true as const,
            cockpitId: context.cockpitId,
            stackId: context.stackId,
            portLeaseProjection: ports,
            siblingDirectories: servedSiblingVariables(configuration.config, served.siblings),
        }
        return {
            run: context,
            ownComposeAuthority,
            configuration,
            namespace: context.namespace,
            cockpitId: context.cockpitId,
            stackId: context.stackId,
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

    const observeServices = async (request: { readonly configPath: string }): Promise<ServiceObservation> => {
        if (!input || resolve(request.configPath) !== input.configPath) throw new RefusalError('service configuration path does not match')
        const context = await prepare(input.signal, (diagnostics) => { throw new DeclarationRefusalError(diagnostics[0]!) }, true)
        return {
            topology: context.topology,
            completedServices: context.lifecycle.completedServices,
            // The recorded container is what `up`, `preflight` and `logs` revalidate, so a rebuild that
            // replaced it updates the record rather than leaving the stack looking broken.
            recordContainer: async (service, containerId) => {
                const value = { ...context.lifecycle, completedServices: context.lifecycle.completedServices
                    .map((row) => row.service === service ? { service, containerId } : row) }
                const published = await publishLifecycleRecord(context.run, context.lifecycleRecord, value)
                if ('status' in published) return published.diagnostics
                if (published.kind === 'complete') return []
                return [{ severity: 'error' as const,
                    code: published.kind === 'missing' ? ENVIRONMENT_CODES.STATE_RECORD_MALFORMED : published.code,
                    target: context.namespace.paths.lifecycle(context.stackId).path,
                    message: `the rebuilt container of service ${service} runs, and the stack record could not be updated to it${published.kind === 'missing' ? '' : `: ${published.message}`}`,
                    fix: 'run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config <your cockpit.toml> to record the running containers again' }]
            },
        }
    }

    const services: ServiceCommandAdapters = {
        observe: observeServices,
        execute: (step: ExecutionStep) => execute(step, input?.signal ? { signal: input.signal } : undefined),
        executeForeground: async (planned) => {
            if (!executeForeground) throw new RefusalError('foreground execution is not bound')
            return executeForeground(planned, input?.signal ? { signal: input.signal } : {})
        },
    }

    const logs: LogsCommandAdapters = {
        observe: observeLogs,
        execute: (step: ExecutionStep, options: { readonly signal?: AbortSignal }) => execute(step, options),
        ...(input?.signal ? { signal: input.signal } : {}),
    }
    return { logs, services, environment: { observe: observeEnvironment } }
}
