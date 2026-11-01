import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadCockpitConfig, projectMachineFloorConfig } from '../config/load.js'
import type { ConsumedLoadedConfig } from '../config/load.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { redirectedBindSources } from './compose-topology.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import type { CockpitConfig } from '../schema.js'
import { COMPOSE_OWNERSHIP_FILE, renderComposeOwnership } from './compose-ownership.js'
import {
    checkGeneratedEnvironment,
    generatedApplicationProjection,
    observeGeneratedApplication,
    projectGeneratedApplicationNodeExecutable,
    projectGeneratedApplicationRuntimeAuthority,
    projectGeneratedApplicationMountSources,
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
    type RuntimeReadinessPurpose,
    type SleepCommandAdapters,
    type UpCommandAdapters,
} from './application.js'
import {
    ENVIRONMENT_CODES,
    type EnvironmentCommandOutcome,
    type EnvironmentDiagnostic,
    type ExecutionStep,
} from './contract.js'
import { declaresNothingToRun, runtimeNotDeclared } from './declaration.js'
import { resolveDiskCapacityExecutable, resolveDockerExecutable, resolveGitExecutable } from './executable.js'
import { observeHostCapacity } from './host-observation.js'
import type { GeneratedObservationRuntime } from './generated-stack.js'
import {
    observeExternalDependencies,
    observeExternalDependency,
    planExternalDependency,
    verifyExternalDependency,
} from './external-dependencies.js'
import { checkoutId, composeProjectName, holderId, stackId } from './identity.js'
import { observeDependencyInstall, planInstall, resolveInstallExecutables } from './installs.js'
import {
    projectLifecycleStage,
    resolveLifecycleStage,
} from './lifecycle-stage.js'
import {
    acquirePortProjection,
    compensateAcquiredPortHolder,
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
    type RuntimeMountMismatch,
    type RuntimeServiceEvidence,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import { readLocalRuntimeMeasurements } from './runtime-measurement-record.js'
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

/** Names each mount difference by the row that declared it, so the refusal says what to edit. */
function mountMismatchDiagnostics(
    mismatch: RuntimeMountMismatch,
    config: CockpitConfig,
    siblingsRoot: string,
): readonly EnvironmentDiagnostic[] {
    const bySource = new Map(config.sibling.map((sibling) => [resolve(siblingsRoot, sibling.dir), sibling]))
    return Object.freeze([
        ...mismatch.missing.map((source) => {
            const sibling = bySource.get(source)
            return Object.freeze({
                severity: 'error' as const, code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE,
                target: sibling ? `sibling:${sibling.slug}` : source,
                message: sibling
                    ? `sibling ${sibling.slug} is declared mount = "always", but no Compose service bind-mounts ${source} or a directory inside it, so cockpit will not vouch for this stack`
                    : `${source} is declared for the stack to mount, but no Compose service bind-mounts it, so cockpit will not vouch for this stack`,
                fix: sibling
                    ? `bind-mount \${${sibling.var}}, or a directory inside it, in a Compose service, or set mount = "none" on sibling ${sibling.slug} in cockpit.toml; then run npx --no cockpit sync --config <your cockpit.toml> and npx --no cockpit check --config <your cockpit.toml>`
                    : 'bind-mount it in a Compose service or remove it from environment.generated_host_paths; then run npx --no cockpit sync --config <your cockpit.toml> and npx --no cockpit check --config <your cockpit.toml>',
            })
        }),
        ...mismatch.unexpected.map((source) => Object.freeze({
            severity: 'error' as const, code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE, target: source,
            message: `a Compose service bind-mounts ${source}, which lies inside no mount = "always" sibling and is no environment.generated_host_paths entry, so cockpit will not hand it to a container`,
            fix: 'move the bind inside a mount = "always" sibling, declare it as one or as an environment.generated_host_paths entry, or remove the bind mount; then run npx --no cockpit sync --config <your cockpit.toml> and npx --no cockpit check --config <your cockpit.toml>',
        })),
    ])
}

/** Names the sibling a redirected bind sits in, so the refusal says which checkout holds the link. */
function redirectedMountDiagnostics(
    redirected: readonly Readonly<{ bind: string; holder: string }>[],
    config: CockpitConfig,
    siblingsRoot: string,
): readonly EnvironmentDiagnostic[] {
    const bySource = new Map(config.sibling.map((sibling) => [resolve(siblingsRoot, sibling.dir), sibling]))
    return Object.freeze(redirected.map(({ bind, holder }) => {
        const sibling = bySource.get(holder)
        return Object.freeze({
            severity: 'error' as const, code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE, target: bind,
            message: `a Compose service bind-mounts ${bind}, which resolves through a symbolic link to a path outside ${sibling ? `sibling ${sibling.slug}` : holder}, so cockpit will not hand that path to a container`,
            fix: `replace the link with a real directory, or bind the path it points at directly and declare it as a mount = "always" sibling or an environment.generated_host_paths entry; then run ${cockpitCommand('check')}`,
        })
    }))
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
        purpose?: RuntimeReadinessPurpose,
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
        const env: Record<string, string | undefined> = {}
        for (const [name, entry] of Object.entries(rawEnvironment as Record<string, unknown>)) {
            if (name.length === 0 || name.includes('\0') || name.includes('=')
                || entry !== undefined && (typeof entry !== 'string' || entry.includes('\0'))) return undefined
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
        if (declaresNothingToRun(loaded.result.config.environment)) return Object.freeze({ kind: 'refusal' as const,
            status: 2 as const, result: null, diagnostics: Object.freeze([runtimeNotDeclared(loaded.result.source.path)]) })
        const setupEnvironment = Object.freeze(Object.fromEntries(Object.entries(input.env)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')))
        const git = await resolveGitExecutable(input.env)
        if (git.state !== 'available') return refusal(loaded.result.source.path, git.reason)
        const observedAt = new Date().toISOString()
        const checkoutObservation = await observeSetupCheckout({
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            observedAt,
            env: setupEnvironment,
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
            env: setupEnvironment,
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
            checkoutRoot: dirname(loaded.result.source.path),
            siblingsRoot: resolve(dirname(loaded.result.source.path), loaded.result.config.cockpit.siblings_root),
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
        if (!projection || projection.sourceSha256 !== context.source.sha256 || projection.runtimeSha256 !== context.runtimeSha256
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
            return reject(executables.target, executables.message, executables.code)
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
            if (planned.kind !== 'complete') return reject(planned.target, planned.message, planned.code)
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
        const data = generated?.data
        if (!binding?.generatedRuntime || !generated || !data || binding.generatedApplication !== projection
            || generatedApplicationProjection(projection) !== projection) {
            return leafRefusal<DataModeExecutionResult | import('./contract.js').EnvironmentObservation>(
                'generated-data', 'generated data authority is unavailable')
        }
        const durable = await readDataModeOutcome({
            namespace: context.namespace,
            stackId: context.stackId,
            configSha256: context.runtimeSha256,
            generation: projection.generation,
            mode: data.default_mode,
        })
        const runtimeAuthority = projectGeneratedApplicationRuntimeAuthority(projection, {
            topology: runtime.topology, runtime: binding.generatedRuntime,
        })
        if (!runtimeAuthority) return leafRefusal<DataModeExecutionResult | import('./contract.js').EnvironmentObservation>(
            'generated-data', `generated data runtime authority is unavailable; current runtime identities and ports cannot be authenticated — fix: ${cockpitCommand('up', { config: context.source.path })}`)
        const planned = await withLifecycleConfiguration(context, async (configuration) => planDataMode({
            environment: generated,
            mode: data.default_mode,
            checkoutRoot: binding.checkoutRoot,
            includeFixtureVolume: false,
            namespace: context.namespace,
            stackId: context.stackId,
            holderId: context.holderId,
            configuration,
            generation: projection.generation,
            observedAt: new Date().toISOString(),
            runtimeAuthority,
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

    const withRuntimeReadiness: LifecycleCommandAdapterComposition['withRuntimeReadiness'] = (context, use, ports, refuse, purpose) =>
        runtimeReadiness(context, use, ports, refuse, purpose)

    // `resolvedMounts` is set only on a teardown retry: stopping or removing a stack must not depend
    // on its mounts matching cockpit.toml, or a stack whose declaration drifted could never be retired.
    const runtimeReadiness = async <T>(
        context: LifecycleRunContext,
        use: (runtime: LifecycleRuntimeReadiness) => Promise<T>,
        ports: PortLeaseProjection | undefined,
        refuse: ReadinessRefusal<T> | undefined,
        purpose: RuntimeReadinessPurpose | undefined,
        resolvedMounts?: readonly string[],
    ): Promise<T | undefined> => {
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
                // Runtime readiness authenticates the current runtime. The lifecycle application
                // owns comparison with persisted progress and can name a generated-identity change;
                // hiding it here turns an actionable mismatch into a generic missing-authority error.
                if (!decoded) return undefined
            } else if (stored.kind !== 'missing') return undefined
        }
        binding = bindings.get(context)
        if (!binding) return undefined
        const currentBinding = binding
        // The machine floor bounds cold start and host capacity; without it there is nothing to hold
        // the runtime to, so say which table is missing instead of a generic evidence refusal.
        const machine = currentBinding.config.environment.machine
        if (!machine) {
            return refuse?.(ownerDiagnostics(ENVIRONMENT_CODES.CONFIG_SCHEMA_INVALID,
                'cockpit.toml declares no [environment.machine] table; runtime commands need its runtime_memory_mb, runtime_cpus, free_disk_mb and cold_start_seconds',
                'environment.machine'))
        }
        const env = runtimeEnvironment(input.env)
        const docker = await resolveDockerExecutable(input.env)
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
        const measured = admitRuntimeMeasurement(observed, await readLocalRuntimeMeasurements(currentBinding.checkoutRoot))
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
            const sources = await projectGeneratedApplicationMountSources(generatedApplication)
            if (!sources) return undefined
            if ('kind' in sources) return refuse?.(ownerDiagnostics(ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE,
                `generated host input must be an ordinary ${sources.expectedType} without symbolic-link components; missing, unreadable or wrong-type inputs cannot be handed to Docker; restore or create the declared input, then rerun ${cockpitCommand('up')}`,
                sources.path))
            expectedMountSources = sources
        } else {
            const declared = await composeArtifacts(currentBinding.checkoutRoot, currentBinding.config.environment.compose_files)
            if (!declared) return undefined
            // The cockpit's own Compose files carry no ownership labels; the override `sync`
            // publishes adds them, and it is admitted only while it equals a fresh render.
            const ownership = renderComposeOwnership({
                sources: declared.map(({ reference, source }) => ({ reference, source })),
                stackId: context.stackId, cockpitId: context.cockpitId, configSha256: context.runtimeSha256,
            })
            if (ownership.kind !== 'complete') return refuse?.(ownerDiagnostics(ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE,
                `the ownership override cannot be rendered from environment.compose_files: ${ownership.reason}`, ownership.target))
            const override = await composeArtifact(currentBinding.checkoutRoot, COMPOSE_OWNERSHIP_FILE,
                createHash('sha256').update(ownership.bytes).digest('hex'))
            if (!override) return refuse?.(ownerDiagnostics(ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE,
                `${COMPOSE_OWNERSHIP_FILE} is missing or does not match the current Compose files and cockpit.toml; run ${cockpitCommand('sync')}`,
                COMPOSE_OWNERSHIP_FILE))
            artifacts = Object.freeze([...declared, override])
            expectedMountSources = Object.freeze([...new Set([
                ...currentBinding.config.sibling
                    .filter((sibling) => sibling.mount === 'always')
                    .map((sibling) => resolve(currentBinding.siblingsRoot, sibling.dir)),
                ...currentBinding.config.environment.generated_host_paths
                    .map((path) => resolve(currentBinding.checkoutRoot, path)),
            ])].sort())
        }
        if (!artifacts || artifacts.length === 0) return undefined
        if (resolvedMounts) expectedMountSources = resolvedMounts
        const siblingDirectories = Object.freeze(Object.fromEntries(currentBinding.config.sibling
            .map((sibling) => [sibling.var, resolve(currentBinding.siblingsRoot, sibling.dir)])))
        const batchId = randomBytes(32).toString('hex')
        const runtime = createRuntimeAdapter({
            runtime: observed.runtime,
            composeVersion: observed.composeVersion,
            executable: docker.value,
            operation: 'validate',
            cwd: currentBinding.checkoutRoot,
            composeFiles: artifacts,
            projectName: composeProjectName({ cockpitName: currentBinding.config.cockpit.name, stackId: context.stackId }),
            env,
            ports: ports ? Object.freeze(Object.values(ports.lease.ports)) : Object.freeze([]),
            labels: { stackId: context.stackId, cockpitId: context.cockpitId, configSha256: context.runtimeSha256, batchId },
            timeoutMs: input.timeoutMs,
            stackId: context.stackId,
            coldStartLimitMillis: machine.cold_start_seconds * 1_000,
            expectedMountSources,
            activeProfiles,
        }, generatedApplication?.generatedComposeAuthority && ports ? {
            generatedComposeAuthority: generatedApplication.generatedComposeAuthority,
            portLeaseProjection: ports,
        // A compose-first stack reads its host ports from the [ports.bases] variables and its
        // sibling checkouts from the [[sibling]] var variables, so both reach Compose as those
        // variables instead of the `${VAR:-default}` fallback. A generated file writes each sibling
        // path literally and its runtime authority admits only leased ports, so it gets neither
        // the sibling variables nor a use for them.
        } : !generated ? { ownComposeFiles: true as const, cockpitId: context.cockpitId, stackId: context.stackId,
            ...(ports ? { portLeaseProjection: ports } : {}), siblingDirectories } : undefined)
        if (runtime.kind !== 'preview') return runtime.kind === 'refusal' ? refuse?.(runtime.diagnostics) : undefined
        const startedAt = new Date().toISOString()
        const topologyPlan = createRuntimeTopologyPlan({
            runtimePlan: runtime.plan,
            stackId: context.stackId,
            configSha256: context.runtimeSha256,
            batchId,
            observationWindow: {
                startedAt,
                expiresAt: new Date(Date.parse(startedAt) + MAX_TOPOLOGY_OBSERVATION_WINDOW_MS).toISOString(),
            },
        })
        if (topologyPlan.kind !== 'planned') return undefined
        const topologyOutcome = await execute(topologyPlan.step)
        const topology = admitRuntimeTopology({ plan: topologyPlan, outcome: topologyOutcome })
        if (topology.kind !== 'complete') {
            const mismatch = topology.mounts
            if (!mismatch) return undefined
            if (purpose === 'teardown' && !resolvedMounts) {
                const resolved = [...expectedMountSources.filter((source) => !mismatch.missing.includes(source)), ...mismatch.unexpected].sort()
                return runtimeReadiness(context, use, ports, refuse, purpose, Object.freeze(resolved))
            }
            return refuse?.(mountMismatchDiagnostics(mismatch, currentBinding.config, currentBinding.siblingsRoot))
        }
        if (purpose !== 'teardown') {
            const redirected = await redirectedBindSources(
                topology.topology.services.flatMap(({ bindMountSources }) => bindMountSources), expectedMountSources)
            if (redirected.length > 0) return refuse?.(redirectedMountDiagnostics(redirected, currentBinding.config, currentBinding.siblingsRoot))
        }
        if (generatedApplication) {
            const step = runtime.plan.steps[0]
            const publicEnv = projectRuntimeExecutionEnvironment(topology.topology)
            if (!step || !publicEnv) return undefined
            const generatedRuntime: GeneratedObservationRuntime = Object.freeze({
                root: currentBinding.checkoutRoot,
                executable: docker.value,
                composeFiles: Object.freeze(artifacts.map(({ canonicalPath: path, sha256 }) => Object.freeze({ path, sha256 }))),
                projectName: composeProjectName({ cockpitName: currentBinding.config.cockpit.name, stackId: context.stackId }),
                publicEnv,
                stdoutLimitBytes: step.stdoutLimitBytes,
                stderrLimitBytes: step.stderrLimitBytes,
            })
            bindings.set(context, Object.freeze({ ...currentBinding, generatedRuntime }))
        }
        const disk = await resolveDiskCapacityExecutable()
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
            resolveDockerExecutable(input.env),
            resolveDiskCapacityExecutable(),
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
        const acquired = await acquirePortProjection({
            namespace: context.namespace,
            stackId: context.stackId,
            holderId: context.holderId,
            checkoutId: context.checkoutId,
            config: context.ports,
            now,
            listenerTimeoutMs,
            listenerEvidence: await listenerEvidence(context, now, listenerTimeoutMs),
            declarations: context.entrypointDerivatives,
        })
        if (acquired.kind === 'refusal') return refuse?.(acquired.diagnostics)
        if (acquired.kind !== 'complete') return undefined
        let retainOnFailure = false
        const compensationFailure = (error: unknown, cleanup: unknown) => {
            const detail = (value: unknown) => value instanceof Error
                && value.message.length > 0 && value.message.length <= 512
                ? value.message.split('\n', 1)[0]!
                : 'unknown failure'
            return new AggregateError(
                [error, cleanup],
                `downstream port preparation failed: ${detail(error)}; acquired-holder compensation failed: ${detail(cleanup)}`,
            )
        }
        try {
            return await use(Object.freeze({
                leaseResult: acquired.leaseResult,
                projection: acquired.projection,
                retainOnFailure: () => { retainOnFailure = true },
            }))
        } catch (error) {
            if (!retainOnFailure && acquired.leaseResult.kind === 'complete' && acquired.leaseResult.change === 'acquired') {
                let compensated: Awaited<ReturnType<typeof compensateAcquiredPortHolder>>
                try {
                    compensated = await compensateAcquiredPortHolder({ namespace: context.namespace,
                        leaseResult: acquired.leaseResult, now: new Date().toISOString() })
                } catch (cleanup) {
                    throw compensationFailure(error, cleanup)
                }
                if (compensated.kind !== 'complete') {
                    const cleanup = new Error(compensated.diagnostics
                        .map(({ code, message, target }) => `${code}: ${message}${target ? ` (${target})` : ''}`).join('; '))
                    throw compensationFailure(error, cleanup)
                }
            }
            throw error
        }
    }

    return Object.freeze({ load, execute, prepareGeneratedEnvironment, completeGeneratedEnvironment, completeGeneratedDependencies, completeGeneratedData, completeGeneratedVendors, withRuntimeReadiness, withGeneratedRuntime, withMachineFloorReadiness, withLifecycleStage, withAcquiredPorts })
}
