import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
import { admitDependencyRuntime, createDependencyRuntimePlan } from './dependency-runtime.js'
import { observeDependencyLoad } from './installs.js'
import { generatedApplicationProjection } from './generated-application.js'
import { checkoutId } from './identity.js'
import {
    issueRuntimeMeasurementProbeAuthority,
    observeDockerRuntime,
    projectDependencyRuntime,
    resolveRuntimeServiceOrder,
    type RuntimeTopologyEvidence,
} from './runtime.js'
import { createLifecycleCompositionFixtureSupport } from '../../test-support/lifecycle-composition-fixture.js'

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
    it('completes the generated lifecycle through real owner callbacks', async () => {
        const passed = await runGeneratedScenario()
        expect(passed.result, JSON.stringify(passed.result)).toMatchObject({
            kind: 'complete',
            status: 0,
            result: { change: 'started', stackId: passed.context.stackId },
            progress: { notApplied: [] },
        })
        expect(passed.result.progress?.attempted ?? []).toEqual([])
        expect(passed.result.progress?.applied).toEqual(expect.arrayContaining([
            'publication',
            'generated',
            'dependency:app:install',
            'dependency:app:load',
            'dependency:app:stamp',
            'dependencies',
            'data',
            'data:seeded:seeded-schema',
            'data:seeded:seeded-sweep',
            'data:seeded:seeded-fixtures',
            'vendor:messages:loader',
            'vendor:messages:route',
            'external-dependencies',
            'seeded',
        ]))
        expect(passed.steps.map(({ id }) => id)).toEqual(expect.arrayContaining([
            'runtime:docker-compose:topology:generated-environment',
            'generated-observation:compose-variables',
            'dependency-runtime:inspect:app',
            'data:seeded:seeded-schema',
            'external:messages:loader',
        ]))
        expect(passed.steps.find(({ id }) => id === 'generated-observation:mount:app:/workspace/source')?.paths)
            .toContain(join(passed.candidate.checkout, 'app'))
        const seeded = await resolveLifecycleStage({
            namespace: passed.context.namespace,
            stackId: passed.context.stackId,
            observedAt: new Date().toISOString(),
        })
        expect(seeded).toMatchObject({ kind: 'complete', authority: { stage: 'steady' } })
        const doctor = await runDoctor({ configPath: passed.candidate.configPath }, createHealthCommandAdapters({
            configPath: passed.candidate.configPath,
            env: { PATH: `${passed.candidate.root}:/usr/bin:/bin`, HOME: passed.candidate.home },
            timeoutMs: 5_000,
        }, executeProbe))
        expect(doctor.result.checks, JSON.stringify(doctor.diagnostics)).toEqual(expect.arrayContaining([
            expect.objectContaining({ owner: 'generated-environment' }),
            expect.objectContaining({ owner: 'dependency-install-policy' }),
            expect.objectContaining({ owner: 'environment-data-plane' }),
            expect.objectContaining({ owner: 'external-dependency-boundary' }),
        ]))
    }, 120_000)

    it.each(['bind', 'environment-file', 'build-context', 'default-dockerfile', 'explicit-dockerfile'] as const)(
        'checks every %s host input before Compose build or start', async (input) => {
            const candidate = await generatedFixture()
            const originalConfig = await readFile(candidate.configPath, 'utf8')
            for (const defect of ['final-link', 'intermediate-link', 'wrong-type', 'missing', 'valid'] as const) {
                const home = join(candidate.root, `home-${defect}`)
                await mkdir(home)
                await rm(join(candidate.checkout, 'app/inputs'), { recursive: true, force: true })
                const directory = input === 'bind' || input === 'build-context'
                const build = input.includes('dockerfile') || input === 'build-context'
                const sourceDirectory = input === 'bind' ? 'inputs/source' : '.'
                const environmentFile = input === 'environment-file' ? 'inputs/runtime' : '.env'
                const buildDeclaration = build ? { context: 'inputs/context',
                    ...(input === 'explicit-dockerfile' ? { dockerfile: 'recipe/Containerfile' } : {}) } : undefined
                const source = input === 'bind' ? sourceDirectory : input === 'environment-file' ? environmentFile
                    : input === 'build-context' ? 'inputs/context'
                    : `inputs/context/${buildDeclaration?.dockerfile ?? 'Dockerfile'}`
                const target = join(candidate.checkout, 'app', source)
                const foreign = join(candidate.root, `foreign-${defect}`)
                await mkdir(foreign)
                const foreignFile = join(foreign, 'sentinel')
                await writeFile(foreignFile, 'foreign input must remain unchanged\n')
                const foreignBefore = await lstat(foreignFile)
                const config = originalConfig
                    .replace('kind = "bind"\nsource = "."', `kind = "bind"\nsource = "${sourceDirectory}"`)
                    .replace('app:bind:.:/workspace/source', `app:bind:${sourceDirectory}:/workspace/source`)
                    .replace('kind = "environment-file"\nsource = ".env"', `kind = "environment-file"\nsource = "${environmentFile}"`)
                    .replace('app:environment-file:.env:/workspace/.env', `app:environment-file:${environmentFile}:/workspace/.env`)
                await writeFile(candidate.configPath, buildDeclaration ? config.replace(
                    /\[environment\.generated\.services\.image\][\s\S]*?(?=\[\[environment\.generated\.services\.ports\]\])/,
                    `[environment.generated.services.build]\ncontext = "${buildDeclaration.context}"\n${buildDeclaration.dockerfile ? `dockerfile = "${buildDeclaration.dockerfile}"\n` : ''}\n`,
                ) : config)
                await mkdir(resolve(target, '..'), { recursive: true })
                if (directory) await mkdir(target)
                else await writeFile(target, input === 'environment-file' ? 'SYNTHETIC_SETTING=1\n' : 'FROM scratch\n')
                if (buildDeclaration && input === 'build-context') await writeFile(join(target, 'Dockerfile'), 'FROM scratch\n')
                if (defect === 'intermediate-link') {
                    const intermediate = resolve(target, '..')
                    await rm(intermediate, { recursive: true })
                    await symlink(foreign, intermediate)
                } else if (defect !== 'valid') {
                    await rm(target, { recursive: true })
                    if (defect === 'final-link') await symlink(directory ? foreign : foreignFile, target)
                    if (defect === 'wrong-type') {
                        if (directory) await writeFile(target, 'not a directory\n')
                        else await mkdir(target)
                    }
                }
                const steps: ExecutionStep[] = []
                const adapters = createLifecycleCommandAdapters({
                    configPath: candidate.configPath,
                    env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: home },
                    sessionId: 'generated-inputs', timeoutMs: 5_000,
                }, async (step) => {
                    steps.push(step)
                    return executeProbe(step)
                })
                const loaded = await adapters.load({ configPath: candidate.configPath })
                expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
                if (loaded.kind !== 'complete') throw new Error('generated input configuration was refused')
                const generation = createHash('sha256').update(`generated-environment\0${loaded.result.source.sha256}`).digest('hex')
                await configureGeneratedDocker(candidate, loaded.result, generation, {
                    sourceDirectory, environmentFile, ...(buildDeclaration ? { build: buildDeclaration } : {}),
                })
                listenerProbeControl.enabled = true
                const result = await runUp({ configPath: candidate.configPath }, adapters)
                const dispatches = steps.filter(({ id }) => /^runtime:docker-compose:(build|start):/.test(id))
                if (defect === 'valid') expect(dispatches.length, JSON.stringify(result)).toBeGreaterThan(0)
                else {
                    expect(result.kind, `${input}:${defect}`).toBe('refusal')
                    expect.soft(dispatches.map(({ id }) => id), `${input}:${defect}`).toEqual([])
                    const contextLink = input === 'default-dockerfile' && defect === 'intermediate-link'
                    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
                        code: 'GENERATED_ENVIRONMENT_UNAVAILABLE', target: contextLink ? resolve(target, '..') : target,
                        message: expect.stringContaining(`ordinary ${directory || contextLink ? 'directory' : 'file'}`),
                    })]))
                    expect(result.diagnostics.some(({ message }) => message.includes('rerun cockpit up --config cockpit.toml'))).toBe(true)
                }
                const foreignAfter = await lstat(foreignFile)
                expect({ dev: foreignAfter.dev, ino: foreignAfter.ino }).toEqual({ dev: foreignBefore.dev, ino: foreignBefore.ino })
                expect(await readFile(foreignFile, 'utf8')).toBe('foreign input must remain unchanged\n')
            }
        }, 180_000)

    it('refuses a generated lifecycle with a wrong effective port', async () => {
        const broken = await runGeneratedScenario({ portOffset: 10 })
        expect(broken.result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'GENERATED_ENVIRONMENT_UNAVAILABLE' })],
            progress: { applied: ['publication'] },
        })
        expect(broken.result.progress?.notApplied).toEqual(expect.arrayContaining(['generated', 'dependencies', 'data', 'external-dependencies', 'seeded']))
        expect(broken.steps.some(({ id }) => id.startsWith('dependency-runtime:'))).toBe(false)
        expect(broken.steps.some(({ id }) => id.startsWith('data:'))).toBe(false)
        expect(broken.steps.some(({ id }) => id.startsWith('external:'))).toBe(false)
        const unseeded = await resolveLifecycleStage({
            namespace: broken.context.namespace,
            stackId: broken.context.stackId,
            observedAt: new Date().toISOString(),
        })
        expect(unseeded).toMatchObject({ kind: 'complete', authority: { stage: 'bootstrap' } })
    })

    it('preserves generated lifecycle progress and replays a failed vendor route', async () => {
        const failed = await runGeneratedScenario({ failNeedle: 'vendor.mjs route' })
        expect(failed.result).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'EXTERNAL_DEPENDENCIES_UNAVAILABLE' })],
            progress: {
                attempted: ['vendor:messages:route'],
                notApplied: expect.arrayContaining([
                    'vendor:messages:egress',
                    'vendor:messages:stub-rejection',
                    'vendor:messages:stub-outage',
                    'external-dependencies',
                    'seeded',
                ]),
            },
        })
        expect(failed.result.progress?.applied).toEqual(expect.arrayContaining([
            'vendor:messages:tls-generate',
            'vendor:messages:tls-trust',
            'vendor:messages:tls-hostname',
            'vendor:messages:loader',
        ]))
        const applied = new Set(failed.result.progress?.applied ?? [])
        const attempted = new Set(failed.result.progress?.attempted ?? [])
        const notApplied = new Set(failed.result.progress?.notApplied ?? [])
        expect([...attempted].filter((id) => applied.has(id))).toEqual([])
        expect([...notApplied].filter((id) => applied.has(id) || attempted.has(id))).toEqual([])
        const stored = await readState(failed.context.namespace.paths.lifecycle(failed.context.stackId))
        expect(stored.kind).toBe('complete')
        if (stored.kind !== 'complete') return
        expect(decodeLifecycleRecord(stored.value, failed.context)?.value.generatedProgress).toEqual(failed.result.progress)
        const routeStepsBeforeReplay = failed.steps.filter(({ id }) => id === 'external:messages:route').length
        const replayAdapters = createLifecycleCommandAdapters({
            configPath: failed.candidate.configPath,
            env: { PATH: `${failed.candidate.root}:/usr/bin:/bin`, HOME: failed.candidate.home },
            sessionId: 'generated-production',
            timeoutMs: 5_000,
        }, async (step) => {
            failed.steps.push(step)
            return executeProbe(step)
        })
        const replay = await runUp({ configPath: failed.candidate.configPath }, replayAdapters)
        expect(replay).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({ code: 'EXTERNAL_DEPENDENCIES_UNAVAILABLE' })],
        })
        expect(failed.steps.filter(({ id }) => id === 'external:messages:route')).toHaveLength(routeStepsBeforeReplay + 1)
    })

    it('synchronizes and replays the exact generated application for runtime readiness', async () => {
        const candidate = await generatedFixture()
        const steps: ExecutionStep[] = []
        const executions: Array<{ id: string; kind: string; code?: string }> = []
        const adapters = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'generated-sync',
            timeoutMs: 5_000,
        }, async (step) => {
            steps.push(step)
            const outcome = await executeProbe(step)
            executions.push({
                id: step.id,
                kind: outcome.kind,
                ...('code' in outcome ? { code: outcome.code } : {}),
            })
            return outcome
        })
        const loaded = await adapters.load({ configPath: candidate.configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return
        const application = await adapters.withAcquiredPorts(loaded.result,
            async ({ projection }) => adapters.prepareGeneratedEnvironment(loaded.result, projection))
        expect(generatedApplicationProjection(application)).toBe(application)
        if (!application) return
        expect(application).toMatchObject({ profiles: ['application'], generation: expect.stringMatching(/^[a-f0-9]{64}$/) })
        const project = `cockpit-${application.generation.slice(0, 12)}`
        await writeFile(join(candidate.checkout, 'topology.json'), JSON.stringify({
            volumes: {
                dependencies: { name: `${project}_dependencies` },
                'product-data': { name: `${project}_product-data` },
            },
            services: { app: {
            profiles: ['application'],
            image: 'node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5',
            labels: {
                'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
                'dev.b0dea.cockpit.config-sha256': loaded.result.source.sha256,
                'dev.b0dea.cockpit.generation-id': application.generation,
                'dev.b0.cockpit.generated': '1',
                'dev.b0.cockpit.generation': application.generation,
                'dev.b0.cockpit.source-sha256': loaded.result.source.sha256,
            },
            volumes: [
                { type: 'bind', source: join(candidate.checkout, 'app'), target: '/workspace/source' },
                { type: 'bind', source: join(candidate.checkout, 'app/.env'), target: '/workspace/.env' },
                { type: 'volume', source: 'dependencies', target: '/workspace/node_modules' },
                { type: 'volume', source: 'product-data', target: '/workspace/data' },
            ],
        } } }))

        const acquired = await adapters.withAcquiredPorts(loaded.result, async (value) => value)
        expect(acquired).toBeDefined()
        if (!acquired) return
        const readiness = await adapters.withRuntimeReadiness(loaded.result, async (value) => value, acquired.projection)
        const ids = steps.map(({ id }) => id)
        expect.soft(ids).toContain('runtime:docker-compose-version')
        expect.soft(ids).toContain('runtime:docker-operating-system')
        expect.soft(ids).toContain('runtime:docker-compose:topology:generated-environment')
        expect.soft(ids).toContain('runtime:measure:resources')
        expect.soft(ids).toContain('runtime:measure:free-disk')
        expect.soft(executions.filter(({ id }) => id.startsWith('runtime:')).every(({ kind }) => kind === 'complete')).toBe(true)
        expect(readiness, JSON.stringify({ ids, executions, lease: acquired.projection.lease })).toEqual(expect.objectContaining({ topology: expect.objectContaining({
            stackId: loaded.result.stackId,
            services: [expect.objectContaining({ id: 'app' })],
        }) }))
        if (!readiness) return
        await expect(adapters.withGeneratedRuntime(loaded.result, readiness, async (value) => value))
            .resolves.toEqual(expect.objectContaining({ application, runtime: expect.objectContaining({
                publicEnv: expect.objectContaining({ APP_HOST_PORT: String(acquired.projection.lease.ports.APP_HOST_PORT) }),
            }) }))
        await expect(adapters.withGeneratedRuntime(loaded.result, { ...readiness } as never, async (value) => value))
            .resolves.toBeUndefined()
        const topologyStep = steps.find((step) => step.id === 'runtime:docker-compose:topology:generated-environment')
        expect(topologyStep?.argv).toEqual(expect.arrayContaining([
            join(candidate.checkout, 'generated/compose.yml'), '--profile', 'application',
        ]))

        const replay = createLifecycleCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            sessionId: 'generated-replay',
            timeoutMs: 5_000,
        }, executeProbe)
        const replayed = await replay.load({ configPath: candidate.configPath })
        expect(replayed.kind).toBe('complete')
        if (replayed.kind !== 'complete') return
        await expect(replay.withRuntimeReadiness(
            replayed.result,
            async (value) => value,
            acquired.projection,
        )).resolves.toBeDefined()
    })

})
