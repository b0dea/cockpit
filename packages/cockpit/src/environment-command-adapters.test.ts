import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import {
    checkoutId as deriveCheckoutId,
    cockpitId as deriveCockpitId,
    stackId as deriveStackId,
} from './environment/identity.js'
import { setupCommand } from './setup/command.js'
import type {
    SetupCommandAdapters,
    SetupCommandInput,
} from './setup/command.js'
import { loadCockpitConfig } from './config/load.js'
import { CockpitConfig } from './schema.js'
import { executeProbe } from './environment-exec/execute.js'
import { ENVIRONMENT_CODES, type EnvironmentObservation } from './environment/contract.js'
import { resolvedExecutable, resolveGitExecutable } from './environment/executable.js'
import { observeSetupCheckout, withSetupCheckoutProjection } from './environment/setup-observation.js'
import { observeConfiguration, selectStateRoot } from './environment/state.js'
import { recordLifecycleStarted, recordLifecycleSeeded, resolveLifecycleStage } from './environment/lifecycle-stage.js'
import { refreshObservationPostures, resolveObservationPostures, type PreflightContext } from './environment/observations.js'
import { admitRuntimeTopology, createRuntimeAdapter, createRuntimeTopologyPlan, observeRuntimeExecution, projectRuntimeExecutionEnvironment } from './environment/runtime.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './generated-environment/command.js'
import { observeGeneratedApplication, projectGeneratedApplicationRuntimeAuthority } from './environment/generated-application.js'
import { admitGeneratedObservation, createGeneratedObservationExecution, inspectGeneratedRuntimeAuthority } from './environment/generated-stack.js'
import { deriveEntrypoints, observePortFamily, projectPortLeaseResult } from './environment/ports.js'
import { leasePortFamilyFixture } from '../test-support/port-lease-fixture.js'
import { holderId as deriveHolderId } from './environment/identity.js'
import type { HealthObservationProducers, HealthObservationSource, HealthObservationSourceInput } from './environment/application.js'

const application = vi.hoisted(() => ({
    runBaselineRecord: vi.fn(),
    runDoctor: vi.fn(),
    runDown: vi.fn(),
    runLogs: vi.fn(),
    runPreflight: vi.fn(),
    runReset: vi.fn(),
    runSetup: vi.fn(),
    runSleep: vi.fn(),
    runUp: vi.fn(),
}))

vi.mock('./environment/application.js', () => application)

afterEach(() => vi.clearAllMocks())

const applicationPath = fileURLToPath(new URL('./environment/application.ts', import.meta.url))
const commandPath = fileURLToPath(new URL('./setup/command.ts', import.meta.url))
const checkoutId = deriveCheckoutId({ checkoutPath: '/synthetic/checkout' })
const stackId = deriveStackId({
    cockpitId: deriveCockpitId({ name: 'synthetic', mainCheckoutPath: '/synthetic/main' }),
    checkoutId,
    variant: { kind: 'shared' },
})

function imports(source: string): readonly string[] {
    return [...source.matchAll(/(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1]!)
}

describe('setup command adapter boundary', () => {
    it('owns the setup command contract in the environment application', () => {
        const application = readFileSync(applicationPath, 'utf8')
        const command = readFileSync(commandPath, 'utf8')

        expect(application).toMatch(/export interface SetupCommandInput/)
        expect(application).toMatch(/export interface SetupCommandResult/)
        expect(application).toMatch(/export interface SetupCommandAdapters/)
        expect(imports(application)).not.toContain('../setup/command.js')
        expect(imports(command)).toContain('../environment/application.js')
        const contractImport = command.match(
            /import type\s*\{([\s\S]*?)\}\s*from '..\/environment\/application\.js'/,
        )?.[1]
        expect(contractImport).toContain('SetupCommandInput')
        expect(contractImport).toContain('SetupCommandResult')
        expect(contractImport).toContain('SetupCommandAdapters')
        expect(command).not.toMatch(/(?:interface|type)\s+SetupCommand(?:Input|Result|Adapters)\b/)
    })

    it('keeps execution access out of the command adapter', () => {
        const command = readFileSync(commandPath, 'utf8')

        expect(imports(command)).not.toContain('../environment-exec/execute.js')
        expect(command).not.toMatch(/\bexecutePlan\s*\(/)
        expect(command).not.toMatch(/\b(?:loadCockpitConfig|resolveGitExecutable|planSetup)\b/)
        expect(command).toMatch(/return runSetup\(input, adapters\)/)
    })

    it('returns the exact application envelope after forwarding the input and adapters', async () => {
        const input = Object.freeze({ configPath: '/synthetic/cockpit.toml' }) as SetupCommandInput
        const adapters = Object.freeze({}) as SetupCommandAdapters
        const result = Object.freeze({
            kind: 'complete',
            status: 0,
            result: Object.freeze({
                source: Object.freeze({
                    path: '/synthetic/cockpit.toml',
                    byteLength: 1,
                    sha256: '1'.repeat(64),
                }),
                siblings: Object.freeze([]),
            }),
            diagnostics: Object.freeze([]),
        }) satisfies Awaited<ReturnType<typeof setupCommand>>
        application.runSetup.mockResolvedValueOnce(result)

        const returned = await setupCommand(input, adapters)

        expect(application.runSetup).toHaveBeenCalledOnce()
        expect(application.runSetup).toHaveBeenCalledWith(input, adapters)
        expect(returned).toBe(result)
    })
})

describe('environment observation command adapters', () => {
    it('preserves generated HTTP 503 health failure through preflight and doctor', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-http-health-')))
        const requests: string[] = []
        const server = createServer((request, response) => {
            requests.push(request.url ?? '')
            response.writeHead(503, { 'Content-Type': 'text/plain' })
            response.end('synthetic service unavailable')
        })
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject)
                server.listen(0, '127.0.0.1', resolve)
            })
            const address = server.address()
            if (!address || typeof address === 'string') throw new Error('HTTP health server has no TCP address')
            const endpoint = `http://127.0.0.1:${address.port}/health`
            execFileSync('git', ['init', '--quiet', root])
            execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
                'commit', '--quiet', '--allow-empty', '-m', 'synthetic fixture'])
            const fixture = await loadCockpitConfig('fixtures/registries/generated-environment.toml')
            if (fixture.kind !== 'complete' || !fixture.result.config.environment.generated) throw new Error('generated health fixture was refused')
            const declaration = structuredClone(fixture.result.config.environment.generated)
            const service = declaration.services[0]!
            service.health.probe = { ...service.health.probe,
                argv: ['node', '-e', `fetch(${JSON.stringify(endpoint)}).then(response => { console.log(response.status); process.exit(response.ok ? 0 : 1) }).catch(error => { console.error(error); process.exit(2) })`] }
            const document = parseToml(readFileSync('fixtures/registries/generated-environment.toml', 'utf8'))
            const source = stringifyToml({ ...document, cockpit: { name: 'generated-environment', siblings_root: '.' },
                environment: { install_policies: fixture.result.config.environment.install_policies, generated: declaration } })
            const validated = CockpitConfig.safeParse(parseToml(source))
            if (!validated.success) throw new Error(`generated health schema issues: ${JSON.stringify(validated.error.issues)}`)
            const configPath = join(root, 'cockpit.toml')
            await writeFile(configPath, source)
            await mkdir(join(root, 'app'))
            await writeFile(join(root, 'app/.env'), 'SYNTHETIC=1\n')
            await writeFile(join(root, 'app/.node-version'), '22.0.0\n')
            await mkdir(join(root, 'fixtures'))
            await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
            const synced = await syncGeneratedEnvironment({ configPath })
            if (synced.kind !== 'complete') throw new Error(`generated health sync was refused: ${JSON.stringify(synced.diagnostics)}`)
            const composePath = join(root, 'compose.generated.yml')
            const compose = readFileSync(composePath, 'utf8')
            const renderedCompose = parseYaml(compose)
            const renderedService = renderedCompose.services.app
            const cockpit = deriveCockpitId({ name: 'generated-environment', mainCheckoutPath: root })
            const checkout = deriveCheckoutId({ checkoutPath: root })
            const stack = deriveStackId({ cockpitId: cockpit, checkoutId: checkout, variant: { kind: 'shared' } })
            expect(renderedService.labels['dev.b0dea.cockpit.stack-id'])
                .toBe('${COCKPIT_STACK_ID:?cockpit runtime stack identity is unavailable}')
            expect(renderedService.labels['dev.b0dea.cockpit.owner-id'])
                .toBe('${COCKPIT_OWNER_ID:?cockpit runtime owner identity is unavailable}')
            const labels = { ...renderedService.labels,
                'dev.b0dea.cockpit.stack-id': stack, 'dev.b0dea.cockpit.owner-id': cockpit }
            const holder = deriveHolderId({ stackId: stack, checkoutId: checkout, sessionId: 'synthetic-http-health' })
            const state = await selectStateRoot({ platform: 'linux', home: root, cockpitId: cockpit })
            if (state.kind !== 'complete') throw new Error('generated health state root was refused')
            const observedAt = new Date().toISOString()
            const lease = await leasePortFamilyFixture({ namespace: state.value, stackId: stack, holderId: holder, checkoutId: checkout,
                config: fixture.result.config.ports, now: observedAt, listenerTimeoutMs: 1_000,
                listenerEvidence: Array.from({ length: fixture.result.config.ports.count }, (_, offset) => ({
                    ports: Object.values(fixture.result.config.ports.bases).map(base => base + offset * fixture.result.config.ports.step),
                    observation: { state: 'available' as const, value: [], observedAt, producer: 'synthetic-listener-control' },
                })) })
            if (lease.kind !== 'complete') throw new Error(`generated health port lease was refused: ${JSON.stringify(lease)}`)
            const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
            if (entrypoints.kind !== 'complete') throw new Error('generated health entrypoints were refused')
            const portLeaseProjection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
            if (!portLeaseProjection) throw new Error('generated health port projection was refused')
            const effectivePort = lease.lease.ports.APP_HOST_PORT!
            const resolvedVolumes = renderedService.volumes.map((volume: { type: string; source: string; target: string }) =>
                volume.type === 'bind' ? { ...volume, source: resolve(root, volume.source) } : volume)
            const expectedMountSources = resolvedVolumes.filter(({ type }: { type: string }) => type === 'bind')
                .map(({ source }: { source: string }) => source).sort()
            const topologyDocument = { services: { app: { image: renderedService.image, labels,
                healthcheck: renderedService.healthcheck, volumes: resolvedVolumes,
                ports: [{ target: service.ports[0]!.internal, published: String(effectivePort) }] } },
                volumes: Object.fromEntries(Object.keys(renderedCompose.volumes).map(source => [source, { name: `synthetic_${source}` }])) }
            for (const transition of [recordLifecycleStarted, recordLifecycleSeeded]) {
                if ((await transition({ namespace: state.value, stackId: stack, holderId: holder, observedAt })).kind !== 'complete') {
                    throw new Error('generated health lifecycle transition was refused')
                }
            }
            const docker = join(root, 'docker')
            const script = `#!${process.execPath}
const args = process.argv.slice(2)
if (args.includes('config')) {
    if (process.env.COCKPIT_STACK_ID !== ${JSON.stringify(stack)} || process.env.COCKPIT_OWNER_ID !== ${JSON.stringify(cockpit)}) {
        throw new Error('synthetic Compose requires authenticated runtime identity variables')
    }
    process.stdout.write(${JSON.stringify(JSON.stringify(topologyDocument))})
}
else if (args.includes('exec')) {
    const command = args.slice(args.indexOf('-T') + 2)
    if (command[0] === 'node' && (command[1] === '-e' || command[1] === '--version')) {
        const result = require('node:child_process').spawnSync(process.execPath, command.slice(1), { stdio: 'inherit' })
        if (result.error) throw result.error
        process.exit(result.status ?? 2)
    }
}
`
            await writeFile(docker, script)
            await chmod(docker, 0o700)
            const executable = resolvedExecutable({ canonicalPath: docker, invocationPath: docker,
                sha256: createHash('sha256').update(script).digest('hex'), executionMode: 'verified-path' })!
            const composeSha256 = createHash('sha256').update(compose).digest('hex')
            const batchId = 'f'.repeat(64)
            const runtime = createRuntimeAdapter({ runtime: { name: 'docker', version: '27.1.2', executableSha256: executable.sha256 },
                composeVersion: '2.39.2', executable, operation: 'validate', cwd: root, stackId: stack,
                coldStartLimitMillis: 60_000, expectedMountSources, ports: [effectivePort], projectName: 'synthetic', env: {}, timeoutMs: 5_000,
                labels: { stackId: stack, configSha256: synced.result.application.runtimeSha256, batchId },
                composeFiles: [{ reference: 'compose.generated.yml', canonicalPath: composePath, source: compose, sha256: composeSha256 }] },
                { generatedComposeAuthority: synced.result.application.generatedComposeAuthority!, portLeaseProjection })
            if (runtime.kind !== 'preview') throw new Error(`generated health runtime was refused: ${JSON.stringify(runtime)}`)
            expect(labels['dev.b0dea.cockpit.stack-id']).toBe(stack)
            const planned = createRuntimeTopologyPlan({ runtimePlan: runtime.plan, stackId: stack,
                configSha256: synced.result.application.runtimeSha256, batchId,
                observationWindow: { startedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } })
            if (planned.kind !== 'planned') throw new Error(planned.reason)
            const topology = admitRuntimeTopology({ plan: planned, outcome: await executeProbe(planned.step) })
            if (topology.kind !== 'complete') throw new Error(topology.reason)
            const publicEnv = projectRuntimeExecutionEnvironment(topology.topology)
            if (!publicEnv) throw new Error('generated health runtime environment authority was refused')
            const canonicalNode = await realpath(process.execPath)
            const nodeExecutable = resolvedExecutable({ canonicalPath: canonicalNode, invocationPath: process.execPath,
                sha256: createHash('sha256').update(readFileSync(canonicalNode)).digest('hex'), executionMode: 'verified-path' })!
            const harness = { topology: topology.topology, runtime: { root, executable,
                composeFiles: [{ path: composePath, sha256: composeSha256 }], projectName: 'synthetic',
                publicEnv, hostExecutables: { [process.execPath]: nodeExecutable },
                stdoutLimitBytes: 4_096, stderrLimitBytes: 1_024 } }
            const git = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
            if (git.state !== 'available') throw new Error('generated health Git executable was unavailable')
            const aggregates: EnvironmentObservation[] = []
            const load = async (_input: unknown, issue: (source: HealthObservationSourceInput) => HealthObservationSource | undefined) => {
                const fresh = await loadCockpitConfig(configPath)
                if (fresh.kind !== 'complete') throw new Error('generated health configuration did not reload')
                const setupTime = new Date().toISOString()
                const setup = await observeSetupCheckout({ source: fresh.result.source, cockpitName: fresh.result.config.cockpit.name,
                    observedAt: setupTime, env: {}, gitExecutable: git.value })
                const configuration = (await observeConfiguration({ stackId: stack, observedAt: setupTime, path: configPath }))
                    .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
                const posture = await resolveObservationPostures({ configuration, cockpitId: cockpit, checkoutPath: root, variant: { kind: 'shared' } })
                const stage = await resolveLifecycleStage({ namespace: state.value, stackId: stack, observedAt: setupTime })
                if (stage.kind !== 'complete') throw new Error('generated health lifecycle authority was refused')
                const refreshPreflight = async (previous: PreflightContext): Promise<PreflightContext> => {
                    const observedAt = new Date().toISOString()
                    const configuration = (await observeConfiguration({ stackId: stack, observedAt, path: configPath }))
                        .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
                    const posture = await refreshObservationPostures({ configuration, cockpitId: cockpit, checkoutPath: root,
                        variant: { kind: 'shared' }, previous: previous.authorities[0]! })
                    const stage = await resolveLifecycleStage({ namespace: state.value, stackId: stack, observedAt })
                    if (stage.kind !== 'complete') throw new Error('generated health lifecycle refresh was refused')
                    expect(stage.authority).not.toBe(previous.stages[0])
                    expect(posture.evaluatedAt).toBe(previous.authorities[0]!.evaluatedAt)
                    return { authorities: [posture], stages: [stage.authority] }
                }
                const generated = async () => {
                    const current = await checkGeneratedEnvironment({ configPath })
                    if (current.kind !== 'complete') throw new Error(`generated health check was refused: ${JSON.stringify(current.diagnostics)}`)
                    const authority = projectGeneratedApplicationRuntimeAuthority(current.result.application, harness)
                    if (!authority) throw new Error('generated health runtime authority was refused')
                    const rendered = inspectGeneratedRuntimeAuthority(authority)!.rendered
                    const health = rendered.observations.find(({ id }) => id === 'health:app:property')!
                    const execution = createGeneratedObservationExecution({ authority, observation: health })
                    if (execution.kind !== 'planned') throw new Error(execution.reason)
                    const before = requests.length
                    const outcome = await executeProbe(execution.step)
                    expect(outcome.stdout.toString('utf8').trim()).toBe('503')
                    expect(requests.slice(before)).toEqual(['/health'])
                    expect(admitGeneratedObservation({ execution, outcome })).toMatchObject({ id: 'health:app:property', kind: 'failed' })
                    const aggregate = await observeGeneratedApplication(current.result.application, harness, async step => {
                        const outcome = await executeProbe(step)
                        expect(outcome.kind).toBe(step.labels.generatedObservationId === health.id ? 'refusal' : 'complete')
                        return outcome
                    })
                    expect(requests.slice(before)).toEqual(['/health', '/health'])
                    expect(aggregate).toMatchObject({ owner: 'generated-environment', code: ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE,
                        observed: { state: 'failed' } })
                    if (!aggregate) throw new Error('generated health aggregate was not issued')
                    aggregates.push(aggregate)
                    return [aggregate]
                }
                const none = async () => []
                const producers: HealthObservationProducers = { surfaces: none, generated, data: none, external: none, claims: none, git: none,
                    host: none, installs: none, lifecycle: none, ports: none, runtime: none, state: none, templates: none, envSchema: none }
                const source = await withSetupCheckoutProjection(setup, { source: fresh.result.source,
                    cockpitName: fresh.result.config.cockpit.name, evaluatedAt: Date.parse(setupTime) }, checkout => issue({
                    checkout, configuration: fresh.result, preflight: { authorities: [posture], stages: [stage.authority] },
                    env: {}, gitExecutable: git.value, timeoutMs: 1_000, producers, refreshPreflight, stopped: null, notices: () => [],
                }))
                if (!source) throw new Error('generated health source was not issued')
                return source
            }
            const actual = await vi.importActual<typeof import('./environment/application.js')>('./environment/application.js')
            const adapters = { load, execute: executeProbe }
            const preflight = await actual.runPreflight({ configPath }, adapters)
            const doctor = await actual.runDoctor({ configPath }, adapters)
            expect(aggregates).toHaveLength(2)
            expect(aggregates[0]).not.toBe(aggregates[1])
            const checks = [preflight.result, doctor.result].map(result => result.checks.find(({ owner, code }) =>
                owner === 'generated-environment' && code === ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE))
            for (const check of checks) {
                expect.soft(check).toMatchObject({ owner: 'generated-environment', code: ENVIRONMENT_CODES.GENERATED_ENVIRONMENT_UNAVAILABLE,
                    verdict: 'fail' })
                expect(check).not.toHaveProperty('measured')
                expect.soft(check?.verdict).not.toBe('unavailable')
            }
            expect(checks[1]).toMatchObject({ owner: checks[0]?.owner, code: checks[0]?.code, verdict: checks[0]?.verdict })
            expect(preflight.kind).toBe('blocked')
            expect(preflight.result.verdict).toBe('fail')
            expect(doctor.result.verdict).toBe('fail')
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
            await rm(root, { recursive: true, force: true })
        }
    })

    it('preserves producer-issued tri-state healthy, unhealthy, empty, unavailable configuration and transport facts through both real routes', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-health-routes-')))
        try {
            execFileSync('git', ['init', '--quiet', root])
            execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
                'commit', '--quiet', '--allow-empty', '-m', 'synthetic fixture'])
            const configPath = join(root, 'cockpit.toml')
            await writeFile(configPath, `[cockpit]\nname = "health-routes"\nsiblings_root = "."\n\n[[sibling]]\nslug = "app"\ndir = "app"\nmount = "always"\nacquire = "none"\nvar = "APP_DIR"\npurpose = "Synthetic service"\n\n[ports.bases]\nWEB = 43000\n`)
            await mkdir(join(root, 'app'))
            const loaded = await loadCockpitConfig(configPath)
            if (loaded.kind !== 'complete') throw new Error(`health route configuration was refused: ${JSON.stringify(loaded.diagnostics)}`)
            const cockpit = deriveCockpitId({ name: loaded.result.config.cockpit.name, mainCheckoutPath: root })
            const checkout = deriveCheckoutId({ checkoutPath: root })
            const stack = deriveStackId({ cockpitId: cockpit, checkoutId: checkout, variant: { kind: 'shared' } })
            const holder = deriveHolderId({ stackId: stack, checkoutId: checkout, sessionId: 'synthetic-health' })
            const home = join(root, 'home')
            await mkdir(home)
            const state = await selectStateRoot({ platform: 'linux', home, cockpitId: cockpit })
            if (state.kind !== 'complete') throw new Error('health route state root was refused')
            const observedAt = new Date().toISOString()
            for (const transition of [recordLifecycleStarted, recordLifecycleSeeded]) {
                const result = await transition({ namespace: state.value, stackId: stack, holderId: holder, observedAt })
                if (result.kind !== 'complete') throw new Error('health route lifecycle transition was refused')
            }
            const configuration = (await observeConfiguration({ stackId: stack, observedAt, path: configPath }))
                .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
            const posture = await resolveObservationPostures({ configuration, cockpitId: cockpit, checkoutPath: root, variant: { kind: 'shared' } })
            const git = await resolveGitExecutable({ PATH: process.env.PATH ?? '' })
            if (git.state !== 'available') throw new Error('health route Git executable was unavailable')
            const runtimeValues = async (healthy: boolean) => {
                const directory = join(root, healthy ? 'healthy' : 'unhealthy')
                await mkdir(directory)
                const path = join(directory, 'docker')
                const script = healthy ? "#!/bin/sh\nprintf 'services:\\n  app:\\n    volumes:\\n      - /tmp/source:/workspace\\n'\n" : '#!/bin/sh\nexit 9\n'
                await writeFile(path, script)
                await chmod(path, 0o755)
                const executable = resolvedExecutable({ canonicalPath: path, invocationPath: path,
                    sha256: createHash('sha256').update(script).digest('hex'), executionMode: 'verified-path' })!
                const source = 'services: {}\n'
                const composePath = join(root, 'compose.yml')
                await writeFile(composePath, source)
                const planned = createRuntimeAdapter({ runtime: { name: 'docker', version: '27.1.2', executableSha256: executable.sha256 },
                    composeVersion: '2.39.2', executable, operation: 'validate', cwd: root, stackId: stack,
                    coldStartLimitMillis: 10_000, expectedMountSources: ['/tmp/source'],
                    composeFiles: [{ reference: 'compose.yml', canonicalPath: composePath, source, sha256: createHash('sha256').update(source).digest('hex') }],
                    projectName: 'synthetic-health', env: {}, ports: [], labels: {}, timeoutMs: 10_000 })
                if (planned.kind !== 'preview') throw new Error('health runtime plan was refused')
                return observeRuntimeExecution({ plan: planned.plan, outcome: await executeProbe(planned.plan.steps[0]!) })
            }
            const healthy = await runtimeValues(true)
            const unhealthy = await runtimeValues(false)
            const lease = await leasePortFamilyFixture({ namespace: state.value, stackId: stack, holderId: holder, checkoutId: checkout,
                config: { step: 100, count: 1, bases: { WEB: 43000 } }, now: observedAt, listenerTimeoutMs: 100,
                listenerEvidence: [{ ports: [43000], observation: { state: 'available', value: [], observedAt, producer: 'synthetic-listener-probe' } }] })
            if (lease.kind !== 'complete') throw new Error('health empty listener evidence was refused')
            const empty = await observePortFamily({ namespace: state.value, stackId: stack, observedAt, leaseEvidence: lease })
            const missingConfiguration = (await observeConfiguration({ stackId: stack, observedAt, path: join(root, 'missing.toml') }))
                .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
            const rows: readonly { name: string; producer: keyof HealthObservationProducers; value: EnvironmentObservation; verdict: 'pass' | 'fail' | 'unavailable'; measured?: boolean }[] = [
                { name: 'healthy', producer: 'runtime', value: healthy.find(({ code }) => code === ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE)!, verdict: 'pass', measured: true },
                { name: 'unhealthy', producer: 'runtime', value: unhealthy.find(({ code }) => code === ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE)!, verdict: 'fail', measured: false },
                { name: 'acquisition-only', producer: 'ports', value: empty, verdict: 'unavailable' },
                { name: 'configuration-unavailable', producer: 'state', value: missingConfiguration, verdict: 'unavailable' },
                { name: 'transport', producer: 'runtime', value: unhealthy.find(({ code }) => code === ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE)!, verdict: 'unavailable' },
            ]
            const actual = await vi.importActual<typeof import('./environment/application.js')>('./environment/application.js')
            for (const row of rows) {
                const load = async (_input: unknown, issue: (source: HealthObservationSourceInput) => HealthObservationSource | undefined) => {
                    const fresh = await loadCockpitConfig(configPath)
                    if (fresh.kind !== 'complete') throw new Error('health route configuration did not reload')
                    const setupTime = new Date().toISOString()
                    const setup = await observeSetupCheckout({ source: fresh.result.source, cockpitName: fresh.result.config.cockpit.name,
                        observedAt: setupTime, env: {}, gitExecutable: git.value })
                    expect(setup).toMatchObject({ state: 'available' })
                    const stage = await resolveLifecycleStage({ namespace: state.value, stackId: stack, observedAt })
                    if (stage.kind !== 'complete') throw new Error('health route lifecycle authority was refused')
                    const preflight: PreflightContext = { authorities: [posture], stages: [stage.authority] }
                    const refreshPreflight = async (previous: PreflightContext): Promise<PreflightContext> => {
                        const observedAt = new Date().toISOString()
                        const configuration = (await observeConfiguration({ stackId: stack, observedAt, path: configPath }))
                            .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)!
                        const posture = await refreshObservationPostures({ configuration, cockpitId: cockpit, checkoutPath: root,
                            variant: { kind: 'shared' }, previous: previous.authorities[0]! })
                        const stage = await resolveLifecycleStage({ namespace: state.value, stackId: stack, observedAt })
                        if (stage.kind !== 'complete') throw new Error('health route lifecycle refresh was refused')
                        expect(stage.authority).not.toBe(previous.stages[0])
                        expect(posture.evaluatedAt).toBe(previous.authorities[0]!.evaluatedAt)
                        return { authorities: [posture], stages: [stage.authority] }
                    }
                    const produce = async () => [row.value]
                    const none = async () => []
                    const producers: HealthObservationProducers = { surfaces: none, generated: none, data: none, external: none, claims: none,
                        git: none, host: none, installs: none, lifecycle: none, ports: none, runtime: none, state: none, templates: none, envSchema: none,
                        [row.producer]: produce }
                    const source = await withSetupCheckoutProjection(setup, { source: fresh.result.source,
                        cockpitName: fresh.result.config.cockpit.name, evaluatedAt: Date.parse(setupTime) }, checkout => issue({
                        checkout, configuration: fresh.result, preflight, env: {}, gitExecutable: git.value, timeoutMs: 1_000,
                        producers, refreshPreflight, stopped: null, notices: () => [],
                    }))
                    if (!source) throw new Error(`health source was not issued for ${row.name}`)
                    return source
                }
                const adapters = { load, execute: executeProbe }
                const first = await actual.runPreflight({ configPath }, adapters)
                const second = await actual.runDoctor({ configPath }, adapters)
                if (row.name === 'acquisition-only') {
                    expect(first).toMatchObject({ kind: 'blocked', status: 2, result: { verdict: 'unavailable', checks: [] } })
                    expect(second.result).toMatchObject({ verdict: 'unavailable', checks: [] })
                    expect(first.diagnostics).toContainEqual(expect.objectContaining({ code: ENVIRONMENT_CODES.LIFECYCLE_EVIDENCE_INVALID }))
                    continue
                }
                const checks = [first.result, second.result].map(result => result.checks.find(({ owner, code }) => owner === row.value.owner && code === row.value.code))
                for (const check of checks) {
                    expect(check, row.name).toMatchObject({ owner: row.value.owner, code: row.value.code, verdict: row.verdict })
                    if (row.measured === undefined) expect(check).not.toHaveProperty('measured')
                    else expect(check).toHaveProperty('measured', row.measured)
                }
                expect(checks[1]).toMatchObject(checks[0]!)
                expect(first.kind).toBe('blocked')
                expect(first.result.verdict).not.toBe('pass')
            }
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

})
