import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { loadCockpitConfig, consumeLoadedConfigProjection, type ConsumedLoadedConfig } from '../config/load.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import {
    decodeLifecycleRecord,
    type BaselineCommandAdapters,
    type BaselineObservation,
    type LogObservation,
    type LogsCommandAdapters,
} from './application.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import type { GeneratedComposeArtifactAuthority } from './generated-stack.js'
import { deriveEntrypoints, observeRetainedPortFamily, projectRetainedPortFamilyResult, type PortLeaseProjection } from './ports.js'
import { ENVIRONMENT_CODES, type ExecutionStep, type HolderId, type LifecycleProgress, type StackId } from './contract.js'
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
    authenticateStabilityCapture,
    captureRuntimeEvidence,
    createEnvironmentSnapshot,
    createStabilityCapturePlan,
    environmentBaselineConfirmation,
    isEnvironmentBaselineAuthentic,
    type EnvironmentBaseline,
    type JsonValue,
} from './evidence.js'
import {
    abortStateTransaction,
    readState,
    transactState,
    type StateNamespace,
    type StateRecord,
} from './state.js'

export const mechanism = {
    id: 'read-command-composition',
    module: 'packages/cockpit/src/environment/read-composition.ts',
    exports: ['createReadCommandAdapters'],
} as const

const COMPOSE_BYTE_LIMIT = 1_048_576
const DEFAULT_OUTPUT_LIMIT = 1_048_576
const SAFE_RUNTIME_ENV = new Set(['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])

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
    readonly baseline: BaselineCommandAdapters & {
        readonly revalidate: (observation: BaselineObservation) => Promise<BaselineObservation>
    }
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
    readonly generatedComposeAuthority?: GeneratedComposeArtifactAuthority
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

interface PendingBaseline {
    readonly stackId: StackId
    readonly namespace: StateNamespace
    readonly cockpitId: string
    readonly holderId: HolderId
    readonly address: ReturnType<StateNamespace['paths']['baseline']>
    readonly expected: StateRecord | null
    readonly configSha256: string
    readonly snapshotSha256: string
    readonly evidenceSha256: string
    readonly fingerprint: Readonly<{
        source: string
        runtime: string
        cohort: string
        predecessor: string
        stability: string
    }>
}

interface BaselineMeasurement {
    readonly observation: BaselineObservation
    readonly basis: PendingBaseline
}

function freezeJson(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return Object.freeze(value.map(freezeJson))
    if (value !== null && typeof value === 'object') {
        return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeJson(child)])))
    }
    return value
}

function freezeBaseline(baseline: EnvironmentBaseline): EnvironmentBaseline {
    return Object.freeze({
        ...baseline,
        snapshot: Object.freeze({
            ...baseline.snapshot,
            intendedState: freezeJson(baseline.snapshot.intendedState),
        }),
        evidence: Object.freeze({
            ...baseline.evidence,
            runtime: Object.freeze({ ...baseline.evidence.runtime }),
            command: Object.freeze({
                ...baseline.evidence.command,
                stepIds: Object.freeze([...baseline.evidence.command.stepIds]) as unknown as readonly [string, string],
            }),
            observedBytes: Object.freeze({ ...baseline.evidence.observedBytes }),
            stability: Object.freeze({ ...baseline.evidence.stability }),
        }),
    })
}

function baselineRevalidationFailure(error: unknown): TypeError {
    const reason = error instanceof TypeError ? error.message : ''
    if (['configuration projection is unavailable', 'configuration authority does not match',
        'configuration and runtime authority do not match', 'compose artifacts are unavailable',
        'compose artifacts changed during runtime observation'].includes(reason)) {
        return new TypeError('baseline config source changed')
    }
    if (['authenticated runtime topology is unavailable', 'runtime executable authority changed'].includes(reason)) {
        return new TypeError('baseline runtime topology changed')
    }
    if (['a complete stable runtime cohort is unavailable', 'runtime service cohort changed',
        'runtime evidence subject is unavailable', 'lifecycle state changed during baseline observation'].includes(reason)) {
        return new TypeError('baseline runtime cohort changed')
    }
    if (['previous baseline is unavailable', 'previous baseline is malformed'].includes(reason)) {
        return new TypeError('baseline previous baseline changed')
    }
    if (['runtime evidence capture plan is unavailable', 'runtime evidence capture is unavailable',
        'runtime evidence is unavailable'].includes(reason)) {
        return new TypeError('baseline runtime stability changed')
    }
    return new TypeError('baseline revalidation is unavailable')
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
        return Object.freeze({
            configPath: resolve(configPath),
            env: Object.freeze(env),
            sessionId,
            timeoutMs,
            outputLimitBytes,
            ...(signal ? { signal } : {}),
            ...(runtimeMeasurementProbeAuthority === undefined ? {} : { runtimeMeasurementProbeAuthority }),
        })
    } catch {
        return undefined
    }
}

function runtimeEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(Object.entries(env)
        .filter((entry): entry is [string, string] => SAFE_RUNTIME_ENV.has(entry[0]) && typeof entry[1] === 'string')))
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
        return Object.freeze({
            reference,
            canonicalPath,
            source,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        })
    } catch {
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
    return artifacts.length > 0 ? Object.freeze(artifacts) : undefined
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

function baselineRecord(value: unknown, context: StableReadContext): EnvironmentBaseline | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const candidate = value as Partial<EnvironmentBaseline>
    if (candidate.artifact !== 'environment-baseline' || candidate.schemaVersion !== 1
        || candidate.stackId !== context.stackId || candidate.snapshot === undefined || candidate.evidence === undefined) return undefined
    const baseline = value as EnvironmentBaseline
    return environmentBaselineConfirmation(baseline.snapshot, baseline.evidence, baseline) === '' ? undefined : baseline
}

export function createReadCommandAdapters(
    rawInput: ReadCommandCompositionInput,
    execute: Executor,
): ReadCommandAdapterComposition {
    const input = captureInput(rawInput)
    const pending = new Map<string, PendingBaseline>()
    const previews = new WeakMap<object, PendingBaseline>()
    const latestPreviews = new Map<string, PendingBaseline>()

    const prepare = async (signal?: AbortSignal): Promise<StableReadContext> => {
        if (!input || typeof execute !== 'function') throw new TypeError('read command composition is unavailable')
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
        if (loaded.kind !== 'complete') throw new TypeError('authenticated lifecycle context is unavailable')
        const context = loaded.result
        const configurationResult = await loadCockpitConfig(input.configPath)
        if (configurationResult.kind !== 'complete') throw new TypeError('configuration projection is unavailable')
        const configuration = consumeLoadedConfigProjection(configurationResult.result)
        if (!configuration || !sameSource(context.source, configuration.source)) {
            throw new TypeError('configuration authority does not match')
        }
        const checkoutRoot = dirname(configuration.source.path)
        const generated = configuration.config.environment.generated
        const references = generated ? [generated.compose_file] : configuration.config.environment.compose_files
        const composeFiles = await composeArtifacts(checkoutRoot, references)
        if (!composeFiles) throw new TypeError('compose artifacts are unavailable')
        const retained = await observeRetainedPortFamily({ namespace: context.namespace, stackId: context.stackId,
            holderId: context.holderId, checkoutId: context.checkoutId, config: context.ports })
        if (retained.kind !== 'complete') throw new TypeError('retained port authority is unavailable')
        const entrypoints = deriveEntrypoints({ lease: retained.lease, declarations: context.entrypointDerivatives })
        const ports: PortLeaseProjection | undefined = await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })
        if (!ports) throw new TypeError('retained port projection is unavailable')
        const readiness = await lifecycle.withRuntimeReadiness(context, async (value) => value, ports)
        if (!readiness) throw new TypeError('authenticated runtime topology is unavailable')
        const generatedApplication = generated ? await lifecycle.withGeneratedRuntime(context, readiness,
            async ({ application }) => application) : undefined
        const generatedComposeAuthority = generatedApplication?.generatedComposeAuthority
        if (generated && !generatedComposeAuthority) throw new TypeError('generated runtime authority is unavailable')
        if (readiness.topology.cwd !== checkoutRoot
            || readiness.topology.stackId !== context.stackId
            || readiness.topology.configSha256 !== context.runtimeSha256) {
            throw new TypeError('configuration and runtime authority do not match')
        }
        const lifecycleRead = await readState(context.namespace.paths.lifecycle(context.stackId))
        if (lifecycleRead.kind !== 'complete') throw new TypeError('lifecycle state is unavailable')
        const lifecycleValue = decodeLifecycleRecord(lifecycleRead.value, context)?.value
        if (!lifecycleValue || lifecycleValue.completedServices.length === 0) throw new TypeError('lifecycle state is malformed')
        if (lifecycleValue.holderId !== context.holderId) throw new TypeError('lifecycle holder authority changed')
        if (generatedApplication && !isDeepStrictEqual(lifecycleValue.generatedReplay, {
            runtimeSha256: generatedApplication.runtimeSha256, generation: generatedApplication.generation,
            profiles: generatedApplication.profiles, mounts: generatedApplication.mounts,
        })) throw new TypeError('generated lifecycle replay authority changed')
        const env = runtimeEnvironment(input.env)
        const executable = await resolveDockerExecutable(input.env)
        if (executable.state !== 'available') {
            throw new TypeError(`runtime executable authority changed: ${executable.reason}`)
        }
        if (executable.value.sha256 !== readiness.topology.executableSha256) {
            throw new TypeError('runtime executable authority changed')
        }
        const confirmedComposeFiles = await composeArtifacts(checkoutRoot, references)
        if (!confirmedComposeFiles || JSON.stringify(confirmedComposeFiles) !== JSON.stringify(composeFiles)) {
            throw new TypeError('compose artifacts changed during runtime observation')
        }
        const ownComposeAuthority = generated ? undefined : Object.freeze({
            ownComposeFiles: true as const,
            cockpitId: context.cockpitId,
            stackId: context.stackId,
            portLeaseProjection: ports,
            siblingDirectories: Object.freeze(Object.fromEntries(configuration.config.sibling.map((sibling) => [
                sibling.var,
                resolve(checkoutRoot, configuration.config.cockpit.siblings_root, sibling.dir),
            ]))),
        })
        return Object.freeze({
            ...(generatedComposeAuthority ? { generatedComposeAuthority } : {}),
            ...(ownComposeAuthority ? { ownComposeAuthority } : {}),
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
        })
    }

    const observeLogs = async (request: { readonly configPath: string; readonly service: string }): Promise<LogObservation> => {
        if (!input || resolve(request.configPath) !== input.configPath) throw new TypeError('log configuration path does not match')
        const context = await prepare(input.signal)
        const declared = context.topology.services.map(({ id }) => id)
        if (!declared.includes(request.service)) throw new DeclarationRefusalError(serviceNotDeclared(request.service, declared))
        const completed = context.lifecycle.completedServices.find(({ service }) => service === request.service)
        if (!completed) {
            throw new TypeError('requested service is not in the selected running stack')
        }
        const evidence = await authenticateService(context.topology, completed.service, completed.containerId, execute, input.signal)
        if (!evidence) throw new TypeError('requested service identity is unavailable')
        const after = await readState(context.namespace.paths.lifecycle(context.stackId))
        if (after.kind !== 'complete' || JSON.stringify(after.value) !== JSON.stringify(context.lifecycleRecord)) {
            throw new TypeError('lifecycle state changed during log observation')
        }
        return Object.freeze({
            ...(context.generatedComposeAuthority ? { generatedComposeAuthority: context.generatedComposeAuthority } : {}),
            ...(context.ownComposeAuthority ? { ownComposeAuthority: context.ownComposeAuthority } : {}),
            request: Object.freeze({
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
                services: Object.freeze(context.topology.services.map(({ id }) => id)),
                service: request.service,
                timeoutMs: input.timeoutMs,
                outputLimitBytes: input.outputLimitBytes,
                env: context.env,
            }),
        })
    }

    const measureBaseline = async (): Promise<BaselineMeasurement> => {
        if (!input) throw new TypeError('baseline command composition is unavailable')
        const context = await prepare()
        if (!exactCompletedTopology(context)) {
            throw new TypeError('a complete stable runtime cohort is unavailable')
        }
        let evidenceSubject: RuntimeServiceEvidence | undefined
        const cohort: Readonly<{ readonly service: string; readonly containerId: string }>[] = []
        for (const completed of context.lifecycle.completedServices) {
            const service = await authenticateService(context.topology, completed.service, completed.containerId, execute)
            if (!service) throw new TypeError('runtime service cohort changed')
            evidenceSubject = service
            cohort.push(Object.freeze({ service: completed.service, containerId: service.containerId }))
        }
        if (!evidenceSubject) throw new TypeError('runtime evidence subject is unavailable')
        const createdAt = new Date().toISOString()
        const capturePlan = createStabilityCapturePlan({
            stackId: context.stackId,
            configSha256: context.configuration.runtimeSha256,
            runtimeExecutable: context.executable.value,
            cwd: context.topology.cwd,
            env: Object.freeze(Object.fromEntries(Object.entries(context.env).filter(([name]) => name === 'PATH'))),
            containerId: evidenceSubject.containerId,
            batchId: context.topology.batchId,
            runtime: Object.freeze({ name: 'docker', version: context.topology.runtimeVersion }),
            contentPaths: Object.freeze(['/proc/1/exe']),
            timeoutMs: input.timeoutMs,
            outputLimitBytes: input.outputLimitBytes,
        })
        if (capturePlan.kind !== 'preview' || capturePlan.plan.steps.length !== 2) {
            throw new TypeError('runtime evidence capture plan is unavailable')
        }
        const results = []
        for (const step of capturePlan.plan.steps) results.push(await execute(step))
        const authenticated = authenticateStabilityCapture({
            plan: capturePlan,
            results: results as [ExecuteProbeOutcome, ExecuteProbeOutcome],
        })
        if ('state' in authenticated) throw new TypeError('runtime evidence capture is unavailable')
        const evidence = captureRuntimeEvidence({ capture: authenticated })
        if (evidence.state !== 'available') throw new TypeError('runtime evidence is unavailable')
        const after = await readState(context.namespace.paths.lifecycle(context.stackId))
        if (after.kind !== 'complete' || JSON.stringify(after.value) !== JSON.stringify(context.lifecycleRecord)) {
            throw new TypeError('lifecycle state changed during baseline observation')
        }
        const address = context.namespace.paths.baseline(context.stackId)
        const prior = await readState(address)
        if (prior.kind !== 'complete' && prior.kind !== 'missing') throw new TypeError('previous baseline is unavailable')
        const previous = prior.kind === 'complete' ? baselineRecord(prior.value.value, context) : undefined
        if (prior.kind === 'complete' && !previous) throw new TypeError('previous baseline is malformed')
        const snapshot = createEnvironmentSnapshot({
            stackId: context.stackId,
            configSha256: context.configuration.runtimeSha256,
            createdAt,
            creationSource: 'resolved-config',
            intendedState: context.configuration.config as unknown as JsonValue,
        })
        const ownedSnapshot = Object.freeze({ ...snapshot, intendedState: freezeJson(snapshot.intendedState) })
        const ownedEvidence = Object.freeze({
            ...evidence,
            runtime: Object.freeze({ ...evidence.runtime }),
            command: Object.freeze({
                ...evidence.command,
                stepIds: Object.freeze([...evidence.command.stepIds]) as unknown as readonly [string, string],
            }),
            observedBytes: Object.freeze({ ...evidence.observedBytes }),
            stability: Object.freeze({ ...evidence.stability }),
        })
        const observation = Object.freeze({
            snapshot: ownedSnapshot,
            evidence: ownedEvidence,
            ...(previous ? { previous: freezeBaseline(previous) } : {}),
        })
        const basis = Object.freeze({
            stackId: context.stackId,
            namespace: context.namespace,
            cockpitId: context.cockpitId,
            holderId: context.holderId,
            address,
            expected: prior.kind === 'complete' ? prior.value : null,
            configSha256: context.configuration.runtimeSha256,
            snapshotSha256: snapshot.snapshotSha256,
            evidenceSha256: evidence.evidenceSha256,
            fingerprint: Object.freeze({
                source: JSON.stringify(context.configuration.source),
                runtime: JSON.stringify({
                    stackId: context.topology.stackId,
                    configSha256: context.topology.configSha256,
                    batchId: context.topology.batchId,
                    runtimeVersion: context.topology.runtimeVersion,
                    composeVersion: context.topology.composeVersion,
                    executableSha256: context.topology.executableSha256,
                    projectName: context.topology.projectName,
                    cwd: context.topology.cwd,
                    services: context.topology.services,
                    composeFiles: context.composeFiles.map(({ reference, canonicalPath, sha256 }) => ({ reference, canonicalPath, sha256 })),
                }),
                cohort: JSON.stringify({ lifecycle: context.lifecycleRecord, services: cohort }),
                predecessor: JSON.stringify(prior.kind === 'complete' ? prior.value : null),
                stability: JSON.stringify({
                    stackId: evidence.stackId,
                    configSha256: evidence.configSha256,
                    runtime: evidence.runtime,
                    batchId: evidence.command.batchId,
                    containerId: evidence.command.containerId,
                    stability: evidence.stability,
                }),
            }),
        })
        return Object.freeze({ observation, basis })
    }

    const observeBaseline = async (request: { readonly configPath: string }): Promise<BaselineObservation> => {
        if (!input || resolve(request.configPath) !== input.configPath) throw new TypeError('baseline configuration path does not match')
        const measured = await measureBaseline()
        pending.delete(measured.basis.stackId)
        latestPreviews.set(measured.basis.stackId, measured.basis)
        previews.set(measured.observation, measured.basis)
        return measured.observation
    }

    const revalidateBaseline = async (observation: BaselineObservation): Promise<BaselineObservation> => {
        const basis = observation && typeof observation === 'object' ? previews.get(observation) : undefined
        if (!basis) {
            throw new TypeError('baseline preview authority is unavailable')
        }
        previews.delete(observation)
        if (latestPreviews.get(basis.stackId) !== basis) {
            throw new TypeError('baseline preview authority is unavailable')
        }
        latestPreviews.delete(basis.stackId)
        pending.delete(basis.stackId)
        let fresh: BaselineMeasurement
        try {
            fresh = await measureBaseline()
        } catch (error) {
            throw baselineRevalidationFailure(error)
        }
        const changed = (Object.keys(basis.fingerprint) as (keyof PendingBaseline['fingerprint'])[])
            .find((field) => basis.fingerprint[field] !== fresh.basis.fingerprint[field])
        if (changed) {
            const names: Record<keyof PendingBaseline['fingerprint'], string> = {
                source: 'config source',
                runtime: 'runtime topology',
                cohort: 'runtime cohort',
                predecessor: 'previous baseline',
                stability: 'runtime stability',
            }
            throw new TypeError(`baseline ${names[changed]} changed`)
        }
        pending.set(basis.stackId, basis)
        return observation
    }

    const writeBaseline = async (baseline: EnvironmentBaseline): Promise<void> => {
        if (!isEnvironmentBaselineAuthentic(baseline)) throw new TypeError('baseline write authority is unavailable')
        const basis = pending.get(baseline.stackId)
        if (!basis
            || baseline.snapshot.configSha256 !== basis.configSha256
            || baseline.evidence.configSha256 !== basis.configSha256
            || baseline.snapshot.snapshotSha256 !== basis.snapshotSha256
            || baseline.evidence.evidenceSha256 !== basis.evidenceSha256) {
            throw new TypeError('baseline write authority is unavailable')
        }
        pending.delete(baseline.stackId)
        let fresh: BaselineMeasurement
        try {
            fresh = await measureBaseline()
        } catch {
            throw new TypeError('baseline write authority is unavailable')
        }
        if ((Object.keys(basis.fingerprint) as (keyof PendingBaseline['fingerprint'])[])
            .some((field) => basis.fingerprint[field] !== fresh.basis.fingerprint[field])) {
            throw new TypeError('baseline write authority is unavailable')
        }
        const expected = JSON.stringify(basis.expected)
        const result = await transactState(
            basis.namespace,
            basis.address,
            { ownerId: basis.holderId },
            async (current) => JSON.stringify(current) === expected
                ? Object.freeze({
                    format: 'cockpit-state/v1' as const,
                    kind: 'baseline' as const,
                    cockpitId: basis.cockpitId,
                    subjectId: baseline.stackId,
                    revision: current === null ? 0 : current.revision + 1,
                    updatedAt: baseline.recordedAt,
                    value: baseline as unknown as StateRecord['value'],
                })
                : abortStateTransaction(false),
        )
        if ('aborted' in result || result.kind !== 'complete') throw new TypeError('baseline publication is not durable')
    }

    const logs: LogsCommandAdapters = Object.freeze({
        observe: observeLogs,
        execute: (step: ExecutionStep, options: { readonly signal?: AbortSignal }) => execute(step, options),
        ...(input?.signal ? { signal: input.signal } : {}),
    })
    const baseline: BaselineCommandAdapters & {
        readonly revalidate: (observation: BaselineObservation) => Promise<BaselineObservation>
    } = Object.freeze({ observe: observeBaseline, revalidate: revalidateBaseline, write: writeBaseline })
    return Object.freeze({ logs, baseline })
}
