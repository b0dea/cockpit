import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { cockpitCommand } from '../fix-catalogue.js'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { runCli } from '../cli.js'
import { beginOperatorReset, runDown, runReset } from './application/destructive.js'
import { runDoctor } from './application/doctor.js'
import { decodeLifecycleRecord, runSession, runSleep, runUp } from './application/lifecycle.js'
import { type LifecycleRunContext } from './application/lifecycle-context.js'
import { RefusalError, type ExecutionStep } from './contract.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { createDestructiveCommandAdapters } from './destructive-composition.js'
import { runSiblingAdd, runSiblingRemove } from './sibling-registration.js'
import { resolveLifecycleStage } from './lifecycle-stage.js'
import { createHealthCommandAdapters } from './health-composition.js'
import { createReadCommandAdapters } from './read-composition.js'
import { runServiceExec, runServicePs, runServiceRestart } from './application/services.js'
import { readState } from './state.js'
import { decodeCoordinationRecord, readActiveStackInventory } from './claims.js'
import { releaseStoppedStack } from './claims.js'
import { withStackTeardown } from './claims.js'
import { observeProcessStart, processHost } from './claims.js'
import { checkGeneratedEnvironment } from './generated-application/check.js'
import { syncGeneratedEnvironment } from './generated-application/sync.js'
import { checkoutId, composeProjectName, holderId } from './identity.js'
import { leasePortFamily } from './ports.js'
import { observeMachineStacks } from './stack-inventory.js'
import {
    resolveRuntimeServiceOrder,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import { createLifecycleCompositionFixtureSupport } from '../../test-support/lifecycle-composition-fixture.js'
import { publishComposeOwnership } from '../../test-support/compose-ownership-fixture.js'

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
    vi.unstubAllEnvs()
    expect(listenerProbeControl.active, 'listener probes must settle before fixture cleanup').toBe(0)
    listenerProbeControl.enabled = false
    listenerProbeControl.active = 0
    listenerProbeControl.maximumActive = 0
    listenerProbeControl.calls = 0
    listenerProbeControl.delayMs = 0
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const { fixture, stackFixture, configureStackDocker, runStackScenario } = createLifecycleCompositionFixtureSupport(roots, listenerProbeControl)

// Each case drives the real lifecycle owners through dozens of child processes (fenced execution,
// publication helpers, Git and runtime probes), so its wall time scales with machine load rather
// than with the work under test. The budget is sized for four concurrent workers on a busy host.
describe('production lifecycle adapter composition', { timeout: 180_000 }, () => {
    it('loads nested configuration and supplies fresh runtime, stage, and acquired-port authorities', async () => {
        const candidate = await fixture()
        const cockpitRoot = join(candidate.checkout, 'control')
        await mkdir(cockpitRoot)
        const configPath = join(cockpitRoot, 'cockpit.toml')
        const composePath = join(cockpitRoot, 'compose.yml')
        await rename(candidate.composePath, composePath)
        await writeFile(configPath, (await readFile(candidate.configPath, 'utf8'))
            .replace('siblings_root = "siblings"', 'siblings_root = "../repositories"'))
        let runtimeCwd: string | undefined
        const execute = async (step: ExecutionStep) => {
            if (step.id.startsWith('runtime:docker-compose:topology:')) runtimeCwd = step.cwd
            return executeProbe(step)
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
            expect.objectContaining({ owner: 'runtime-planning', code: 'RUNTIME_UNAVAILABLE' }),
            expect.objectContaining({ owner: 'runtime-planning', code: 'MOUNT_POSTURE_UNAVAILABLE' }),
        ],
        }))
        const topology = (readiness as { topology: RuntimeTopologyEvidence }).topology
        const windowStart = Date.parse(topology.observationWindow.startedAt)
        const windowEnd = Date.parse(topology.observationWindow.expiresAt)
        expect(windowEnd - windowStart).toBe(330_000)
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
        expect(coordination.kind === 'complete' && decodeCoordinationRecord(coordination.value, loaded.result.stackId))
            .toMatchObject({ holders: [], lease: null })
        // The refused up leaves the record as it found it, so no family stays reserved either: sleep
        // says the stack is already asleep instead of blaming a co-tenant or naming a reservation.
        const slept = await runSleep({ configPath: candidate.configPath }, createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, executeProbe))
        expect(slept).toMatchObject({ kind: 'complete', status: 0, result: { change: 'unchanged' }, diagnostics: [{
            severity: 'warning', code: 'STACK_NOT_RUNNING', message: expect.stringContaining('the stack is already asleep'),
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

    it('refuses a Compose below the floor before executing the topology plan', async () => {
        const candidate = await fixture(2)
        const docker = await readFile(candidate.dockerPath, 'utf8')
        await writeFile(candidate.dockerPath, docker.replace('printf "2.39.2\\n"', 'printf "2.34.0\\n"'), { mode: 0o700 })
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
        expect(up).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'RUNTIME_UNAVAILABLE',
            message: expect.stringContaining('Docker Compose 2.34.0 is older than 2.35.0'), fix: expect.stringContaining('upgrade Docker Compose') }] })
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
        const failure = new RefusalError('synthetic downstream failure')

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
        expect(combined).toMatchObject({ cause: {
            errors: [failure, expect.objectContaining({ message: expect.stringContaining('CLAIM_CO_TENANT') })],
        } })
        expect(combined).toBeInstanceOf(RefusalError)
        expect((combined as RefusalError).message).toContain('downstream port preparation failed: synthetic downstream failure')
        expect((combined as RefusalError).message).toContain('acquired-holder compensation failed: CLAIM_CO_TENANT')
    })

    it('retains a fresh holder when runtime dispatch succeeds before its adapter rejects', async () => {
        const candidate = await stackFixture()
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
            sessionId: 'stack-production',
            timeoutMs: 5_000,
        }, execute)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return
        await configureStackDocker(candidate, loaded.result)
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
            sessionId: 'stack-production',
            timeoutMs: 5_000,
        }, executeProbe)
        const recovered = await runUp({ configPath: candidate.configPath }, recoveryAdapters)
        expect(recovered, JSON.stringify(recovered)).toMatchObject({ kind: 'complete', result: { change: 'resumed' } })
        const stopped = await runSleep({ configPath: candidate.configPath }, recoveryAdapters)
        expect(stopped, JSON.stringify(stopped)).toMatchObject({ kind: 'complete', result: { change: 'stopped' } })
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
        expect(readiness).toEqual(expect.objectContaining({ activeProfiles: ['runtime_probe'] }))

        // Compose accepts a profile no service declares and starts nothing for it; cockpit refuses.
        const undeclared = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
            activeProfiles: ['missing'],
        }, executeProbe)
        const reloaded = await undeclared.load({ configPath: candidate.configPath })
        if (reloaded.kind !== 'complete') throw new Error(JSON.stringify(reloaded))
        const refused = await undeclared.withRuntimeReadiness<unknown>(reloaded.result, async () => [], undefined, (diagnostics) => diagnostics)
        expect(refused).toEqual([expect.objectContaining({ code: 'COMPOSE_PROFILE_UNDEFINED', target: 'profile:missing',
            message: expect.stringContaining('from up --profile') })])
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

    const recordedInputs = async (context: LifecycleRunContext) => {
        const saved = await readState(context.namespace.paths.lifecycle(context.stackId))
        if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
        return decodeLifecycleRecord(saved.value, context)?.value.runtimeInputs
    }
    // An edit Compose itself reads changes the stack's runtime inputs without touching cockpit.toml.
    const editCompose = async (checkout: string) => {
        const path = join(checkout, 'compose.yml')
        await writeFile(path, (await readFile(path, 'utf8')).replace('    volumes:', '    environment: ["MODE=reviewed"]\n    volumes:'))
    }

    it.each(['container', 'no-resources'] as const)('retires completed down before starting a changed stack: %s', async resources => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = {
            configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000,
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
        // A reset preview of the stopped stack claims it only to read it, and gives the claim and
        // its lease back; the claim it kept made the next up refuse on every retry.
        const coordination = async () => {
            const stored = await readState(first.context.namespace.paths.coordination(first.context.stackId))
            if (stored.kind !== 'complete') throw new Error(JSON.stringify(stored))
            return stored.value.value
        }
        const beforePreview = await coordination()
        const preview = await runReset({ configPath: input.configPath }, createDestructiveCommandAdapters({
            ...input, dockerContext: 'default',
        }, executeProbe))
        expect(preview, JSON.stringify(preview)).toMatchObject({ kind: 'preview', status: 0 })
        expect(await coordination()).toEqual(beforePreview)
        const declined = await beginOperatorReset({ configPath: input.configPath }, createDestructiveCommandAdapters({
            ...input, dockerContext: 'default',
        }, executeProbe))
        if (!('decide' in declined)) throw new Error(JSON.stringify(declined))
        expect(await declined.decide('decline')).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'RESET_CONFIRMATION_MISMATCH' }] })
        expect(await coordination()).toEqual(beforePreview)
        // A claim an earlier command left on the stopped stack, as the preview's own once did: up
        // names down as the way out, since rerunning up meets the same claim.
        const leftover = createLifecycleCommandAdapters(input, executeProbe)
        const leftoverLoad = await leftover.load({ configPath: input.configPath })
        if (leftoverLoad.kind !== 'complete') throw new Error(JSON.stringify(leftoverLoad))
        expect(await leftover.withAcquiredPorts(leftoverLoad.result, async () => true)).toBe(true)
        const held = await runUp({ configPath: input.configPath }, createLifecycleCommandAdapters(input, executeProbe))
        expect(held).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EXECUTION_PRECONDITION_CHANGED',
            fix: 'run `cd <the cockpit root> && ./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config <your cockpit.toml> && ./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config <your cockpit.toml>`, which releases the claim and starts the stack afresh' }] })
        const released = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters({ ...input, dockerContext: 'default' }, executeProbe))
        expect(released, JSON.stringify(released)).toMatchObject({ kind: 'complete', result: { change: 'removed' } })
        await editCompose(first.candidate.checkout)
        const steps: ExecutionStep[] = []
        const adapters = createLifecycleCommandAdapters(input, async step => { steps.push(step); return executeProbe(step) })
        const loaded = await adapters.load({ configPath: input.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        await configureStackDocker(first.candidate, loaded.result)

        const result = await runUp({ configPath: input.configPath }, adapters)

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete', status: 0 })
        expect(steps.some(({ id }) => id === 'runtime:docker-compose:start:app')).toBe(true)
        const saved = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
        const inputs = decodeLifecycleRecord(saved.value, first.context)?.value.runtimeInputs
        expect(inputs?.['compose.yml']).toMatch(/^[a-f0-9]{64}$/)
        expect(inputs?.['compose.yml']).not.toBe(first.inputs?.['compose.yml'])
        expect(saved.value.value).not.toHaveProperty('teardownComplete')
    })

    it('keeps the final down claim when lifecycle retirement fails and resumes after the path is repaired', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = { configPath: first.candidate.configPath, dockerContext: 'default',
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000 }
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
        })
        await rm(path, { recursive: true })
        await rename(backup, path)
        const retained = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (retained.kind !== 'complete') throw new Error(JSON.stringify(retained))
        expect(decodeLifecycleRecord(retained.value, first.context)?.value.runtimeInputs).toEqual(first.inputs)
        expect(retained.value.value).not.toHaveProperty('teardownComplete')
        const inventory = await readActiveStackInventory(first.context.namespace)
        expect(inventory, JSON.stringify(inventory)).toMatchObject({ kind: 'complete', value: [{ stackId: first.context.stackId }] })
        await writeFile(join(first.candidate.root, 'docker-failure-needle'), 'volume ls\n')
        const unavailable = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters(input, executeProbe))
        expect(unavailable).toMatchObject({ kind: 'refusal', status: 2 })
        const retryable = await readState(first.context.namespace.paths.coordination(first.context.stackId))
        if (retryable.kind !== 'complete') throw new Error(JSON.stringify(retryable))
        expect(decodeCoordinationRecord(retryable.value, first.context.stackId)).toMatchObject({
            holders: [{ holderId: first.context.holderId }], lease: { released: false },
        })
        await writeFile(join(first.candidate.root, 'docker-failure-needle'), '\n')

        const recovered = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters(input, executeProbe))
        expect(recovered, JSON.stringify(recovered)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'removed' } })
        expect(await readActiveStackInventory(first.context.namespace)).toMatchObject({ kind: 'complete', value: [] })
        const saved = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
        expect(decodeLifecycleRecord(saved.value, first.context)?.value).toMatchObject({ teardownComplete: true, completedServices: [] })
    })

    it('keeps reset previews read-only and finishes an interrupted reset once it is approved again', async () => {
        const candidate = await stackFixture()
        await writeFile(candidate.configPath, (await readFile(candidate.configPath, 'utf8'))
            .replace('[environment]\n', '[environment]\ngenerated_host_paths = ["reset-cache"]\n'))
        const target = join(candidate.checkout, 'reset-cache')
        await mkdir(target)
        await writeFile(join(target, 'generated.txt'), 'synthetic generated cache\n')
        const input = { configPath: candidate.configPath, dockerContext: 'default',
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000 }
        const { dockerContext: _dockerContext, ...lifecycleInput } = input
        const lifecycle = createLifecycleCommandAdapters(lifecycleInput, executeProbe)
        const loaded = await lifecycle.load({ configPath: input.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        await configureStackDocker(candidate, loaded.result, ['reset-cache'])
        listenerProbeControl.enabled = true
        const upped = await runUp({ configPath: input.configPath }, lifecycle)
        expect(upped, JSON.stringify(upped)).toMatchObject({ kind: 'complete', status: 0 })
        const startedInputs = await recordedInputs(loaded.result)
        expect(startedInputs).toBeDefined()
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
            holders: [{ holderId: loaded.result.holderId }],
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
        expect(decodeLifecycleRecord(saved.value, loaded.result)?.value.runtimeInputs).toEqual(startedInputs)
    })

    it('preserves the recorded runtime inputs after sleep and resumes the same stack without a teardown fact', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const slept = await runSleep({ configPath: first.candidate.configPath }, first.adapters)
        expect(slept, JSON.stringify(slept)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'stopped' } })
        const stopped = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (stopped.kind !== 'complete') throw new Error(JSON.stringify(stopped))
        expect(decodeLifecycleRecord(stopped.value, first.context)?.value.runtimeInputs).toEqual(first.inputs)
        expect(stopped.value.value).not.toHaveProperty('teardownComplete')

        const resumed = await runUp({ configPath: first.candidate.configPath }, first.adapters)

        expect(resumed, JSON.stringify(resumed)).toMatchObject({ kind: 'complete', status: 0 })
        const saved = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
        expect(decodeLifecycleRecord(saved.value, first.context)?.value.runtimeInputs).toEqual(first.inputs)
        expect(saved.value.value).not.toHaveProperty('teardownComplete')
    })

    // Sessions whose up refused on a torn-down stack exit without their closing sleep, and their
    // holds stay behind with nothing running.
    // An agent tool starts every MCP server at once, and each server a `cockpit session` wraps runs
    // its own up. On a stack that was asleep or removed they all refused, and each refusal left its
    // hold behind, so the servers that needed the stack never started.
    it.each(['asleep', 'removed'] as const)('starts a %s stack once for sessions that begin together, and leaves no hold after they end', async (state) => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const configPath = first.candidate.configPath
        const env = { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home }
        const stopped = state === 'asleep'
            ? await runSleep({ configPath }, first.adapters)
            : await runDown({ configPath }, createDestructiveCommandAdapters({ configPath, env, sessionId: 'stack-production', timeoutMs: 5_000, dockerContext: 'default' }, executeProbe))
        expect(stopped, JSON.stringify(stopped)).toMatchObject({ kind: 'complete', status: 0 })
        const holders = async () => {
            const stored = await readState(first.context.namespace.paths.coordination(first.context.stackId))
            if (stored.kind !== 'complete') throw new Error(JSON.stringify(stored))
            return decodeCoordinationRecord(stored.value, first.context.stackId)!.holders.length
        }
        expect(await holders()).toBe(0)
        const sessionIds = ['mcp-logs', 'mcp-product', 'mcp-browser']
        const adapters = sessionIds.map((sessionId) => createLifecycleCommandAdapters({ configPath, env, sessionId, timeoutMs: 5_000 }, executeProbe))
        const loaded = await adapters[0]!.load({ configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        await configureStackDocker(first.candidate, loaded.result)
        // Each server runs until every bring-up has answered, as servers an agent tool started together do.
        let settled = 0
        let everyUpSettled!: () => void
        const allSettled = new Promise<void>((resolve) => { everyUpSettled = resolve })
        const heldWhileRunning: number[] = []

        const sessions = await Promise.all(adapters.map((sessionAdapters) => runSession({
            configPath, argv: ['synthetic-mcp-server'], cwd: first.candidate.checkout, env,
        }, {
            up: async (input) => {
                const up = await runUp(input, sessionAdapters)
                if (++settled === sessionIds.length) everyUpSettled()
                return up
            },
            sleep: (input) => runSleep(input, sessionAdapters),
            resolveExecutable: async () => ({ state: 'available', value: {
                canonicalPath: process.execPath, invocationPath: process.execPath,
                sha256: '1'.repeat(64), executionMode: 'verified-path',
            } }),
            executeForeground: async () => {
                await allSettled
                heldWhileRunning.push(await holders())
                return { kind: 'complete', exitCode: 0, signal: null, terminationConfirmed: true }
            },
        })))

        for (const session of sessions) expect(session, JSON.stringify(session)).toMatchObject({ kind: 'complete', status: 0 })
        expect(heldWhileRunning[0]).toBe(sessionIds.length)
        expect(sessions.map((session) => session.kind === 'complete' ? session.result.sleep.change : undefined).sort())
            .toEqual(['retained', 'retained', 'stopped'])
        expect(await holders()).toBe(0)
    })

    // Giving back a refused up's hold required the record exactly as its acquisition wrote it, so a
    // holder that joined in between kept the refused one's hold in place for good.
    it('gives back the hold of an up that refused after another holder joined', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = { configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000 }
        expect(await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters({ ...input, dockerContext: 'default' }, executeProbe)))
            .toMatchObject({ kind: 'complete', result: { change: 'removed' } })
        const coTenant = holderId({ stackId: first.context.stackId, checkoutId: first.context.checkoutId, sessionId: 'co-tenant' })
        let joined = false
        // The co-tenant joins once this up holds the stack and reads its runtime, so this up is no
        // longer the stopped stack's only holder and refuses before starting anything.
        const adapters = createLifecycleCommandAdapters(input, async (step) => {
            if (!joined && step.id.startsWith('runtime:')) {
                const stored = await readState(first.context.namespace.paths.coordination(first.context.stackId))
                const lease = stored.kind === 'complete' ? decodeCoordinationRecord(stored.value, first.context.stackId)?.lease : undefined
                if (lease && !lease.released) {
                    joined = true
                    const observedAt = new Date().toISOString()
                    expect(await leasePortFamily({ namespace: first.context.namespace, stackId: first.context.stackId, holderId: coTenant,
                        checkoutId: first.context.checkoutId, config: first.context.ports, now: observedAt, listenerTimeoutMs: 5_000,
                        listenerEvidence: [{ ports: Object.values(lease.ports), observation: {
                            state: 'available', value: [], observedAt, producer: 'controlled-test-probe' } }] })).toMatchObject({ kind: 'complete' })
                }
            }
            return executeProbe(step)
        })
        const loaded = await adapters.load({ configPath: input.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        await configureStackDocker(first.candidate, loaded.result)

        const refused = await runUp({ configPath: input.configPath }, adapters)

        expect(joined).toBe(true)
        expect(refused, JSON.stringify(refused)).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'EXECUTION_PRECONDITION_CHANGED' }] })
        expect(refused.diagnostics.map(({ code }) => code)).not.toContain('CLAIM_CO_TENANT')
        const stored = await readState(first.context.namespace.paths.coordination(first.context.stackId))
        if (stored.kind !== 'complete') throw new Error(JSON.stringify(stored))
        expect(decodeCoordinationRecord(stored.value, first.context.stackId)?.holders.map(({ holderId }) => holderId)).toEqual([coTenant])
    })

    // Docker creates a missing bind source as an empty directory, so a service that expected a file
    // there failed, and nothing named the file or what should have created it.
    it('names a failed service\'s missing bind source and that cockpit.toml declares nothing creating it', async () => {
        const candidate = await stackFixture()
        const configPath = candidate.configPath
        const env = { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home }
        const adapters = createLifecycleCommandAdapters({ configPath, env, sessionId: 'bind-source', timeoutMs: 5_000 }, executeProbe)
        const loaded = await adapters.load({ configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        await configureStackDocker(candidate, loaded.result, ['app/run/state.json'])
        listenerProbeControl.enabled = true
        await writeFile(join(candidate.root, 'docker-failure-needle'), 'up --detach\n')

        const result = await runUp({ configPath }, adapters)

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'refusal' })
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'BIND_SOURCE_MISSING', target: 'app',
            message: expect.stringContaining(join(candidate.checkout, 'app/run/state.json')),
            fix: expect.stringContaining('cockpit.toml declares no step that creates a bind source') }))
    })

    // A session ended on its up's refusal without the closing sleep, so an up that had started a
    // service left the session's hold, and the service, behind.
    it('releases a session whose up refused after starting a service', async () => {
        const candidate = await stackFixture()
        const configPath = candidate.configPath
        const env = { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home }
        const adapters = createLifecycleCommandAdapters({ configPath, env, sessionId: 'mcp-product', timeoutMs: 5_000 }, executeProbe)
        const loaded = await adapters.load({ configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        await configureStackDocker(candidate, loaded.result)
        listenerProbeControl.enabled = true
        await writeFile(join(candidate.root, 'docker-failure-needle'), 'up --detach\n')
        const steps: string[] = []

        const session = await runSession({ configPath, argv: ['synthetic-mcp-server'], cwd: candidate.checkout, env }, {
            up: (input) => runUp(input, adapters),
            sleep: (input) => runSleep(input, createLifecycleCommandAdapters({ configPath, env, sessionId: 'mcp-product', timeoutMs: 5_000 },
                async (step) => { steps.push(step.id); return executeProbe(step) })),
            resolveExecutable: async () => ({ state: 'available', value: {
                canonicalPath: process.execPath, invocationPath: process.execPath,
                sha256: '1'.repeat(64), executionMode: 'verified-path',
            } }),
            executeForeground: async () => { throw new Error('the server must not start on a stack that did not come up') },
        })

        expect(session, JSON.stringify(session)).toMatchObject({ kind: 'refusal', status: 2 })
        expect(steps.some((id) => id.includes(':stop:'))).toBe(true)
        const stored = await readState(loaded.result.namespace.paths.coordination(loaded.result.stackId))
        if (stored.kind !== 'complete') throw new Error(JSON.stringify(stored))
        expect(decodeCoordinationRecord(stored.value, loaded.result.stackId)).toMatchObject({ holders: [], lease: { released: true } })
    })

    it.each(['down', 'up'] as const)('%s releases the holds of sessions that ended, never of one running or unconfirmed', async (verb) => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = { configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000 }
        const destructive = (execute: typeof executeProbe) => createDestructiveCommandAdapters({ ...input, dockerContext: 'default' }, execute)
        expect(await runDown({ configPath: input.configPath }, destructive(executeProbe))).toMatchObject({ kind: 'complete', result: { change: 'removed' } })
        const session = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        const exited = once(session, 'exit')
        try {
            const started = await observeProcessStart(session.pid!, processHost(executeProbe))
            if (started.state !== 'present') throw new Error(JSON.stringify(started))
            for (const sessionId of ['ended-session', 'other-ended-session']) {
                const held = createLifecycleCommandAdapters({ ...input, sessionId, holderProcess: { pid: session.pid!, processStart: started.start } }, executeProbe)
                const loaded = await held.load({ configPath: input.configPath })
                if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
                expect(await held.withAcquiredPorts(loaded.result, async () => true)).toBe(true)
            }
            const holders = async () => {
                const stored = await readState(first.context.namespace.paths.coordination(first.context.stackId))
                if (stored.kind !== 'complete') throw new Error(JSON.stringify(stored))
                return decodeCoordinationRecord(stored.value, first.context.stackId)?.holders.map(({ pid }) => pid)
            }
            expect(await holders()).toEqual([session.pid, session.pid])
            // A presence probe that answers nothing, as under a sandbox, leaves the session unconfirmed.
            const unconfirmed: typeof executeProbe = async (step) => step.id.startsWith('process:presence:')
                ? { kind: 'refusal' } as unknown as Awaited<ReturnType<typeof executeProbe>> : executeProbe(step)
            const act = async (execute: typeof executeProbe) => {
                if (verb === 'down') return runDown({ configPath: input.configPath }, destructive(execute))
                const adapters = createLifecycleCommandAdapters(input, execute)
                const loaded = await adapters.load({ configPath: input.configPath })
                if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
                await configureStackDocker(first.candidate, loaded.result)
                return runUp({ configPath: input.configPath }, adapters)
            }

            for (const execute of [executeProbe, unconfirmed]) {
                if (execute === unconfirmed) {
                    session.kill('SIGKILL')
                    await exited
                }
                expect(await act(execute)).toMatchObject({ kind: 'refusal' })
                expect(await holders()).toEqual([session.pid, session.pid])
            }

            const released = await act(executeProbe)
            expect(released, JSON.stringify(released)).toMatchObject({ kind: 'complete', status: 0 })
            expect(await holders()).toEqual(verb === 'down' ? [] : [undefined])
        } finally {
            session.kill('SIGKILL')
        }
    })

    // A stack keeps the profiles it started with, so a later command run without --profile, the
    // sleep that stops it included, still activates the services those profiles enable.
    it('records the profiles up started the stack with and acts on them in later commands', async () => {
        const first = await runStackScenario({ profiles: ['jobs'] })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const recorded = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (recorded.kind !== 'complete') throw new Error(JSON.stringify(recorded))
        expect(decodeLifecycleRecord(recorded.value, first.context)?.value.activeProfiles).toEqual(['jobs'])
        expect(first.inputs).toHaveProperty(['active Compose profiles'])
        const steps: ExecutionStep[] = []
        const later = createLifecycleCommandAdapters({
            configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production',
            timeoutMs: 5_000,
        }, async (step) => { steps.push(step); return executeProbe(step) })

        const slept = await runSleep({ configPath: first.candidate.configPath }, later)

        expect(slept, JSON.stringify(slept)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'stopped' } })
        const stop = steps.find(({ id }) => id.startsWith('runtime:docker-compose:stop'))
        expect(stop?.argv).toEqual(expect.arrayContaining(['--profile', 'jobs']))
    })

    // Retiring a stack must not depend on its declaration still matching: a profile the stack started
    // with and the Compose files no longer declare is dropped for teardown instead of refusing it.
    it('stops a stack whose recorded profile the Compose files no longer declare', async () => {
        const first = await runStackScenario({ profiles: ['jobs'] })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        await configureStackDocker(first.candidate, first.context)

        const slept = await runSleep({ configPath: first.candidate.configPath }, first.adapters)

        expect(slept, JSON.stringify(slept)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'stopped' } })
    })

    // The verbs reach the stack through the topology its readiness authenticated, so the agent never
    // names the hashed project, its files or its profiles.
    it('runs the service verbs on the stack up started, under its own project and profiles', async () => {
        const first = await runStackScenario({ profiles: ['jobs'] })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const steps: ExecutionStep[] = []
        const foreground = vi.fn(async () => ({ kind: 'complete' as const, exitCode: 3, signal: null, terminationConfirmed: true as const }))
        const { services } = createReadCommandAdapters({
            configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production',
            timeoutMs: 5_000,
        }, async (step) => { steps.push(step); return executeProbe(step) }, foreground)

        expect(await runServicePs({ configPath: first.candidate.configPath }, services)).toMatchObject({ kind: 'complete',
            result: { services: [{ service: 'app', state: 'running', health: 'healthy' }] } })
        expect(await runServiceRestart({ configPath: first.candidate.configPath, service: 'app', verb: 'restart' }, services))
            .toMatchObject({ kind: 'complete', result: { service: 'app', containerId: first.docker.containerId, change: 'restarted' } })
        expect(steps.find(({ id }) => id.startsWith('runtime:docker-compose:restart:app'))?.argv)
            .toEqual(expect.arrayContaining(['--profile', 'jobs', 'restart', '--no-deps', 'app']))
        expect(await runServiceExec({ configPath: first.candidate.configPath, service: 'app', argv: ['psql', '-c', 'select 1'], tty: false }, services))
            .toMatchObject({ kind: 'complete', status: 3 })
        const [planned] = foreground.mock.calls[0] as unknown as [{ argv: readonly string[] }]
        expect(planned.argv.slice(planned.argv.indexOf('--project-name'))).toEqual([
            '--project-name', composeProjectName({ cockpitName: 'stack-environment', stackId: first.context.stackId }),
            '--profile', 'jobs', 'exec', '--no-tty', 'app', 'psql', '-c', 'select 1'])
        expect(await runServiceRestart({ configPath: first.candidate.configPath, service: 'missing', verb: 'rebuild' }, services))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'SERVICE_NOT_DECLARED' }] })
    })

    // `up`, `ps` and `test-run` run as separate commands, each under its own session identity, so
    // they read the stack as the holder its record names; a reader that claimed its own identity
    // found no retained port authority, and the gate ran no stage against a healthy stack.
    it('runs a stack-dependent gate stage against the stack a separate up started, and refuses foreign or missing port authority', async () => {
        const first = await runStackScenario({ testing: true })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        // The gate reads the repository it grades at a commit.
        await run('git', ['-C', first.candidate.checkout, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'])
        const cli = async (argv: readonly string[]) => {
            let stdout = ''
            const io = { stdout: { write: (text: string) => ((stdout += text), true) }, stderr: { write: () => true } }
            const status = await runCli([...argv, '--config', first.candidate.configPath, '--json'], io, {},
                { env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home } })
            return { status, ...JSON.parse(stdout) as { result: Record<string, unknown> | null; diagnostics: readonly { message: string }[] } }
        }
        const gate = () => cli(['test-run', '--gate', 'full'])
        const passed = await gate()
        expect(passed, JSON.stringify(passed.diagnostics)).toMatchObject({ status: 0, result: { verdict: 'PASS', executed: 1 } })
        await expect(readFile(join(first.candidate.root, 'stage-ran'), 'utf8')).resolves.toBe('')
        expect(await cli(['ps'])).toMatchObject({ status: 0, result: { services: [{ service: 'app', state: 'running', health: 'healthy' }] } })

        const coordination = first.context.namespace.paths.coordination(first.context.stackId).path
        const retained = await readFile(coordination, 'utf8')
        const unavailable = { status: 2, result: { verdict: 'DEGRADED', executed: 0 },
            diagnostics: [{ message: expect.stringContaining('retained port authority is unavailable') }] }
        // The recorded holder registered to another checkout is not this checkout's authority.
        const record = JSON.parse(retained) as { value: { holders: { checkoutId: string }[] } }
        record.value.holders[0]!.checkoutId = checkoutId({ checkoutPath: '/synthetic/other' })
        await writeFile(coordination, JSON.stringify(record))
        expect(await gate()).toMatchObject(unavailable)
        await rm(coordination)
        expect(await gate()).toMatchObject(unavailable)
        await writeFile(coordination, retained)
        expect(await gate()).toMatchObject({ status: 0, result: { verdict: 'PASS', executed: 1 } })
    })

    it('gives two cockpits with the same name their own Compose project, kept across a cosmetic edit', async () => {
        const projectOf = (steps: readonly ExecutionStep[]) => [...new Set(steps.flatMap(({ argv }) => {
            const index = argv.indexOf('--project-name')
            return index === -1 ? [] : [argv[index + 1]!]
        }))]
        const first = await runStackScenario()
        const second = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        expect(second.result, JSON.stringify(second.result)).toMatchObject({ kind: 'complete', status: 0 })
        const [firstProject, ...otherFirst] = projectOf(first.steps)
        const [secondProject, ...otherSecond] = projectOf(second.steps)
        expect([otherFirst, otherSecond]).toEqual([[], []])
        expect(firstProject).toMatch(/^stack-environment-[a-f0-9]{12}$/)
        expect(secondProject).toMatch(/^stack-environment-[a-f0-9]{12}$/)
        expect(firstProject).not.toBe(secondProject)
        // The committed ownership override stays portable between checkouts, so it names no project.
        const compose = await readFile(join(first.candidate.checkout, 'compose.cockpit.yml'), 'utf8')
        expect(compose).not.toMatch(/^name:/m)

        const configPath = first.candidate.configPath
        await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('purpose = "Synthetic application"', 'purpose = "Synthetic application, described again"'))
        const steps: ExecutionStep[] = []
        const resumed = await runUp({ configPath }, createLifecycleCommandAdapters({ configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000 }, async (step) => { steps.push(step); return executeProbe(step) }))
        expect(resumed, JSON.stringify(resumed)).toMatchObject({ kind: 'complete', status: 0 })
        expect(projectOf(steps)).toEqual([firstProject])
    })

    it.each([
        ['a sibling purpose', (text: string) => text.replace('purpose = "Synthetic application"', 'purpose = "Synthetic application, described again"')],
        ['the guards', (text: string) => `${text}\n[guards]\nprotected_branches = [ "main", "release" ]\n`],
        ['the machine floor', (text: string) => text.replace('cold_start_seconds = 30', 'cold_start_seconds = 45')],
    ])('keeps the running stack when only %s changes', async (_label, edit) => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = {
            configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000,
        }
        const previous = await readFile(input.configPath, 'utf8')
        const edited = edit(previous)
        expect(edited).not.toBe(previous)
        await writeFile(input.configPath, edited)

        // The fake daemon still reports the containers the first `up` started, with their labels.
        const resumed = await runUp({ configPath: input.configPath }, createLifecycleCommandAdapters(input, executeProbe))

        expect(resumed, JSON.stringify(resumed)).toMatchObject({ kind: 'complete', status: 0 })
        const saved = await readState(first.context.namespace.paths.lifecycle(first.context.stackId))
        if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
        expect(decodeLifecycleRecord(saved.value, first.context)?.value.runtimeInputs).toEqual(first.inputs)
        const down = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters({ ...input, dockerContext: 'default' }, executeProbe))
        expect(down, JSON.stringify(down)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'removed' } })
    })

    it('accepts a sibling the stack does not use while a stack is recorded, and refuses one it would mount until down', async () => {
        const first = await runStackScenario()
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
            sessionId: 'stack-production', timeoutMs: 5_000 }, executeProbe))
        expect(down, JSON.stringify(down)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'removed' } })
        expect(await add('tools', 'always')).toMatchObject({ status: 0, result: { action: 'added' } })
    })

    it('refuses an up below the declared machine floor before starting any service', async () => {
        // The scripted runtime reports 2048 MB of memory and 2 CPUs.
        const { result, steps } = await runStackScenario({ memoryMb: 4096 })

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'MACHINE_MEMORY_BELOW_FLOOR',
            message: 'the container runtime has 2048 MB of memory, below the 4096 MB that environment.machine.runtime_memory_mb declares',
            fix: expect.stringContaining('lower the declared environment.machine floor') }] })
        expect(steps.map(({ argv }) => argv.join(' ')).filter((line) => / up /.test(line))).toEqual([])
    })

    // A small app's Compose file often declares no healthcheck; once its container runs it is ready.
    it('starts a service that declares no healthcheck once its container runs', async () => {
        const { result, steps } = await runStackScenario({ healthcheck: false })

        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete', status: 0 })
        expect(steps.some(({ id }) => id === 'runtime:docker-container:health:app')).toBe(true)
    })

    it('refuses an up after a runtime change with one recovery that removes the old stack and starts the new one', async () => {
        const first = await runStackScenario({ synced: true })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = {
            configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000,
        }
        await editCompose(first.candidate.checkout)
        const adapters = createLifecycleCommandAdapters(input, executeProbe)
        const loaded = await adapters.load({ configPath: input.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        const path = loaded.result.source.path
        // The fake daemon still reports the containers the first `up` started; the recorded
        // progress names the Compose file they started from.
        await configureStackDocker(first.candidate, loaded.result)

        const refused = await runUp({ configPath: input.configPath }, adapters)

        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'LIFECYCLE_PROGRESS_INVALID',
            message: `the recorded stack runs an earlier version of the services, ports, mounts or images: compose.yml changed since it started, and up does not replace a running stack — fix: run \`${cockpitCommand('down', { config: path })}\`, then \`${cockpitCommand('up', { config: path })}\``,
        }] })
        // An ownership override that no longer matches a fresh render is not handed to Compose;
        // down names the sync that brings it current, and stops nothing until then.
        const overridePath = join(first.candidate.checkout, 'compose.cockpit.yml')
        const rendered = await readFile(overridePath, 'utf8')
        await writeFile(overridePath, `${rendered}# edited by hand\n`)
        const stale = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters({ ...input, dockerContext: 'default' }, executeProbe))
        expect(stale).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'GENERATED_ENVIRONMENT_UNAVAILABLE',
            message: `compose.cockpit.yml is missing or does not match the current Compose files and cockpit.toml; run ${cockpitCommand('sync')}`,
        }] })
        vi.stubEnv('HOME', first.candidate.home)
        const synced = await syncGeneratedEnvironment({ configPath: input.configPath })
        expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete', status: 0 })
        expect(await readFile(overridePath, 'utf8')).toBe(rendered)
        // Follow the recovery exactly as printed: it must remove the old stack and start the new one.
        const down = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters({ ...input, dockerContext: 'default' }, executeProbe))
        expect(down, JSON.stringify(down)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'removed' } })
        await configureStackDocker(first.candidate, loaded.result)
        const resumed = createLifecycleCommandAdapters(input, executeProbe)
        const restarted = await runUp({ configPath: input.configPath }, resumed)
        expect(restarted, JSON.stringify(restarted)).toMatchObject({ kind: 'complete', status: 0 })
    })

    it('refuses a rename while a stack is recorded under the old name until down runs under it, then syncs the rename', async () => {
        const first = await runStackScenario({ synced: true })
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = {
            configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000,
        }
        const path = first.context.source.path
        // sync reads the state root from the process environment, as the CLI does.
        vi.stubEnv('HOME', first.candidate.home)
        const recorded = await syncGeneratedEnvironment({ configPath: input.configPath })
        expect(recorded, JSON.stringify(recorded.diagnostics)).toMatchObject({ kind: 'complete', status: 0 })
        const ledgerPath = join(first.candidate.checkout, '.cockpit/generated-environment-ownership.json')
        const ledger = await readFile(ledgerPath, 'utf8')
        const original = await readFile(input.configPath, 'utf8')
        const renamed = original.replace('name = "stack-environment"', 'name = "renamed-environment"')
        expect(renamed).not.toBe(original)
        await writeFile(input.configPath, renamed)
        const refusal = { code: 'STACK_RECORDED_UNDER_EARLIER_NAME', message: `cockpit.name was changed from "stack-environment" while a stack started under that name is still recorded; the stack keeps the earlier name, so only down run under that name removes its containers — fix: set name = "stack-environment" in ${path} again, run \`${cockpitCommand('down', { config: path })}\`, then rename the cockpit and run \`${cockpitCommand('sync', { config: path })}\`` }
        const down = () => runDown({ configPath: input.configPath }, createDestructiveCommandAdapters({ ...input, dockerContext: 'default' }, executeProbe))

        expect(await syncGeneratedEnvironment({ configPath: input.configPath })).toMatchObject({ kind: 'refusal', diagnostics: [refusal] })
        expect(await readFile(ledgerPath, 'utf8')).toBe(ledger)
        expect(await checkGeneratedEnvironment({ configPath: input.configPath })).toMatchObject({ kind: 'refusal', diagnostics: [refusal] })
        expect(await down()).toMatchObject({ kind: 'refusal', diagnostics: [refusal] })
        expect(await runUp({ configPath: input.configPath }, createLifecycleCommandAdapters(input, executeProbe)))
            .toMatchObject({ kind: 'refusal', diagnostics: [refusal] })

        // Follow the fix as printed: down under the old name, then rename again.
        await writeFile(input.configPath, original)
        const removed = await down()
        expect(removed, JSON.stringify(removed)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'removed' } })
        await writeFile(input.configPath, renamed)
        const synced = await syncGeneratedEnvironment({ configPath: input.configPath })
        expect(synced, JSON.stringify(synced.diagnostics)).toMatchObject({ kind: 'complete', status: 0 })
        expect(JSON.parse(await readFile(ledgerPath, 'utf8')).cockpitId).toMatch(/^cockpit:renamed-environment:/)
    })

    it.each([['up', false], ['asleep', true]])('refuses an up after a port base change while the stack is %s with the same down-then-up recovery, and the new port is leased', async (_state, sleepFirst) => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = {
            configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000,
        }
        const previous = await readFile(input.configPath, 'utf8')
        const intended = previous.replace('APP_HOST_PORT = 4100', 'APP_HOST_PORT = 4200')
        expect(intended).not.toBe(previous)
        await writeFile(input.configPath, intended)
        const adapters = createLifecycleCommandAdapters(input, executeProbe)
        const loaded = await adapters.load({ configPath: input.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        const path = loaded.result.source.path
        await configureStackDocker(first.candidate, loaded.result)

        if (sleepFirst) {
            // The running stack holds its lease on the old port family; sleep releases it by stack,
            // not by the edited declaration.
            const slept = await runSleep({ configPath: input.configPath }, createLifecycleCommandAdapters(input, executeProbe))
            expect(slept, JSON.stringify(slept)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'stopped' } })
        }
        const refused = await runUp({ configPath: input.configPath }, adapters)

        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'LIFECYCLE_PROGRESS_INVALID',
            // A running stack still holds the lease that recorded its [ports]; a sleeping one released it,
            // so only the runtime declaration, which is cockpit.toml, is known to differ.
            message: `the recorded stack runs an earlier version of the services, ports, mounts or images: ${sleepFirst ? '' : '[ports] in '}cockpit.toml changed since it started, and up does not replace a running stack — fix: run \`${cockpitCommand('down', { config: path })}\`, then \`${cockpitCommand('up', { config: path })}\``,
        }] })
        // A running stack still holds its lease on the old port family; down removes it by stack,
        // not by the edited declaration.
        const down = await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters({ ...input, dockerContext: 'default' }, executeProbe))
        expect(down, JSON.stringify(down)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'removed' } })
        await configureStackDocker(first.candidate, loaded.result)
        const restarted = await runUp({ configPath: input.configPath }, createLifecycleCommandAdapters(input, executeProbe))
        expect(restarted, JSON.stringify(restarted)).toMatchObject({ kind: 'complete', status: 0 })
        const coordination = await readState(first.context.namespace.paths.coordination(first.context.stackId))
        if (coordination.kind !== 'complete') throw new Error(JSON.stringify(coordination))
        expect(decodeCoordinationRecord(coordination.value, first.context.stackId)?.lease).toMatchObject({ released: false, ports: { APP_HOST_PORT: 4200 } })
    })

    // An agent tool that gives up on a server during a cold start kills its `cockpit session` wrapper
    // outright, which leaves a hold whose process is gone and a stack only partly started. Doctor
    // called that a missing runtime, which its readiness summary put down to the Compose version.
    it('names a start a killed session left unfinished, lists its hold as ended, and lets up finish it', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const configPath = first.candidate.configPath
        const env = { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home }
        expect(await runDown({ configPath }, createDestructiveCommandAdapters({ configPath, env, sessionId: 'stack-production', timeoutMs: 5_000, dockerContext: 'default' }, executeProbe)))
            .toMatchObject({ kind: 'complete', result: { change: 'removed' } })
        await configureStackDocker(first.candidate, first.context)
        // Health reads of a starting service wait, as they do through a cold start.
        const hang = join(first.candidate.root, 'health-reads-wait')
        await writeFile(first.candidate.dockerPath, (await readFile(first.candidate.dockerPath, 'utf8')).replace('joined="$*"\n',
            `joined="$*"\ncase "$joined" in *inspect*) if [ -f '${hang}' ]; then /bin/sleep 60; fi ;; esac\n`), { mode: 0o700 })
        await writeFile(hang, '')
        const stopped = join(first.candidate.root, 'runtime-stopped')
        const wrapper = spawn(process.execPath, [resolve('packages/cockpit/bin/cockpit.mjs'), 'session', '--config', configPath, '--', '/usr/bin/true'],
            { env: { ...env, PATH: `${first.candidate.root}:/usr/bin:/bin` }, stdio: 'ignore' })
        const exited = once(wrapper, 'exit')
        try {
            // Compose was asked to start the service once the stopped marker is gone.
            for (let waited = 0; await readFile(stopped).then(() => true, () => false); waited += 1) {
                if (waited > 600) throw new Error('the session never started the stack')
                await new Promise((settle) => setTimeout(settle, 100))
            }
            await new Promise((settle) => setTimeout(settle, 1_000))
        } finally {
            wrapper.kill('SIGKILL')
            await exited
        }
        await rm(hang)

        const doctor = await runDoctor({ configPath }, createHealthCommandAdapters({ configPath, env, timeoutMs: 5_000 }, executeProbe))
        expect(doctor.diagnostics[0], JSON.stringify(doctor.diagnostics)).toMatchObject({ code: 'STACK_NOT_RUNNING', target: first.context.stackId,
            message: expect.stringContaining('the session that was starting this stack ended before it finished'),
            fix: cockpitCommand('up', { config: configPath }) })
        expect(doctor.diagnostics.map(({ code }) => code)).not.toContain('RUNTIME_UNAVAILABLE')
        expect((doctor.result as { readiness: { gaps: readonly { id: string }[] } }).readiness.gaps.map(({ id }) => id)).not.toContain('container-runtime')

        // `stacks` lists the machine's stacks from this observation; the hold the killed session left is ended.
        const stacks = await observeMachineStacks({ namespace: first.context.namespace,
            own: { cockpitId: first.context.cockpitId, stackId: first.context.stackId, mainCheckoutPath: first.candidate.checkout },
            observeProcess: (pid) => observeProcessStart(pid, processHost(executeProbe)) })
        if ('kind' in stacks) throw new Error(JSON.stringify(stacks))
        expect(stacks.inventory.stacks.find(({ stackId }) => stackId === first.context.stackId)).toMatchObject({ state: { holders: 1, endedHolders: 1 } })

        const finished = await runUp({ configPath }, createLifecycleCommandAdapters({ configPath, env, sessionId: 'stack-production', timeoutMs: 5_000 }, executeProbe))
        expect(finished, JSON.stringify(finished)).toMatchObject({ kind: 'complete', status: 0 })
    })

    it('prints every finding doctor counts for a start a killed session left unfinished', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const configPath = first.candidate.configPath
        const env = { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home }
        expect(await runDown({ configPath }, createDestructiveCommandAdapters({ configPath, env, sessionId: 'stack-production', timeoutMs: 5_000, dockerContext: 'default' }, executeProbe)))
            .toMatchObject({ kind: 'complete', result: { change: 'removed' } })
        await configureStackDocker(first.candidate, first.context)
        const hang = join(first.candidate.root, 'health-reads-wait')
        await writeFile(first.candidate.dockerPath, (await readFile(first.candidate.dockerPath, 'utf8')).replace('joined="$*"\n',
            `joined="$*"\ncase "$joined" in *inspect*) if [ -f '${hang}' ]; then /bin/sleep 60; fi ;; esac\n`), { mode: 0o700 })
        await writeFile(hang, '')
        const stopped = join(first.candidate.root, 'runtime-stopped')
        const wrapper = spawn(process.execPath, [resolve('packages/cockpit/bin/cockpit.mjs'), 'session', '--config', configPath, '--', '/usr/bin/true'],
            { env, stdio: 'ignore' })
        const exited = once(wrapper, 'exit')
        try {
            for (let waited = 0; await readFile(stopped).then(() => true, () => false); waited += 1) {
                if (waited > 600) throw new Error('the session never started the stack')
                await new Promise((settle) => setTimeout(settle, 100))
            }
            await new Promise((settle) => setTimeout(settle, 1_000))
        } finally {
            wrapper.kill('SIGKILL')
            await exited
        }
        await rm(hang)

        // The report's own stream must carry what its headline counts: read without stderr (piped, or
        // captured by a tool), it listed only the findings a readiness gap names, and this one has none.
        let stdout = ''
        let stderr = ''
        expect(await runCli(['doctor', '--config', configPath], {
            stdout: { write: (text: string) => ((stdout += text), true) },
            stderr: { write: (text: string) => ((stderr += text), true) },
        }, {}, { env: { ...env, NO_UPDATE_NOTIFIER: '1' } })).toBe(0)
        const counted = /Findings: (?:(\d+) errors?)?(?: and )?(?:(\d+) warnings?)?, listed below/.exec(stdout)
        expect(counted, stdout).not.toBeNull()
        expect(stdout).toMatch(/^ERROR STACK_NOT_RUNNING .*the session that was starting this stack ended before it finished/m)
        expect(stdout.match(/^ERROR /gm)?.length ?? 0, stdout).toBe(Number(counted![1] ?? 0))
        expect(stdout.match(/^WARNING /gm)?.length ?? 0, stdout).toBe(Number(counted![2] ?? 0))
        expect(stderr).toBe('')
    })

    // A wrapper whose server exits at once sleeps as soon as its up returns. The sessions that waited
    // behind its bring-up then tried to join while that sleep ran, and up refused them outright.
    it('starts sessions that begin together when one of them ends at once, and leaves the stack stopped after the last', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const configPath = first.candidate.configPath
        const env = { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home }
        expect(await runDown({ configPath }, createDestructiveCommandAdapters({ configPath, env, sessionId: 'stack-production', timeoutMs: 5_000, dockerContext: 'default' }, executeProbe)))
            .toMatchObject({ kind: 'complete' })
        let sleeping!: () => void
        const sleepStarted = new Promise<void>((settle) => { sleeping = settle })
        const sessionIds = ['mcp-exits', 'mcp-product', 'mcp-browser']
        const adapters = sessionIds.map((sessionId) => createLifecycleCommandAdapters({ configPath, env, sessionId, timeoutMs: 5_000 }, executeProbe))
        // The first wrapper's sleep holds the stack's teardown while the others come to join.
        const slowSleep = createLifecycleCommandAdapters({ configPath, env, sessionId: sessionIds[0]!, timeoutMs: 5_000 }, async (step) => {
            sleeping()
            await new Promise((settle) => setTimeout(settle, 1_500))
            return executeProbe(step)
        })
        const loaded = await adapters[0]!.load({ configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        await configureStackDocker(first.candidate, loaded.result)
        let settled = 0
        let everyUpSettled!: () => void
        const allSettled = new Promise<void>((settle) => { everyUpSettled = settle })

        const sessions = await Promise.all(adapters.map((sessionAdapters, index) => runSession({
            configPath, argv: ['synthetic-mcp-server'], cwd: first.candidate.checkout, env,
        }, {
            up: async (input) => {
                if (index > 0) await sleepStarted
                const up = await runUp(input, sessionAdapters)
                if (++settled === sessionIds.length - 1) everyUpSettled()
                return up
            },
            sleep: (input) => runSleep(input, index === 0 ? slowSleep : sessionAdapters),
            resolveExecutable: async () => ({ state: 'available', value: {
                canonicalPath: process.execPath, invocationPath: process.execPath,
                sha256: '1'.repeat(64), executionMode: 'verified-path',
            } }),
            executeForeground: async () => {
                if (index === 0) return { kind: 'complete', exitCode: 1, signal: null, terminationConfirmed: true }
                await allSettled
                return { kind: 'complete', exitCode: 0, signal: null, terminationConfirmed: true }
            },
        })))

        expect(sessions.map(({ kind, status }) => [kind, status]), JSON.stringify(sessions)).toEqual([['complete', 1], ['complete', 0], ['complete', 0]])
        const stored = await readState(first.context.namespace.paths.coordination(first.context.stackId))
        if (stored.kind !== 'complete') throw new Error(JSON.stringify(stored))
        expect(decodeCoordinationRecord(stored.value, first.context.stackId)).toMatchObject({ holders: [], lease: { released: true } })
        expect(await readFile(join(first.candidate.root, 'runtime-stopped')).then(() => 'stopped', () => 'running')).toBe('stopped')
    })

    describe('a session that joins a running stack while another holder leaves', () => {
        // The stack the first up started, joined by a second session, after the first one slept: the
        // second session holds it alone, and the progress still names the first.
        const joinedStack = async () => {
            const first = await runStackScenario()
            expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
            const configPath = first.candidate.configPath
            const env = { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home }
            const remaining = createLifecycleCommandAdapters({ configPath, env, sessionId: 'mcp-remaining', timeoutMs: 5_000 }, executeProbe)
            expect(await runUp({ configPath }, remaining)).toMatchObject({ kind: 'complete', result: { change: 'unchanged' } })
            expect(await runSleep({ configPath }, first.adapters)).toMatchObject({ kind: 'complete', result: { change: 'retained' } })
            const coordination = async () => {
                const stored = await readState(first.context.namespace.paths.coordination(first.context.stackId))
                if (stored.kind !== 'complete') throw new Error(JSON.stringify(stored))
                return decodeCoordinationRecord(stored.value, first.context.stackId)!
            }
            return { first, configPath, env, remaining, coordination }
        }
        // The joining session's up runs; once it holds the stack, the remaining holder sleeps.
        const joining = (stack: Awaited<ReturnType<typeof joinedStack>>, afterLeave: () => Promise<void> = async () => {}) => {
            let left = false
            const adapters = createLifecycleCommandAdapters({ configPath: stack.configPath, env: stack.env, sessionId: 'mcp-joining', timeoutMs: 5_000 }, async (step) => {
                if (!left && step.id.startsWith('runtime:')) {
                    left = true
                    expect(await runSleep({ configPath: stack.configPath }, stack.remaining)).toMatchObject({ kind: 'complete', result: { change: 'retained' } })
                    await afterLeave()
                }
                return executeProbe(step)
            })
            return runSession({ configPath: stack.configPath, argv: ['synthetic-mcp-server'], cwd: stack.first.candidate.checkout, env: stack.env }, {
                up: (input) => runUp(input, adapters),
                sleep: (input) => runSleep(input, adapters),
                resolveExecutable: async () => ({ state: 'available', value: {
                    canonicalPath: process.execPath, invocationPath: process.execPath,
                    sha256: '1'.repeat(64), executionMode: 'verified-path',
                } }),
                executeForeground: async () => ({ kind: 'complete', exitCode: 0, signal: null, terminationConfirmed: true }),
            })
        }

        // Taking the progress over checked the holders against those the up started with, so a holder
        // that left meanwhile refused the session with CLAIM_CO_TENANT.
        it('takes the stack over instead of refusing, and stops it when the session ends', async () => {
            const stack = await joinedStack()

            const session = await joining(stack)

            expect(session, JSON.stringify(session)).toMatchObject({ kind: 'complete', status: 0, result: { sleep: { change: 'stopped' } } })
            expect(await stack.coordination()).toMatchObject({ holders: [], lease: { released: true } })
        })

        // A refused up that found itself the last holder dropped its hold and the lease while the
        // containers it joined kept running, and the session's closing sleep then had nothing to stop.
        it('stops the stack it was left holding when its up refuses', async () => {
            const stack = await joinedStack()
            const needle = join(stack.first.candidate.root, 'docker-failure-needle')

            const session = await joining(stack, () => writeFile(needle, 'inspect\n'))
            await writeFile(needle, '\n')

            expect(session, JSON.stringify(session)).toMatchObject({ kind: 'refusal' })
            expect(await stack.coordination()).toMatchObject({ holders: [], lease: { released: true } })
            expect(await readFile(join(stack.first.candidate.root, 'runtime-stopped')).then(() => 'stopped', () => 'running')).toBe('stopped')
        })
    })

    // A running stack nothing holds read to up as a stopped one: its own containers' listeners made
    // the leased family look taken, up leased the next one, and then refused the stack as one started
    // from an earlier configuration, naming files that had not changed.
    it('takes over a running stack no session holds, on the ports it runs on', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const configPath = first.candidate.configPath
        const env = { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home }
        expect(await releaseStoppedStack({ namespace: first.context.namespace, stackId: first.context.stackId, holderId: first.context.holderId }))
            .toMatchObject({ kind: 'complete' })
        listenerProbeControl.enabled = false
        // The stack's own service still publishes the port it was leased.
        const published = createServer()
        published.listen(4100, '127.0.0.1')
        await once(published, 'listening')
        try {
            const adapters = createLifecycleCommandAdapters({ configPath, env, sessionId: 'mcp-next', timeoutMs: 5_000 }, executeProbe)

            const up = await runUp({ configPath }, adapters)

            expect(up, JSON.stringify(up)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'unchanged', ports: { APP_HOST_PORT: 4100 } } })
        } finally {
            published.close()
            await once(published, 'close')
        }
        const stored = await readState(first.context.namespace.paths.coordination(first.context.stackId))
        if (stored.kind !== 'complete') throw new Error(JSON.stringify(stored))
        expect(decodeCoordinationRecord(stored.value, first.context.stackId)).toMatchObject({ holders: [expect.anything()], lease: { released: false, ports: { APP_HOST_PORT: 4100 } } })
    })

    // A Compose upgrade under a running stack changes the work up would resume; the refusal named
    // cockpit.toml and the Compose files, which had not changed.
    it('names a changed Compose version, not unchanged files, when it refuses a running stack', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        await writeFile(first.candidate.dockerPath, (await readFile(first.candidate.dockerPath, 'utf8'))
            .replace("printf '2.39.2\\n'", "printf '5.5.0\\n'"), { mode: 0o700 })

        const refused = await runUp({ configPath: first.candidate.configPath }, first.adapters)

        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_PROGRESS_INVALID',
            message: expect.stringContaining('Docker Compose 2.39.2, now 5.5.0') }] })
        expect(refused.diagnostics[0]!.message).not.toContain('changed since it started, and up')
    })

    // A sleep run from a terminal while sessions hold the stack released nothing and reported that no
    // session held it, though the stack kept running for them.
    it('names who holds the stack when a sleep that holds none of it runs', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const configPath = first.candidate.configPath
        const env = { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home }
        expect(await runUp({ configPath }, createLifecycleCommandAdapters({ configPath, env, sessionId: 'mcp-joined', timeoutMs: 5_000 }, executeProbe)))
            .toMatchObject({ kind: 'complete', result: { change: 'unchanged' } })

        const slept = await runSleep({ configPath }, createLifecycleCommandAdapters({ configPath, env, sessionId: 'another-terminal', timeoutMs: 5_000 }, executeProbe))

        expect(slept, JSON.stringify(slept)).toMatchObject({ kind: 'complete', status: 0, result: { change: 'not-held' },
            diagnostics: [{ severity: 'warning', code: 'CLAIM_CO_TENANT', message: expect.stringContaining('another cockpit session holds this stack') }] })
    })

    // A refused up that could not take the teardown lock to give its hold back kept it, with nothing
    // running and nothing that would ever remove it, or kept it on a running stack without saying so.
    it.each(['stopped', 'running'] as const)('gives back, or names, the hold of an up that refused while a teardown held a %s stack', async (state) => {
        const running = state === 'running' ? await runStackScenario() : undefined
        const candidate = running?.candidate ?? await stackFixture({ memoryMb: 999_999 })
        const configPath = candidate.configPath
        const env = { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home }
        let release!: () => void
        const released = new Promise<void>((settle) => { release = settle })
        let teardown: Promise<unknown> | undefined
        const adapters = createLifecycleCommandAdapters({ configPath, env, sessionId: 'mcp-refused', timeoutMs: 5_000 }, async (step) => {
            if (!teardown && step.id.startsWith('runtime:')) {
                const loaded = await adapters.load({ configPath })
                if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
                let locked!: () => void
                const holding = new Promise<void>((settle) => { locked = settle })
                teardown = withStackTeardown(loaded.result.namespace, loaded.result.stackId,
                    holderId({ stackId: loaded.result.stackId, checkoutId: loaded.result.checkoutId, sessionId: 'teardown' }),
                    async () => { locked(); await released; return {} })
                await holding
            }
            return executeProbe(step)
        })
        const loaded = await adapters.load({ configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        await configureStackDocker(candidate, loaded.result)
        listenerProbeControl.enabled = true
        // Revalidating the running stack fails, so the joining up refuses before starting anything.
        if (running) await writeFile(join(candidate.root, 'docker-failure-needle'), 'inspect\n')

        const refused = await runUp({ configPath }, adapters)
        release()
        await teardown

        expect(refused, JSON.stringify(refused)).toMatchObject({ kind: 'refusal' })
        const stored = await readState(loaded.result.namespace.paths.coordination(loaded.result.stackId))
        if (stored.kind !== 'complete') throw new Error(JSON.stringify(stored))
        const holders = decodeCoordinationRecord(stored.value, loaded.result.stackId)!.holders.map(({ holderId }) => holderId)
        if (running) {
            expect(holders).toContain(loaded.result.holderId)
            expect(refused.diagnostics).toContainEqual(expect.objectContaining({ code: 'STATE_LOCKED', message: expect.stringContaining('kept its hold') }))
        } else expect(holders).toEqual([])
    })

    // Whether a stack nobody holds is taken over unprobed was read before up took the port lock, so a
    // sleep that stopped the stack in between left its ports leased without a look at who listens.
    it('probes the ports of a stack that a sleep stopped while up was getting ready to lease them', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const configPath = first.candidate.configPath
        const env = { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home }
        const wrapper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        const published = createServer()
        try {
            const started = await observeProcessStart(wrapper.pid!, processHost(executeProbe))
            if (started.state !== 'present') throw new Error(JSON.stringify(started))
            const ending = createLifecycleCommandAdapters({ configPath, env, sessionId: 'mcp-ending', timeoutMs: 5_000,
                holderProcess: { pid: wrapper.pid!, processStart: started.start } }, executeProbe)
            expect(await runUp({ configPath }, ending)).toMatchObject({ kind: 'complete', result: { change: 'unchanged' } })
            expect(await runSleep({ configPath }, first.adapters)).toMatchObject({ kind: 'complete', result: { change: 'retained' } })
            listenerProbeControl.enabled = false
            // Something else listens on the stack's port once the stack is stopped.
            published.listen(4100, '127.0.0.1')
            await once(published, 'listening')
            let slept = false
            const next = createLifecycleCommandAdapters({ configPath, env, sessionId: 'mcp-next', timeoutMs: 5_000 }, async (step) => {
                if (!slept && step.id.startsWith('process:presence:')) {
                    slept = true
                    expect(await runSleep({ configPath }, ending)).toMatchObject({ kind: 'complete', result: { change: 'stopped' } })
                }
                return executeProbe(step)
            })

            const up = await runUp({ configPath }, next)

            expect(slept).toBe(true)
            expect(up, JSON.stringify(up)).toMatchObject({ kind: 'complete', status: 0, result: { ports: { APP_HOST_PORT: 4200 } } })
        } finally {
            wrapper.kill('SIGKILL')
            if (published.listening) {
                published.close()
                await once(published, 'close')
            }
        }
    })

    // With the files, versions, docker command and ports all as recorded, the refusal still blamed the
    // versions, command or ports, though the work it compares also covers how each service starts.
    it('does not blame the runtime or ports when what differs is something else the stack starts from', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const moved = join(first.candidate.root, 'moved')
        await mkdir(moved)
        await writeFile(join(moved, 'docker'), await readFile(first.candidate.dockerPath, 'utf8'), { mode: 0o700 })
        const adapters = createLifecycleCommandAdapters({ configPath: first.candidate.configPath,
            env: { PATH: `${moved}:/usr/bin:/bin`, HOME: first.candidate.home }, sessionId: 'stack-production', timeoutMs: 5_000 }, executeProbe)

        const refused = await runUp({ configPath: first.candidate.configPath }, adapters)

        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_PROGRESS_INVALID',
            message: expect.stringContaining('something the stack starts from, other than these files, changed') }] })
        expect(refused.diagnostics[0]!.message).not.toContain('the Docker or Compose version, the docker command or the stack\'s ports changed')
    })

    // A hold that up took outside any session stays after the sessions end, yet the session said the
    // stack stops once the last session holding it ends.
    it('names the hold an up outside any session keeps, beside the sessions that still hold the stack', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const configPath = first.candidate.configPath
        const env = { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home }
        const wrappers = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }))
        try {
            const sessions = await Promise.all(wrappers.map(async (wrapper, index) => {
                const started = await observeProcessStart(wrapper.pid!, processHost(executeProbe))
                if (started.state !== 'present') throw new Error(JSON.stringify(started))
                return createLifecycleCommandAdapters({ configPath, env, sessionId: `mcp-${index}`, timeoutMs: 5_000,
                    holderProcess: { pid: wrapper.pid!, processStart: started.start } }, executeProbe)
            }))
            expect(await runUp({ configPath }, sessions[0]!)).toMatchObject({ kind: 'complete' })

            const ended = await runSession({ configPath, argv: ['synthetic-mcp-server'], cwd: first.candidate.checkout, env }, {
                up: (input) => runUp(input, sessions[1]!),
                sleep: (input) => runSleep(input, sessions[1]!),
                resolveExecutable: async () => ({ state: 'available', value: {
                    canonicalPath: process.execPath, invocationPath: process.execPath,
                    sha256: '1'.repeat(64), executionMode: 'verified-path',
                } }),
                executeForeground: async () => ({ kind: 'complete', exitCode: 0, signal: null, terminationConfirmed: true }),
            })

            expect(ended, JSON.stringify(ended)).toMatchObject({ kind: 'complete', status: 0, diagnostics: [{ code: 'SESSION_STACK_RETAINED',
                message: expect.stringContaining('an up run outside any session'),
                fix: expect.stringContaining('sleep --config') }] })
            expect(ended.diagnostics[0]!.message).toContain(`process ${wrappers[0]!.pid}`)
            expect(ended.diagnostics[0]!.message).not.toContain('it stops once the last session holding it ends')
        } finally {
            for (const wrapper of wrappers) wrapper.kill('SIGKILL')
        }
    })

    // MCP sessions end together, and their closing sleeps queue on the teardown lock; one that waited
    // longer than two seconds refused, and its hold stayed behind.
    it('completes every session that ends at the same time, and stops the stack after the last', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const configPath = first.candidate.configPath
        const env = { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home }
        const sessionIds = ['mcp-logs', 'mcp-product', 'mcp-browser']
        const adapters = sessionIds.map((sessionId) => createLifecycleCommandAdapters({ configPath, env, sessionId, timeoutMs: 5_000 }, executeProbe))
        for (const sessionAdapters of adapters) expect(await runUp({ configPath }, sessionAdapters)).toMatchObject({ kind: 'complete' })
        expect(await runSleep({ configPath }, first.adapters)).toMatchObject({ kind: 'complete', result: { change: 'retained' } })
        let sleeping!: () => void
        const firstSleepStarted = new Promise<void>((settle) => { sleeping = settle })
        // The first closing sleep holds the teardown lock past the two seconds a sleep used to wait.
        const slowSleep = createLifecycleCommandAdapters({ configPath, env, sessionId: sessionIds[0]!, timeoutMs: 5_000 }, async (step) => {
            sleeping()
            await new Promise((settle) => setTimeout(settle, 3_000))
            return executeProbe(step)
        })
        let slowed = false

        const sleeps = await Promise.all(adapters.map(async (sessionAdapters, index) => {
            if (index > 0) await firstSleepStarted
            const slept = await runSleep({ configPath }, index === 0 && !slowed ? (slowed = true, slowSleep) : sessionAdapters)
            return slept
        }))

        expect(sleeps.map((slept) => slept.kind), JSON.stringify(sleeps)).toEqual(['complete', 'complete', 'complete'])
        expect(sleeps.map((slept) => slept.kind === 'complete' ? slept.result.change : undefined).sort()).toEqual(['retained', 'retained', 'stopped'])
        const stored = await readState(first.context.namespace.paths.coordination(first.context.stackId))
        if (stored.kind !== 'complete') throw new Error(JSON.stringify(stored))
        expect(decodeCoordinationRecord(stored.value, first.context.stackId)).toMatchObject({ holders: [], lease: { released: true } })
    })

    // A Compose file added to environment.compose_files read as one that "changed", so the reader looked
    // for an edit in a file the stack never started from. Up names the addition and keeps the recovery.
    it.each([['a running', false], ['an asleep', true]] as const)('names a Compose file added to the files %s stack started from, with the down-then-up recovery', async (_state, sleepFirst) => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = { configPath: first.candidate.configPath, env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000 }
        if (sleepFirst) expect(await runSleep({ configPath: input.configPath }, createLifecycleCommandAdapters(input, executeProbe)))
            .toMatchObject({ kind: 'complete', result: { change: 'stopped' } })
        await writeFile(join(first.candidate.checkout, 'compose.extra.yml'), 'services: {}\n')
        await writeFile(input.configPath, (await readFile(input.configPath, 'utf8'))
            .replace('compose_files = ["compose.yml"]', 'compose_files = ["compose.yml", "compose.extra.yml"]'))
        const adapters = createLifecycleCommandAdapters(input, executeProbe)
        const loaded = await adapters.load({ configPath: input.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        await configureStackDocker(first.candidate, loaded.result)
        const path = loaded.result.source.path

        const refused = await runUp({ configPath: input.configPath }, adapters)

        expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_PROGRESS_INVALID',
            message: `the recorded stack runs an earlier version of the services, ports, mounts or images: cockpit.toml changed and compose.extra.yml was added to environment.compose_files since it started, and up does not replace a running stack — fix: run \`${cockpitCommand('down', { config: path })}\`, then \`${cockpitCommand('up', { config: path })}\`` }] })
    })

    // Up refused a stack down had removed, while another session held it, with only "rerun up", which
    // met the same hold again; nothing said which session it was or how to look it up.
    it('names the session holding a stack up cannot start, by process, with how to look it up and not its command line', async () => {
        const first = await runStackScenario()
        expect(first.result, JSON.stringify(first.result)).toMatchObject({ kind: 'complete', status: 0 })
        const input = { configPath: first.candidate.configPath, env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'stack-production', timeoutMs: 5_000 }
        expect(await runDown({ configPath: input.configPath }, createDestructiveCommandAdapters({ ...input, dockerContext: 'default' }, executeProbe)))
            .toMatchObject({ kind: 'complete', result: { change: 'removed' } })
        const session = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000) // synthetic-session-argument'], { stdio: 'ignore' })
        try {
            const started = await observeProcessStart(session.pid!, processHost(executeProbe))
            if (started.state !== 'present') throw new Error(JSON.stringify(started))
            const held = createLifecycleCommandAdapters({ ...input, sessionId: 'other-session', holderProcess: { pid: session.pid!, processStart: started.start } }, executeProbe)
            const heldContext = await held.load({ configPath: input.configPath })
            if (heldContext.kind !== 'complete') throw new Error(JSON.stringify(heldContext))
            expect(await held.withAcquiredPorts(heldContext.result, async () => true)).toBe(true)
            const adapters = createLifecycleCommandAdapters(input, executeProbe)
            const loaded = await adapters.load({ configPath: input.configPath })
            if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
            await configureStackDocker(first.candidate, loaded.result)

            const refused = await runUp({ configPath: input.configPath }, adapters)

            expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'CLAIM_CO_TENANT',
                message: expect.stringContaining(`(process ${session.pid})`) }] })
            expect(refused.diagnostics[0]!.message).toContain(`\`ps -o pid,ppid,command -p ${session.pid}\``)
            expect(refused.diagnostics[0]!.message).not.toContain('synthetic-session-argument')
        } finally {
            session.kill('SIGKILL')
        }
    })

    // A session whose start failed keeps its hold and its unfinished progress; another session's up
    // was told to resume or release a start that session owns, with no word of which session it was.
    it('names the session whose unfinished start another session cannot take over, by process', async () => {
        const candidate = await stackFixture()
        const configPath = candidate.configPath
        const env = { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home }
        const session = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        try {
            const started = await observeProcessStart(session.pid!, processHost(executeProbe))
            if (started.state !== 'present') throw new Error(JSON.stringify(started))
            const starting = createLifecycleCommandAdapters({ configPath, env, sessionId: 'mcp-starting', timeoutMs: 5_000,
                holderProcess: { pid: session.pid!, processStart: started.start } }, executeProbe)
            const loaded = await starting.load({ configPath })
            if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
            await configureStackDocker(candidate, loaded.result)
            listenerProbeControl.enabled = true
            await writeFile(join(candidate.root, 'docker-failure-needle'), 'up --detach\n')
            expect(await runUp({ configPath }, starting)).toMatchObject({ kind: 'refusal' })
            await writeFile(join(candidate.root, 'docker-failure-needle'), '\n')

            const refused = await runUp({ configPath }, createLifecycleCommandAdapters({ configPath, env, sessionId: 'mcp-joining', timeoutMs: 5_000 }, executeProbe))

            expect(refused).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'CLAIM_CO_TENANT',
                message: expect.stringContaining(`\`ps -o pid,ppid,command -p ${session.pid}\``) }] })
        } finally {
            session.kill('SIGKILL')
        }
    })
})
