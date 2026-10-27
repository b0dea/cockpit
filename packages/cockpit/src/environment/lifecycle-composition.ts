import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadCockpitConfig, projectMachineFloorConfig } from '../config/load.js'
import type { ConsumedLoadedConfig } from '../config/load.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import {
    checkGeneratedEnvironment,
    generatedApplicationProjection,
    observeGeneratedApplication,
    projectGeneratedApplicationNodeExecutable,
    projectGeneratedApplicationRuntimeAuthority,
    resolveGeneratedApplicationOperation,
    syncGeneratedEnvironment,
    type GeneratedApplicationProjection,
} from './generated-application.js'
import { admitDependencyRuntime, createDependencyRuntimePlan } from './dependency-runtime.js'
import {
    executeDataMode,
    observeDataMode,
    planDataMode,
    projectDataModeObservationSteps,
    readDataModeOutcome,
    type DataModeExecutionResult,
} from './data-plane.js'
import {
    decodeLifecycleRecord,
    issueLifecycleRunContext,
    withLifecycleConfiguration,
    type LifecycleRunContext,
    type ReadinessRefusal,
    type SleepCommandAdapters,
    type UpCommandAdapters,
} from './application.js'
import {
    ENVIRONMENT_CODES,
    type EnvironmentCommandOutcome,
    type EnvironmentDiagnostic,
    type ExecutionStep,
} from './contract.js'
import { resolveDiskCapacityExecutable, resolveDockerExecutable, resolveGitExecutable } from './executable.js'
import { observeHostCapacity } from './host-observation.js'
import type { GeneratedObservationRuntime } from './generated-stack.js'
import {
    observeExternalDependencies,
    observeExternalDependency,
    planExternalDependency,
    verifyExternalDependency,
} from './external-dependencies.js'
import { checkoutId, holderId, stackId } from './identity.js'
import { observeDependencyInstall, planInstall, resolveInstallExecutables } from './installs.js'
import {
    projectLifecycleStage,
    resolveLifecycleStage,
} from './lifecycle-stage.js'
import {
    deriveEntrypoints,
    leasePortFamily,
    projectPortLeaseResult,
    type PortLeaseProjection,
    type PortListenerEvidenceInput,
} from './ports.js'
import {
    admitRuntimeMeasurement,
    admitRuntimeTopology,
    collectMachineFloorEvidence,
    createMachineFloorPlan,
    createRuntimeAdapter,
    createRuntimeTopologyPlan,
    issueMachineFloorAuthority,
    observeDockerRuntime,
    observeRuntimeMeasurement,
    projectRuntimeLifecycle,
    projectRuntimeExecutionEnvironment,
    projectDependencyRuntime,
    runtimeMeasurementProbeObservation,
    type ComposeArtifact,
    type RuntimeMeasurementProbeAuthority,
    type MachineFloorAuthority,
    type RuntimeLifecycleProjection,
    type RuntimeServiceEvidence,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import {
    consumeSetupCheckoutProjection,
    observeSetupCheckout,
    withSetupCheckoutProjection,
} from './setup-observation.js'
import { readState, selectStateRoot } from './state.js'
import { externalDependencyTemplateFragments, inspectEnvironmentKeys } from './templates.js'

export const mechanism = {
    id: 'lifecycle-adapter-composition',
    module: 'packages/cockpit/src/environment/lifecycle-composition.ts',
    exports: ['createLifecycleCommandAdapters'],
} as const

const COMPOSE_BYTE_LIMIT = 1_048_576
const LISTENER_CONCURRENCY = 16
const MAX_TOPOLOGY_OBSERVATION_WINDOW_MS = 300_000
const SAFE_DOCKER_ENV = new Set(['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'])

function ownerDiagnostics(code: EnvironmentDiagnostic['code'], message: string, target: string): readonly EnvironmentDiagnostic[] {
    return Object.freeze([Object.freeze({ severity: 'error' as const, code, message, target })])
}

function runtimeUnavailable(reason: string, target: string): readonly EnvironmentDiagnostic[] {
    return ownerDiagnostics(ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, reason, target)
}

export interface LifecycleCommandCompositionInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly sessionId: string
    readonly timeoutMs: number
    readonly activeProfiles?: readonly string[]
    readonly runtimeMeasurementProbeAuthority?: RuntimeMeasurementProbeAuthority | (() => RuntimeMeasurementProbeAuthority)
}

export type LifecycleCommandAdapterComposition = Omit<UpCommandAdapters & SleepCommandAdapters, 'withRuntimeReadiness'> & {
    prepareGeneratedEnvironment(context: LifecycleRunContext, ports: PortLeaseProjection): Promise<GeneratedApplicationProjection | undefined>
    completeGeneratedEnvironment(
        context: LifecycleRunContext,
        runtime: LifecycleRuntimeReadiness,
        services: readonly RuntimeServiceEvidence[],
        projection: GeneratedApplicationProjection,
    ): Promise<EnvironmentCommandOutcome<import('./contract.js').EnvironmentObservation>>
    completeGeneratedDependencies(
        context: LifecycleRunContext,
        runtime: LifecycleRuntimeReadiness,
        services: readonly RuntimeServiceEvidence[],
        projection: GeneratedApplicationProjection,
    ): Promise<GeneratedCommandOutcome<readonly import('./contract.js').EnvironmentObservation[]>>
    completeGeneratedVendors(
        context: LifecycleRunContext,
        runtime: LifecycleRuntimeReadiness,
        services: readonly RuntimeServiceEvidence[],
        projection: GeneratedApplicationProjection,
    ): Promise<GeneratedCommandOutcome<import('./contract.js').EnvironmentObservation>>
    completeGeneratedData(
        context: LifecycleRunContext,
        runtime: LifecycleRuntimeReadiness,
        services: readonly RuntimeServiceEvidence[],
        projection: GeneratedApplicationProjection,
    ): Promise<EnvironmentCommandOutcome<DataModeExecutionResult | import('./contract.js').EnvironmentObservation>>
    withMachineFloorReadiness<T>(
        context: LifecycleRunContext,
        use: (observations: readonly import('./contract.js').EnvironmentObservation[]) => Promise<T>,
        refuse?: ReadinessRefusal<T>,
    ): Promise<T | undefined>
    withGeneratedRuntime<T>(
        context: LifecycleRunContext,
        readiness: LifecycleRuntimeReadiness,
        use: (value: Readonly<{
            application: GeneratedApplicationProjection
            runtime: GeneratedObservationRuntime
        }>) => Promise<T>,
    ): Promise<T | undefined>
    withRuntimeReadiness<T>(
        context: LifecycleRunContext,
        use: (runtime: LifecycleRuntimeReadiness) => Promise<T>,
        ports?: PortLeaseProjection,
        refuse?: ReadinessRefusal<T>,
    ): Promise<T | undefined>
}

type GeneratedCommandOutcome<T> = EnvironmentCommandOutcome<T> & {
    readonly progressEvidence?: readonly unknown[]
}

interface LifecycleRuntimeReadiness {
    readonly topology: RuntimeTopologyEvidence
    readonly lifecycle: RuntimeLifecycleProjection
    readonly hostObservations: readonly import('./contract.js').EnvironmentObservation[]
    readonly runtimeObservations: readonly import('./contract.js').EnvironmentObservation[]
}

interface CompositionBinding {
    readonly config: ConsumedLoadedConfig['config']
    readonly checkoutRoot: string
    readonly siblingsRoot: string
    readonly machineFloorAuthority?: MachineFloorAuthority
    readonly generatedApplication?: GeneratedApplicationProjection
    readonly generatedRuntime?: GeneratedObservationRuntime
}

function refusal(target: string, message = 'lifecycle composition authority is unavailable'): EnvironmentCommandOutcome<LifecycleRunContext> {
    return Object.freeze({
        kind: 'refusal' as const,
        status: 2 as const,
        result: null,
        diagnostics: Object.freeze([Object.freeze({
            severity: 'error' as const,
            code: ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
            message,
            target,
        })]),
    })
}

function leafRefusal<T>(
    target: string,
    message: string,
    code: import('./contract.js').EnvironmentDiagnostic['code'] = ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID,
    progressEvidence?: readonly unknown[],
): GeneratedCommandOutcome<T> {
    return Object.freeze({
        kind: 'refusal' as const,
        status: 2 as const,
        result: null,
        diagnostics: Object.freeze([Object.freeze({
            severity: 'error' as const,
            code,
            message,
            target,
        })]),
        ...(progressEvidence ? { progressEvidence: Object.freeze([...progressEvidence]) } : {}),
    })
}

function captureInput(value: LifecycleCommandCompositionInput): LifecycleCommandCompositionInput | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const keys = ['configPath', 'env', 'sessionId', 'timeoutMs']
        const actualKeys = Reflect.ownKeys(descriptors)
        const optionalKeys = ['activeProfiles', 'runtimeMeasurementProbeAuthority'].filter((key) => descriptors[key] !== undefined)
        if (actualKeys.length !== keys.length + optionalKeys.length
            || keys.some((key) => !descriptors[key] || !('value' in descriptors[key]!))
            || optionalKeys.some((key) => !('value' in descriptors[key]!))) return undefined
        const configPath = descriptors.configPath!.value
        const rawEnvironment = descriptors.env!.value
        const sessionId = descriptors.sessionId!.value
        const timeoutMs = descriptors.timeoutMs!.value
        const activeProfiles = descriptors.activeProfiles?.value
        const runtimeMeasurementProbeAuthority = descriptors.runtimeMeasurementProbeAuthority?.value
        if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0')
            || typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.includes('\0')
            || typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
            || activeProfiles !== undefined && (!Array.isArray(activeProfiles) || activeProfiles.length > 64
                || new Set(activeProfiles).size !== activeProfiles.length
                || activeProfiles.some((profile) => typeof profile !== 'string' || !/^[a-z0-9][a-z0-9_.-]*$/.test(profile)))
            || !rawEnvironment || typeof rawEnvironment !== 'object' || Array.isArray(rawEnvironment)) return undefined
        const env: Record<string, string> = {}
        for (const [name, entry] of Object.entries(rawEnvironment as Record<string, unknown>)) {
            if (entry === undefined) continue
            if (name.length === 0 || name.includes('\0') || name.includes('=')
                || typeof entry !== 'string' || entry.includes('\0')) return undefined
            env[name] = entry
        }
        return Object.freeze({ configPath: resolve(configPath), env: Object.freeze(env), sessionId, timeoutMs,
            ...(activeProfiles === undefined ? {} : { activeProfiles: Object.freeze([...activeProfiles].sort()) }),
            ...(runtimeMeasurementProbeAuthority === undefined ? {} : { runtimeMeasurementProbeAuthority }) })
    } catch {
        return undefined
    }
}

function runtimeEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(Object.entries(env)
        .filter((entry): entry is [string, string] => SAFE_DOCKER_ENV.has(entry[0]) && typeof entry[1] === 'string')))
}

function confined(root: string, path: string): boolean {
    const relation = relative(root, path)
    return relation === '' || relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

async function composeArtifact(root: string, reference: string, expectedSha256?: string): Promise<ComposeArtifact | undefined> {
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
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        if (expectedSha256 !== undefined && sha256 !== expectedSha256) return undefined
        return Object.freeze({ reference, canonicalPath, source, sha256 })
    } catch {
        return undefined
    } finally {
        try { await handle?.close() } catch { /* No file authority survives an unavailable artifact. */ }
    }
}

async function composeArtifacts(root: string, references: readonly string[]): Promise<readonly ComposeArtifact[] | undefined> {
    const artifacts: ComposeArtifact[] = []
    for (const reference of references) {
        const artifact = await composeArtifact(root, reference)
        if (!artifact) return undefined
        artifacts.push(artifact)
    }
    return Object.freeze(artifacts)
}

function generatedProjectionMatches(
    generated: NonNullable<CompositionBinding['config']['environment']['generated']>,
    browser: CompositionBinding['config']['browser'],
    projection: GeneratedApplicationProjection,
): boolean {
    const profiles = [...new Set(generated.services.flatMap((service) => service.profiles))].sort()
    const declaredMounts = generated.services.flatMap((service) => service.mounts
        .map((mount) => `${service.id}:${mount.kind}:${mount.source}:${mount.target}`)).sort()
    const manifest = browser?.project.manifest ?? (browser ? join(dirname(browser.project.lockfile), 'package.json') : undefined)
    const runnerMounts = browser?.endpoint && manifest ? [
        'cockpit-browser-runner:environment-file:.cockpit/browser/runner.sh:/cockpit/browser-runner.sh',
        `cockpit-browser-runner:environment-file:${manifest}:/cockpit/project/package.json`,
        `cockpit-browser-runner:environment-file:${browser.project.lockfile}:/cockpit/project/package-lock.json`,
        `cockpit-browser-runner:bind:${browser.artifacts.runner}:/cockpit/artifacts`,
    ] : []
    const mounts = [...declaredMounts, ...runnerMounts].sort()
    return JSON.stringify(projection.profiles) === JSON.stringify(profiles)
        && JSON.stringify(projection.mounts) === JSON.stringify(mounts)
        && projection.inspection.files.filter(({ path }) => path === generated.compose_file).length === 1
}

function generatedReplayMatches(
    projection: GeneratedApplicationProjection,
    replay: Readonly<{
        sourceSha256: string
        generation: string
        profiles: readonly string[]
        mounts: readonly string[]
    }> | undefined,
): boolean {
    return replay !== undefined
        && replay.sourceSha256 === projection.sourceSha256
        && replay.generation === projection.generation
        && JSON.stringify(replay.profiles) === JSON.stringify(projection.profiles)
        && JSON.stringify(replay.mounts) === JSON.stringify(projection.mounts)
}

async function occupiedPort(port: number, timeoutMs: number): Promise<boolean | undefined> {
    return new Promise((complete) => {
        const socket = createConnection({ host: '127.0.0.1', port })
        let settled = false
        const finish = (value: boolean | undefined) => {
            if (settled) return
            settled = true
            socket.destroy()
            complete(value)
        }
        socket.setTimeout(timeoutMs, () => finish(undefined))
        socket.once('connect', () => finish(true))
        socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' ? false : undefined))
    })
}

async function listenerEvidence(
    context: LifecycleRunContext,
    requestedAt: string,
    timeoutMs: number,
): Promise<readonly PortListenerEvidenceInput[]> {
    const deadline = Date.parse(requestedAt) + timeoutMs
    const candidates = Array.from({ length: context.ports.count }, (_, offset) => {
        const ports = Object.values(context.ports.bases).map((base) => base + offset * context.ports.step)
        return Object.freeze({ ports: Object.freeze(ports) })
    })
    const observed = candidates.map(({ ports }) => ports.map(() => undefined as boolean | undefined))
    const tasks = candidates.flatMap(({ ports }, family) => ports.map((port, index) => ({ family, index, port })))
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(LISTENER_CONCURRENCY, tasks.length) }, async () => {
        while (cursor < tasks.length) {
            const task = tasks[cursor++]!
            const remaining = deadline - Date.now()
            if (remaining <= 0) return
            observed[task.family]![task.index] = Number.isSafeInteger(task.port) && task.port >= 1 && task.port <= 65_535
                ? await occupiedPort(task.port, remaining)
                : undefined
        }
    }))
    const completedAt = Date.now()
    return Object.freeze(candidates.map(({ ports }, family) => {
        const familyObservation = observed[family]!
        const unavailable = completedAt > deadline || familyObservation.length !== ports.length
            || familyObservation.some((value) => value === undefined)
        return Object.freeze({
            ports,
            observation: unavailable
                ? Object.freeze({
                    state: 'unavailable' as const,
                    reason: 'bounded loopback listener observation is unavailable',
                    producer: mechanism.id,
                })
                : Object.freeze({
                    state: 'available' as const,
                    value: Object.freeze(ports.filter((_port, index) => familyObservation[index] === true)),
                    observedAt: new Date(Math.max(completedAt, Date.parse(requestedAt))).toISOString(),
                    producer: mechanism.id,
                }),
        })
    }))
}

export function createLifecycleCommandAdapters(
    rawInput: LifecycleCommandCompositionInput,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): LifecycleCommandAdapterComposition {
    const input = captureInput(rawInput)
    const bindings = new WeakMap<LifecycleRunContext, CompositionBinding>()
    const issuedRuntimeReadiness = new WeakSet<object>()

    const load: LifecycleCommandAdapterComposition['load'] = async (command) => {
        if (!input || typeof execute !== 'function' || command.configPath !== input.configPath) {
            return refusal(typeof command?.configPath === 'string' ? command.configPath : 'lifecycle')
        }
        const loaded = await loadCockpitConfig(input.configPath)
        if (loaded.kind === 'refusal') return loaded
        const git = await resolveGitExecutable(input.env as Readonly<Record<string, string>>)
        if (git.state !== 'available') return refusal(loaded.result.source.path, git.reason)
        const observedAt = new Date().toISOString()
        const checkoutObservation = await observeSetupCheckout({
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            observedAt,
            env: input.env as Readonly<Record<string, string>>,
            gitExecutable: git.value,
        })
        const machineConfiguration = projectMachineFloorConfig(loaded.result)
        const projected = await withSetupCheckoutProjection(checkoutObservation, {
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            evaluatedAt: Date.parse(observedAt),
        }, (projection) => machineConfiguration
            ? issueMachineFloorAuthority({ configuration: machineConfiguration, checkout: projection })
            : consumeSetupCheckoutProjection(projection))
        const checkout = projected && 'authority' in projected ? projected.checkout : projected
        if (!checkout || process.platform !== 'darwin' && process.platform !== 'linux') {
            return refusal(loaded.result.source.path, checkoutObservation.state === 'failed'
                ? checkoutObservation.reason : 'authenticated checkout evidence is unavailable')
        }
        const namespace = await selectStateRoot({
            platform: process.platform,
            home: input.env.HOME,
            xdgStateHome: input.env.XDG_STATE_HOME,
            checkoutRoots: [checkout.currentCheckoutPath, checkout.mainCheckoutPath],
            cockpitId: checkout.cockpitId,
        })
        if (namespace.kind !== 'complete') return refusal(loaded.result.source.path, 'state namespace is unavailable')
        const currentStackId = stackId({
            cockpitId: checkout.cockpitId,
            checkoutId: checkout.checkoutId,
            variant: { kind: 'shared' },
        })
        const currentHolderId = holderId({
            stackId: currentStackId,
            checkoutId: checkout.checkoutId,
            sessionId: input.sessionId,
        })
        const confirmedAt = new Date().toISOString()
        const confirmed = await observeSetupCheckout({
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            observedAt: confirmedAt,
            env: input.env as Readonly<Record<string, string>>,
            gitExecutable: git.value,
        })
        const issued = await withSetupCheckoutProjection(confirmed, {
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            evaluatedAt: Date.parse(confirmedAt),
        }, (projection) => issueLifecycleRunContext({
            configPath: input.configPath,
            checkout: projection,
            configuration: loaded.result,
            namespace: namespace.value,
            stackId: currentStackId,
            holderId: currentHolderId,
            sessionId: input.sessionId,
        }))
        if (!issued || issued.kind !== 'complete') return issued ?? refusal(loaded.result.source.path)
        bindings.set(issued.result, Object.freeze({
            config: loaded.result.config,
            checkoutRoot: checkout.currentCheckoutPath,
            siblingsRoot: resolve(checkout.mainCheckoutPath, loaded.result.config.cockpit.siblings_root),
            ...(projected && 'authority' in projected ? { machineFloorAuthority: projected.authority } : {}),
        }))
        return Object.freeze({ ...issued, diagnostics: loaded.diagnostics })
    }

    const projectGeneratedApplication = async (
        context: LifecycleRunContext,
        action: 'sync' | 'check',
        ports?: PortLeaseProjection,
    ): Promise<GeneratedApplicationProjection | undefined> => {
        const binding = bindings.get(context)
        const generated = binding?.config.environment.generated
        if (!input || !binding || !generated) return undefined
        const outcome = action === 'sync'
            ? await syncGeneratedEnvironment({ configPath: input.configPath }, { execute }, ports)
            : await checkGeneratedEnvironment({ configPath: input.configPath }, ports)
        if (outcome.kind !== 'complete') {
            if (action === 'sync') throw new Error(outcome.diagnostics
                .map(({ code, message, target }) => `${code}: ${message}${target ? ` (${target})` : ''}`).join('; '))
            return undefined
        }
        const projection = generatedApplicationProjection(outcome.result.application)
        if (!projection || projection.sourceSha256 !== context.source.sha256
            || !generatedProjectionMatches(generated, binding.config.browser, projection)) return undefined
        bindings.set(context, Object.freeze({ ...binding, generatedApplication: projection }))
        return projection
    }

    const prepareGeneratedEnvironment: LifecycleCommandAdapterComposition['prepareGeneratedEnvironment'] = async (context, ports) => {
        return projectGeneratedApplication(context, 'sync', ports)
    }

    const completeGeneratedDependencies: LifecycleCommandAdapterComposition['completeGeneratedDependencies'] = async (
        context,
        runtime,
        services,
        projection,
    ) => {
        const binding = bindings.get(context)
        const generated = binding?.config.environment.generated
        const dependencies = binding?.config.sibling.filter(({ toolchain }) => toolchain !== 'none') ?? []
        const observations: import('./contract.js').EnvironmentObservation[] = []
        const reject = (target: string, message: string, code?: import('./contract.js').EnvironmentDiagnostic['code']) =>
            leafRefusal<readonly import('./contract.js').EnvironmentObservation[]>(
                target, message, code, observations)
        if (!input || !binding || !generated || binding.generatedApplication !== projection
            || generatedApplicationProjection(projection) !== projection) {
            return reject('generated-dependencies', 'generated dependency authority is unavailable')
        }
        const node = projectGeneratedApplicationNodeExecutable(projection)
        if (!node) return reject('generated-dependencies', 'generated dependency executable authority is unavailable')
        const executables = await resolveInstallExecutables(node)
        if (executables.kind !== 'complete') {
            return reject(executables.target, executables.message)
        }
        for (const sibling of dependencies) {
            const serviceMatches = generated.services.filter(({ sibling: owner }) => owner === sibling.slug)
            if (serviceMatches.length !== 1) {
                return reject(sibling.slug, 'generated dependency service identity is ambiguous')
            }
            const service = serviceMatches[0]!
            const mountedPolicies = service.mounts.flatMap((mount) => {
                if (mount.kind !== 'volume') return []
                const volume = generated.volumes.find(({ id }) => id === mount.source)
                if (!volume || volume.purpose !== 'dependencies' || !volume.install_policy) return []
                const policy = binding.config.environment.install_policies.find((candidate) =>
                    candidate.volume === volume.install_policy && candidate.toolchain === sibling.toolchain)
                return policy ? [{ policy, volume: volume.id }] : []
            })
            if (mountedPolicies.length !== 1) {
                return reject(sibling.slug, 'generated dependency install policy is ambiguous')
            }
            const evidence = services.filter(({ service: id }) => id === service.id)
            if (evidence.length !== 1) {
                return reject(service.id, 'generated dependency service evidence is unavailable')
            }
            const selected = mountedPolicies[0]!
            if (selected.policy.install.length === 0 || selected.policy.load_probe.length === 0) {
                return reject(sibling.slug, 'generated dependency install policy commands are empty')
            }
            const policy = Object.freeze({
                volume: selected.policy.volume,
                lockfile: selected.policy.lockfile,
                install: Object.freeze([...selected.policy.install]) as readonly [string, ...string[]],
                load_probe: Object.freeze([...selected.policy.load_probe]) as readonly [string, ...string[]],
            })
            const dependencyRuntime = projectDependencyRuntime({
                topology: runtime.topology,
                evidence: evidence[0]!,
                service: service.id,
                volume: selected.volume,
            })
            if (!dependencyRuntime) return reject(service.id, 'generated dependency runtime authority is unavailable')
            const runtimePlan = createDependencyRuntimePlan({ runtime: dependencyRuntime })
            if (runtimePlan.kind !== 'planned') return reject(service.id, runtimePlan.reason)
            const inspectOutcome = await execute(runtimePlan.inspect)
            const architectureOutcome = await execute(runtimePlan.architecture)
            const abiOutcome = await execute(runtimePlan.abi)
            const admitted = admitDependencyRuntime({ plan: runtimePlan, inspectOutcome, architectureOutcome, abiOutcome })
            if (admitted.kind !== 'complete') return reject(service.id, admitted.reason)
            const checkoutRoot = resolve(binding.siblingsRoot, sibling.dir)
            if (!confined(binding.siblingsRoot, checkoutRoot)) {
                return reject(sibling.slug, 'generated dependency checkout escaped the sibling root')
            }
            const planned = await planInstall({
                checkoutId: checkoutId({ checkoutPath: checkoutRoot }),
                holderId: context.holderId,
                pid: process.pid,
                checkoutRoot,
                lockfilePath: resolve(checkoutRoot, selected.policy.lockfile),
                state: context.namespace,
                runtime: admitted.binding,
                policy,
                executables: executables.executables,
                execution: {
                    env: Object.freeze({}),
                    installTimeoutMs: input.timeoutMs,
                    probeTimeoutMs: input.timeoutMs,
                    helperTimeoutMs: input.timeoutMs,
                    stdoutLimitBytes: 65_536,
                    stderrLimitBytes: 65_536,
                },
            }, { execute })
            if (planned.kind !== 'complete') return reject(planned.target, planned.message)
            const observation = await observeDependencyInstall({
                planned,
                options: { execute },
                stackId: context.stackId,
                observedAt: new Date().toISOString(),
            })
            observations.push(observation)
            if (observation.observed.state !== 'available') {
                return reject(observation.source, observation.observed.reason, observation.code)
            }
        }
        return Object.freeze({
            kind: 'complete' as const,
            status: 0 as const,
            diagnostics: Object.freeze([]),
            result: Object.freeze(observations),
            progressEvidence: Object.freeze([...observations]),
        })
    }

    const completeGeneratedEnvironment: LifecycleCommandAdapterComposition['completeGeneratedEnvironment'] = async (
        context,
        runtime,
        _services,
        projection,
    ) => {
        const binding = bindings.get(context)
        if (!binding?.generatedRuntime || binding.generatedApplication !== projection
            || generatedApplicationProjection(projection) !== projection) {
            return leafRefusal<import('./contract.js').EnvironmentObservation>(
                'generated-environment', 'generated environment authority is unavailable')
        }
        const observation = await observeGeneratedApplication(
            projection,
            { topology: runtime.topology, runtime: binding.generatedRuntime },
            execute,
        )
        return observation
            ? Object.freeze({ kind: 'complete' as const, status: 0 as const, diagnostics: Object.freeze([]), result: observation })
            : leafRefusal<import('./contract.js').EnvironmentObservation>(
                'generated-environment', 'generated environment observations are incomplete')
    }

    const completeGeneratedVendors: LifecycleCommandAdapterComposition['completeGeneratedVendors'] = async (
        context,
        runtime,
        services,
        projection,
    ) => {
        const binding = bindings.get(context)
        const generated = binding?.config.environment.generated
        const observed: import('./external-dependencies.js').ExternalDependencyObservation[] = []
        const reject = (target: string, message: string, code?: import('./contract.js').EnvironmentDiagnostic['code']) =>
            leafRefusal<import('./contract.js').EnvironmentObservation>(
                target, message, code, observed)
        if (!binding?.generatedRuntime || !generated || generated.vendors.length === 0
            || binding.generatedApplication !== projection || generatedApplicationProjection(projection) !== projection) {
            return reject('generated-vendors', 'generated vendor authority is unavailable')
        }
        const prepared = []
        for (const vendor of generated.vendors) {
            let generatedRuntime = binding.generatedRuntime
            if (vendor.egress_guard) {
                const evidence = services.filter(({ service }) => service === vendor.egress_guard!.local_service)
                if (evidence.length !== 1) {
                    return reject(vendor.id, 'generated vendor service evidence is unavailable')
                }
                generatedRuntime = Object.freeze({
                    ...generatedRuntime,
                    serviceAuthority: Object.freeze({ topology: runtime.topology, evidence: evidence[0]! }),
                })
            }
            const authority = projectGeneratedApplicationRuntimeAuthority(projection, {
                topology: runtime.topology,
                runtime: generatedRuntime,
            })
            if (!authority) return reject(vendor.id, 'generated vendor runtime authority is unavailable')
            const fragments = externalDependencyTemplateFragments(vendor)
            if (fragments.kind !== 'complete') return reject(vendor.id, fragments.reason)
            const presentShadowFiles = []
            for (const shadow of vendor.shadow_files ?? []) {
                const sibling = binding.config.sibling.find(({ slug }) => slug === shadow.sibling)
                const declaration = sibling?.environment_files?.find(({ instance }) => instance === shadow.instance)
                if (!sibling || !declaration) continue
                const siblingRoot = resolve(binding.siblingsRoot, sibling.dir)
                if (!confined(binding.siblingsRoot, siblingRoot)) continue
                const inspection = await inspectEnvironmentKeys({
                    siblingRoot,
                    templatePath: resolve(siblingRoot, declaration.template),
                    instancePath: resolve(siblingRoot, declaration.instance),
                })
                if (inspection.kind === 'fresh' || inspection.kind === 'stale') {
                    presentShadowFiles.push(Object.freeze({ sibling: shadow.sibling, instance: shadow.instance }))
                }
            }
            const plan = planExternalDependency({
                authority,
                purpose: 'startup',
                declaration: vendor,
                fragments,
                runtime: generatedRuntime,
                observedAt: new Date().toISOString(),
                presentShadowFiles: Object.freeze(presentShadowFiles),
            })
            if (plan.kind !== 'complete') return reject(vendor.id, plan.message)
            prepared.push(Object.freeze({ vendor, authority, plan }))
        }
        for (const { vendor, authority, plan } of prepared) {
            const evidence = await verifyExternalDependency(plan, { execute })
            const observation = observeExternalDependency({ evidence, authority })
            if (!observation) return reject(vendor.id, 'generated vendor observation is unavailable')
            observed.push(observation)
            if (observation.state !== 'available') {
                return reject(vendor.id, observation.reason, ENVIRONMENT_CODES.EXTERNAL_DEPENDENCIES_UNAVAILABLE)
            }
        }
        const aggregateAuthority = projectGeneratedApplicationRuntimeAuthority(projection, {
            topology: runtime.topology,
            runtime: binding.generatedRuntime,
        })
        const aggregate = aggregateAuthority
            ? observeExternalDependencies({
                authority: aggregateAuthority,
                observations: Object.freeze(observed),
                purpose: 'startup',
            })
            : undefined
        return aggregate
            ? Object.freeze({ kind: 'complete' as const, status: 0 as const, diagnostics: Object.freeze([]), result: aggregate,
                progressEvidence: Object.freeze([...observed]) })
            : reject('generated-vendors', 'generated vendor observations are incomplete')
    }

    const completeGeneratedData: LifecycleCommandAdapterComposition['completeGeneratedData'] = async (
        context,
        runtime,
        _services,
        projection,
    ) => {
        const binding = bindings.get(context)
        const generated = binding?.config.environment.generated
        if (!binding?.generatedRuntime || !generated || binding.generatedApplication !== projection
            || generatedApplicationProjection(projection) !== projection) {
            return leafRefusal<DataModeExecutionResult | import('./contract.js').EnvironmentObservation>(
                'generated-data', 'generated data authority is unavailable')
        }
        const durable = await readDataModeOutcome({
            namespace: context.namespace,
            stackId: context.stackId,
            configSha256: context.source.sha256,
            generation: projection.generation,
            mode: generated.data.default_mode,
        })
        const planned = await withLifecycleConfiguration(context, async (configuration) => planDataMode({
            environment: generated,
            mode: generated.data.default_mode,
            checkoutRoot: binding.checkoutRoot,
            includeFixtureVolume: false,
            namespace: context.namespace,
            stackId: context.stackId,
            holderId: context.holderId,
            configuration,
            generation: projection.generation,
            observedAt: new Date().toISOString(),
            resolve: (operation, stepContext) => {
                const resolved = resolveGeneratedApplicationOperation(
                    projection,
                    { topology: runtime.topology, runtime: binding.generatedRuntime! },
                    operation,
                    stepContext,
                )
                if (!resolved) throw new TypeError('generated data operation authority is unavailable')
                return resolved
            },
        }))
        if (!planned || planned.kind !== 'preview') {
            const diagnostic = planned?.diagnostics[0]
            return leafRefusal<DataModeExecutionResult | import('./contract.js').EnvironmentObservation>(
                diagnostic?.target ?? 'generated-data', diagnostic?.message ?? 'generated data plan is unavailable')
        }
        if (durable) {
            const steps = projectDataModeObservationSteps({ plan: planned.plan, projection: durable })
            if (!steps) return leafRefusal<DataModeExecutionResult | import('./contract.js').EnvironmentObservation>(
                'generated-data', 'generated data readback authority is unavailable')
            const outcomes = await Promise.all(steps.map((step) => execute(step)))
            const observation = observeDataMode({ plan: planned.plan, projection: durable, outcomes: Object.freeze(outcomes) })
            return observation
                ? Object.freeze({ kind: 'complete' as const, status: 0 as const, diagnostics: Object.freeze([]), result: observation })
                : leafRefusal<DataModeExecutionResult | import('./contract.js').EnvironmentObservation>(
                    'generated-data', 'generated data readback is unavailable')
        }
        const result = await executeDataMode(planned.plan, execute)
        if (result.kind === 'refusal') {
            return Object.freeze({ kind: 'refusal' as const, status: 2 as const, diagnostics: result.diagnostics, result: null })
        }
        return Object.freeze({ kind: 'complete' as const, status: 0 as const, diagnostics: Object.freeze([]), result })
    }

    const withRuntimeReadiness: LifecycleCommandAdapterComposition['withRuntimeReadiness'] = async (context, use, ports, refuse) => {
        let binding = bindings.get(context)
        if (!input || !binding) return undefined
        const generated = binding.config.environment.generated
        const generatedApplication = generated
            ? binding.generatedApplication ?? await projectGeneratedApplication(context, 'check', ports)
            : undefined
        if (generated && !generatedApplication) return undefined
        if (generated && !ports) return undefined
        if (generated && generatedApplication) {
            const stored = await readState(context.namespace.paths.lifecycle(context.stackId))
            if (stored.kind === 'complete') {
                const decoded = decodeLifecycleRecord(stored.value, context)
                if (!decoded || !generatedReplayMatches(generatedApplication, decoded.value.generatedReplay)) return undefined
            } else if (stored.kind !== 'missing') return undefined
        }
        binding = bindings.get(context)
        if (!binding) return undefined
        const currentBinding = binding
        const env = runtimeEnvironment(input.env)
        const docker = await resolveDockerExecutable(env)
        if (docker.state !== 'available') return refuse?.(runtimeUnavailable(docker.reason, context.stackId))
        let probeAuthority: RuntimeMeasurementProbeAuthority | undefined
        if (input.runtimeMeasurementProbeAuthority !== undefined) {
            try {
                probeAuthority = typeof input.runtimeMeasurementProbeAuthority === 'function'
                    ? input.runtimeMeasurementProbeAuthority() : input.runtimeMeasurementProbeAuthority
            } catch (error) {
                throw new TypeError('runtime measurement probe authority supplier failed', { cause: error })
            }
        }
        const observed = input.runtimeMeasurementProbeAuthority === undefined
            ? await observeDockerRuntime({
                executable: docker.value,
                cwd: binding.checkoutRoot,
                env,
                timeoutMs: input.timeoutMs,
            }, execute)
            : (probeAuthority === undefined ? undefined : runtimeMeasurementProbeObservation(probeAuthority, docker.value.sha256))
                ?? Object.freeze({ kind: 'unavailable' as const, code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, reason: 'runtime measurement probe authority is unavailable or expired' })
        if (observed.kind !== 'complete') return refuse?.(ownerDiagnostics(observed.code, observed.reason, context.stackId))
        const measured = admitRuntimeMeasurement(observed, currentBinding.config.environment.runtime_measurements)
        const certifiedProbe = input.runtimeMeasurementProbeAuthority !== undefined
        if (measured.kind !== 'admitted' && !certifiedProbe) return refuse?.(ownerDiagnostics(measured.code, measured.reason, context.stackId))
        const measurementObservation = measured.kind === 'admitted'
            ? observeRuntimeMeasurement(measured, context.stackId) : undefined
        let artifacts: readonly ComposeArtifact[] | undefined
        let activeProfiles = input.activeProfiles ?? []
        let expectedMountSources: readonly string[]
        if (generated && generatedApplication) {
            if (input.activeProfiles !== undefined
                && JSON.stringify(input.activeProfiles) !== JSON.stringify(generatedApplication.profiles)) return undefined
            const ownedCompose = generatedApplication.inspection.files.find(({ path }) => path === generated.compose_file)
            const artifact = ownedCompose
                ? await composeArtifact(currentBinding.checkoutRoot, generated.compose_file, ownedCompose.sha256)
                : undefined
            if (!artifact) return undefined
            artifacts = Object.freeze([artifact])
            activeProfiles = generatedApplication.profiles
            const sources = generated.services.flatMap((service) => service.mounts
                .filter((mount) => mount.kind !== 'volume')
                .map((mount) => resolve(currentBinding.checkoutRoot, mount.source)))
            if (sources.some((source) => !confined(currentBinding.checkoutRoot, source))) return undefined
            expectedMountSources = Object.freeze([...new Set(sources)].sort())
        } else {
            artifacts = await composeArtifacts(currentBinding.checkoutRoot, currentBinding.config.environment.compose_files)
            expectedMountSources = Object.freeze([...new Set([
                ...currentBinding.config.sibling
                    .filter((sibling) => sibling.mount === 'always')
                    .map((sibling) => resolve(currentBinding.siblingsRoot, sibling.dir)),
                ...currentBinding.config.environment.generated_host_paths
                    .map((path) => resolve(currentBinding.checkoutRoot, path)),
            ])].sort())
        }
        if (!artifacts || artifacts.length === 0 || !currentBinding.config.environment.machine) return undefined
        const batchId = randomBytes(32).toString('hex')
        const runtime = createRuntimeAdapter({
            runtime: observed.runtime,
            composeVersion: observed.composeVersion,
            executable: docker.value,
            operation: 'validate',
            cwd: currentBinding.checkoutRoot,
            composeFiles: artifacts,
            projectName: currentBinding.config.cockpit.name,
            env,
            ports: generated && ports ? Object.freeze(Object.values(ports.lease.ports)) : Object.freeze([]),
            labels: { stackId: context.stackId, configSha256: context.source.sha256, batchId },
            timeoutMs: input.timeoutMs,
            stackId: context.stackId,
            coldStartLimitMillis: currentBinding.config.environment.machine.cold_start_seconds * 1_000,
            expectedMountSources,
            activeProfiles,
        }, generatedApplication && ports ? {
            generatedComposeAuthority: generatedApplication.generatedComposeAuthority,
            portLeaseProjection: ports,
        } : undefined)
        if (runtime.kind !== 'preview') return runtime.kind === 'refusal' ? refuse?.(runtime.diagnostics) : undefined
        const startedAt = new Date().toISOString()
        const topologyPlan = createRuntimeTopologyPlan({
            runtimePlan: runtime.plan,
            stackId: context.stackId,
            configSha256: context.source.sha256,
            batchId,
            observationWindow: {
                startedAt,
                expiresAt: new Date(Date.parse(startedAt) + MAX_TOPOLOGY_OBSERVATION_WINDOW_MS).toISOString(),
            },
        })
        if (topologyPlan.kind !== 'planned') return undefined
        const topologyOutcome = await execute(topologyPlan.step)
        const topology = admitRuntimeTopology({ plan: topologyPlan, outcome: topologyOutcome })
        if (topology.kind !== 'complete') return undefined
        if (generatedApplication) {
            const step = runtime.plan.steps[0]
            const publicEnv = projectRuntimeExecutionEnvironment(topology.topology)
            if (!step || !publicEnv) return undefined
            const generatedRuntime: GeneratedObservationRuntime = Object.freeze({
                root: currentBinding.checkoutRoot,
                executable: docker.value,
                composeFiles: Object.freeze(artifacts.map(({ canonicalPath: path, sha256 }) => Object.freeze({ path, sha256 }))),
                projectName: currentBinding.config.cockpit.name,
                publicEnv,
                stdoutLimitBytes: step.stdoutLimitBytes,
                stderrLimitBytes: step.stderrLimitBytes,
            })
            bindings.set(context, Object.freeze({ ...currentBinding, generatedRuntime }))
        }
        const disk = await resolveDiskCapacityExecutable(env)
        if (disk.state !== 'available') return undefined
        const floorPlan = createMachineFloorPlan({
            runtimePlan: runtime.plan,
            diskExecutable: disk.value,
            timeoutMs: input.timeoutMs,
            authority: currentBinding.machineFloorAuthority!,
        })
        if (floorPlan.kind !== 'preview') return undefined
        const machineEvidence = collectMachineFloorEvidence(floorPlan.plan, [
            await execute(floorPlan.plan.steps[0]!),
            await execute(floorPlan.plan.steps[1]!),
        ])
        if (!machineEvidence) return undefined
        const hostObservations = observeHostCapacity({ evidence: machineEvidence })
        const lifecycle = projectRuntimeLifecycle(topology.topology)
        if (!lifecycle) return undefined
        const readiness = Object.freeze({
            topology: topology.topology,
            lifecycle,
            hostObservations,
            runtimeObservations: Object.freeze(measurementObservation
                ? [measurementObservation, ...topology.observations] : [...topology.observations]),
        })
        issuedRuntimeReadiness.add(readiness)
        return use(readiness)
    }

    const withGeneratedRuntime: LifecycleCommandAdapterComposition['withGeneratedRuntime'] = async (
        context,
        readiness,
        use,
    ) => {
        const binding = bindings.get(context)
        const application = binding?.generatedApplication
        const runtime = binding?.generatedRuntime
        if (!binding?.config.environment.generated || !application || !runtime
            || generatedApplicationProjection(application) !== application
            || !issuedRuntimeReadiness.has(readiness)
            || !projectGeneratedApplicationRuntimeAuthority(application, {
                topology: readiness.topology,
                runtime,
            })) return undefined
        return use(Object.freeze({ application, runtime }))
    }

    const withMachineFloorReadiness: LifecycleCommandAdapterComposition['withMachineFloorReadiness'] = async (context, use, refuse) => {
        const binding = bindings.get(context)
        if (!input || !binding?.machineFloorAuthority || !binding.config.environment.machine) return undefined
        const env = runtimeEnvironment(input.env)
        const [docker, disk] = await Promise.all([
            resolveDockerExecutable(env),
            resolveDiskCapacityExecutable(env),
        ])
        if (docker.state !== 'available') return refuse?.(runtimeUnavailable(docker.reason, context.stackId))
        if (disk.state !== 'available') return refuse?.(runtimeUnavailable(disk.reason, context.stackId))
        const plan = createMachineFloorPlan({
            runtimeExecutable: docker.value,
            diskExecutable: disk.value,
            cwd: binding.checkoutRoot,
            env,
            timeoutMs: input.timeoutMs,
            authority: binding.machineFloorAuthority,
        })
        if (plan.kind !== 'preview') return plan.kind === 'refusal' ? refuse?.(plan.diagnostics) : undefined
        const evidence = collectMachineFloorEvidence(plan.plan, [
            await execute(plan.plan.steps[0]!),
            await execute(plan.plan.steps[1]!),
        ])
        return evidence ? use(observeHostCapacity({ evidence })) : undefined
    }

    const withLifecycleStage: LifecycleCommandAdapterComposition['withLifecycleStage'] = async (context, use, refuse) => {
        if (!bindings.has(context)) return undefined
        const observedAt = new Date().toISOString()
        const resolved = await resolveLifecycleStage({ namespace: context.namespace, stackId: context.stackId, observedAt })
        if (resolved.kind !== 'complete') return refuse?.(resolved.diagnostics)
        const projection = projectLifecycleStage({
            authority: resolved.authority,
            stackId: context.stackId,
            cockpitId: context.cockpitId,
            earliest: Date.parse(resolved.authority.observedAt),
            latest: Date.parse(resolved.authority.validThrough),
            evaluatedAt: Date.now(),
        })
        return projection ? use(projection) : undefined
    }

    const withAcquiredPorts: LifecycleCommandAdapterComposition['withAcquiredPorts'] = async (context, use, refuse) => {
        if (!bindings.has(context)) return undefined
        const now = new Date().toISOString()
        const listenerTimeoutMs = Math.min(input?.timeoutMs ?? 1, 30_000)
        const leaseResult = await leasePortFamily({
            namespace: context.namespace,
            stackId: context.stackId,
            holderId: context.holderId,
            checkoutId: context.checkoutId,
            config: context.ports,
            now,
            listenerTimeoutMs,
            listenerEvidence: await listenerEvidence(context, now, listenerTimeoutMs),
        })
        if (leaseResult.kind !== 'complete') return refuse?.(leaseResult.diagnostics)
        const entrypoints = deriveEntrypoints({ lease: leaseResult.lease, declarations: context.entrypointDerivatives })
        if (entrypoints.kind !== 'complete') return refuse?.(entrypoints.diagnostics)
        const projection = projectPortLeaseResult({ leaseResult, entrypointResult: entrypoints })
        return projection ? use(Object.freeze({ leaseResult, projection })) : undefined
    }

    return Object.freeze({ load, execute, prepareGeneratedEnvironment, completeGeneratedEnvironment, completeGeneratedDependencies, completeGeneratedData, completeGeneratedVendors, withRuntimeReadiness, withGeneratedRuntime, withMachineFloorReadiness, withLifecycleStage, withAcquiredPorts })
}
