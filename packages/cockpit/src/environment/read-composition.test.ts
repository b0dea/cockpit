import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createReadCommandAdapters } from './read-composition.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { runLogs } from './application/logs.js'
import { RefusalError } from './contract.js'

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
    composeSource: undefined as string | undefined,
    lifecycleHolderId: undefined as string | undefined,
    incomplete: false,
    multipleServices: false,
    unavailableService: undefined as string | undefined,
    configSha256: undefined as string | undefined,
    runtimeVersion: undefined as string | undefined,
    containerId: undefined as string | undefined,
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
    executePreparation: false,
    readinessRefusal: undefined as undefined | readonly Record<string, unknown>[],
}))

vi.mock('../config/load.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../config/load.js')>(),
    loadCockpitConfig: vi.fn(async () => ({ kind: 'complete', result: {
        source: { ...source, sha256: controls.configSha256 ?? source.sha256 },
        runtimeSha256: controls.configSha256 ?? source.sha256,
        config: { cockpit: { siblings_root: '.' }, sibling: [{ var: 'APP_DIR', dir: 'app' }], environment: { compose_files: ['compose.yml'] } },
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
                },
            },
            cockpitId: lifecycleRecord.cockpitId,
            checkoutId: `checkout:${sha('4')}`,
            stackId,
            holderId,
            ports: { step: 10, count: 1, bases: { APP_PORT: 61000 } },
            entrypointDerivatives: [],
        } })),
        withRuntimeReadiness: vi.fn(async (_context, use, ports, refuse) => {
            if (controls.readinessRefusal) return refuse?.(controls.readinessRefusal)
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
}))

vi.mock('../bounded-read.js', () => ({
    readBoundedFile: vi.fn(() => ({ kind: 'complete', bytes: Buffer.from(controls.composeSource ?? 'services: {}') })),
}))

vi.mock('./state.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('./state.js')>(),
    readState: vi.fn(async () => {
        controls.lifecycleReads += 1
        const selectedRecord = controls.multipleServices
            ? { ...lifecycleRecord, value: { ...lifecycleRecord.value, completedServices: [
                ...lifecycleRecord.value.completedServices,
                { service: 'worker', containerId: workerContainerId },
            ] } }
            : controls.containerId
                ? { ...lifecycleRecord, value: { ...lifecycleRecord.value, completedServices: [
                    { service: 'api', containerId: controls.containerId },
                ] } }
                : lifecycleRecord
        const selected = controls.lifecycleHolderId
            ? { ...selectedRecord, value: { ...selectedRecord.value, holderId: controls.lifecycleHolderId } }
            : selectedRecord
        return controls.stateChanged && controls.lifecycleReads > 1
            ? { kind: 'complete', value: { ...selected, revision: 1 } }
            : { kind: 'complete', value: selected }
    }),
}))

vi.mock('./runtime.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('./runtime.js')>(),
    revalidateRuntimeService: vi.fn(async ({ service, expectedContainerId, execute }) => {
        controls.revalidatedServices.push(service)
        if (controls.unavailableService === service) return { kind: 'failure' }
        for (const id of [`status:${service}`, `identity:${service}`, `inspect:${service}`]) await execute({ id })
        return { kind: 'observed', observation: { service, containerId: expectedContainerId } }
    }),
    admitRuntimeServiceHealth: vi.fn((observation) => ({ containerId: observation.containerId })),
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
    }
})

describe('production read command composition', () => {
    beforeEach(() => {
        controls.composeSource = undefined
        controls.lifecycleHolderId = undefined
        controls.incomplete = false
        controls.multipleServices = false
        controls.unavailableService = undefined
        controls.configSha256 = undefined
        controls.runtimeVersion = undefined
        controls.containerId = undefined
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
        controls.executePreparation = false
        controls.readinessRefusal = undefined
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

    it('reports the runtime readiness refusal itself, such as an unmeasured runtime, instead of a generic observation failure', async () => {
        const unmeasured = Object.freeze({ severity: 'error', code: 'RUNTIME_UNMEASURED', target: stackId,
            message: 'runtime orbstack engine 29.8.2 has no passing measurement on this machine' })
        controls.readinessRefusal = [unmeasured]
        const adapters = createReadCommandAdapters({ configPath: source.path, env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli', timeoutMs: 5_000 }, vi.fn(async () => ({ kind: 'complete' })) as never)

        await expect(runLogs({ configPath: source.path, service: 'api', since: '5m', tail: 100, follow: false, json: true },
            adapters.logs)).resolves.toEqual({ kind: 'refusal', status: 2, result: null, diagnostics: [unmeasured] })
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

        await expect(adapters.logs.observe({ configPath: source.path, service: 'api' })).rejects.toBeInstanceOf(RefusalError)
        expect(getter).not.toHaveBeenCalled()
    })

    it('transfers retained port and sibling authority through compose-first logs', async () => {
        controls.composeSource = 'services:\n  api:\n    image: busybox\n    ports: ["${APP_HOST_PORT:-4100}:3000"]\n    volumes: ["${APP_DIR}:/app"]\n'
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

    it('captures a complete runtime cohort as environment evidence and its snapshot', async () => {
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)

        const observed = await adapters.environment.observe({ configPath: source.path })
        expect(Object.keys(observed).sort()).toEqual(['evidence', 'snapshot'])
    })

    it('revalidates every completed service before capturing environment evidence', async () => {
        controls.multipleServices = true
        controls.unavailableService = 'api'
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)

        await expect(adapters.environment.observe({ configPath: source.path })).rejects.toThrow(
            'runtime service cohort changed',
        )
        expect(controls.revalidatedServices).toEqual(['api'])
        controls.unavailableService = undefined
        controls.revalidatedServices.length = 0
        await expect(adapters.environment.observe({ configPath: source.path })).resolves.toBeDefined()
        expect(controls.revalidatedServices).toEqual(['api', 'worker'])
    })

    it('fails closed when the runtime cohort is incomplete or lifecycle state changes during observation', async () => {
        const adapters = createReadCommandAdapters({
            configPath: source.path,
            env: { PATH: '/synthetic' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, vi.fn(async () => ({ kind: 'complete' })) as never)
        controls.incomplete = true
        await expect(adapters.environment.observe({ configPath: source.path })).rejects.toThrow(
            'a complete stable runtime cohort is unavailable',
        )
        controls.incomplete = false
        controls.stateChanged = true
        controls.lifecycleReads = 0
        await expect(adapters.logs.observe({ configPath: source.path, service: 'api' })).rejects.toThrow(
            'lifecycle state changed during log observation',
        )
    })
})
