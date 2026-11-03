import { lstat, realpath } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { loadCockpitConfig } from '../config/load.js'
import { cockpitCommand } from '../fix-catalogue.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import {
    decodeLifecycleRecord,
    revalidateService,
    type DoctorCommandAdapters,
    type HealthObservationProducers,
    type PreflightCommandAdapters,
    type RuntimeReadiness,
    withLifecycleConfiguration,
} from './application.js'
import { decodeCoordinationRecord, observeClaimState, readRootPortInventory } from './claims.js'
import { inspectCodexHookTrust } from './codex-hook-trust.js'
import { observeEnvSchemas } from './env-schema-observation.js'
import {
    hasErrorCode,
    RefusalError,
    ENVIRONMENT_CODES,
    errorCause,
    type EnvironmentDiagnostic,
    type EnvironmentObservation,
    type ExecutionStep,
} from './contract.js'
import { declaresNothingToRun, runtimeNotDeclared } from './declaration.js'
import { resolveDockerExecutable, resolveExecutablePath, resolveGitExecutable } from './executable.js'
import {
    observeExternalDependencies,
    observeExternalDependency,
    planExternalDependency,
    verifyExternalDependency,
} from './external-dependencies.js'
import { createGitObservationStep, observeGit, observeRunningCheckout } from './git-observation.js'
import { inspectProjectReadiness } from './readiness-composition.js'
import { stackId } from './identity.js'
import { observeDependencyLoad } from './installs.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { observeStateSeed, resolveLifecycleStage } from './lifecycle-stage.js'
import { refreshObservationPostures, resolveObservationPostures, type PreflightContext } from './observations.js'
import {
    deriveEntrypoints,
    observeRetainedPortFamily,
    projectRetainedPortFamilyResult,
    revalidatePortLeaseProjection,
} from './ports.js'
import {
    admitDependencyRuntime,
    createDependencyRuntimePlan,
} from './dependency-runtime.js'
import {
    observeDataMode,
    planDataMode,
    projectDataModeObservationSteps,
    readDataModeOutcome,
} from './data-plane.js'
import {
    generatedApplicationProjection,
    projectGeneratedApplicationRuntimeAuthority,
    resolveGeneratedApplicationOperation,
    checkGeneratedEnvironment,
    observeGeneratedApplicationHealth,
    observeGeneratedApplicationSurfaces,
    syncGeneratedEnvironment,
} from './generated-application.js'
import {
    admitRuntimeMeasurement,
    observeDockerRuntime,
    observeRuntimeMeasurement,
    observeRuntimeMountMaterialization,
    observeRuntimePortFamily,
    projectDependencyRuntime,
    type RuntimeServiceEvidence,
} from './runtime.js'
import { readLocalRuntimeMeasurements } from './runtime-measurement-record.js'
import {
    consumeSetupCheckoutProjection,
    observeSetupCheckout,
    withSetupCheckoutProjection,
    type ConsumedSetupCheckoutObservation,
} from './setup-observation.js'
import { observeConfiguration, readState, selectStateRoot, type StateNamespace } from './state.js'
import {
    externalDependencyTemplateFragments,
    inspectEnvironmentKeys,
    observeTemplateHealth,
} from './templates.js'

export const mechanism = {
    id: 'health-command-composition',
    module: 'packages/cockpit/src/environment/health-composition.ts',
    exports: ['createHealthCommandAdapters'],
} as const

export interface HealthCommandCompositionInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly timeoutMs: number
}

export type HealthCommandAdapterComposition = PreflightCommandAdapters & DoctorCommandAdapters

interface CapturedInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly timeoutMs: number
}

function captureInput(value: HealthCommandCompositionInput): CapturedInput | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const keys = ['configPath', 'env', 'timeoutMs']
        if (Reflect.ownKeys(descriptors).length !== keys.length
            || keys.some((key) => !descriptors[key] || !('value' in descriptors[key]!))) return undefined
        const configPath = descriptors.configPath!.value
        const rawEnvironment = descriptors.env!.value
        const timeoutMs = descriptors.timeoutMs!.value
        if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0')
            || typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
            || !rawEnvironment || typeof rawEnvironment !== 'object' || Array.isArray(rawEnvironment)) return undefined
        const env: Record<string, string | undefined> = {}
        for (const [name, entry] of Object.entries(rawEnvironment as Record<string, unknown>)) {
            if (name.length === 0 || name.includes('\0') || name.includes('=')
                || entry !== undefined && (typeof entry !== 'string' || entry.includes('\0'))) return undefined
            env[name] = entry
        }
        return Object.freeze({ configPath: resolve(configPath), env: Object.freeze(env), timeoutMs })
    } catch {
        // A throwing accessor or proxy trap makes the input malformed, which the caller refuses.
        return undefined
    }
}

function gitObservationEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(Object.entries(env)
        .filter((entry): entry is [string, string] =>
            (entry[0] === 'LANG' || entry[0] === 'LC_ALL' || entry[0] === 'TZ') && typeof entry[1] === 'string')))
}

function checkoutObservationEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(Object.entries(env)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')))
}

function commandConfigPath(value: unknown): string | undefined {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const descriptor = descriptors.configPath
        return Reflect.ownKeys(descriptors).length === 1 && descriptor && 'value' in descriptor
            && typeof descriptor.value === 'string'
            ? descriptor.value
            : undefined
    } catch {
        // A throwing accessor or proxy trap makes the command malformed, which the caller refuses.
        return undefined
    }
}

// `sleep` releases the last holder and stops the services, so every runtime probe after it fails;
// reporting that as missing observation evidence hid the one command that brings the stack back.
async function sleepingStack(
    namespace: Extract<Awaited<ReturnType<typeof selectStateRoot>>, { readonly kind: 'complete' }>['value'],
    stack: ReturnType<typeof stackId>,
    configPath: string,
): Promise<EnvironmentDiagnostic | undefined> {
    const stored = await readState(namespace.paths.coordination(stack))
    if (stored.kind !== 'complete') return undefined
    const coordination = decodeCoordinationRecord(stored.value, stack)
    if (!coordination || coordination.holders.length > 0) return undefined
    const fix = cockpitCommand('up', { config: configPath })
    return Object.freeze({
        severity: 'error' as const, code: ENVIRONMENT_CODES.STACK_NOT_RUNNING, target: stack,
        message: 'the stack is asleep: no session holds it and its services are stopped, so there is nothing running to check; run up to start it, then rerun this command',
        fix,
    })
}

// Before the first `up` doctor still measures the machine, so a missing runtime is named there
// rather than first at bring-up.
function runtimeUnavailable(reason: string, target: string): EnvironmentDiagnostic {
    return Object.freeze({
        severity: 'error' as const,
        code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE,
        message: `the container runtime that runs this stack is not usable on this machine: ${reason}`,
        target,
        fix: 'install or start Docker so that docker info succeeds, then rerun this command',
    })
}

function producers(input: {
    readonly checkout: ConsumedSetupCheckoutObservation
    readonly config: Awaited<ReturnType<typeof loadCockpitConfig>> & { readonly kind: 'complete' }
    readonly namespace: Extract<Awaited<ReturnType<typeof selectStateRoot>>, { readonly kind: 'complete' }>['value']
    readonly stack: ReturnType<typeof stackId>
    readonly git: Extract<Awaited<ReturnType<typeof resolveGitExecutable>>, { readonly state: 'available' }>['value']
    readonly env: Readonly<Record<string, string | undefined>>
    readonly timeoutMs: number
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
    // Why the running stack could not be read (a configuration edited since `up`, say) reaches the
    // command through here instead of surfacing only as missing evidence.
    readonly refuse?: (diagnostics: readonly EnvironmentDiagnostic[]) => undefined
    // No stack runs (never brought up, asleep, or no runtime declared): every row that needs none is
    // still observed, from the declaration and the machine, and the rest are left to the evaluation.
    readonly stopped: boolean
    // Refusals met on the way that explain missing evidence (no container runtime, for one).
    readonly notice: (diagnostics: readonly EnvironmentDiagnostic[]) => void
}): Readonly<{ observations: HealthObservationProducers; revalidate: () => Promise<boolean> }> {
    const observedAt = () => new Date().toISOString()
    const siblingRoot = resolve(dirname(input.config.result.source.path), input.config.result.config.cockpit.siblings_root)
    const generated = input.config.result.config.environment.generated
    const declaresStack = generated !== undefined || input.config.result.config.environment.compose_files.length > 0
    const runningStack = declaresStack && !input.stopped
    // Only doctor reaches here for a cockpit that declares nothing to run; a mounted sibling there
    // gives Docker nothing to do, so a missing runtime must not be reported as a gap.
    const configuredRuntime = !declaresNothingToRun(input.config.result.config.environment)
    const runtimeMeasurement = configuredRuntime && !runningStack ? (async () => {
        const docker = await resolveDockerExecutable(input.env)
        if (docker.state !== 'available') {
            if (input.stopped) input.notice([runtimeUnavailable(docker.reason, input.stack)])
            return undefined
        }
        const observed = await observeDockerRuntime({
            executable: docker.value,
            cwd: input.checkout.currentCheckoutPath,
            env: Object.freeze(Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] =>
                ['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(entry[0])
                && typeof entry[1] === 'string',
            ))),
            timeoutMs: input.timeoutMs,
        }, input.execute)
        if (observed.kind !== 'complete') return undefined
        return observeRuntimeMeasurement(
            admitRuntimeMeasurement(observed, await readLocalRuntimeMeasurements(input.namespace.root)),
            input.stack,
        )
    })() : undefined
    const runtimeSession = runningStack ? (async () => {
        const adapters = createLifecycleCommandAdapters({
            configPath: input.config.result.source.path,
            env: input.env,
            sessionId: 'cockpit-health-read-only',
            timeoutMs: input.timeoutMs,
        }, input.execute)
        const loaded = await adapters.load({ configPath: input.config.result.source.path })
        if (loaded.kind === 'refusal') return input.refuse?.(loaded.diagnostics)
        if (loaded.kind !== 'complete' || loaded.result.stackId !== input.stack) return undefined
        const stored = await readState(loaded.result.namespace.paths.lifecycle(loaded.result.stackId))
        if (stored.kind !== 'complete') return undefined
        const lifecycle = decodeLifecycleRecord(stored.value, loaded.result)
        if (!lifecycle || generated !== undefined && (!lifecycle.value.generatedReplay
            || lifecycle.value.generatedReplay.runtimeSha256 !== loaded.result.runtimeSha256)) return undefined
        const retained = await observeRetainedPortFamily({
            namespace: loaded.result.namespace,
            stackId: loaded.result.stackId,
            holderId: lifecycle.value.holderId,
            checkoutId: loaded.result.checkoutId,
            config: loaded.result.ports,
        })
        if (retained.kind !== 'complete') return undefined
        const entrypoints = deriveEntrypoints({ lease: retained.lease, declarations: loaded.result.entrypointDerivatives })
        if (entrypoints.kind !== 'complete') return undefined
        const ports = await projectRetainedPortFamilyResult({ retainedResult: retained, entrypointResult: entrypoints })
        if (!ports) return undefined
        const readiness = await adapters.withRuntimeReadiness<RuntimeReadiness | undefined>(loaded.result, async (value) => value, ports,
            (diagnostics) => input.refuse?.(diagnostics))
        return readiness ? Object.freeze({ adapters, context: loaded.result, readiness, lifecycle, ports,
            lifecycleSnapshot: JSON.stringify(stored.value) }) : undefined
    })() : undefined
    const stableSession = async () => {
        const session = await runtimeSession
        if (!session) return undefined
        const [configuration, stored, leaseCurrent] = await Promise.all([
            loadCockpitConfig(input.config.result.source.path),
            readState(session.context.namespace.paths.lifecycle(session.context.stackId)),
            revalidatePortLeaseProjection({ projection: session.ports, namespace: session.context.namespace }),
        ])
        return configuration.kind === 'complete' && configuration.result.source.sha256 === input.config.result.source.sha256
            && stored.kind === 'complete' && JSON.stringify(stored.value) === session.lifecycleSnapshot && leaseCurrent
            ? session : undefined
    }
    const generatedRuntime = generated === undefined ? undefined : (async () => {
        const session = await runtimeSession
        return session?.adapters.withGeneratedRuntime(session.context, session.readiness, async (value) => value)
    })()
    const checkedApplication = (async () => {
        if (generated !== undefined && runningStack) return (await generatedRuntime)?.application
        const session = await runtimeSession
        if (runningStack && !session) return undefined
        const checked = await checkGeneratedEnvironment({ configPath: input.config.result.source.path }, session?.ports,
            { execute: input.execute })
        return checked.kind === 'complete' ? generatedApplicationProjection(checked.result.application) : undefined
    })()
    const machineFloor = !runningStack && input.config.result.config.environment.machine ? (async () => {
            const adapters = createLifecycleCommandAdapters({
                configPath: input.config.result.source.path,
                env: input.env,
                sessionId: 'cockpit-health-machine-floor',
                timeoutMs: input.timeoutMs,
            }, input.execute)
            const loaded = await adapters.load({ configPath: input.config.result.source.path })
            if (loaded.kind !== 'complete' || loaded.result.stackId !== input.stack) return undefined
            return adapters.withMachineFloorReadiness(loaded.result, async (value) => value,
                (diagnostics) => { input.notice(diagnostics); return undefined })
        })() : undefined
    const inspectCurrentServices = async () => {
        const session = await stableSession()
        const completed = session?.lifecycle.value.completedServices
        if (!session || !completed
            || completed.length !== session.readiness.topology.services.length
            || JSON.stringify(completed.map(({ service }) => service).sort())
                !== JSON.stringify(session.readiness.topology.services.map(({ id }) => id).sort())) return undefined
        const values = new Map<string, RuntimeServiceEvidence>()
        for (const service of completed) {
            const admitted = await revalidateService(session.readiness.topology, service, { execute: input.execute })
            if (admitted.kind !== 'complete') return undefined
            values.set(service.service, admitted.evidence)
        }
        return await stableSession() ? values : undefined
    }
    const currentServices = runningStack ? inspectCurrentServices() : undefined
    const observations: HealthObservationProducers = Object.freeze({
        surfaces: async () => {
            const application = await checkedApplication
            const observations = application && observeGeneratedApplicationSurfaces(application)
            if (!observations) throw new RefusalError('surface health needs a current checked generated publication; run npx --no cockpit sync --config <your cockpit.toml>')
            return observations
        },
        generated: async () => {
            if (generated === undefined || !runningStack) return Object.freeze([])
            const [session, prepared] = await Promise.all([runtimeSession, generatedRuntime])
            if (!session || !prepared) throw new RefusalError('generated health needs authenticated runtime readiness')
            const observations = await observeGeneratedApplicationHealth(prepared.application,
                { topology: session.readiness.topology, runtime: prepared.runtime }, input.execute)
            if (!observations || !await stableSession()) throw new RefusalError('generated environment observation is unavailable or changed')
            return Object.freeze([observations.environment, observations.registryAuthentication])
        },
        data: async () => {
            const data = generated?.data
            if (generated === undefined || data === undefined || !runningStack) return Object.freeze([])
            const session = await runtimeSession
            const lifecycle = session?.lifecycle
            if (!session || !lifecycle) throw new RefusalError('data health needs authenticated runtime readiness')
            const observation = await session.adapters.withGeneratedRuntime(
                session.context,
                session.readiness,
                async ({ application, runtime }) => {
                    const projection = await readDataModeOutcome({
                        namespace: session.context.namespace,
                        stackId: session.context.stackId,
                        configSha256: application.runtimeSha256,
                        generation: application.generation,
                        mode: data.default_mode,
                    })
                    if (!projection) return undefined
                    const runtimeAuthority = projectGeneratedApplicationRuntimeAuthority(application, {
                        topology: session.readiness.topology, runtime,
                    })
                    if (!runtimeAuthority) throw new RefusalError(`generated data runtime authority is unavailable; current runtime identities and ports cannot be authenticated — fix: ${cockpitCommand('up', { config: session.context.source.path })}`)
                    const planned = await withLifecycleConfiguration(session.context, async (configuration) => planDataMode({
                        environment: generated,
                        mode: data.default_mode,
                        checkoutRoot: runtime.root,
                        includeFixtureVolume: data.default_mode === 'seeded' && data.fixtures !== undefined,
                        namespace: session.context.namespace,
                        stackId: session.context.stackId,
                        holderId: lifecycle.value.holderId,
                        configuration,
                        generation: application.generation,
                        observedAt: observedAt(),
                        runtimeAuthority,
                        resolve: (operation, context) => {
                            const step = resolveGeneratedApplicationOperation(
                                application,
                                { topology: session.readiness.topology, runtime },
                                operation,
                                context,
                            )
                            if (!step) throw new RefusalError('generated data probe authority is unavailable')
                            return step
                        },
                    }))
                    if (!planned || planned.kind !== 'preview') return undefined
                    const probeSteps = projectDataModeObservationSteps({ plan: planned.plan, projection })
                    if (!probeSteps) return undefined
                    const outcomes = await Promise.all(probeSteps.map((step) => input.execute(step)))
                    return observeDataMode({ plan: planned.plan, projection, outcomes: Object.freeze(outcomes) })
                },
            )
            if (!observation) throw new RefusalError('data health observation is unavailable')
            return Object.freeze([observation])
        },
        external: async () => {
            if (generated === undefined || generated.vendors.length === 0 || !runningStack) return Object.freeze([])
            const [session, services] = await Promise.all([runtimeSession, currentServices])
            if (!session || !services) throw new RefusalError('external dependency health needs current runtime services')
            const observation = await session.adapters.withGeneratedRuntime(
                session.context,
                session.readiness,
                async ({ application, runtime }) => {
                    const observations = []
                    for (const vendor of generated.vendors) {
                        const service = vendor.egress_guard === undefined
                            ? undefined : services.get(vendor.egress_guard.local_service)
                        if (vendor.egress_guard !== undefined && !service) return undefined
                        const vendorRuntime = service === undefined ? runtime : Object.freeze({
                            ...runtime,
                            serviceAuthority: Object.freeze({ topology: session.readiness.topology, evidence: service }),
                        })
                        const authority = projectGeneratedApplicationRuntimeAuthority(application, {
                            topology: session.readiness.topology,
                            runtime: vendorRuntime,
                        })
                        if (!authority) return undefined
                        const fragments = externalDependencyTemplateFragments(vendor)
                        if (fragments.kind !== 'complete') return undefined
                        const presentShadowFiles = []
                        for (const shadow of vendor.shadow_files ?? []) {
                            const sibling = input.config.result.config.sibling.find(({ slug }) => slug === shadow.sibling)
                            const declaration = sibling?.environment_files?.find(({ instance }) => instance === shadow.instance)
                            if (!sibling || !declaration) continue
                            const root = resolve(siblingRoot, sibling.dir)
                            const inspection = await inspectEnvironmentKeys({
                                siblingRoot: root,
                                templatePath: resolve(root, declaration.template),
                                instancePath: resolve(root, declaration.instance),
                            })
                            if (inspection.kind === 'fresh' || inspection.kind === 'stale') {
                                presentShadowFiles.push(Object.freeze({ sibling: shadow.sibling, instance: shadow.instance }))
                            }
                        }
                        const plan = planExternalDependency({
                            authority,
                            purpose: 'health',
                            declaration: vendor,
                            fragments,
                            runtime: vendorRuntime,
                            observedAt: observedAt(),
                            presentShadowFiles: Object.freeze(presentShadowFiles),
                        })
                        if (plan.kind !== 'complete') return undefined
                        const evidence = await verifyExternalDependency(plan, { execute: input.execute })
                        const projected = observeExternalDependency({ evidence, authority })
                        if (!projected) return undefined
                        observations.push(projected)
                    }
                    const aggregateAuthority = projectGeneratedApplicationRuntimeAuthority(application, {
                        topology: session.readiness.topology,
                        runtime,
                    })
                    return aggregateAuthority && generated.vendors.length > 0
                        ? observeExternalDependencies({
                            authority: aggregateAuthority,
                            observations: Object.freeze(observations),
                            purpose: 'health',
                        })
                        : undefined
                },
            )
            if (!observation) throw new RefusalError('external dependency health observation is unavailable')
            return Object.freeze([observation])
        },
        claims: async () => Object.freeze([await observeClaimState({
            namespace: input.namespace, stackId: input.stack, observedAt: observedAt(),
        })]),
        git: async () => {
            // Git status may refresh its index while checked publication authenticates checkout authority.
            await machineFloor
            await checkedApplication
            const step = createGitObservationStep({
                executable: input.git,
                checkoutRoot: input.checkout.currentCheckoutPath,
                env: gitObservationEnvironment(input.env),
                timeoutMs: input.timeoutMs,
                stackId: input.stack,
                source: input.config.result.source.path,
                checkoutId: input.checkout.checkoutId,
            })
            if (!step) throw new RefusalError('Git health observation could not be planned')
            const result = observeGit(step, await input.execute(step), {
                stackId: input.stack,
                checkoutId: input.checkout.checkoutId,
                source: input.config.result.source.path,
            })
            if (result.kind !== 'complete') throw new RefusalError('Git health observation is unavailable')
            if (!runningStack) return result.observations
            const session = await stableSession()
            if (!session) throw new RefusalError('running checkout health needs unchanged runtime and lifecycle authority')
            const time = observedAt()
            const setup = await observeSetupCheckout({ source: input.config.result.source,
                cockpitName: input.config.result.config.cockpit.name, observedAt: time,
                env: checkoutObservationEnvironment(input.env), gitExecutable: input.git })
            const running = await withSetupCheckoutProjection(setup, { source: input.config.result.source,
                cockpitName: input.config.result.config.cockpit.name, evaluatedAt: Date.parse(time) },
            (projection) => observeRunningCheckout(session.readiness.topology, projection, session.context.runtimeSha256, time))
            if (running?.kind !== 'complete') throw new RefusalError('running checkout identity observation is unavailable')
            return Object.freeze([...result.observations, running.observation])
        },
        host: async () => {
            if (input.config.result.config.environment.machine) {
                if (machineFloor) {
                    const current = await machineFloor
                    // A stopped stack's unusable runtime is already a notice that names why.
                    if (!current && input.stopped) return Object.freeze([])
                    if (!current) throw new RefusalError('configured host capacity needs authenticated machine-floor execution evidence')
                    return current
                }
                const current = await runtimeSession
                if (!current) throw new RefusalError('configured host capacity needs authenticated machine-floor execution evidence')
                return current.readiness.hostObservations
            }
            return Object.freeze([])
        },
        installs: async () => {
            const dependencies = input.config.result.config.sibling.filter(({ toolchain }) => toolchain !== 'none')
            if (dependencies.length === 0 || input.stopped) return Object.freeze([])
            const [session, services] = await Promise.all([runtimeSession, currentServices])
            if (!generated || !session || !services) {
                throw new RefusalError('configured dependency health needs authenticated generated runtime services')
            }
            const observations: EnvironmentObservation[] = []
            for (const sibling of dependencies) {
                const generatedServices = generated.services.filter(({ sibling: owner }) => owner === sibling.slug)
                if (generatedServices.length !== 1) throw new RefusalError(`dependency service identity is ambiguous for ${sibling.slug}`)
                const service = generatedServices[0]!
                const policies = service.mounts.flatMap((mount) => {
                    if (mount.kind !== 'volume') return []
                    const volume = generated.volumes.find(({ id }) => id === mount.source)
                    if (!volume || volume.purpose !== 'dependencies' || !volume.install_policy) return []
                    const policy = input.config.result.config.environment.install_policies.find((candidate) =>
                        candidate.volume === volume.install_policy && candidate.toolchain === sibling.toolchain)
                    return policy ? [{ policy, volume: volume.id }] : []
                })
                const serviceEvidence = services.get(service.id)
                if (policies.length !== 1 || !serviceEvidence) {
                    throw new RefusalError(`dependency runtime evidence is unavailable for ${sibling.slug}`)
                }
                const dependencyRuntime = projectDependencyRuntime({
                    topology: session.readiness.topology,
                    evidence: serviceEvidence,
                    service: service.id,
                    volume: policies[0]!.volume,
                })
                if (!dependencyRuntime) throw new RefusalError(`dependency runtime authority is unavailable for ${sibling.slug}`)
                const runtimePlan = createDependencyRuntimePlan({ runtime: dependencyRuntime })
                if (runtimePlan.kind !== 'planned') throw new RefusalError(runtimePlan.reason)
                const admitted = admitDependencyRuntime({
                    plan: runtimePlan,
                    inspectOutcome: await input.execute(runtimePlan.inspect),
                    architectureOutcome: await input.execute(runtimePlan.architecture),
                    abiOutcome: await input.execute(runtimePlan.abi),
                })
                if (admitted.kind !== 'complete') throw new RefusalError(admitted.reason)
                const load = policies[0]!.policy.load_probe
                if (load.length === 0) throw new RefusalError(`dependency load probe is empty for ${sibling.slug}`)
                const observation = await observeDependencyLoad({
                    binding: admitted.binding,
                    load: Object.freeze([...load]) as readonly [string, ...string[]],
                    env: Object.freeze({}),
                    timeoutMs: input.timeoutMs,
                    stdoutLimitBytes: 1_048_576,
                    stderrLimitBytes: 1_048_576,
                }, { execute: input.execute })
                if (!observation) throw new RefusalError(`dependency load observation is unavailable for ${sibling.slug}`)
                observations.push(observation)
            }
            return Object.freeze(observations)
        },
        lifecycle: async () => Object.freeze([await observeStateSeed({
            namespace: input.namespace, stackId: input.stack, observedAt: observedAt(),
        })]),
        ports: async () => {
            if (!runningStack) return Object.freeze([])
            const [session, services] = await Promise.all([stableSession(), currentServices])
            if (!session || !services) throw new RefusalError('runtime port health needs current lifecycle, lease and service identities')
            const observation = await observeRuntimePortFamily({ topology: session.readiness.topology,
                services: Object.freeze([...services.values()]), namespace: session.context.namespace,
                listenerTimeoutMs: input.timeoutMs,
                revalidate: async () => {
                    const fresh = await inspectCurrentServices()
                    if (!fresh) throw new RefusalError('runtime services or lifecycle changed during port observation')
                    return Object.freeze([...fresh.values()])
                } })
            return Object.freeze([observation])
        },
        runtime: async () => {
            if (!configuredRuntime) return Object.freeze([])
            if (!runningStack) {
                const measured = await runtimeMeasurement
                // A stopped stack's missing runtime is already a notice; its rows are left unobserved.
                if (!measured && input.stopped) return Object.freeze([])
                if (!measured) throw new RefusalError('configured runtime measurement needs authenticated runtime identity evidence')
                return Object.freeze([measured])
            }
            const [session, services] = await Promise.all([stableSession(), currentServices])
            if (!session || !services) throw new RefusalError('configured runtime health needs current runtime execution evidence')
            return Object.freeze([...session.readiness.runtimeObservations,
                observeRuntimeMountMaterialization({ topology: session.readiness.topology,
                    services: Object.freeze([...services.values()]), observedAt: observedAt() })])
        },
        envSchema: async () => Object.freeze(await observeEnvSchemas({
            stackId: input.stack,
            siblings: input.config.result.config.sibling.map((sibling) => ({
                slug: sibling.slug, dir: sibling.dir, root: resolve(siblingRoot, sibling.dir),
            })),
            env: input.env,
            timeoutMs: input.timeoutMs,
        }, { execute: input.execute })),
        state: async () => observeConfiguration({
            path: input.config.result.source.path, stackId: input.stack, observedAt: observedAt(),
        }),
        templates: async () => observeTemplateHealth({
            stackId: input.stack, observedAt: observedAt(), siblingRoot,
            siblings: input.config.result.config.sibling,
        }),
    })
    return Object.freeze({ observations, revalidate: async () => !runningStack || await stableSession() !== undefined })
}

async function checkoutProjection(
    input: CapturedInput,
    loaded: Extract<Awaited<ReturnType<typeof loadCockpitConfig>>, { readonly kind: 'complete' }>,
    git: Extract<Awaited<ReturnType<typeof resolveGitExecutable>>, { readonly state: 'available' }>['value'],
): Promise<ConsumedSetupCheckoutObservation | Readonly<{ failed: EnvironmentDiagnostic }> | undefined> {
    const observedAt = new Date().toISOString()
    const observed = await observeSetupCheckout({
        source: loaded.result.source,
        cockpitName: loaded.result.config.cockpit.name,
        observedAt,
        env: checkoutObservationEnvironment(input.env),
        gitExecutable: git,
    })
    // The owner's reason (for example, a cockpit root that is not a Git checkout) says what to do; dropping
    // it left preflight with only "observation source is unavailable".
    if (observed.state === 'failed') return Object.freeze({ failed: Object.freeze({ severity: 'error' as const,
        code: observed.code, message: observed.reason, target: loaded.result.source.path }) })
    return withSetupCheckoutProjection(observed, {
        source: loaded.result.source,
        cockpitName: loaded.result.config.cockpit.name,
        evaluatedAt: Date.parse(observedAt),
    }, consumeSetupCheckoutProjection)
}

// Work orders exist once workorders/ does, and from then on work review and work grade run the Codex CLI
// as the independent evaluator whichever agent tool did the work; doctor names a missing one before a
// grade fails on it.
async function inspectWorkEvaluator(root: string, env: Readonly<Record<string, string | undefined>>): Promise<readonly EnvironmentDiagnostic[]> {
    try { if (!(await lstat(join(root, 'workorders'))).isDirectory()) return Object.freeze([]) }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return Object.freeze([])
        throw error
    }
    // work review searches only canonical PATH directories, so doctor does too.
    for (const directory of (env.PATH ?? '').split(delimiter)) {
        if (!directory || !isAbsolute(directory) || resolve(directory) !== directory) continue
        let canonical: string
        try { canonical = await realpath(directory) } catch (error) {
            if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'EACCES')) continue
            throw error
        }
        if (canonical === directory && (await resolveExecutablePath(join(directory, 'codex'))).state === 'available') return Object.freeze([])
    }
    return Object.freeze([Object.freeze({
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'EVALUATOR_UNAVAILABLE' satisfies typeof ENVIRONMENT_CODES.EVALUATOR_UNAVAILABLE,
        message: 'this cockpit has work orders, but the Codex CLI (codex) is not on PATH, and work review and work grade run it as the independent evaluator',
        target: 'workorders',
        fix: 'install the Codex CLI with npm install -g @openai/codex, sign in with codex login, then run npx --no cockpit doctor --config <your cockpit.toml>',
    })])
}

export function createHealthCommandAdapters(
    rawInput: HealthCommandCompositionInput,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): HealthCommandAdapterComposition {
    const input = captureInput(rawInput)
    let selectedNamespace: StateNamespace | undefined
    const load: HealthCommandAdapterComposition['load'] = async (command, issue, refuse, purpose) => {
        const requestedPath = commandConfigPath(command)
        if (!input || typeof execute !== 'function' || typeof issue !== 'function'
            || requestedPath !== input.configPath) return undefined
        const loaded = await loadCockpitConfig(input.configPath)
        // A malformed cockpit.toml is the user's to fix, so the loader's own diagnostics reach them.
        if (loaded.kind === 'refusal') return refuse?.(loaded.diagnostics)
        if (loaded.kind !== 'complete') return undefined
        // Health is about a running stack or a machine floor; with neither declared it is not declared,
        // never healthy, and preflight refuses. Doctor still checks what such a cockpit does depend on:
        // its Git working tree, its siblings and its surfaces.
        const notDeclared = declaresNothingToRun(loaded.result.config.environment)
            ? runtimeNotDeclared(loaded.result.source.path) : undefined
        if (notDeclared && purpose !== 'doctor') return refuse?.([notDeclared])
        const git = await resolveGitExecutable(input.env)
        if (git.state !== 'available') return undefined
        const checkout = await checkoutProjection(input, loaded, git.value)
        if (checkout && 'failed' in checkout) return refuse?.([...notDeclared ? [notDeclared] : [], checkout.failed])
        if (!checkout || process.platform !== 'darwin' && process.platform !== 'linux') return undefined
        const namespace = await selectStateRoot({
            platform: process.platform,
            home: input.env.HOME,
            xdgStateHome: input.env.XDG_STATE_HOME,
            checkoutRoots: [checkout.currentCheckoutPath, checkout.mainCheckoutPath],
            cockpitId: checkout.cockpitId,
        })
        // Without the state root's own refusal, doctor reported only that its observation source
        // was unavailable, which named neither the directory nor why it could not be used.
        if (namespace.kind === 'refusal') return refuse?.([Object.freeze({ severity: 'error' as const,
            code: namespace.code, message: namespace.message, target: namespace.target })])
        if (namespace.kind !== 'complete') return undefined
        selectedNamespace = namespace.value
        const currentStack = stackId({
            cockpitId: checkout.cockpitId,
            checkoutId: checkout.checkoutId,
            variant: { kind: 'shared' },
        })
        let stopped: EnvironmentDiagnostic | null = notDeclared ?? null
        const refreshPreflight = async (previous?: PreflightContext): Promise<PreflightContext | undefined> => {
            const observedAt = new Date().toISOString()
            const configuration = (await observeConfiguration({
                path: loaded.result.source.path,
                stackId: currentStack,
                observedAt,
            })).find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)
            if (!configuration) return undefined
            try {
                const authorityInput = {
                    configuration, cockpitId: checkout.cockpitId,
                    checkoutPath: checkout.currentCheckoutPath, variant: { kind: 'shared' as const },
                }
                const authority = previous === undefined
                    ? await resolveObservationPostures(authorityInput)
                    : previous.authorities.length === 1
                        ? await refreshObservationPostures({ ...authorityInput, previous: previous.authorities[0]! })
                        : undefined
                if (!authority) return undefined
                const stage = await resolveLifecycleStage({
                    namespace: namespace.value,
                    stackId: currentStack,
                    observedAt,
                })
                if (stage.kind !== 'complete') return refuse?.(stage.diagnostics)
                if (previous === undefined && !notDeclared) {
                    if (stage.authority.stage !== 'steady') {
                        const fix = cockpitCommand('up', { config: loaded.result.source.path })
                        stopped = Object.freeze({
                            severity: 'error' as const, code: ENVIRONMENT_CODES.STATE_UNSEEDED, target: loaded.result.source.path,
                            message: `lifecycle is still in bootstrap — the stack has never completed a first bring-up, so only the checks that need no running stack ran; fix: ${fix}; then retry the command that stopped`,
                            fix,
                        })
                    } else stopped = await sleepingStack(namespace.value, currentStack, loaded.result.source.path) ?? null
                }
                return Object.freeze({
                authorities: Object.freeze([authority]),
                stages: Object.freeze([stage.authority]),
            })
            } catch (error) {
                return refuse?.([Object.freeze({
                    severity: 'error' as const, code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
                    message: `preflight evidence could not be read: ${errorCause(error)}`, target: loaded.result.source.path,
                })])
            }
        }
        const preflight = await refreshPreflight()
        if (!preflight) return undefined
        const notices: EnvironmentDiagnostic[] = []
        const sourceProducers = producers({
            checkout,
            config: loaded,
            namespace: namespace.value,
            stack: currentStack,
            git: git.value,
            env: input.env,
            timeoutMs: input.timeoutMs,
            execute,
            ...(refuse ? { refuse: (diagnostics: readonly EnvironmentDiagnostic[]) => refuse(diagnostics) } : {}),
            stopped: stopped !== null,
            notice: (diagnostics) => {
                for (const diagnostic of diagnostics) {
                    if (!notices.some(({ code, target }) => code === diagnostic.code && target === diagnostic.target)) notices.push(diagnostic)
                }
            },
        })
        const secondObservedAt = new Date().toISOString()
        const secondObservation = await observeSetupCheckout({
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            observedAt: secondObservedAt,
            env: checkoutObservationEnvironment(input.env),
            gitExecutable: git.value,
        })
        return withSetupCheckoutProjection(secondObservation, {
            source: loaded.result.source,
            cockpitName: loaded.result.config.cockpit.name,
            evaluatedAt: Date.parse(secondObservedAt),
        }, (projection) => issue({
            checkout: projection,
            configuration: loaded.result,
            preflight,
            env: gitObservationEnvironment(input.env),
            gitExecutable: git.value,
            timeoutMs: input.timeoutMs,
            producers: sourceProducers.observations,
            refreshPreflight: async (previous) => await sourceProducers.revalidate() ? refreshPreflight(previous) : undefined,
            stopped,
            notices: () => Object.freeze([...notices]),
        }))
    }
    const inspectSurfaceOverrides: NonNullable<HealthCommandAdapterComposition['inspectSurfaceOverrides']> = async (configPath) => {
        if (!input) {
            return Object.freeze({
                kind: 'unavailable',
                code: 'SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE',
                reason: 'surface override inspection needs valid command composition input',
            })
        }
        if (configPath !== input.configPath) {
            return Object.freeze({
                kind: 'refusal',
                code: 'SURFACE_OVERRIDE_INSPECTION_PATH_MISMATCH',
                reason: 'surface override inspection is bound to the configured cockpit source',
            })
        }
        try {
            const outcome = await syncGeneratedEnvironment(
                { configPath: input.configPath, dryRun: true },
                { execute },
            )
            if (outcome.kind !== 'complete') {
                const diagnostic = outcome.diagnostics[0]
                return Object.freeze({
                    kind: 'refusal',
                    code: diagnostic?.code || 'SURFACE_OVERRIDE_INSPECTION_REFUSED',
                    reason: diagnostic?.message || 'generated surface override inspection was refused',
                })
            }
            const application = generatedApplicationProjection(outcome.result.application)
            if (!application
                || application.sourceSha256 !== outcome.result.sourceSha256
                || application.generation !== outcome.result.generation) {
                return Object.freeze({
                    kind: 'refusal',
                    code: 'SURFACE_OVERRIDE_INSPECTION_INVALID',
                    reason: 'generated surface override inspection did not return an authenticated application projection',
                })
            }
            return Object.freeze({
                kind: 'complete',
                activeOverrides: application.activeSurfaceOverrides,
                changedOverrideOriginals: application.changedOverrideOriginals,
            })
        } catch (error) {
            return Object.freeze({
                kind: 'unavailable',
                code: 'SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE',
                reason: `authenticated generated surface override inspection is unavailable: ${errorCause(error)}`,
            })
        }
    }
    // Codex skips a project hook nobody on this machine has trusted, so doctor says so.
    const inspectHookTrust = input ? () => inspectCodexHookTrust({ root: dirname(input.configPath), env: input.env })
        : undefined
    const inspectEvaluator = input ? () => inspectWorkEvaluator(dirname(input.configPath), input.env) : undefined
    const inspectReadiness = input ? () => inspectProjectReadiness({ root: dirname(input.configPath), configPath: input.configPath,
        checkRoot: false, env: input.env, timeoutMs: input.timeoutMs }, execute) : undefined
    // Read after load, which selects this cockpit's state namespace; before that there is no state root to read.
    const readUnreadableState: NonNullable<HealthCommandAdapterComposition['readUnreadableState']> = async () => {
        if (!selectedNamespace) return Object.freeze({ kind: 'complete', skipped: Object.freeze([]) })
        const inventory = await readRootPortInventory(selectedNamespace)
        return inventory.kind === 'complete' ? Object.freeze({ kind: 'complete', skipped: inventory.skipped }) : inventory
    }
    return Object.freeze({ load, inspectSurfaceOverrides, ...(inspectHookTrust ? { inspectHookTrust } : {}),
        ...(inspectEvaluator ? { inspectEvaluator } : {}), ...(inspectReadiness ? { inspectReadiness } : {}), readUnreadableState,
        execute: (step: ExecutionStep) => execute(step) })
}
