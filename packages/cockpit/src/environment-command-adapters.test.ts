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
import { createRuntimeAdapter, observeRuntimeExecution, projectRuntimeExecutionEnvironment } from './environment/runtime.js'
import { deriveEntrypoints, observePortFamily, projectPortLeaseResult } from './environment/ports.js'
import { leasePortFamilyFixture } from '../test-support/port-lease-fixture.js'
import { holderId as deriveHolderId } from './environment/identity.js'
import type { HealthObservationProducers, HealthObservationSource, HealthObservationSourceInput } from './environment/application.js'

const application = vi.hoisted(() => ({
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
                    const producers: HealthObservationProducers = { surfaces: none, claims: none,
                        git: none, host: none, lifecycle: none, ports: none, runtime: none, state: none, templates: none, envSchema: none,
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
