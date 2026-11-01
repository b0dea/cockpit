import { execFile } from 'node:child_process'
import { cockpitCommand } from '../fix-catalogue.js'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { beginOperatorReset, decodeLifecycleRecord, runDoctor, runDown, runReset, runSession, runSleep, runUp } from './application.js'
import type { ExecutionStep } from './contract.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { createDestructiveCommandAdapters } from './destructive-composition.js'
import { runSiblingAdd, runSiblingRemove } from './sibling-registration.js'
import { recordLifecycleStarted, resolveLifecycleStage } from './lifecycle-stage.js'
import { createHealthCommandAdapters } from './health-composition.js'
import { readState } from './state.js'
import { decodeCoordinationRecord, inspectDestructiveDrainRecovery, readActiveStackInventory } from './claims.js'
import { admitDependencyRuntime, createDependencyRuntimePlan } from './dependency-runtime.js'
import { observeDependencyLoad } from './installs.js'
import { generatedApplicationProjection, syncGeneratedEnvironment } from './generated-application.js'
import { checkoutId, holderId } from './identity.js'
import { leasePortFamily } from './ports.js'
import {
    issueRuntimeMeasurementProbeAuthority,
    observeDockerRuntime,
    projectDependencyRuntime,
    resolveRuntimeServiceOrder,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import { createLifecycleCompositionFixtureSupport } from '../../test-support/lifecycle-composition-fixture.js'
import { publishComposeOwnership } from '../../test-support/compose-ownership-fixture.js'
import { recordSyntheticMeasurement } from '../../test-support/runtime-measurement-fixture.js'

const run = promisify(execFile)
const roots: string[] = []

const listenerProbeControl = vi.hoisted(() => ({
    enabled: false,
    active: 0,
    maximumActive: 0,
    calls: 0,
    delayMs: 0,
}))

vi.mock('node:net', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:net')>()
    const { EventEmitter } = await import('node:events')
    const createConnection: typeof actual.createConnection = ((..._arguments: Parameters<typeof actual.createConnection>) => {
        if (!listenerProbeControl.enabled) return actual.createConnection(..._arguments)
        listenerProbeControl.calls += 1
        listenerProbeControl.active += 1
        listenerProbeControl.maximumActive = Math.max(listenerProbeControl.maximumActive, listenerProbeControl.active)
        const socket = new EventEmitter() as ReturnType<typeof actual.createConnection>
        let finished = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        let result: ReturnType<typeof setTimeout> | undefined
        socket.destroy = (() => {
            if (!finished) {
                finished = true
                listenerProbeControl.active -= 1
            }
            if (timeout) clearTimeout(timeout)
            if (result) clearTimeout(result)
            return socket
        }) as typeof socket.destroy
        socket.setTimeout = ((milliseconds: number, callback?: () => void) => {
            if (callback) timeout = setTimeout(callback, milliseconds)
            return socket
        }) as typeof socket.setTimeout
        result = setTimeout(() => {
            const error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
            socket.emit('error', error)
        }, listenerProbeControl.delayMs)
        return socket
    }) as typeof actual.createConnection
    return { ...actual, createConnection }
})

afterEach(async () => {
    expect(listenerProbeControl.active, 'listener probes must settle before fixture cleanup').toBe(0)
    listenerProbeControl.enabled = false
    listenerProbeControl.active = 0
    listenerProbeControl.maximumActive = 0
    listenerProbeControl.calls = 0
    listenerProbeControl.delayMs = 0
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const { fixture, generatedFixture, configureGeneratedDocker, runGeneratedScenario } = createLifecycleCompositionFixtureSupport(roots, listenerProbeControl)

// Each case drives the real lifecycle owners through dozens of child processes (fenced execution,
// publication helpers, Git and runtime probes), so its wall time scales with machine load rather
// than with the work under test. The budget is sized for four concurrent workers on a busy host.
describe('production lifecycle adapter composition', { timeout: 180_000 }, () => {
    it('loads nested configuration and supplies fresh runtime, stage, and acquired-port authorities', async () => {
        const candidate = await fixture()
        const cockpitRoot = join(candidate.checkout, 'control')
        await mkdir(cockpitRoot)
        // A measurement belongs to the directory holding cockpit.toml, so the moved configuration needs its own.
        await recordSyntheticMeasurement(cockpitRoot)
        const configPath = join(cockpitRoot, 'cockpit.toml')
        const composePath = join(cockpitRoot, 'compose.yml')
        await rename(candidate.composePath, composePath)
        await writeFile(configPath, (await readFile(candidate.configPath, 'utf8'))
            .replace('siblings_root = "siblings"', 'siblings_root = "../repositories"'))
        let operatingSystemOutput = ''
        let runtimeCwd: string | undefined
        const execute = async (step: ExecutionStep) => {
            if (step.id.startsWith('runtime:docker-compose:topology:')) runtimeCwd = step.cwd
            const outcome = await executeProbe(step)
            if (step.id === 'runtime:docker-operating-system' && outcome.kind === 'complete') {
                operatingSystemOutput = new TextDecoder().decode(outcome.stdout)
            }
            return outcome
        }
        const adapters = createLifecycleCommandAdapters({
            configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, execute)

        const loaded = await adapters.load({ configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return
        await publishComposeOwnership(cockpitRoot, loaded.result)
        await writeFile(composePath, [
            'services:',
            '  api:',
            '    labels:',
            `      dev.b0dea.cockpit.stack-id: ${loaded.result.stackId}`,
            `      dev.b0dea.cockpit.config-sha256: ${loaded.result.runtimeSha256}`,
            '',
        ].join('\n'))
        await publishComposeOwnership(cockpitRoot, loaded.result)
        await writeFile(join(cockpitRoot, 'topology.json'), JSON.stringify({
            services: {
                api: {
                    labels: {
                        'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
                        'dev.b0dea.cockpit.config-sha256': loaded.result.runtimeSha256,
                    },
                    volumes: [{ type: 'bind', source: join(candidate.checkout, 'repositories', 'api'), target: '/api' }],
                },
            },
        }))

        const listener = createServer()
        listener.listen(61_230, '127.0.0.1')
        await once(listener, 'listening')
        let readiness: unknown
        let stage: unknown
        let ports: unknown
        try {
            readiness = await adapters.withRuntimeReadiness(loaded.result, async (value) => value)
            stage = await adapters.withLifecycleStage(loaded.result, async (value) => value)
            ports = await adapters.withAcquiredPorts(loaded.result, async (value) => value)
        } finally {
            listener.close()
            await once(listener, 'close')
        }

        expect(operatingSystemOutput).toBe('["Docker Desktop","docker-desktop","linux"]\n')
        expect(runtimeCwd).toBe(cockpitRoot)
        expect(readiness).toEqual(expect.objectContaining({ topology: expect.objectContaining({
            stackId: loaded.result.stackId,
            configSha256: loaded.result.runtimeSha256,
            runtimeVersion: '27.1.2',
            composeVersion: '2.39.2',
        }),
        hostObservations: [
            expect.objectContaining({ owner: 'host-observation', code: 'MACHINE_MEMORY_BELOW_FLOOR' }),
            expect.objectContaining({ owner: 'host-observation', code: 'MACHINE_CPU_BELOW_FLOOR' }),
            expect.objectContaining({ owner: 'host-observation', code: 'MACHINE_DISK_BELOW_FLOOR' }),
        ],
        runtimeObservations: [
            expect.objectContaining({ owner: 'runtime-planning', code: 'RUNTIME_UNMEASURED' }),
            expect.objectContaining({ owner: 'runtime-planning', code: 'RUNTIME_UNAVAILABLE' }),
            expect.objectContaining({ owner: 'runtime-planning', code: 'MOUNT_POSTURE_UNAVAILABLE' }),
        ],
        }))
        const topology = (readiness as { topology: RuntimeTopologyEvidence }).topology
        const windowStart = Date.parse(topology.observationWindow.startedAt)
        const windowEnd = Date.parse(topology.observationWindow.expiresAt)
        expect(windowEnd - windowStart).toBe(300_000)
        const now = vi.spyOn(Date, 'now')
        now.mockReturnValue(windowStart + 5_001)
        expect(resolveRuntimeServiceOrder(topology)).toEqual(['api'])
        now.mockReturnValue(windowEnd + 1)
        expect(resolveRuntimeServiceOrder(topology)).toEqual([])
        now.mockRestore()
        expect(stage).toBeDefined()
        expect(ports).toEqual(expect.objectContaining({
            leaseResult: expect.objectContaining({ kind: 'complete', holderId: loaded.result.holderId }),
            projection: expect.objectContaining({
                lease: expect.objectContaining({ stackId: loaded.result.stackId, offset: 10 }),
                entrypoints: expect.arrayContaining([expect.objectContaining({ name: 'web' })]),
            }),
        }))
    })

    it('reports the occupied port family from up instead of a generic evidence refusal', async () => {
        const candidate = await fixture(1)
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return
        await publishComposeOwnership(candidate.checkout, loaded.result)
        const labels = {
            'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
            'dev.b0dea.cockpit.config-sha256': loaded.result.runtimeSha256,
        }
        await writeFile(join(candidate.checkout, 'topology.json'), JSON.stringify({ services: { api: {
            labels, volumes: [{ type: 'bind', source: join(candidate.checkout, 'siblings', 'api'), target: '/api' }],
        } } }))

        const listener = createServer()
        listener.listen(61_230, '127.0.0.1')
        await once(listener, 'listening')
        let result: Awaited<ReturnType<typeof runUp>>
        try {
            result = await runUp({ configPath: candidate.configPath }, adapters)
        } finally {
            listener.close()
            await once(listener, 'close')
        }

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'PORT_FAMILY_COLLISION', message: expect.stringContaining('61230'),
        }] })
    })

    it('names an unmounted always sibling from up and still reads the runtime for teardown', async () => {
        const candidate = await fixture()
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        await publishComposeOwnership(candidate.checkout, loaded.result)
        const labels = {
            'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
            'dev.b0dea.cockpit.config-sha256': loaded.result.runtimeSha256,
        }
        await writeFile(join(candidate.checkout, 'topology.json'), JSON.stringify({ services: { api: { labels, volumes: [] } } }))

        const refused = await runUp({ configPath: candidate.configPath }, adapters)

        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'MOUNT_POSTURE_UNAVAILABLE', target: 'sibling:api',
            message: expect.stringContaining(`sibling api is declared mount = "always", but no Compose service bind-mounts ${join(candidate.checkout, 'siblings', 'api')}`),
            fix: expect.stringContaining('set mount = "none" on sibling api'),
        }] })
        // The holder this up added is given back; nothing started, so nothing holds the stack.
        const coordination = await readState(loaded.result.namespace.paths.coordination(loaded.result.stackId))
        expect(coordination.kind === 'complete' && decodeCoordinationRecord(coordination.value, loaded.result.stackId)?.holders).toEqual([])
        // With nothing holding the stack, sleep has nothing to stop; it says so instead of blaming a co-tenant.
        const slept = await runSleep({ configPath: candidate.configPath }, createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe))
        expect(slept).toMatchObject({ kind: 'complete', status: 0, result: { change: 'unchanged' }, diagnostics: [{
            severity: 'warning', code: 'STACK_NOT_RUNNING', message: expect.stringContaining('port family stays reserved'),
        }] })

        const teardown = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe)
        const context = await teardown.load({ configPath: candidate.configPath })
        if (context.kind !== 'complete') throw new Error(JSON.stringify(context))
        const readiness = await teardown.withRuntimeReadiness(context.result, async (value) => value, undefined, undefined, 'teardown')
        expect(readiness?.topology.services.map(({ id }) => id)).toEqual(['api'])
    })

    it('refuses from up a bind inside an always sibling whose real path leaves the sibling', async () => {
        const candidate = await fixture()
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        await publishComposeOwnership(candidate.checkout, loaded.result)
        const escape = join(candidate.checkout, 'siblings', 'api', 'escape')
        await mkdir(join(candidate.checkout, 'siblings', 'api'), { recursive: true })
        await symlink(candidate.home, escape, 'dir')
        await writeFile(join(candidate.checkout, 'topology.json'), JSON.stringify({ services: { api: {
            labels: {
                'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
                'dev.b0dea.cockpit.config-sha256': loaded.result.runtimeSha256,
            },
            volumes: [{ type: 'bind', source: escape, target: '/cache' }],
        } } }))

        expect(await runUp({ configPath: candidate.configPath }, adapters)).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'MOUNT_POSTURE_UNAVAILABLE', target: escape,
            message: expect.stringContaining('resolves through a symbolic link to a path outside sibling api'),
        }] })
    })

    it('binds the public path and session identity and fails closed on unauthenticated runtime output', async () => {
        const candidate = await fixture()
        const execute = vi.fn(executeProbe)
        const first = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, execute)
        const repeated = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, execute)
        const other = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'other-session',
            timeoutMs: 5_000,
        }, execute)

        const [left, right, distinct] = await Promise.all([
            first.load({ configPath: candidate.configPath }),
            repeated.load({ configPath: candidate.configPath }),
            other.load({ configPath: candidate.configPath }),
        ])
        expect(left.kind, JSON.stringify(left)).toBe('complete')
        expect(right.kind).toBe('complete')
        expect(distinct.kind).toBe('complete')
        if (left.kind !== 'complete' || right.kind !== 'complete' || distinct.kind !== 'complete') return
        expect(right.result.holderId).toBe(left.result.holderId)
        expect(distinct.result.holderId).not.toBe(left.result.holderId)
        await expect(first.load({ configPath: join(candidate.root, 'other.toml') })).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }],
        })

        await writeFile(candidate.dockerPath, '#!/bin/sh\nprintf "not-a-version\\n"\n', { mode: 0o700 })
        await chmod(candidate.dockerPath, 0o700)
        await expect(first.withRuntimeReadiness(left.result, async (value) => value)).resolves.toBeUndefined()
        expect(await readFile(candidate.dockerPath, 'utf8')).toContain('not-a-version')
    })

    it('refuses an unmeasured runtime before executing the topology plan', async () => {
        const candidate = await fixture(2, 'unmeasured')
        const execute = vi.fn(executeProbe)
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, execute)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind).toBe('complete')
        if (loaded.kind !== 'complete') return
        await writeFile(candidate.composePath, [
            'services:',
            '  api:',
            '    labels:',
            `      dev.b0dea.cockpit.stack-id: ${loaded.result.stackId}`,
            `      dev.b0dea.cockpit.config-sha256: ${loaded.result.runtimeSha256}`,
            '',
        ].join('\n'))
        await writeFile(join(candidate.checkout, 'topology.json'), JSON.stringify({ services: { api: { labels: {
            'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
            'dev.b0dea.cockpit.config-sha256': loaded.result.runtimeSha256,
        }, volumes: [{ type: 'bind', source: join(candidate.checkout, 'siblings', 'api'), target: '/api' }] } } }))

        await expect(adapters.withRuntimeReadiness(loaded.result, async (value) => value)).resolves.toBeUndefined()
        expect(execute.mock.calls.some(([step]) => step.id.includes('topology'))).toBe(false)

        const up = await runUp({ configPath: candidate.configPath }, adapters)
        expect(up).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'RUNTIME_UNMEASURED' }] })
        const message = up.diagnostics[0]?.message ?? ''
        expect(message).toContain('Runtime docker-desktop on daemon "docker-desktop" has not been measured on this machine')
        expect(message).toContain('OperatingSystem "Docker Desktop", Name "docker-desktop", OSType "linux"; engine 27.1.2')
        expect(message).toContain(`measured in ${join(candidate.checkout, '.cockpit', 'local', 'runtime-measurements.json')}: none`)
        // runtime measure refuses an exported DOCKER_CONTEXT, so the printed remedy clears it.
        expect(message).toMatch(/Measure it on this machine with: env -u DOCKER_CONTEXT npx --no cockpit runtime measure --config <your cockpit\.toml> --image <local-image>$/)
        expect(execute.mock.calls.some(([step]) => step.id.includes('topology'))).toBe(false)
    })

    it('names the missing machine floor table when up cannot bound the runtime', async () => {
        const candidate = await fixture()
        const source = await readFile(candidate.configPath, 'utf8')
        await writeFile(candidate.configPath, source.slice(0, source.indexOf('[environment.machine]')))
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe)

        const up = await runUp({ configPath: candidate.configPath }, adapters)

        expect(up).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'CONFIG_SCHEMA_INVALID', target: 'environment.machine', message: expect.stringContaining('[environment.machine]'),
        }] })
    })

    it('gives back a freshly acquired port lease when entrypoint derivation refuses', async () => {
        const candidate = await fixture()
        const source = await readFile(candidate.configPath, 'utf8')
        // A declared entrypoint named like the rendered APP_PORT address collides only after the lease exists.
        await writeFile(candidate.configPath, source.replace('{ name = "web", kind = "entrypoint"', '{ name = "app-port", kind = "entrypoint"'))
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return
        const use = vi.fn(async (): Promise<unknown> => 'used')

        const refused = await adapters.withAcquiredPorts(loaded.result, use, (diagnostics): unknown => diagnostics)

        expect(use).not.toHaveBeenCalled()
        expect(refused).toEqual([expect.objectContaining({ code: 'PORT_FAMILY_OUT_OF_RANGE', target: 'app-port' })])
        const inventory = await readActiveStackInventory(loaded.result.namespace)
        expect(inventory.kind).toBe('complete')
        if (inventory.kind !== 'complete') return
        expect(inventory.value.filter(({ stackId }) => stackId === loaded.result.stackId)
            .flatMap(({ record }) => record.holders)).toEqual([])
    })

    it('gives back only a freshly acquired port holder when downstream preparation throws', async () => {
        const candidate = await fixture()
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return
        const failure = new Error('synthetic downstream failure')

        await expect(adapters.withAcquiredPorts(loaded.result, async () => { throw failure })).rejects.toBe(failure)
        let inventory = await readActiveStackInventory(loaded.result.namespace)
        expect(inventory.kind).toBe('complete')
        if (inventory.kind !== 'complete') return
        expect(inventory.value.filter(({ stackId }) => stackId === loaded.result.stackId)
            .flatMap(({ record }) => record.holders)).toEqual([])

        expect(await adapters.withAcquiredPorts(loaded.result, async ({ projection }) => projection.ownership.change)).toBe('acquired')
        await expect(adapters.withAcquiredPorts(loaded.result, async () => { throw failure })).rejects.toBe(failure)
        inventory = await readActiveStackInventory(loaded.result.namespace)
        expect(inventory.kind).toBe('complete')
        if (inventory.kind !== 'complete') return
        expect(inventory.value.filter(({ stackId }) => stackId === loaded.result.stackId)
            .flatMap(({ record }) => record.holders)).toEqual([expect.objectContaining({ holderId: loaded.result.holderId })])
    })

    it('surfaces both the downstream exception and a refused fresh-holder compensation', async () => {
        const candidate = await fixture()
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return
        const failure = new Error('synthetic downstream failure')

        const rejected = adapters.withAcquiredPorts(loaded.result, async ({ projection }) => {
            const observedAt = new Date().toISOString()
            const coTenant = await leasePortFamily({
                namespace: loaded.result.namespace,
                stackId: loaded.result.stackId,
                holderId: holderId({ stackId: loaded.result.stackId, checkoutId: loaded.result.checkoutId, sessionId: 'co-tenant' }),
                checkoutId: loaded.result.checkoutId,
                config: loaded.result.ports,
                now: observedAt,
                listenerTimeoutMs: 5_000,
                listenerEvidence: [{ ports: Object.values(projection.lease.ports), observation: {
                    state: 'available', value: [], observedAt, producer: 'controlled-test-probe',
                } }],
            })
            expect(coTenant.kind, JSON.stringify(coTenant)).toBe('complete')
            throw failure
        })

        const combined = await rejected.catch((error: unknown) => error)
        expect(combined).toMatchObject({
            errors: [failure, expect.objectContaining({ message: expect.stringContaining('CLAIM_CO_TENANT') })],
        })
        expect(combined).toBeInstanceOf(AggregateError)
        expect((combined as AggregateError).message).toContain('downstream port preparation failed: synthetic downstream failure')
        expect((combined as AggregateError).message).toContain('acquired-holder compensation failed: CLAIM_CO_TENANT')
    })

    it('retains a fresh holder when runtime dispatch succeeds before its adapter rejects', async () => {
        const candidate = await generatedFixture()
        const failure = new Error('synthetic post-dispatch failure')
        let startDispatched = false
        const execute = async (step: ExecutionStep) => {
            const outcome = await executeProbe(step)
            if (step.id === 'runtime:docker-compose:start:app') {
                startDispatched = true
                throw failure
            }
            return outcome
        }
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'generated-production',
            timeoutMs: 5_000,
        }, execute)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return
        const started = await recordLifecycleStarted({
            namespace: loaded.result.namespace,
            stackId: loaded.result.stackId,
            holderId: loaded.result.holderId,
            observedAt: new Date().toISOString(),
        })
        expect(started.kind, JSON.stringify(started)).not.toBe('refusal')
        const generation = createHash('sha256')
            .update(`generated-environment\0${loaded.result.runtimeSha256}`).digest('hex')
        await configureGeneratedDocker(candidate, loaded.result, generation)
        listenerProbeControl.enabled = true

        await expect(runUp({ configPath: candidate.configPath }, adapters)).rejects.toBe(failure)
        expect(startDispatched).toBe(true)
        const retained = await readActiveStackInventory(loaded.result.namespace)
        expect(retained).toMatchObject({ kind: 'complete', value: [{
            stackId: loaded.result.stackId,
            record: { holders: [expect.objectContaining({ holderId: loaded.result.holderId })] },
        }] })

        const recoveryAdapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'generated-production',
            timeoutMs: 5_000,
        }, executeProbe)
        const recovered = await runUp({ configPath: candidate.configPath }, recoveryAdapters)
        expect(recovered, JSON.stringify(recovered)).toMatchObject({ kind: 'complete', result: { change: 'resumed' } })
        const stopped = await runSleep({ configPath: candidate.configPath }, recoveryAdapters)
        expect(stopped, JSON.stringify(stopped)).toMatchObject({ kind: 'complete', result: { change: 'stopped' } })
    })

    it.each(['single', 'fresh', 'replayed'] as const)('lets an authenticated controlled probe measure an unmeasured runtime without claiming global support with a %s supplier', async (mode) => {
        const candidate = await fixture(2, 'unmeasured')
        const execute = vi.fn(executeProbe)
        const resolved = await (await import('./executable.js')).resolveDockerExecutable({ PATH: `${candidate.root}:/usr/bin:/bin` })
        expect(resolved.state).toBe('available')
        if (resolved.state !== 'available') return
        const observed = await observeDockerRuntime({
            executable: resolved.value,
            cwd: candidate.checkout,
            env: { PATH: `${candidate.root}:/usr/bin:/bin` },
            timeoutMs: 5_000,
        }, execute)
        expect(observed.kind).toBe('complete')
        if (observed.kind !== 'complete') return
        const firstAuthority = issueRuntimeMeasurementProbeAuthority(observed)
        const secondAuthority = issueRuntimeMeasurementProbeAuthority(observed)
        const authorities = [firstAuthority, secondAuthority]
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'controlled-probe',
            timeoutMs: 5_000,
            runtimeMeasurementProbeAuthority: mode === 'single' ? firstAuthority
                : mode === 'fresh' ? () => authorities.shift() ?? secondAuthority : () => firstAuthority,
        }, execute)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind).toBe('complete')
        if (loaded.kind !== 'complete') return
        await publishComposeOwnership(candidate.checkout, loaded.result)
        await writeFile(join(candidate.checkout, 'topology.json'), JSON.stringify({ services: { api: { labels: {
            'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
            'dev.b0dea.cockpit.config-sha256': loaded.result.runtimeSha256,
        }, volumes: [{ type: 'bind', source: join(candidate.checkout, 'siblings', 'api'), target: '/api' }] } } }))

        const readiness = await adapters.withRuntimeReadiness(loaded.result, async (value) => value)

        expect(readiness).toBeDefined()
        expect(execute.mock.calls.filter(([step]) => step.id === 'runtime:docker-operating-system')).toHaveLength(1)
        expect((readiness as { runtimeObservations: readonly { code: string }[] }).runtimeObservations
            .some(({ code }) => code === 'RUNTIME_UNMEASURED')).toBe(false)
        const repeated = await adapters.withRuntimeReadiness(loaded.result, async (value) => value)
        if (mode === 'fresh') expect(repeated).toBeDefined()
        else expect(repeated).toBeUndefined()
        await expect(adapters.withRuntimeReadiness(loaded.result, async (value) => value)).resolves.toBeUndefined()
    })

    it('measures a machine-only floor from the nested configuration directory', async () => {
        const candidate = await fixture()
        const cockpitRoot = join(candidate.checkout, 'control')
        await mkdir(cockpitRoot)
        const configPath = join(cockpitRoot, 'cockpit.toml')
        const source = await readFile(candidate.configPath, 'utf8')
        await writeFile(configPath, source.replace('compose_files = ["compose.yml"]', 'compose_files = []'))
        const execute = vi.fn(executeProbe)
        const path = `${candidate.root}:/usr/bin:/bin`
        const adapters = createLifecycleCommandAdapters({
            configPath,
            env: { PATH: path, UNRELATED_VALUE: 'must-not-reach-children', HOME: candidate.home },
            sessionId: 'machine-only',
            timeoutMs: 5_000,
        }, execute)
        const loaded = await adapters.load({ configPath })
        expect(loaded.kind).toBe('complete')
        if (loaded.kind !== 'complete') return

        const observations = await adapters.withMachineFloorReadiness(loaded.result, async (value) => value)

        expect(observations).toEqual([
            expect.objectContaining({ code: 'MACHINE_MEMORY_BELOW_FLOOR', stackId: loaded.result.stackId }),
            expect.objectContaining({ code: 'MACHINE_CPU_BELOW_FLOOR', stackId: loaded.result.stackId }),
            expect.objectContaining({ code: 'MACHINE_DISK_BELOW_FLOOR', stackId: loaded.result.stackId }),
        ])
        const diskStep = execute.mock.calls.map(([step]) => step).find(({ id }) => id === 'runtime:measure:free-disk')
        expect(diskStep).toMatchObject({ cwd: cockpitRoot, argv: [
            process.execPath, '--input-type=module', '-e', expect.stringContaining('statfsSync'), cockpitRoot,
        ] })
        expect(execute.mock.calls.map(([step]) => step).filter(({ id }) => id.startsWith('runtime:measure:'))
            .map(({ env }) => env)).toEqual([{ PATH: path }, { PATH: path }])
    })

    it('bounds concurrent listener probes while observing every candidate family', async () => {
        const candidate = await fixture(20)
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return

        listenerProbeControl.enabled = true
        listenerProbeControl.delayMs = 10
        const ports = await adapters.withAcquiredPorts(loaded.result, async (value) => value)

        expect(ports).toEqual(expect.objectContaining({
            projection: expect.objectContaining({ lease: expect.objectContaining({ offset: 0 }) }),
        }))
        expect(listenerProbeControl.calls).toBe(21)
        expect(listenerProbeControl.maximumActive).toBe(16)
    })

    it('passes authenticated active profiles through the production runtime owner', async () => {
        const candidate = await fixture()
        const execute = vi.fn(executeProbe)
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
            activeProfiles: ['runtime_probe'],
        }, execute)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return
        await publishComposeOwnership(candidate.checkout, loaded.result)
        const labels = {
            'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
            'dev.b0dea.cockpit.config-sha256': loaded.result.runtimeSha256,
        }
        await writeFile(join(candidate.checkout, 'topology.json'), JSON.stringify({
            services: {
                api: { labels, volumes: [{ type: 'bind', source: join(candidate.checkout, 'siblings', 'api'), target: '/api' }] },
                profiled: { profiles: ['runtime_probe'], labels },
            },
        }))

        const listener = createServer()
        listener.listen(61_230, '127.0.0.1')
        await once(listener, 'listening')
        let readiness: unknown
        try {
            readiness = await adapters.withRuntimeReadiness(loaded.result, async (value) => value)
        } finally {
            listener.close()
            await once(listener, 'close')
        }

        expect(readiness).toEqual(expect.objectContaining({ topology: expect.objectContaining({
            services: expect.arrayContaining([
                expect.objectContaining({ id: 'api' }),
                expect.objectContaining({ id: 'profiled' }),
            ]),
        }) }))
        const topologyStep = execute.mock.calls.map(([step]) => step as ExecutionStep)
            .find(({ id }) => id.startsWith('runtime:docker-compose:topology:'))
        expect(topologyStep?.argv).toEqual(expect.arrayContaining(['--profile', 'runtime_probe']))
    })

    it('does not expose permanent-refusal adapters when composed with valid public input', async () => {
        const candidate = await fixture()
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe)
        const result = await runUp({ configPath: candidate.configPath }, adapters)

        expect(result.diagnostics[0]?.message).not.toContain('not implemented')
        expect(result.diagnostics[0]?.message).not.toContain('unavailable by default')
    })

    it.each(['container', 'no-resources'] as const)('retires completed down before starting a synchronized generated identity: %s', async resources => {
        const first = await runGeneratedScenario({ toolchain: 'none' })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = {
            configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'generated-production', timeoutMs: 5_000,
        }
        if (resources === 'no-resources') await writeFile(join(first.candidate.root, 'runtime-removed'), '')
        const down = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters({
            ...input, dockerContext: 'default',
        }, executeProbe))
        expect(down, JSON.stringify(down)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'removed' } })
        expect(await readActiveStackInventory(first.context.namespace)).toMatchObject({ kind: 'complete', value: [] })
        const retired = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (retired.kind !== 'complete') throw new Error(JSON.stringify(retired))
        expect(decodeLifecycleRecord(retired.value, first.context)?.value).toMatchObject({ teardownComplete: true, completedServices: [] })
        expect(retired.value.value).not.toHaveProperty('generatedReplay')
        expect(retired.value.value).not.toHaveProperty('generatedProgress')
        const source = await readFile(input.configPath, 'utf8')
        await writeFile(input.configPath, source.replace(
            'reason = "Pinned synthetic runtime"', 'reason = "Pinned synthetic runtime after configuration review"'))
        expect(await syncGeneratedEnvironment({ configPath: input.configPath })).toMatchObject({ kind: 'complete', status: 0 })
        const steps: ExecutionStep[] = []
        const adapters = createLifecycleCommandAdapters(input, async step => { steps.push(step); return executeProbe(step) })
        const loaded = await adapters.load({ configPath: input.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        const generation = createHash('sha256').update(`generated-environment\0${loaded.result.runtimeSha256}`).digest('hex')
        expect(generation).not.toBe(first.generation)
        await configureGeneratedDocker(first.candidate, loaded.result, generation, {})

        const result = await runUp({ configPath: input.configPath }, adapters)

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete', status: 0, progress: { notApplied: [] } })
        expect(steps.some(({ id }) => id === 'runtime:docker-compose:start:app')).toBe(true)
        const saved = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
        expect(decodeLifecycleRecord(saved.value, first.context)?.value.generatedReplay?.generation).toBe(generation)
        expect(saved.value.value).not.toHaveProperty('teardownComplete')
    })

    it('keeps the final down claim when lifecycle retirement fails and resumes after the path is repaired', async () => {
        const first = await runGeneratedScenario({ toolchain: 'none' })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = { configPath: first.candidate.configPath, dockerContext: 'default',
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'generated-production', timeoutMs: 5_000 }
        const path = first.context.namespace.paths.lifecycle(first.context.stackId).path
        const backup = `${path}.before-retirement`
        let denied = false
        const adapters = createDestructiveCommandAdapters(input, async step => {
            const outcome = await executeProbe(step)
            if (!denied && step.argv.includes('rm') && step.argv.includes('container')) {
                denied = true
                await rename(path, backup)
                await mkdir(path)
            }
            return outcome
        })
        const refused = await runDown({ configPath: input.configPath }, adapters)
        expect(denied).toBe(true)
        expect(refused, JSON.stringify(refused)).toMatchObject({ kind: 'refusal', status: 2 })
        const held = await readState(first.context.namespace.paths.coordination(first.context.stackId))
        if (held.kind !== 'complete') throw new Error(JSON.stringify(held))
        expect(decodeCoordinationRecord(held.value, first.context.stackId)).toMatchObject({
            holders: [{ holderId: first.context.holderId }], lease: { released: false },
            drain: { purpose: 'down', attempt: { status: 'active' } },
        })
        await rm(path, { recursive: true })
        await rename(backup, path)
        const retained = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (retained.kind !== 'complete') throw new Error(JSON.stringify(retained))
        expect(decodeLifecycleRecord(retained.value, first.context)?.value.generatedReplay?.generation).toBe(first.generation)
        expect(retained.value.value).not.toHaveProperty('teardownComplete')
        const inventory = await readActiveStackInventory(first.context.namespace)
        expect(inventory, JSON.stringify(inventory)).toMatchObject({ kind: 'complete', value: [{ stackId: first.context.stackId }] })
        const repair = await inspectDestructiveDrainRecovery({ namespace: first.context.namespace,
            stackId: first.context.stackId, holderId: first.context.holderId, purpose: 'down' })
        if (repair.kind !== 'repairable') throw new Error(JSON.stringify(repair))
        const savedMarker = join(first.candidate.root, 'saved-executor-marker')
        await rename(repair.fence.markerPath, savedMarker)
        await writeFile(repair.fence.markerPath, '{}', { mode: 0o600 })
        const malformed = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters(input, executeProbe))
        expect(malformed).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'DRAIN_ATTEMPT_REPAIR_REQUIRED' }] })
        const unreleased = await readState(first.context.namespace.paths.coordination(first.context.stackId))
        if (unreleased.kind !== 'complete') throw new Error(JSON.stringify(unreleased))
        expect(decodeCoordinationRecord(unreleased.value, first.context.stackId)).toMatchObject({
            holders: [{ holderId: first.context.holderId }], lease: { released: false }, drain: { attempt: { status: 'active' } },
        })
        await rm(repair.fence.markerPath)
        await rename(savedMarker, repair.fence.markerPath)

        await writeFile(join(first.candidate.root, 'docker-failure-needle'), 'volume ls\n')
        const unavailable = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters(input, executeProbe))
        expect(unavailable).toMatchObject({ kind: 'refusal', status: 2 })
        const retryable = await readState(first.context.namespace.paths.coordination(first.context.stackId))
        if (retryable.kind !== 'complete') throw new Error(JSON.stringify(retryable))
        expect(decodeCoordinationRecord(retryable.value, first.context.stackId)).toMatchObject({
            holders: [{ holderId: first.context.holderId }], lease: { released: false }, drain: { attempt: { status: 'failed' } },
        })
        await writeFile(join(first.candidate.root, 'docker-failure-needle'), '\n')

        const recovered = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters(input, executeProbe))
        expect(recovered, JSON.stringify(recovered)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'removed' } })
        expect(await readActiveStackInventory(first.context.namespace)).toMatchObject({ kind: 'complete', value: [] })
        const saved = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
        expect(decodeLifecycleRecord(saved.value, first.context)?.value).toMatchObject({ teardownComplete: true, completedServices: [] })
    })

    it('keeps interrupted reset previews read-only and reconciles an absent target only after approval', async () => {
        const candidate = await generatedFixture({ toolchain: 'none' })
        await writeFile(candidate.configPath, (await readFile(candidate.configPath, 'utf8'))
            .replace('[environment]\n', '[environment]\ngenerated_host_paths = ["reset-cache"]\n'))
        const target = join(candidate.checkout, 'reset-cache')
        await mkdir(target)
        await writeFile(join(target, 'generated.txt'), 'synthetic generated cache\n')
        const input = { configPath: candidate.configPath, dockerContext: 'default',
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'generated-production', timeoutMs: 5_000 }
        const { dockerContext: _dockerContext, ...lifecycleInput } = input
        const lifecycle = createLifecycleCommandAdapters(lifecycleInput, executeProbe)
        const loaded = await lifecycle.load({ configPath: input.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        const generation = createHash('sha256').update(`generated-environment\0${loaded.result.runtimeSha256}`).digest('hex')
        await configureGeneratedDocker(candidate, loaded.result, generation, {})
        listenerProbeControl.enabled = true
        expect(await runUp({ configPath: input.configPath }, lifecycle)).toMatchObject({ kind: 'complete', status: 0 })
        let interrupted = false
        const adapters = createDestructiveCommandAdapters(input, async step => {
            const outcome = await executeProbe(step)
            if (step.id.startsWith('reset:host-path:')) {
                interrupted = true
                throw new Error('synthetic interruption after removal before publication')
            }
            return outcome
        })
        const first = await beginOperatorReset({ configPath: input.configPath }, adapters)
        if (!('decide' in first)) throw new Error(JSON.stringify(first))
        await expect(first.decide('approve')).rejects.toThrow('synthetic interruption after removal before publication')
        expect(interrupted).toBe(true)
        const address = loaded.result.namespace.paths.coordination(loaded.result.stackId)
        const before = await readState(address)
        if (before.kind !== 'complete') throw new Error(JSON.stringify(before))
        expect(decodeCoordinationRecord(before.value, loaded.result.stackId)).toMatchObject({
            holders: [{ holderId: loaded.result.holderId }], drain: { purpose: 'reset', attempt: { status: 'active' } },
        })
        const retry = createDestructiveCommandAdapters(input, executeProbe)
        expect(await runReset({ configPath: input.configPath }, retry)).toMatchObject({ kind: 'preview', result: {
            noop: false, targets: [{ kind: 'host-path', identity: target, declaration: 'reset-cache' }],
        } })
        const declined = await beginOperatorReset({ configPath: input.configPath }, retry)
        if (!('decide' in declined)) throw new Error(JSON.stringify(declined))
        expect((await readState(address))).toEqual(before)
        expect(await declined.decide('decline')).toMatchObject({ kind: 'refusal' })
        expect((await readState(address))).toEqual(before)
        const approved = await beginOperatorReset({ configPath: input.configPath }, retry)
        if (!('decide' in approved)) throw new Error(JSON.stringify(approved))
        expect(await approved.decide('approve')).toMatchObject({ kind: 'complete', status: 0, result: { change: 'reset' } })
        expect(await readActiveStackInventory(loaded.result.namespace)).toMatchObject({ kind: 'complete', value: [] })
        const saved = await readState(loaded.result.namespace.paths.lifecycle(loaded.result.stackId))
        if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
        expect(saved.value.value).not.toHaveProperty('teardownComplete')
        expect(decodeLifecycleRecord(saved.value, loaded.result)?.value.generatedReplay?.generation).toBe(generation)
    })

    it('preserves the generated replay after sleep and resumes the same identity without a teardown fact', async () => {
        const first = await runGeneratedScenario({ toolchain: 'none' })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const slept = await runSleep({ configPath: first.candidate.configPath }, first.adapters)
        expect(slept, JSON.stringify(slept)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'stopped' } })
        const stopped = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (stopped.kind !== 'complete') throw new Error(JSON.stringify(stopped))
        expect(decodeLifecycleRecord(stopped.value, first.context)?.value.generatedReplay?.generation).toBe(first.generation)
        expect(stopped.value.value).not.toHaveProperty('teardownComplete')

        const resumed = await runUp({ configPath: first.candidate.configPath }, first.adapters)

        expect(resumed, JSON.stringify(resumed)).toMatchObject({ kind: 'complete', status: 0, progress: { notApplied: [] } })
        const saved = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
        expect(decodeLifecycleRecord(saved.value, first.context)?.value.generatedReplay?.generation).toBe(first.generation)
        expect(saved.value.value).not.toHaveProperty('teardownComplete')
    })

    it('gives two cockpits with the same name their own Compose project, kept across a cosmetic edit', async () => {
        const projectOf = (steps: readonly ExecutionStep[]) => [...new Set(steps.flatMap(({ argv }) => {
            const index = argv.indexOf('--project-name')
            return index === -1 ? [] : [argv[index + 1]!]
        }))]
        const first = await runGeneratedScenario({ toolchain: 'none' })
        const second = await runGeneratedScenario({ toolchain: 'none' })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        expect(second.result, JSON.stringify(second.result)).toMatchObject({ kind: 'complete', status: 0 })
        const [firstProject, ...otherFirst] = projectOf(first.steps)
        const [secondProject, ...otherSecond] = projectOf(second.steps)
        expect([otherFirst, otherSecond]).toEqual([[], []])
        expect(firstProject).toMatch(/^generated-environment-[a-f0-9]{12}$/)
        expect(secondProject).toMatch(/^generated-environment-[a-f0-9]{12}$/)
        expect(firstProject).not.toBe(secondProject)
        // The committed Compose file stays portable between checkouts, so it names no project.
        const compose = await readFile(join(first.candidate.checkout, 'generated/compose.yml'), 'utf8')
        expect(compose).not.toMatch(/^name:/m)

        const configPath = first.candidate.configPath
        await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('purpose = "Synthetic application"', 'purpose = "Synthetic application, described again"'))
        const steps: ExecutionStep[] = []
        const resumed = await runUp({ configPath }, createLifecycleCommandAdapters({ configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'generated-production', timeoutMs: 5_000 }, async (step) => { steps.push(step); return executeProbe(step) }))
        expect(resumed, JSON.stringify(resumed)).toMatchObject({ kind: 'complete', status: 0 })
        expect(projectOf(steps)).toEqual([firstProject])
    })

    it.each([
        ['a sibling purpose', (text: string) => text.replace('purpose = "Synthetic application"', 'purpose = "Synthetic application, described again"')],
        ['the guards', (text: string) => text.replace('[guards]\n', '[guards]\nprotected_branches = [ "main", "release" ]\n')],
    ])('keeps the running stack when only %s changes', async (_label, edit) => {
        const first = await runGeneratedScenario({ toolchain: 'none' })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = {
            configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'generated-production', timeoutMs: 5_000,
        }
        const previous = await readFile(input.configPath, 'utf8')
        const edited = edit(previous)
        expect(edited).not.toBe(previous)
        await writeFile(input.configPath, edited)
        expect(await syncGeneratedEnvironment({ configPath: input.configPath })).toMatchObject({ kind: 'complete', status: 0 })

        // The fake daemon still reports the containers the first `up` started, with their labels.
        const resumed = await runUp({ configPath: input.configPath }, createLifecycleCommandAdapters(input, executeProbe))

        expect(resumed, JSON.stringify(resumed)).toMatchObject({ kind: 'complete', status: 0, progress: { notApplied: [] } })
        const saved = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
        expect(decodeLifecycleRecord(saved.value, first.context)?.value.generatedReplay?.generation).toBe(first.generation)
        const down = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters({ ...input, dockerContext: 'default' }, executeProbe))
        expect(down, JSON.stringify(down)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'removed' } })
    })

    it('accepts a sibling the stack does not use while a stack is recorded, and refuses one it would mount until down', async () => {
        const first = await runGeneratedScenario({ toolchain: 'none' })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const env = { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home }
        const configPath = first.candidate.configPath
        const add = (slug: string, mount: string) => runSiblingAdd({ configPath, slug, create: false, env, mount,
            remote: `https://git.invalid/${slug}.git`, purpose: 'Synthetic docs' }, { execute: executeProbe })

        expect(await add('docs', 'none')).toMatchObject({ status: 0, result: { action: 'added' } })
        expect(await runSiblingRemove({ configPath, slug: 'docs', env })).toMatchObject({ status: 0, result: { action: 'removed' } })

        const before = await readFile(configPath, 'utf8')
        const refused = await add('tools', 'always')
        expect(refused).toMatchObject({ status: 2, diagnostics: [{ code: 'SIBLING_STACK_RECORDED' }] })
        expect(refused.diagnostics[0]!.message).toContain(`fix: run \`${cockpitCommand('down', { config: first.context.source.path })}\`, then rerun this command`)
        expect(await readFile(configPath, 'utf8')).toBe(before)
        const down = await runDown({ configPath }, createDestructiveCommandAdapters({ configPath, env, dockerContext: 'default',
            sessionId: 'generated-production', timeoutMs: 5_000 }, executeProbe))
        expect(down, JSON.stringify(down)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'removed' } })
        expect(await add('tools', 'always')).toMatchObject({ status: 0, result: { action: 'added' } })
    })

    it('refuses an up after a runtime change with one recovery that removes the old stack and starts the new one', async () => {
        const first = await runGeneratedScenario({ toolchain: 'none' })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = {
            configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'generated-production', timeoutMs: 5_000,
        }
        const previous = await readFile(input.configPath, 'utf8')
        const intended = previous.replace('retries = 4', 'retries = 5')
        expect(intended).not.toBe(previous)
        await writeFile(input.configPath, intended)
        expect(await syncGeneratedEnvironment({ configPath: input.configPath })).toMatchObject({ kind: 'complete', status: 0 })
        const adapters = createLifecycleCommandAdapters(input, executeProbe)
        const loaded = await adapters.load({ configPath: input.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        const path = loaded.result.source.path
        const generation = createHash('sha256').update(`generated-environment\0${loaded.result.runtimeSha256}`).digest('hex')
        expect(generation).not.toBe(first.generation)
        // The fake daemon renders whichever configuration it is told about; the recorded progress
        // still names the identity the first `up` started.
        await configureGeneratedDocker(first.candidate, loaded.result, generation, {})

        const refused = await runUp({ configPath: input.configPath }, adapters)

        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'LIFECYCLE_PROGRESS_INVALID',
            message: `the recorded stack runs an earlier version of the services, ports, mounts or images in cockpit.toml, and up does not replace a running stack — fix: run \`${cockpitCommand('down', { config: path })}\`, then \`${cockpitCommand('up', { config: path })}\``,
        }] })
        // Follow the recovery exactly as printed: it must remove the old stack and start the new one.
        const down = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters({ ...input, dockerContext: 'default' }, executeProbe))
        expect(down, JSON.stringify(down)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'removed' } })
        await configureGeneratedDocker(first.candidate, loaded.result, generation, {})
        const resumed = createLifecycleCommandAdapters(input, executeProbe)
        const restarted = await runUp({ configPath: input.configPath }, resumed)
        expect(restarted, JSON.stringify(restarted)).toMatchObject({ kind: 'complete', status: 0, progress: { notApplied: [] } })
    })
})
