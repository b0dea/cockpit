import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { decodeLifecycleRecord, runDoctor, runSession, runSleep, runUp } from './application.js'
import type { ExecutionStep } from './contract.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { recordLifecycleStarted, resolveLifecycleStage } from './lifecycle-stage.js'
import { createHealthCommandAdapters } from './health-composition.js'
import { readState } from './state.js'
import { readActiveStackInventory } from './claims.js'
import { admitDependencyRuntime, createDependencyRuntimePlan } from './dependency-runtime.js'
import { observeDependencyLoad } from './installs.js'
import { generatedApplicationProjection } from './generated-application.js'
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

describe('production lifecycle adapter composition', () => {
    it('loads authenticated context and supplies fresh runtime, stage, and acquired-port authorities', async () => {
        const candidate = await fixture()
        let operatingSystemOutput = ''
        const execute = async (step: ExecutionStep) => {
            const outcome = await executeProbe(step)
            if (step.id === 'runtime:docker-operating-system' && outcome.kind === 'complete') {
                operatingSystemOutput = new TextDecoder().decode(outcome.stdout)
            }
            return outcome
        }
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
        }, execute)

        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return
        await publishComposeOwnership(candidate.checkout, loaded.result)
        await writeFile(candidate.composePath, [
            'services:',
            '  api:',
            '    labels:',
            `      dev.b0dea.cockpit.stack-id: ${loaded.result.stackId}`,
            `      dev.b0dea.cockpit.config-sha256: ${loaded.result.source.sha256}`,
            '',
        ].join('\n'))
        await publishComposeOwnership(candidate.checkout, loaded.result)
        await writeFile(join(candidate.checkout, 'topology.json'), JSON.stringify({
            services: {
                api: {
                    labels: {
                        'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
                        'dev.b0dea.cockpit.config-sha256': loaded.result.source.sha256,
                    },
                    volumes: [{ type: 'bind', source: join(candidate.checkout, 'siblings', 'api'), target: '/api' }],
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
        expect(readiness).toEqual(expect.objectContaining({ topology: expect.objectContaining({
            stackId: loaded.result.stackId,
            configSha256: loaded.result.source.sha256,
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
            'dev.b0dea.cockpit.config-sha256': loaded.result.source.sha256,
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
            `      dev.b0dea.cockpit.config-sha256: ${loaded.result.source.sha256}`,
            '',
        ].join('\n'))
        await writeFile(join(candidate.checkout, 'topology.json'), JSON.stringify({ services: { api: { labels: {
            'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
            'dev.b0dea.cockpit.config-sha256': loaded.result.source.sha256,
        }, volumes: [{ type: 'bind', source: join(candidate.checkout, 'siblings', 'api'), target: '/api' }] } } }))

        await expect(adapters.withRuntimeReadiness(loaded.result, async (value) => value)).resolves.toBeUndefined()
        expect(execute.mock.calls.some(([step]) => step.id.includes('topology'))).toBe(false)

        const up = await runUp({ configPath: candidate.configPath }, adapters)
        expect(up).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'RUNTIME_UNMEASURED' }] })
        const message = up.diagnostics[0]?.message ?? ''
        expect(message).toContain('Runtime docker-desktop is not supported by a complete measurement row')
        expect(message).toContain('OperatingSystem "Docker Desktop", Name "docker-desktop", OSType "linux"')
        expect(message).toContain('measured rows: docker-desktop (unmeasured)')
        expect(message).toMatch(/cockpit runtime measure --config <cockpit\.toml> --image <local-image> --write$/)
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

        await expect(rejected).rejects.toMatchObject({
            message: 'downstream port preparation and acquired-holder compensation both failed',
            errors: [failure, expect.objectContaining({ message: expect.stringContaining('CLAIM_CO_TENANT') })],
        })
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
            'dev.b0dea.cockpit.config-sha256': loaded.result.source.sha256,
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

    it('measures a machine-only floor through config-bound authority', async () => {
        const candidate = await fixture()
        const source = await readFile(candidate.configPath, 'utf8')
        await writeFile(candidate.configPath, source.replace('compose_files = ["compose.yml"]', 'compose_files = []'))
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'machine-only',
            timeoutMs: 5_000,
        }, executeProbe)
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind).toBe('complete')
        if (loaded.kind !== 'complete') return

        const observations = await adapters.withMachineFloorReadiness(loaded.result, async (value) => value)

        expect(observations).toEqual([
            expect.objectContaining({ code: 'MACHINE_MEMORY_BELOW_FLOOR', stackId: loaded.result.stackId }),
            expect.objectContaining({ code: 'MACHINE_CPU_BELOW_FLOOR', stackId: loaded.result.stackId }),
            expect.objectContaining({ code: 'MACHINE_DISK_BELOW_FLOOR', stackId: loaded.result.stackId }),
        ])
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
            'dev.b0dea.cockpit.config-sha256': loaded.result.source.sha256,
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

    it('names the generated identity change and cleanup commands instead of hiding it behind readiness', async () => {
        const first = await runGeneratedScenario()
        const source = await readFile(first.candidate.configPath, 'utf8')
        await writeFile(first.candidate.configPath, source.replace(
            'reason = "Pinned synthetic runtime"',
            'reason = "Pinned synthetic runtime after configuration review"',
        ))
        const adapters = createLifecycleCommandAdapters({
            configPath: first.candidate.configPath,
            env: { PATH: `${first.candidate.root}:/usr/bin:/bin`, HOME: first.candidate.home },
            sessionId: 'generated-production',
            timeoutMs: 5_000,
        }, executeProbe)
        const loaded = await adapters.load({ configPath: first.candidate.configPath })
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
        const generation = createHash('sha256').update(`generated-environment\0${loaded.result.source.sha256}`).digest('hex')
        await configureGeneratedDocker(first.candidate, loaded.result, generation, {})
        listenerProbeControl.enabled = true

        const result = await runUp({ configPath: first.candidate.configPath }, adapters)

        expect(result).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'LIFECYCLE_PROGRESS_INVALID',
            message: `generated environment identity changed since lifecycle progress was recorded; run \`cockpit down --config ${JSON.stringify(loaded.result.source.path)}\` to remove the old stack, then \`cockpit up --config ${JSON.stringify(loaded.result.source.path)}\``,
        }] })
    })
})
