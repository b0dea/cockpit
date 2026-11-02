import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'smol-toml'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createReadCommandAdapters } from './read-composition.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { runLogs } from './application.js'
import { projectGeneratedComposeArtifactAuthority, renderGeneratedEnvironment } from './generated-stack.js'
import { planLogs } from './logs.js'
import type { EnvironmentBaseline } from './evidence.js'

const sha = (value: string) => value.padEnd(64, value[0] ?? 'a').slice(0, 64)
const stackId = `stack:${sha('a')}`
const holderId = `holder:${sha('b')}:session`
const containerId = sha('c')
const workerContainerId = sha('9')
const source = Object.freeze({ path: '/synthetic/cockpit.toml', byteLength: 100, sha256: sha('d') })
const topology = Object.freeze({
    stackId,
    configSha256: source.sha256,
    batchId: sha('e'),
    runtimeVersion: '27.1.2',
    composeVersion: '2.39.2',
    executableSha256: sha('f'),
    projectName: 'synthetic-cockpit',
    cwd: '/synthetic',
    observationWindow: Object.freeze({
        startedAt: '2026-09-25T00:00:00.000Z',
        expiresAt: '2026-09-25T00:01:00.000Z',
    }),
    services: Object.freeze([Object.freeze({ id: 'api', dependsOn: [], bindMountSources: [], healthcheck: false })]),
})
const lifecycleRecord = Object.freeze({
    format: 'cockpit-state/v1',
    kind: 'lifecycle',
    cockpitId: 'cockpit:synthetic-cockpit:' + sha('1'),
    subjectId: stackId,
    revision: 0,
    updatedAt: '2026-09-25T00:00:00.000Z',
    value: Object.freeze({
        holderId,
        workBasisSha256: sha('2'),
        operationGeneration: sha('3'),
        completedServices: Object.freeze([Object.freeze({ service: 'api', containerId })]),
    }),
})

const controls = vi.hoisted(() => ({
    generated: undefined as undefined | Record<string, unknown>,
    generatedApplication: undefined as undefined | Readonly<Record<string, unknown>>,
    generatedComposeSource: undefined as string | undefined,
    generatedReplay: false,
    generatedReplayGeneration: undefined as string | undefined,
    lifecycleHolderId: undefined as string | undefined,
    incomplete: false,
    multipleServices: false,
    unavailableService: undefined as string | undefined,
    configSha256: undefined as string | undefined,
    runtimeVersion: undefined as string | undefined,
    containerId: undefined as string | undefined,
    predecessorChanged: false,
    processIdentitySha256: undefined as string | undefined,
    contentHash: undefined as string | undefined,
    captureContainerId: undefined as string | undefined,
    captureUnavailable: false,
    captureBatchId: undefined as string | undefined,
    readinessBatchIds: [] as string[],
    stateChanged: false,
    lifecycleReads: 0,
    revalidatedServices: [] as string[],
    readinessPorts: [] as unknown[],
    authenticBaselines: new WeakSet<object>(),
    writes: [] as unknown[],
    executePreparation: false,
}))

vi.mock('../config/load.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../config/load.js')>(),
    loadCockpitConfig: vi.fn(async () => ({ kind: 'complete', result: {
        source: { ...source, sha256: controls.configSha256 ?? source.sha256 },
        runtimeSha256: controls.configSha256 ?? source.sha256,
        config: { cockpit: { siblings_root: '.' }, sibling: [{ var: 'APP_DIR', dir: 'app' }], environment: controls.generated
            ? { generated: controls.generated }
            : { compose_files: ['compose.yml'] } },
    } })),
    consumeLoadedConfigProjection: vi.fn((value) => value),
}))

vi.mock('./lifecycle-composition.js', () => ({
    createLifecycleCommandAdapters: vi.fn((_input: unknown, execute: (step: unknown) => Promise<unknown>) => ({
        load: vi.fn(async () => ({ kind: 'complete', result: {
            configPath: source.path,
            source: { ...source, sha256: controls.configSha256 ?? source.sha256 },
            runtimeSha256: controls.configSha256 ?? source.sha256,
            namespace: {
                paths: {
                    lifecycle: () => ({ kind: 'lifecycle', path: '/state/lifecycle', cockpitId: lifecycleRecord.cockpitId, subjectId: stackId }),
                    baseline: () => ({ kind: 'baseline', path: '/state/baseline', cockpitId: lifecycleRecord.cockpitId, subjectId: stackId }),
                },
            },
            cockpitId: lifecycleRecord.cockpitId,
            checkoutId: `checkout:${sha('4')}`,
            stackId,
            holderId,
            ports: { step: 10, count: 1, bases: { APP_PORT: 61000 } },
            entrypointDerivatives: [],
        } })),
        withRuntimeReadiness: vi.fn(async (_context, use, ports) => {
            if (controls.executePreparation) await execute({ id: 'runtime:prepare' })
            if (ports) controls.readinessPorts.push(ports)
            // Like the real runtime adapter, every readiness observation mints its own batch id.
            const batchId = (controls.readinessBatchIds.length + 1).toString(16).padStart(64, 'e')
            controls.readinessBatchIds.push(batchId)
            return use({
            topology: {
                ...topology,
                batchId,
                configSha256: source.sha256,
                runtimeVersion: controls.runtimeVersion ?? topology.runtimeVersion,
                services: controls.incomplete || controls.multipleServices
                    ? [...topology.services, { id: 'worker', dependsOn: [], bindMountSources: [], healthcheck: false }]
                    : topology.services,
            },
            lifecycle: {},
        }) }),
        withGeneratedRuntime: vi.fn(async (_context, _readiness, use) => controls.generatedApplication
            ? use({ application: controls.generatedApplication })
            : undefined),
    })),
}))

vi.mock('./ports.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('./ports.js')>(),
    observeRetainedPortFamily: vi.fn(async () => ({
        kind: 'complete', holderId, recordRevision: 0,
        lease: { stackId, offset: 0, ports: { APP_HOST_PORT: 4100 } },
    })),
    deriveEntrypoints: vi.fn(() => ({ kind: 'complete', values: [], stackId, ports: { APP_HOST_PORT: 4100 } })),
    projectRetainedPortFamilyResult: vi.fn(async () => {
        const projection = Object.freeze({
            lease: Object.freeze({ stackId, offset: 0, ports: Object.freeze({ APP_HOST_PORT: 4100 }) }),
            ownership: Object.freeze({ holderId, holderIds: Object.freeze([holderId]), recordRevision: 0 }),
            entrypoints: Object.freeze([]),
        })
        return projection
    }),
}))

vi.mock('./executable.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('./executable.js')>(),
    resolveDockerExecutable: vi.fn(async () => ({ state: 'available', value: {
        canonicalPath: '/synthetic/docker', invocationPath: '/synthetic/docker', sha256: topology.executableSha256, executionMode: 'verified-path',
    } })),
}))

vi.mock('node:fs/promises', () => ({
    realpath: vi.fn(async (path: string) => path),
    lstat: vi.fn(async () => ({ isFile: () => true, isSymbolicLink: () => false,
        size: Buffer.byteLength(controls.generatedComposeSource ?? 'services: {}'), dev: 1, ino: 2 })),
    open: vi.fn(async () => ({
        stat: vi.fn(async () => ({ isFile: () => true,
            size: Buffer.byteLength(controls.generatedComposeSource ?? 'services: {}'), dev: 1, ino: 2, mtimeMs: 1 })),
        readFile: vi.fn(async () => Buffer.from(controls.generatedComposeSource ?? 'services: {}')),
        close: vi.fn(async () => undefined),
    })),
}))

vi.mock('./state.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('./state.js')>(),
    abortStateTransaction: vi.fn((value) => ({ aborted: true, value })),
    readState: vi.fn(async (address: { kind: string }) => {
        if (address.kind === 'baseline') return controls.predecessorChanged
            ? { kind: 'complete', value: {
                format: 'cockpit-state/v1', kind: 'baseline', cockpitId: lifecycleRecord.cockpitId,
                subjectId: stackId, revision: 0, updatedAt: '2026-09-25T00:00:10.000Z',
                value: {
                    artifact: 'environment-baseline', schemaVersion: 1, stackId, version: 1,
                    recordedAt: '2026-09-25T00:00:10.000Z',
                    snapshot: {
                        artifact: 'generated-environment-snapshot', schemaVersion: 1, stackId,
                        configSha256: source.sha256, createdAt: '2026-09-25T00:00:08.000Z',
                        creationSource: 'resolved-config', intendedState: {}, snapshotSha256: sha('8'),
                    },
                    evidence: {
                        artifact: 'captured-runtime-evidence', schemaVersion: 1, stackId,
                        configSha256: source.sha256, runtime: { name: 'docker', version: '27.1.2', executableSha256: topology.executableSha256 },
                        observedAt: '2026-09-25T00:00:09.000Z', captureStartedAt: '2026-09-25T00:00:08.000Z',
                        command: { batchId: topology.batchId, containerId, stepIds: ['process', 'content'], timeoutMs: 1000, stdoutLimitBytes: 10, stderrLimitBytes: 10 },
                        observedBytes: { stdout: 1, stderr: 0 },
                        stability: { processIdentitySha256: sha('5'), contentHash: sha('6') }, evidenceSha256: sha('7'),
                    },
                },
            } }
            : { kind: 'missing' }
        controls.lifecycleReads += 1
        const application = controls.generatedApplication
        const selectedBase = controls.generatedReplay ? { ...lifecycleRecord, value: { ...lifecycleRecord.value, generatedReplay: {
            runtimeSha256: typeof application?.runtimeSha256 === 'string' ? application.runtimeSha256 : source.sha256,
            generation: controls.generatedReplayGeneration
                ?? (typeof application?.generation === 'string' ? application.generation : sha('8')),
            profiles: Array.isArray(application?.profiles) ? application.profiles : ['application'],
            mounts: Array.isArray(application?.mounts) ? application.mounts : ['app'],
        } } } : lifecycleRecord
        const selectedRecord = controls.multipleServices
            ? { ...lifecycleRecord, value: { ...lifecycleRecord.value, completedServices: [
                ...lifecycleRecord.value.completedServices,
                { service: 'worker', containerId: workerContainerId },
            ] } }
            : controls.containerId
                ? { ...lifecycleRecord, value: { ...lifecycleRecord.value, completedServices: [
                    { service: 'api', containerId: controls.containerId },
                ] } }
                : selectedBase
        const selected = controls.lifecycleHolderId
            ? { ...selectedRecord, value: { ...selectedRecord.value, holderId: controls.lifecycleHolderId } }
            : selectedRecord
        return controls.stateChanged && controls.lifecycleReads > 1
            ? { kind: 'complete', value: { ...selected, revision: 1 } }
            : { kind: 'complete', value: selected }
    }),
    transactState: vi.fn(async (_namespace, _address, _options, update) => {
        const record = await update(null)
        controls.writes.push(record)
        return 'aborted' in record ? record : { kind: 'complete', value: record }
    }),
}))

vi.mock('./runtime.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('./runtime.js')>(),
    createRuntimeServiceRevalidationPlan: vi.fn(({ service, expectedContainerId }) => {
        controls.revalidatedServices.push(service)
        return controls.unavailableService === service
            ? { kind: 'unavailable' }
            : { kind: 'planned', service, expectedContainerId, status: { id: `status:${service}` }, identity: { id: `identity:${service}` } }
    }),
    admitRuntimeServiceRevalidationStatus: vi.fn(() => ({ kind: 'admitted' })),
    admitRuntimeServiceRevalidation: vi.fn(({ plan }) => ({ kind: 'planned', plan: { kind: 'planned', service: plan.service, expectedContainerId: plan.expectedContainerId, step: { id: `inspect:${plan.service}` } } })),
    admitRuntimeServiceObservation: vi.fn(({ plan }) => ({ kind: 'complete', observation: { service: plan.service, containerId: plan.expectedContainerId } })),
    admitRuntimeServiceHealth: vi.fn(({ observation }) => ({ kind: 'complete', evidence: { containerId: observation.containerId } })),
}))

vi.mock('./evidence.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./evidence.js')>()
    return {
        ...actual,
        // The real planner runs, so a composition default it refuses, such as an output limit above the
        // capture bound, fails here instead of only against a live stack.
        createStabilityCapturePlan: vi.fn((input) => {
            controls.captureContainerId = input.containerId
            controls.captureBatchId = input.batchId
            return actual.createStabilityCapturePlan(input)
        }),
        authenticateStabilityCapture: vi.fn(() => controls.captureUnavailable
            ? { state: 'unavailable', code: 'EXECUTION_STEP_FAILED', reason: 'stability capture execution was refused' }
            : { capture: true }),
        captureRuntimeEvidence: vi.fn(() => ({
            state: 'available', artifact: 'captured-runtime-evidence', schemaVersion: 1,
            stackId, configSha256: controls.configSha256 ?? source.sha256, runtime: { name: 'docker', version: controls.runtimeVersion ?? '27.1.2', executableSha256: topology.executableSha256 },
            observedAt: '2026-09-25T00:00:10.000Z', captureStartedAt: '2026-09-25T00:00:09.000Z',
            command: { batchId: controls.captureBatchId ?? topology.batchId, containerId: controls.captureContainerId ?? containerId, stepIds: ['process', 'content'], timeoutMs: 1000, stdoutLimitBytes: 10, stderrLimitBytes: 10 },
            observedBytes: { stdout: 1, stderr: 0 }, stability: {
                processIdentitySha256: controls.processIdentitySha256 ?? sha('5'),
                contentHash: controls.contentHash ?? sha('6'),
            }, evidenceSha256: sha('7'),
        })),
        createEnvironmentSnapshot: vi.fn(({ stackId: selectedStackId, configSha256 }) => ({
            artifact: 'generated-environment-snapshot', schemaVersion: 1, stackId: selectedStackId, configSha256,
            createdAt: '2026-09-25T00:00:08.000Z', creationSource: 'resolved-config', intendedState: {}, snapshotSha256: sha('8'),
        })),
        environmentBaselineConfirmation: vi.fn(() => 'synthetic-confirmation'),
        isEnvironmentBaselineAuthentic: vi.fn((value) => value !== null && typeof value === 'object' && controls.authenticBaselines.has(value)),
    }
})

describe('production read command composition', () => {
    beforeEach(() => {
        controls.generated = undefined
        controls.generatedApplication = undefined
        controls.generatedComposeSource = undefined
        controls.generatedReplay = false
        controls.generatedReplayGeneration = undefined
        controls.lifecycleHolderId = undefined
        controls.incomplete = false
        controls.multipleServices = false
        controls.unavailableService = undefined
        controls.configSha256 = undefined
        controls.runtimeVersion = undefined
        controls.containerId = undefined
        controls.predecessorChanged = false
        controls.processIdentitySha256 = undefined
        controls.contentHash = undefined
        controls.captureContainerId = undefined
        controls.captureUnavailable = false
        controls.captureBatchId = undefined
        controls.readinessBatchIds.length = 0
        controls.stateChanged = false
        controls.lifecycleReads = 0
        controls.revalidatedServices.length = 0
        controls.readinessPorts.length = 0
        controls.authenticBaselines = new WeakSet<object>()
        controls.writes.length = 0
        controls.executePreparation = false
    })

    it('returns public cancellation while runtime authentication is blocked', async () => {
        controls.executePreparation = true
        const controller = new AbortController()
        let releaseStarted: () => void = () => { throw new Error('runtime preparation did not start') }
        const started = new Promise<void>(resolve => { releaseStarted = resolve })
        const options: Array<{ signal?: AbortSignal } | undefined> = []
        const stepIds: string[] = []
        const execute = vi.fn(async (step: { id: string }, supplied?: { signal?: AbortSignal }) => {
            stepIds.push(step.id)
            options.push(supplied)
            if (step.id === 'inspect:api') {
                releaseStarted()
                if (!controller.signal.aborted) {
                    await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }))
                }
                return { kind: 'refusal' }
            }
            return { kind: 'complete' }
        })
        const adapters = createReadCommandAdapters({ configPath: source.path, env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli', timeoutMs: 5_000, signal: controller.signal }, execute as never)
        const outcome = runLogs({ configPath: source.path, service: 'api', since: '5m', tail: 100,
            follow: true, json: true }, adapters.logs)

        await started
        controller.abort()

        await expect(outcome).resolves.toEqual({
            kind: 'cancelled', status: 130, diagnostics: [], result: { json: true, records: [], truncated: false },
        })
        expect(stepIds).toEqual(['runtime:prepare', 'status:api', 'identity:api', 'inspect:api'])
        expect(options.every(option => option?.signal === controller.signal)).toBe(true)
    })

    it('returns public cancellation before observing an already aborted request', async () => {
        const controller = new AbortController()
        controller.abort()
        const observe = vi.fn()

        const outcome = await runLogs({ configPath: source.path, service: 'api', since: '5m', tail: 100,
            follow: true, json: false }, { observe, execute: vi.fn(), signal: controller.signal })

        expect(outcome).toEqual({
            kind: 'cancelled', status: 130, diagnostics: [], result: { json: false, records: [], truncated: false },
        })
        expect(observe).not.toHaveBeenCalled()
    })

    it('passes opaque controlled-runtime authority only to the lifecycle consumer', async () => {
        const authority = Object.freeze({ kind: 'runtime-measurement-probe-authority' as const })
        const execute = vi.fn(async () => ({ kind: 'complete' }))
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
            runtimeMeasurementProbeAuthority: authority,
        }, execute as never)

        await adapters.logs.observe({ configPath: source.path, service: 'api' })
        expect(createLifecycleCommandAdapters).toHaveBeenLastCalledWith(
            expect.objectContaining({ runtimeMeasurementProbeAuthority: authority }),
            expect.any(Function),
        )
    })

    it('rejects accessor-backed controlled-runtime authority without invoking it', async () => {
        const getter = vi.fn(() => Object.freeze({ kind: 'runtime-measurement-probe-authority' as const }))
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
            get runtimeMeasurementProbeAuthority() { return getter() },
        }, vi.fn(async () => ({ kind: 'complete' })) as never)

        await expect(adapters.logs.observe({ configPath: source.path, service: 'api' })).rejects.toBeInstanceOf(TypeError)
        expect(getter).not.toHaveBeenCalled()
    })

    it('reads completed lifecycle records carrying generated replay metadata', async () => {
        controls.generatedReplay = true
        const adapters = createReadCommandAdapters({ configPath: source.path, env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli', timeoutMs: 5_000 }, vi.fn(async () => ({ kind: 'complete' })) as never)
        const observation = await adapters.logs.observe({ configPath: source.path, service: 'api' })
        expect(observation.request.containerId).toBe(containerId)
    })

    it('transfers retained ports and renderer authority through the generated log route', async () => {
        const fixture = parse(readFileSync(resolve('fixtures/registries/generated-environment.toml'), 'utf8')) as {
            environment: { generated: Record<string, unknown> }
        }
        const generation = sha('8')
        const rendered = renderGeneratedEnvironment({
            declaration: fixture.environment.generated as never,
            sourceSha256: source.sha256,
            generation,
            stackId,
            cockpitId: lifecycleRecord.cockpitId,
            portDefaults: { APP_HOST_PORT: 4100 },
            siblingDirectories: { app: 'app' },
        })
        expect(rendered.kind).toBe('complete')
        if (rendered.kind !== 'complete') throw new Error(rendered.reason)
        const authority = projectGeneratedComposeArtifactAuthority(rendered)
        expect(authority).toBeDefined()
        controls.generated = fixture.environment.generated
        controls.generatedComposeSource = rendered.compose
        controls.generatedReplay = true
        controls.generatedApplication = Object.freeze({
            sourceSha256: source.sha256,
            runtimeSha256: source.sha256,
            generation,
            generatedComposeAuthority: authority!,
            profiles: rendered.replay.profiles,
            mounts: rendered.replay.mounts,
            inspection: Object.freeze({ kind: 'passed', files: Object.freeze([]) }),
        })
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)

        const observation = await adapters.logs.observe({ configPath: source.path, service: 'api' })
        expect(controls.readinessPorts).toHaveLength(1)
        expect(controls.readinessPorts[0]).toMatchObject({ lease: { stackId, ports: { APP_HOST_PORT: 4100 } } })
        expect(observation.generatedComposeAuthority).toBe(authority)
        const request = Object.freeze({ ...observation.request, since: '5m', tail: 100, follow: false })
        expect(planLogs(request, observation.generatedComposeAuthority)).toMatchObject({ kind: 'planned' })
        expect(planLogs(request, { ...authority! })).toMatchObject({ kind: 'unavailable' })

        const wrongGeneration = renderGeneratedEnvironment({
            declaration: fixture.environment.generated as never,
            sourceSha256: source.sha256,
            generation: sha('9'),
            stackId,
            cockpitId: lifecycleRecord.cockpitId,
            portDefaults: { APP_HOST_PORT: 4100 },
            siblingDirectories: { app: 'app' },
        })
        expect(wrongGeneration.kind).toBe('complete')
        if (wrongGeneration.kind !== 'complete') throw new Error(wrongGeneration.reason)
        expect(planLogs(request, projectGeneratedComposeArtifactAuthority(wrongGeneration)))
            .toMatchObject({ kind: 'unavailable' })

        controls.lifecycleHolderId = `holder:${sha('7')}:session`
        await expect(adapters.logs.observe({ configPath: source.path, service: 'api' })).rejects.toThrow('lifecycle holder authority changed')
        controls.lifecycleHolderId = undefined
        controls.generatedReplayGeneration = sha('7')
        await expect(adapters.logs.observe({ configPath: source.path, service: 'api' })).rejects.toThrow('generated lifecycle replay authority changed')
    })

    it('transfers retained port and sibling authority through compose-first logs', async () => {
        controls.generatedComposeSource = 'services:\n  api:\n    image: busybox\n    ports: ["${APP_HOST_PORT:-4100}:3000"]\n    volumes: ["${APP_DIR}:/app"]\n'
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)

        const observation = await adapters.logs.observe({ configPath: source.path, service: 'api' })
        expect(observation.ownComposeAuthority).toMatchObject({
            ownComposeFiles: true,
            cockpitId: lifecycleRecord.cockpitId,
            stackId,
            portLeaseProjection: { lease: { ports: { APP_HOST_PORT: 4100 } } },
            siblingDirectories: { APP_DIR: '/synthetic/app' },
        })
    })

    it('derives the log authority from configuration, topology, and persisted lifecycle state', async () => {
        const execute = vi.fn(async () => ({ kind: 'complete' }))
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, execute as never)

        const observation = await adapters.logs.observe({ configPath: source.path, service: 'api' })

        expect(observation.request).toMatchObject({
            stackId,
            configSha256: source.sha256,
            batchId: controls.readinessBatchIds.at(-1),
            service: 'api',
            containerId,
            services: ['api'],
            runtimeVersion: '27.1.2',
            composeVersion: '2.39.2',
        })
        // A service the stack does not declare is a wrong name, not a runtime that failed to measure.
        expect(await runLogs({ configPath: source.path, service: 'worker', since: '10m', tail: 20, follow: false, json: false },
            adapters.logs)).toMatchObject({ kind: 'refusal', status: 2, diagnostics: [{
                code: 'SERVICE_NOT_DECLARED', target: 'worker',
                message: 'this stack declares no service worker; it declares api',
            }] })
    })

    it('captures a complete runtime cohort and publishes only its explicitly returned baseline', async () => {
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)

        const observed = await adapters.baseline.observe({ configPath: source.path })
        expect(Object.isFrozen(observed)).toBe(true)
        expect(Object.isFrozen(observed.snapshot)).toBe(true)
        expect(Object.isFrozen(observed.snapshot.intendedState)).toBe(true)
        expect(Object.isFrozen(observed.evidence)).toBe(true)
        expect(Object.isFrozen(observed.evidence.command.stepIds)).toBe(true)
        const baseline = {
            artifact: 'environment-baseline', schemaVersion: 1, stackId, version: 1,
            recordedAt: '2026-09-25T00:00:11.000Z', snapshot: observed.snapshot, evidence: observed.evidence,
        } as unknown as EnvironmentBaseline
        await expect(adapters.baseline.write(baseline)).rejects.toThrow('baseline write authority is unavailable')
        await expect(adapters.baseline.revalidate(observed)).resolves.toBe(observed)
        controls.authenticBaselines.add(baseline)
        await adapters.baseline.write(baseline)

        expect(controls.writes).toHaveLength(1)
        expect(controls.writes[0]).toMatchObject({ kind: 'baseline', subjectId: stackId, value: baseline })
        await expect(adapters.baseline.write(baseline)).rejects.toThrow('baseline write authority is unavailable')
    })

    it('revalidates every completed service before capturing baseline evidence', async () => {
        controls.multipleServices = true
        controls.unavailableService = 'api'
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)

        await expect(adapters.baseline.observe({ configPath: source.path })).rejects.toThrow(
            'runtime service cohort changed',
        )
        expect(controls.revalidatedServices).toEqual(['api'])
        controls.unavailableService = undefined
        controls.revalidatedServices.length = 0
        await expect(adapters.baseline.observe({ configPath: source.path })).resolves.toBeDefined()
        expect(controls.revalidatedServices).toEqual(['api', 'worker'])
        expect(controls.writes).toHaveLength(0)
    })

    it('rejects a caller-forged baseline record after observation', async () => {
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)
        const observed = await adapters.baseline.observe({ configPath: source.path })
        const forged = {
            artifact: 'environment-baseline', schemaVersion: 1, stackId, version: 1,
            recordedAt: '2026-09-25T00:00:11.000Z', snapshot: observed.snapshot, evidence: observed.evidence,
        } as unknown as EnvironmentBaseline

        await expect(adapters.baseline.revalidate(observed)).resolves.toBe(observed)
        await expect(adapters.baseline.write(forged)).rejects.toThrow('baseline write authority is unavailable')
        expect(controls.writes).toHaveLength(0)
    })

    it('consumes write authority when the authenticated runtime changes after revalidation', async () => {
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)
        const observed = await adapters.baseline.observe({ configPath: source.path })
        const baseline = {
            artifact: 'environment-baseline', schemaVersion: 1, stackId, version: 1,
            recordedAt: '2026-09-25T00:00:11.000Z', snapshot: observed.snapshot, evidence: observed.evidence,
        } as unknown as EnvironmentBaseline
        await adapters.baseline.revalidate(observed)
        controls.authenticBaselines.add(baseline)
        controls.containerId = sha('7')

        await expect(adapters.baseline.write(baseline)).rejects.toThrow('baseline write authority is unavailable')
        await expect(adapters.baseline.write(baseline)).rejects.toThrow('baseline write authority is unavailable')
        expect(controls.writes).toHaveLength(0)
    })

    it('owns and freezes the complete preview returned to the operator', async () => {
        controls.predecessorChanged = true
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)

        const observed = await adapters.baseline.observe({ configPath: source.path })

        expect(Object.isFrozen(observed.previous)).toBe(true)
        expect(Object.isFrozen(observed.previous?.snapshot)).toBe(true)
        expect(Object.isFrozen(observed.previous?.snapshot.intendedState)).toBe(true)
        expect(Object.isFrozen(observed.previous?.evidence)).toBe(true)
        expect(Object.isFrozen(observed.previous?.evidence.command.stepIds)).toBe(true)
        await expect(adapters.baseline.revalidate(observed)).resolves.toBe(observed)
    })

    it.each([
        ['config source', () => { controls.configSha256 = sha('4') }, 'baseline config source changed'],
        ['runtime topology', () => { controls.runtimeVersion = '28.0.0' }, 'baseline runtime topology changed'],
        ['container cohort', () => { controls.containerId = sha('7') }, 'baseline runtime cohort changed'],
        ['previous baseline', () => { controls.predecessorChanged = true }, 'baseline previous baseline changed'],
        ['process identity', () => { controls.processIdentitySha256 = sha('8') }, 'baseline runtime stability changed'],
        ['content identity', () => { controls.contentHash = sha('9') }, 'baseline runtime stability changed'],
        ['capture availability', () => { controls.captureUnavailable = true }, 'baseline runtime stability changed'],
    ] as const)('consumes the preview when %s changes after approval', async (_field, change, message) => {
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)
        const observed = await adapters.baseline.observe({ configPath: source.path })
        change()

        await expect(adapters.baseline.revalidate(observed)).rejects.toThrow(message)
        await expect(adapters.baseline.revalidate(observed)).rejects.toThrow('baseline preview authority is unavailable')
        expect(controls.writes).toHaveLength(0)
    })

    it('fails closed when the runtime cohort is incomplete or lifecycle state changes during observation', async () => {
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)
        controls.incomplete = true
        await expect(adapters.baseline.observe({ configPath: source.path })).rejects.toThrow(
            'a complete stable runtime cohort is unavailable',
        )
        controls.incomplete = false
        controls.stateChanged = true
        controls.lifecycleReads = 0
        await expect(adapters.logs.observe({ configPath: source.path, service: 'api' })).rejects.toThrow(
            'lifecycle state changed during log observation',
        )
        expect(controls.writes).toHaveLength(0)
    })
})
