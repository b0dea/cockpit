import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { parse } from 'smol-toml'
import { executeProbe, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { CockpitConfig } from '../schema.js'
import { loadCockpitConfig, projectMachineFloorConfig } from '../config/load.js'
import { cockpitId, checkoutId, stackId } from './identity.js'
import { ENVIRONMENT_CODES } from './contract.js'
import {
    classifyResolvedRuntimeLiterals,
    measureMachineFloor,
    createRuntimeAdapter,
    admitRuntimeServiceHealth,
    admitRuntimeMeasurement,
    runtimeIdentity,
    observeRuntimeTopology,
    stopRuntime,
    startRuntimeService,
    revalidateRuntimeService,
    type RuntimeServiceOutcome,
    type RuntimeTopologyEvidence,
    isRuntimeServiceEvidence,
    isRuntimeObservation,
    isRuntimeTopologyEvidence,
    issueMachineFloorAuthority,
    observeDockerRuntime,
    observedVersionCore,
    observeRuntimeServiceColdStart,
    observeRuntimeMountMaterialization,
    observeRuntimePortFamily,
    observeRuntimeMeasurement,
    projectRuntimeLifecycle,
    projectRuntimeExecutionEnvironment,
    consumeRuntimeServiceFailureForLogs,
    resolveRuntimeServiceOrder,
} from './runtime.js'
import { reduceDrainOutcome, reserveDrain, reserveDrainAttempt } from './claims.js'
import { deriveEntrypoints, projectPortLeaseResult } from './ports.js'
import { leasePortFamilyFixture } from '../../test-support/port-lease-fixture.js'
import { resolveExecutablePath, resolveGitExecutable } from './executable.js'
import { observeSetupCheckout, withSetupCheckoutProjection } from './setup-observation.js'
import { readState, selectStateRoot, transactState } from './state.js'
import type { CheckoutId, ExecutionStep, HolderId } from './contract.js'
import type { LocalRuntimeMeasurements, RuntimeMeasurementRow } from './runtime-measurement-record.js'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const measured = (rows: readonly RuntimeMeasurementRow[]): LocalRuntimeMeasurements =>
    ({ kind: 'read', path: '/synthetic/state/machine/runtime-measurements.json', rows })
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Measures the machine floor, recording each step; `run: false` records the steps without running them. */
async function machineFloor(input: Parameters<typeof measureMachineFloor>[0], options: { run?: boolean; alter?: (outcome: ExecuteProbeOutcome, index: number) => ExecuteProbeOutcome } = {}) {
    const steps: ExecutionStep[] = []
    const outcome = await measureMachineFloor(input, async (step) => {
        steps.push(step)
        if (options.run === false) return { kind: 'refusal' } as never
        const result = await executeProbe(step)
        return options.alter ? options.alter(result, steps.length - 1) : result
    })
    return { steps, outcome }
}

const executableSha = sha('synthetic executable')
const artifact = (reference: string, source = 'services: {}\n') => ({
    reference,
    canonicalPath: `/tmp/synthetic-cockpit/${reference}`,
    source,
    sha256: sha(source),
})

const runtimeInput = {
    runtime: { name: 'docker' as const, version: '27.1.2', executableSha256: executableSha },
    composeVersion: '2.39.2',
    executable: { canonicalPath: '/usr/local/bin/docker', invocationPath: '/usr/local/bin/docker', sha256: executableSha, executionMode: 'verified-path' as const },
    operation: 'up' as const,
    cwd: '/tmp/synthetic-cockpit',
    composeFiles: [artifact('compose/base.yml'), artifact('compose/local.yml')] as const,
    projectName: 'synthetic-stack',
    env: { PATH: '/usr/bin', DOCKER_CONTEXT: 'desktop-linux' },
    ports: [4100, 4200] as const,
    labels: { 'dev.b0dea.cockpit.id': 'synthetic-stack' },
    timeoutMs: 45_000,
}

describe('Docker runtime identity observation', () => {
    it.each([
        ['Docker Desktop', 'Docker Desktop', 'docker-desktop', 'linux', 'darwin', 'docker-desktop'],
        ['OrbStack', 'OrbStack', 'orbstack', 'linux', 'darwin', 'orbstack'],
        ['Colima default profile', 'Ubuntu 24.04.1 LTS', 'colima', 'linux', 'darwin', 'colima'],
        ['Colima named profile', 'Ubuntu 24.04.1 LTS', 'colima-work', 'linux', 'darwin', 'colima'],
        ['Rancher Desktop', 'Alpine Linux v3.20', 'lima-rancher-desktop', 'linux', 'darwin', 'rancher-desktop'],
        ['Linux Docker Engine', 'Ubuntu 24.04 LTS', 'build-host', 'linux', 'linux', 'docker-engine'],
        ['an unrecognised macOS VM', 'Ubuntu 24.04 LTS', 'build-host', 'linux', 'darwin', null],
        ['Windows containers on a Linux host', 'Windows Server 2022', 'build-host', 'windows', 'linux', null],
    ] as const)('identifies %s from one docker info reading', (_name, operatingSystem, name, osType, hostPlatform, expected) => {
        expect(runtimeIdentity({ operatingSystem, name, osType, hostPlatform })).toBe(expected)
    })

    function executableWithVersions(server: string, compose: string, identity = '["Docker Desktop","docker-desktop","linux"]\n') {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-runtime-version-'))
        const path = join(directory, 'docker')
        const source = `#!/bin/sh
if [ "$#" -eq 3 ] && [ "$1" = version ] && [ "$2" = --format ] && [ "$3" = '{{.Server.Version}}' ]; then
  printf '%s' ${shellQuote(server)}
elif [ "$#" -eq 3 ] && [ "$1" = compose ] && [ "$2" = version ] && [ "$3" = --short ]; then
  printf '%s' ${shellQuote(compose)}
elif [ "$#" -eq 3 ] && [ "$1" = info ] && [ "$2" = --format ] && [ "$3" = '[{{json .OperatingSystem}},{{json .Name}},{{json .OSType}}]' ]; then
  printf '%s' ${shellQuote(identity)}
else
  exit 7
fi
`
        writeFileSync(path, source, { mode: 0o700 })
        return { directory, executable: { canonicalPath: path, invocationPath: path, sha256: sha(source), executionMode: 'verified-path' as const } }
    }

    it('uses authenticated bounded probes to identify the runtime and versions', async () => {
        const fixture = executableWithVersions('29.4.0\n', '5.1.2\n')
        try {
            const result = await observeDockerRuntime({
                executable: fixture.executable, cwd: fixture.directory, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 5_000,
            }, (step) => executeProbe(step))

            expect(result).toEqual({
                kind: 'complete', runtime: { name: 'docker', version: '29.4.0', executableSha256: fixture.executable.sha256 },
                runtimeIdentity: 'docker-desktop',
                operatingSystem: 'Docker Desktop', name: 'docker-desktop', osType: 'linux', hostPlatform: process.platform,
                composeVersion: '5.1.2', observedAt: expect.any(String),
            })
        } finally { rmSync(fixture.directory, { recursive: true, force: true }) }
    })

    it('admits only the exact measured runtime with passing controls and a sufficient Compose floor', async () => {
        const fixture = executableWithVersions('29.4.0\n', '5.1.2\n')
        try {
            const observed = await observeDockerRuntime({
                executable: fixture.executable, cwd: fixture.directory, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 5_000,
            }, (step) => executeProbe(step))
            const row = { runtime: 'docker-desktop', daemon: 'docker-desktop', engineVersion: '29.4.0', composeFloor: '5.1.0', measuredOn: '2026-09-26' }
            const admission = admitRuntimeMeasurement(observed, measured([row]))
            expect(admission).toEqual({ kind: 'admitted', runtimeIdentity: 'docker-desktop',
                measurement: 'docker-desktop on "docker-desktop", engine 29.4.0, Compose floor 5.1.0, measured 2026-09-26' })
            const observation = observeRuntimeMeasurement(admission, stackId({
                cockpitId: cockpitId({ name: 'fixture', mainCheckoutPath: fixture.directory }),
                checkoutId: checkoutId({ checkoutPath: fixture.directory }), variant: { kind: 'shared' },
            }))
            // doctor reports which measurement admitted the runtime.
            expect(observation).toEqual(expect.objectContaining({
                code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED,
                source: 'docker-desktop on "docker-desktop", engine 29.4.0, Compose floor 5.1.0, measured 2026-09-26',
                observed: expect.objectContaining({ state: 'available', value: true }),
            }))

            for (const [measurements, reason] of [
                [measured([]), /Runtime docker-desktop on daemon "docker-desktop" has not been measured on this machine/],
                [measured([{ ...row, runtime: 'colima' }]), /has not been measured on this machine/],
                [measured([{ ...row, daemon: 'other-daemon' }]), /has not been measured on this machine/],
                [measured([{ ...row, engineVersion: '29.3.9' }]), /measured with engine 29\.3\.9 and now runs engine 29\.4\.0/],
                [measured([{ ...row, composeFloor: '5.2.0' }]), /below the measured floor 5\.2\.0/],
                [{ kind: 'unreadable', path: '/synthetic/state/machine/runtime-measurements.json', reason: 'the file is not UTF-8 JSON' } as const,
                    /record is unreadable: the file is not UTF-8 JSON; a new measurement replaces it/],
            ] as const) {
                const refused = admitRuntimeMeasurement(observed, measurements)
                expect(refused).toEqual(expect.objectContaining({ kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED }))
                expect(refused.kind === 'unavailable' ? refused.reason : '').toMatch(reason)
                expect(refused.kind === 'unavailable' ? refused.reason : '')
                    .toMatch(/Measure it on this machine with: \.\/node_modules\/@b00dea\/cockpit\/bin\/cockpit\.mjs runtime measure --config <your cockpit\.toml> --image <local-image>$/)
            }
        } finally { rmSync(fixture.directory, { recursive: true, force: true }) }
    })

    it('admits a Docker Desktop Compose version by its numeric core and keeps the suffix as evidence', async () => {
        const fixture = executableWithVersions('29.4.0\n', '2.29.7-desktop.1\n')
        try {
            const observed = await observeDockerRuntime({
                executable: fixture.executable, cwd: fixture.directory, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 5_000,
            }, (step) => executeProbe(step))
            expect(observed).toEqual(expect.objectContaining({ kind: 'complete', composeVersion: '2.29.7-desktop.1' }))
            const row = { runtime: 'docker-desktop', daemon: 'docker-desktop', engineVersion: '29.4.0', measuredOn: '2026-09-26' } as const
            expect(admitRuntimeMeasurement(observed, measured([{ ...row, composeFloor: '2.29.7' }])))
                .toEqual(expect.objectContaining({ kind: 'admitted', runtimeIdentity: 'docker-desktop' }))
            expect(admitRuntimeMeasurement(observed, measured([{ ...row, composeFloor: '2.30.0' }])))
                .toEqual(expect.objectContaining({ kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED }))
            expect(observedVersionCore('2.29.7-desktop.1')).toBe('2.29.7')
        } finally { rmSync(fixture.directory, { recursive: true, force: true }) }
    })

    it('keeps an ordinary guest operating system label unmeasured', async () => {
        const fixture = executableWithVersions('29.4.0\n', '5.1.2\n', '["Ubuntu 24.04 LTS","build-host","linux"]\n')
        try {
            const observed = await observeDockerRuntime({
                executable: fixture.executable, cwd: fixture.directory, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 5_000,
            }, (step) => executeProbe(step))
            // The same daemon reading is a host engine on Linux and an unrecognised VM product elsewhere.
            expect(observed).toEqual(expect.objectContaining({
                kind: 'complete', operatingSystem: 'Ubuntu 24.04 LTS',
                runtimeIdentity: process.platform === 'linux' ? 'docker-engine' : null,
            }))
            expect(admitRuntimeMeasurement(observed, measured([{
                runtime: 'ubuntu-24-04-lts', daemon: 'build-host', engineVersion: '29.4.0', composeFloor: '5.1.0', measuredOn: '2026-09-26',
            }]))).toEqual(expect.objectContaining({ kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED }))
        } finally { rmSync(fixture.directory, { recursive: true, force: true }) }
    })

    it('names the raw docker info values of an unrecognised runtime and asks for them to be reported', async () => {
        const fixture = executableWithVersions('29.4.0\n', '5.1.2\n', '["Windows Server 2022","build-host","windows"]\n')
        try {
            const observed = await observeDockerRuntime({
                executable: fixture.executable, cwd: fixture.directory, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 5_000,
            }, (step) => executeProbe(step))
            const admission = admitRuntimeMeasurement(observed, measured([{
                runtime: 'docker-desktop', daemon: 'docker-desktop', engineVersion: '29.4.0', composeFloor: '5.1.0', measuredOn: '2026-09-26',
            }]))
            expect(admission).toEqual(expect.objectContaining({ kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED }))
            const reason = admission.kind === 'unavailable' ? admission.reason : ''
            expect(reason).toContain('OperatingSystem "Windows Server 2022", Name "build-host", OSType "windows"')
            expect(reason).toContain('measured in /synthetic/state/machine/runtime-measurements.json: docker-desktop on "docker-desktop" (engine 29.4.0, Compose floor 5.1.0)')
            expect(reason).toMatch(/Report these docker info values/)
        } finally { rmSync(fixture.directory, { recursive: true, force: true }) }
    })

    it('refuses malformed versions and a callback that returns unissued evidence', async () => {
        const fixture = executableWithVersions('29.4.0\n', 'v5.1.2\n')
        try {
            const input = { executable: fixture.executable, cwd: fixture.directory, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 5_000 }
            await expect(observeDockerRuntime(input, (step) => executeProbe(step))).resolves.toEqual(
                expect.objectContaining({ kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE }),
            )
            await expect(observeDockerRuntime(input, vi.fn().mockResolvedValue({ kind: 'complete' }))).resolves.toEqual(
                expect.objectContaining({ kind: 'unavailable', code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE }),
            )
        } finally { rmSync(fixture.directory, { recursive: true, force: true }) }
    })
})

describe('runtime plan construction', () => {
    it('constructs an exact bounded compose step and exact compensation', () => {
        const outcome = createRuntimeAdapter(runtimeInput)

        expect(outcome.kind).toBe('preview')
        if (outcome.kind !== 'preview') return
        expect(outcome.plan.steps).toHaveLength(1)
        expect(outcome.plan.steps[0]).toEqual({
            id: 'runtime:docker-compose:up:synthetic-stack',
            argv: [
                '/usr/local/bin/docker', 'compose',
                '--project-directory', '/tmp/synthetic-cockpit',
                '--file', '/tmp/synthetic-cockpit/compose/base.yml',
                '--file', '/tmp/synthetic-cockpit/compose/local.yml',
                '--project-name', 'synthetic-stack',
                'up', '--detach', '--wait',
            ],
            argv0: '/usr/local/bin/docker',
            cwd: '/tmp/synthetic-cockpit',
            env: { PATH: '/usr/bin', DOCKER_CONTEXT: 'desktop-linux', COMPOSE_DISABLE_ENV_FILE: '1' },
            timeoutMs: 45_000,
            stdoutLimitBytes: 65_536,
            stderrLimitBytes: 65_536,
            paths: [
                '/tmp/synthetic-cockpit/compose/base.yml',
                '/tmp/synthetic-cockpit/compose/local.yml',
            ],
            ports: [4100, 4200],
            labels: { 'dev.b0dea.cockpit.id': 'synthetic-stack', operation: 'up', runtime: 'docker', composeVersion: '2.39.2' },
            expected: [],
            consumedFiles: [
                { path: '/usr/local/bin/docker', sha256: executableSha, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: 'verified-path' },
                { path: '/tmp/synthetic-cockpit/compose/base.yml', sha256: sha('services: {}\n'), maxBytes: 1_048_576, argvIndexes: [5], executable: false },
                { path: '/tmp/synthetic-cockpit/compose/local.yml', sha256: sha('services: {}\n'), maxBytes: 1_048_576, argvIndexes: [7], executable: false },
            ],
            filesystemChecks: [],
            compensation: [expect.objectContaining({
                id: 'runtime:docker-compose:down:synthetic-stack',
                argv: [
                    '/usr/local/bin/docker', 'compose',
                    '--project-directory', '/tmp/synthetic-cockpit',
                    '--file', '/tmp/synthetic-cockpit/compose/base.yml',
                    '--file', '/tmp/synthetic-cockpit/compose/local.yml',
                    '--project-name', 'synthetic-stack',
                    'down', '--remove-orphans',
                ],
                env: { PATH: '/usr/bin', DOCKER_CONTEXT: 'desktop-linux', COMPOSE_DISABLE_ENV_FILE: '1' },
                compensation: [],
            })],
        })
        expect(outcome.result).toEqual({
            runtime: 'docker', operation: 'up', projectName: 'synthetic-stack',
        })
    })

    // Compose reads snapshots of the declared files, so it cannot default the project directory to
    // the first file's directory itself; cockpit names that directory, or a product repository's
    // `./` paths resolve against the cockpit root.
    it('runs a cockpit\'s own Compose files from the directory of the first one', () => {
        const owner = cockpitId({ name: 'synthetic', mainCheckoutPath: '/tmp/synthetic-cockpit' })
        const outcome = createRuntimeAdapter({ ...runtimeInput, labels: {},
            composeFiles: [artifact('shop/compose.yml'), artifact('compose.cockpit.yml')] }, {
            ownComposeFiles: true, cockpitId: owner, stackId: stackId({ cockpitId: owner,
                checkoutId: checkoutId({ checkoutPath: '/tmp/synthetic-cockpit' }), variant: { kind: 'shared' } }) })

        expect(outcome.kind, JSON.stringify(outcome)).toBe('preview')
        if (outcome.kind !== 'preview') return
        expect(outcome.plan.steps[0]?.argv.slice(2, 4)).toEqual(['--project-directory', '/tmp/synthetic-cockpit/shop'])
        expect(outcome.plan.steps[0]?.cwd).toBe('/tmp/synthetic-cockpit')
    })

    it.each(['validate', 'up', 'down'] as const)('disables the unauthenticated default .env for %s', (operation) => {
        const outcome = createRuntimeAdapter({ ...runtimeInput, operation })

        expect(outcome.kind).toBe('preview')
        if (outcome.kind !== 'preview') return
        expect(outcome.plan.steps[0]?.env).toEqual({
            PATH: '/usr/bin', DOCKER_CONTEXT: 'desktop-linux', COMPOSE_DISABLE_ENV_FILE: '1',
        })
    })

    it.each([
        ['https://synthetic.invalid/compose.yml', ENVIRONMENT_CODES.RUNTIME_COMPOSE_REMOTE],
        ['oci://synthetic.invalid/compose:latest', ENVIRONMENT_CODES.RUNTIME_COMPOSE_REMOTE],
        ['compose/${PROFILE}.yml', ENVIRONMENT_CODES.RUNTIME_UNMEASURED],
        ['../compose.yml', ENVIRONMENT_CODES.RUNTIME_COMPOSE_REMOTE],
    ])('refuses prohibited compose reference %s before returning a plan', (composeFile, code) => {
        const outcome = createRuntimeAdapter({ ...runtimeInput, composeFiles: [artifact(composeFile)] })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2, result: null }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code, target: composeFile })])
        expect('plan' in outcome).toBe(false)
    })

    it.each([
        ['a quoted build key', 'services:\n  app:\n    "build":\n      context: https://synthetic.invalid/repository.git\n'],
        ['a quoted context key', 'services:\n  app:\n    build:\n      "context": https://synthetic.invalid/repository.git\n'],
        ['a context after another build key', 'services:\n  app:\n    build:\n      dockerfile: Dockerfile\n      context: https://synthetic.invalid/repository.git\n'],
        ['a context after a comment', 'services:\n  app:\n    build:\n      # selected source\n      context: https://synthetic.invalid/repository.git\n'],
        ['a remote short-form build', 'services:\n  app:\n    build: https://synthetic.invalid/source.tar.gz\n'],
        ['an additional service context', 'services:\n  app:\n    build:\n      context: .\n      additional_contexts:\n        dependency: service:builder\n'],
        ['a remote build merged from an anchor', 'services:\n  defaults: &remote\n    build: https://synthetic.invalid/repository.git\n  app:\n    <<: *remote\n'],
        ['unparseable Compose', 'services: [unterminated\n'],
        ['a remote long-form context', 'services:\n  app:\n    build:\n      context: https://synthetic.invalid/repository.git\n'],
        ['a double-quoted remote build', 'services:\n  app:\n    build: "https://synthetic.invalid/repository.git"\n'],
        ['a single-quoted remote context', "services:\n  app:\n    build:\n      context: 'https://synthetic.invalid/repository.git'\n"],
        ['an SSH context', 'services:\n  app:\n    build:\n      context: ssh://synthetic.invalid/repository.git\n'],
    ])('refuses Compose build input with %s before returning a plan', (_label, source) => {
        expect(createRuntimeAdapter({ ...runtimeInput, composeFiles: [artifact('compose.yml', source)] })).toEqual(
            expect.objectContaining({ kind: 'refusal', result: null }),
        )
    })

    it('stops build-context inspection at the next sibling key', () => {
        const source = 'services:\n  app:\n    build:\n      context: .\n    environment:\n      context: https://synthetic.invalid/data\n'
        expect(createRuntimeAdapter({ ...runtimeInput, composeFiles: [artifact('compose.yml', source)] }).kind).toBe('preview')
    })

    it('allows URL values that are data rather than fetch-capable Compose fields', () => {
        const source = 'services:\n  app:\n    image: busybox:1.36\n    environment:\n      PUBLIC_ORIGIN: https://synthetic.invalid\n'
        expect(createRuntimeAdapter({ ...runtimeInput, composeFiles: [artifact('compose.yml', source)] }).kind).toBe('preview')
    })

    it('refuses a folded remote build context', () => {
        const source = 'services:\n  app:\n    build: >\n      https://synthetic.invalid/repository.git\n'
        const outcome = createRuntimeAdapter({ ...runtimeInput, composeFiles: [artifact('compose.yml', source)] })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: ENVIRONMENT_CODES.RUNTIME_COMPOSE_REMOTE })])
    })

    it('binds Compose execution to the exact leased port family', async () => {
        const home = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-runtime-leased-ports-')))
        const configPath = join(home, 'cockpit.toml')
        writeFileSync(configPath, `${readFileSync('fixtures/registries/generated-environment.toml', 'utf8')}\n[environment]\ncompose_files = ["compose.yml"]\n\n[environment.machine]\nruntime_memory_mb = 1024\nruntime_cpus = 1\nfree_disk_mb = 1024\ncold_start_seconds = 30\n`)
        const composeBytes = 'services:\n  app:\n    image: busybox\n    ports: ["127.0.0.1:${APP_HOST_PORT:-4100}:3000"]\n'
        writeFileSync(join(home, 'compose.yml'), composeBytes)
        mkdirSync(join(home, 'app'), { recursive: true })
        execFileSync('git', ['init', '--quiet', home])
        const loaded = await loadCockpitConfig(configPath)
        expect(loaded.kind).toBe('complete')
        if (loaded.kind !== 'complete') return
        const config = loaded.result.config
        const sourceSha256 = loaded.result.runtimeSha256
        const owner = cockpitId({ name: config.cockpit.name, mainCheckoutPath: home })
        const checkout = checkoutId({ checkoutPath: home })
        const ownStack = stackId({ cockpitId: owner, checkoutId: checkout, variant: { kind: 'shared' } })
        const generatedInput = {
            ...runtimeInput,
            operation: 'validate' as const,
            cwd: home,
            composeFiles: [{
                reference: 'compose.yml',
                canonicalPath: join(home, 'compose.yml'),
                source: composeBytes,
                sha256: sha(composeBytes),
            }],
            labels: {
                ...runtimeInput.labels,
                stackId: stackId({ cockpitId: owner, checkoutId: checkout, variant: { kind: 'shared' } }),
                configSha256: sourceSha256,
                batchId: sha('leased runtime batch'),
            },
            stackId: stackId({ cockpitId: owner, checkoutId: checkout, variant: { kind: 'shared' } }),
            coldStartLimitMillis: 30_000,
            expectedMountSources: [],
        }

        const namespace = await selectStateRoot({ platform: 'linux', home, cockpitId: owner })
        expect(namespace.kind).toBe('complete')
        if (namespace.kind !== 'complete') return
        const holder = `holder:${sha('leased runtime holder')}:session` as HolderId
        const leaseObservedAt = new Date().toISOString()
        const lease = await leasePortFamilyFixture({
            namespace: namespace.value,
            stackId: generatedInput.stackId,
            holderId: holder,
            checkoutId: checkout,
            config: config.ports,
            now: leaseObservedAt,
            listenerTimeoutMs: 100,
            listenerEvidence: Array.from({ length: config.ports.count }, (_, index) => ({
                ports: [config.ports.bases.APP_HOST_PORT! + index * config.ports.step],
                observation: { state: 'available', value: [], observedAt: leaseObservedAt, producer: 'leased-runtime-port-listener' },
            })),
        })
        expect(lease.kind, JSON.stringify(lease)).toBe('complete')
        if (lease.kind !== 'complete') return
        const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
        expect(entrypoints.kind).toBe('complete')
        if (entrypoints.kind !== 'complete') return
        const portLeaseProjection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
        expect(portLeaseProjection).toBeDefined()
        if (!portLeaseProjection) return
        const ownAuthority = { ownComposeFiles: true as const, cockpitId: owner, stackId: ownStack }
        const hostileHome = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-runtime-hostile-port-env-')))
        const hostileNamespace = await selectStateRoot({ platform: 'linux', home: hostileHome, cockpitId: owner })
        expect(hostileNamespace.kind).toBe('complete')
        if (hostileNamespace.kind !== 'complete') return
        const hostileObservedAt = new Date().toISOString()
        const hostileLease = await leasePortFamilyFixture({
            namespace: hostileNamespace.value,
            stackId: generatedInput.stackId,
            holderId: `holder:${sha('hostile runtime holder')}:session` as HolderId,
            checkoutId: checkout,
            config: {
                ...config.ports,
                bases: { LD_PRELOAD: config.ports.bases.APP_HOST_PORT! },
            },
            now: hostileObservedAt,
            listenerTimeoutMs: 100,
            listenerEvidence: Array.from({ length: config.ports.count }, (_, index) => ({
                ports: [config.ports.bases.APP_HOST_PORT! + index * config.ports.step],
                observation: { state: 'available', value: [], observedAt: hostileObservedAt, producer: 'hostile-runtime-port-listener' },
            })),
        })
        expect(hostileLease.kind, JSON.stringify(hostileLease)).toBe('complete')
        if (hostileLease.kind !== 'complete') return
        const hostileEntrypoints = deriveEntrypoints({ lease: hostileLease.lease, declarations: [] })
        expect(hostileEntrypoints.kind).toBe('complete')
        if (hostileEntrypoints.kind !== 'complete') return
        const hostileProjection = projectPortLeaseResult({ leaseResult: hostileLease, entrypointResult: hostileEntrypoints })
        expect(hostileProjection).toBeDefined()
        if (!hostileProjection) return
        expect(createRuntimeAdapter({
            ...generatedInput,
            ports: Object.values(hostileLease.lease.ports),
        }, { ...ownAuthority, portLeaseProjection: hostileProjection }))
            .toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
        const boundInput = { ...generatedInput, ports: Object.values(lease.lease.ports) }
        const admitted = createRuntimeAdapter(boundInput, { ...ownAuthority, portLeaseProjection })
        expect(admitted.kind).toBe('preview')
        if (admitted.kind === 'preview') {
            expect(admitted.plan.steps[0]?.env).toMatchObject({ APP_HOST_PORT: String(lease.lease.ports.APP_HOST_PORT) })
            let topologyStep: ExecutionStep | undefined
            await observeRuntimeTopology({
                execute: async (step) => { topologyStep = step; return { kind: 'refusal' } as never },
                runtimePlan: admitted.plan,
                stackId: boundInput.stackId,
                configSha256: sourceSha256,
                batchId: boundInput.labels.batchId,
                observationWindow: {
                    startedAt: '2026-09-26T12:00:00.000Z',
                    expiresAt: '2026-09-26T12:05:00.000Z',
                },
            })
            expect(topologyStep?.env).toMatchObject({ APP_HOST_PORT: String(lease.lease.ports.APP_HOST_PORT) })
            const git = await resolveGitExecutable({ PATH: process.env.PATH ?? '/usr/bin' })
            const observedAt = new Date().toISOString()
            const observedCheckout = git.state === 'available' ? await observeSetupCheckout({
                source: loaded.result.source,
                cockpitName: config.cockpit.name,
                observedAt,
                env: { PATH: process.env.PATH ?? '/usr/bin' },
                gitExecutable: git.value,
            }) : undefined
            const machine = projectMachineFloorConfig(loaded.result)
            const binding = observedCheckout && machine ? await withSetupCheckoutProjection(observedCheckout, {
                source: loaded.result.source,
                cockpitName: config.cockpit.name,
                evaluatedAt: Date.parse(observedAt),
            }, (projection) => issueMachineFloorAuthority({ configuration: machine, checkout: projection })) : undefined
            expect(binding).toBeDefined()
            if (binding) {
                const floor = await machineFloor({
                    runtimePlan: admitted.plan,
                    diskExecutable: { canonicalPath: '/usr/local/bin/node', invocationPath: '/usr/local/bin/node', sha256: sha('disk executable'), executionMode: 'verified-path' },
                    timeoutMs: 10_000,
                    authority: binding.authority,
                }, { run: false })
                expect(floor.steps).toHaveLength(2)
                expect(floor.steps.every(({ env }) => env.APP_HOST_PORT === undefined)).toBe(true)
            }
        }
        expect(createRuntimeAdapter(boundInput, { ...ownAuthority, portLeaseProjection: { ...portLeaseProjection } as never }))
            .toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
        expect(createRuntimeAdapter({ ...boundInput, ports: [lease.lease.ports.APP_HOST_PORT! + 1] }, { ...ownAuthority, portLeaseProjection }))
            .toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
        rmSync(hostileHome, { recursive: true, force: true })
        rmSync(home, { recursive: true, force: true })
    })

    it('refuses producer input that cannot cross the strict execution boundary', () => {
        const outcome = createRuntimeAdapter({ ...runtimeInput, env: { 'BAD=KEY': 'value' } })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
        expect('plan' in outcome).toBe(false)
    })

    it.each([
        ['include: https://synthetic.invalid/compose.yml\n', 'include'],
        ['services:\n  app:\n    extends: { file: https://synthetic.invalid/base.yml }\n', 'extends'],
    ])('refuses %s directives whose artifact estate is not digest-bound', (source) => {
        const outcome = createRuntimeAdapter({ ...runtimeInput, composeFiles: [artifact('compose.yml', source)] })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: ENVIRONMENT_CODES.RUNTIME_COMPOSE_REMOTE })])
    })

    it('refuses a canonical compose path that escaped through a symlinked parent', () => {
        const escaped = { ...artifact('linked/compose.yml'), canonicalPath: '/tmp/outside/compose.yml' }
        const outcome = createRuntimeAdapter({ ...runtimeInput, composeFiles: [escaped] })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
    })

    it('snapshots mutable inputs before returning the execution contract', () => {
        const env = { TOKEN: 'before' }
        const ports = [4100]
        const labels = { owner: 'before' }
        const outcome = createRuntimeAdapter({ ...runtimeInput, env, ports, labels })
        expect(outcome.kind).toBe('preview')
        if (outcome.kind !== 'preview') return

        env.TOKEN = 'after'
        ports[0] = 9999
        labels.owner = 'after'
        expect(outcome.plan.steps[0]).toEqual(expect.objectContaining({
            env: { TOKEN: 'before', COMPOSE_DISABLE_ENV_FILE: '1' },
            ports: [4100], labels: expect.objectContaining({ owner: 'before' }),
        }))
        expect(outcome.plan.steps[0].filesystemChecks.every(Object.isFrozen)).toBe(true)
    })

    it.each([
        { cwd: '/tmp/synthetic\0-cockpit', env: runtimeInput.env, labels: runtimeInput.labels, label: 'NUL path' },
        { cwd: runtimeInput.cwd, env: { ...runtimeInput.env, COMPOSE_FILE: 'other.yml' }, labels: runtimeInput.labels, label: 'compose env override' },
        { cwd: runtimeInput.cwd, env: runtimeInput.env, labels: { operation: 'up\0hidden' }, label: 'NUL label' },
        { cwd: runtimeInput.cwd, env: runtimeInput.env, labels: { 'dev.b0dea.cockpit.id': '${STACK_ID}' }, label: 'unresolved label' },
    ])('refuses $label before it reaches the process boundary', ({ cwd, env, labels }) => {
        const outcome = createRuntimeAdapter({ ...runtimeInput, cwd, env, labels })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED })])
    })

    it.each([
        { executable: { canonicalPath: 'docker', invocationPath: 'docker', sha256: executableSha, executionMode: 'verified-path' as const }, timeoutMs: 45_000, label: 'unresolved executable path' },
        { executable: { ...runtimeInput.executable, invocationPath: 'docker' }, timeoutMs: 45_000, label: 'relative invocation path' },
        { executable: { ...runtimeInput.executable, invocationPath: '/usr/local/bin/../bin/docker' }, timeoutMs: 45_000, label: 'noncanonical invocation path' },
        { executable: { ...runtimeInput.executable, invocationPath: '/tmp/not-docker' }, timeoutMs: 45_000, label: 'wrong runtime invocation name' },
        { executable: runtimeInput.executable, timeoutMs: 0, label: 'zero timeout' },
        { executable: runtimeInput.executable, timeoutMs: 300_001, label: 'unbounded timeout' },
    ])('refuses $label before returning a plan', ({ executable, timeoutMs }) => {
        const outcome = createRuntimeAdapter({ ...runtimeInput, executable, timeoutMs })

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED })])
        expect('plan' in outcome).toBe(false)
    })

    it.each([
        { runtime: { ...runtimeInput.runtime, name: 'other-runtime' }, operation: 'up' },
        { runtime: runtimeInput.runtime, operation: 'restart' },
    ])('refuses an unknown runtime or operation without mapping it to another action', (override) => {
        const outcome = createRuntimeAdapter({ ...runtimeInput, ...override } as typeof runtimeInput)

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED })])
    })
})

describe('runtime measurement classification', () => {
    it('measures available filesystem bytes with the authenticated Node runtime and no host disk utility', async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-disk-capacity-')))
        try {
            const runtimePath = join(root, 'docker')
            const runtimeBytes = '#!/bin/sh\nprintf "1048576|1\\n"\n'
            writeFileSync(runtimePath, runtimeBytes, { mode: 0o700 })
            const node = await resolveExecutablePath(process.execPath)
            if (node.state !== 'available') throw new Error(node.reason)
            const { outcome } = await machineFloor({
                runtimeExecutable: { canonicalPath: runtimePath, invocationPath: runtimePath, sha256: sha(runtimeBytes), executionMode: 'verified-path' },
                diskExecutable: node.value, cwd: root, env: {}, timeoutMs: 10_000,
            })
            const measured = outcome.kind === 'complete' ? outcome.evidence : undefined
            expect(measured).toEqual({
                memoryBytes: 1_048_576, cpuMillis: 1_000,
                freeDiskBytes: expect.any(Number), observedAt: expect.any(String),
            })
            const status = statfsSync(root, { bigint: true })
            expect(measured!.freeDiskBytes).toBeGreaterThanOrEqual(0)
            expect(BigInt(measured!.freeDiskBytes)).toBeLessThanOrEqual(status.blocks * status.bsize)
            expect(measured!.freeDiskBytes % Number(status.bsize)).toBe(0)
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('admits only bounded decimal byte output from the exact disk collector execution', async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-disk-output-')))
        try {
            const executable = (name: string, bytes: string) => {
                const path = join(root, name)
                writeFileSync(path, bytes, { mode: 0o700 })
                return { canonicalPath: path, invocationPath: path, sha256: sha(bytes), executionMode: 'verified-path' as const }
            }
            const runtimeExecutable = executable('docker', '#!/bin/sh\nprintf "1048576|1\\n"\n')
            for (const output of ['0\n', '123456789\n', `${Number.MAX_SAFE_INTEGER}\n`,
                'malformed\n', '-1\n', '1.5\n', '9007199254740992\n', '1\n2\n', '1\n\n', '1 \n', '01\n', '1e3\n', '1']) {
                const diskExecutable = executable('disk-observation', `#!/bin/sh\nprintf '%s' ${shellQuote(output)}\n`)
                const input = { runtimeExecutable, diskExecutable, cwd: root, env: {}, timeoutMs: 10_000 }
                const { outcome } = await machineFloor(input)
                const measured = outcome.kind === 'complete' ? outcome.evidence : undefined
                if (['0\n', '123456789\n', `${Number.MAX_SAFE_INTEGER}\n`].includes(output)) {
                    expect(measured?.freeDiskBytes, output).toBe(Number(output))
                } else expect(measured, output).toBeUndefined()
            }
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('constructs exact bounded runtime-allocation and free-disk collectors', async () => {
        const diskSha = sha('disk executable')
        const { steps } = await machineFloor({
            runtimeExecutable: runtimeInput.executable,
            diskExecutable: { canonicalPath: '/usr/local/bin/node', invocationPath: '/usr/local/bin/node', sha256: diskSha, executionMode: 'verified-path' },
            cwd: runtimeInput.cwd,
            env: runtimeInput.env,
            timeoutMs: 10_000,
        }, { run: false })
        expect(steps.map(({ id, argv, consumedFiles, filesystemChecks }) => ({ id, argv, consumedFiles, filesystemChecks }))).toEqual([
            {
                id: 'runtime:measure:resources',
                argv: ['/usr/local/bin/docker', 'info', '--format', '{{json .MemTotal}}|{{json .NCPU}}'],
                consumedFiles: [{ path: '/usr/local/bin/docker', sha256: executableSha, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: 'verified-path' }],
                filesystemChecks: [],
            },
            {
                id: 'runtime:measure:free-disk', argv: ['/usr/local/bin/node', '--input-type=module', '-e', expect.any(String), runtimeInput.cwd],
                consumedFiles: [{ path: '/usr/local/bin/node', sha256: diskSha, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: 'verified-path' }],
                filesystemChecks: [],
            },
        ])
        expect(steps.every(({ timeoutMs }) => timeoutMs === 10_000)).toBe(true)
    })

    it.each(['null', 'primitive', 'revoked', 'missing', 'extra', 'nested executable', 'environment', 'working directory', 'timeout', 'forged authority'])('refuses hostile machine-floor input: %s', async (kind) => {
        const valid = {
            runtimeExecutable: runtimeInput.executable,
            diskExecutable: { canonicalPath: '/usr/local/bin/node', invocationPath: '/usr/local/bin/node', sha256: sha('disk executable'), executionMode: 'verified-path' as const },
            cwd: runtimeInput.cwd,
            env: runtimeInput.env,
            timeoutMs: 10_000,
        }
        const revoked = Proxy.revocable(valid, {})
        if (kind === 'revoked') revoked.revoke()
        const candidate: unknown = kind === 'null' ? null
            : kind === 'primitive' ? 7
            : kind === 'revoked' ? revoked.proxy
                : kind === 'missing' ? { ...valid, env: undefined }
                : kind === 'extra' ? { ...valid, decision: 'caller' }
                    : kind === 'nested executable' ? { ...valid, diskExecutable: { ...valid.diskExecutable, extra: true } }
                        : kind === 'environment' ? { ...valid, env: { PATH: '/usr/bin', unsafe: 7 } }
                            : kind === 'working directory' ? { ...valid, cwd: 'relative' }
                                : kind === 'timeout' ? { ...valid, timeoutMs: '10000' }
                                    : { ...valid, authority: { kind: 'machine-floor-authority' } }

        expect(await machineFloor(candidate as never, { run: false })).toEqual({ steps: [], outcome: expect.objectContaining({ kind: 'refusal', result: null }) })
    })

    it('refuses accessor-backed machine-floor plans without invoking getters', async () => {
        let reads = 0
        const input = {}
        Object.defineProperty(input, 'runtimeExecutable', {
            enumerable: true, get: () => { reads += 1; return runtimeInput.executable },
        })

        const { outcome } = await machineFloor(input as never, { run: false })

        expect(outcome).toMatchObject({
            kind: 'refusal', result: null,
            diagnostics: [{ code: ENVIRONMENT_CODES.RUNTIME_UNMEASURED }],
        })
        expect(reads).toBe(0)
    })

    it('refuses accessor-backed machine-floor authority inputs without invoking getters', () => {
        let reads = 0
        const input = Object.defineProperties({}, {
            configuration: { enumerable: true, get: () => { reads += 1; return undefined } },
            checkout: { enumerable: true, value: undefined },
        })

        expect(issueMachineFloorAuthority(input as never)).toBeUndefined()
        expect(reads).toBe(0)
    })
})

describe('resolved runtime literal classification', () => {
    it('closes unreadable or malformed literal collections as unsafe', () => {
        const revoked = Proxy.revocable(['safe'], {})
        const extra = ['safe']
        Object.defineProperty(extra, 'decision', { enumerable: true, value: true })
        revoked.revoke()
        expect(() => classifyResolvedRuntimeLiterals(revoked.proxy)).not.toThrow()
        expect(classifyResolvedRuntimeLiterals(revoked.proxy)).toBe('unsafe')
        expect(classifyResolvedRuntimeLiterals(null as never)).toBe('unsafe')
        expect(classifyResolvedRuntimeLiterals(7 as never)).toBe('unsafe')
        expect(classifyResolvedRuntimeLiterals(['safe', 7] as never)).toBe('unsafe')
        expect(classifyResolvedRuntimeLiterals(extra)).toBe('unsafe')
    })

    it('reads each literal once into its owned classification input', () => {
        let reads = 0
        const values = ['safe']
        Object.defineProperty(values, 0, {
            enumerable: true,
            get: () => {
                reads += 1
                if (reads > 1) throw new Error('literal read twice')
                return 'safe'
            },
        })

        expect(classifyResolvedRuntimeLiterals(values)).toBe('resolved')
        expect(reads).toBe(1)
    })
})

describe('authenticated runtime topology and service health', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cockpit-runtime-health-'))
    const composePath = join(directory, '编排.yml')
    const runtimeCockpit = cockpitId({ name: 'synthetic', mainCheckoutPath: '/tmp/main' })
    const stack = stackId({
        cockpitId: runtimeCockpit,
        checkoutId: checkoutId({ checkoutPath: '/tmp/work' }),
        variant: { kind: 'shared' },
    })
    const configSha256 = sha('runtime configuration')
    const batchId = sha('runtime batch')
    const containerId = sha('runtime container')
    const canary = 'runtime-secret-canary'

    writeFileSync(composePath, 'services: {}\n')
    afterAll(() => rmSync(directory, { recursive: true, force: true }))

    const observationWindow = (offsetStart = -1_000, offsetEnd = 60_000) => ({
        startedAt: new Date(Date.now() + offsetStart).toISOString(),
        expiresAt: new Date(Date.now() + offsetEnd).toISOString(),
    })

    function executable(topology: unknown, containers: unknown = []): typeof runtimeInput.executable {
        const path = join(directory, `runtime-${sha(JSON.stringify([topology, containers, Math.random()])).slice(0, 12)}`)
        const rows = Array.isArray(containers)
            ? containers.map((candidate) => {
                if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
                const {
                    Labels: _labels,
                    StartExitCode: _startExitCode,
                    StartDelayMs: _startDelayMs,
                    StartStderr: _startStderr,
                    StopExitCode: _stopExitCode,
                    StatusExitCode: _statusExitCode,
                    StatusOutput: _statusOutput,
                    StatusStderr: _statusStderr,
                    IdentityExitCode: _identityExitCode,
                    IdentityOutput: _identityOutput,
                    IdentityStderr: _identityStderr,
                    InspectExitCode: _inspectExitCode,
                    InspectOutput: _inspectOutput,
                    InspectStderr: _inspectStderr,
                    DependencyInspectOutput: _dependencyInspectOutput,
                    ArchitectureOutput: _architectureOutput,
                    AbiOutput: _abiOutput,
                    ...row
                } = candidate as Record<string, unknown>
                return typeof row.ID === 'string' ? { ...row, ID: row.ID.slice(0, 12) } : row
            }).map((row) => JSON.stringify(row)).join('\n')
            : JSON.stringify(containers)
        const defaultInspected = Array.isArray(containers) && containers.length === 1 && containers[0] !== null
            && typeof containers[0] === 'object' && !Array.isArray(containers[0])
            ? (() => {
                const value = containers[0] as Record<string, unknown>
                const labels = typeof value.Labels === 'string'
                    ? Object.fromEntries(value.Labels.split(',').map((item) => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)]))
                    : value.Labels
                return JSON.stringify({ ID: value.ID, State: value.State, Health: value.Health, Labels: labels,
                    Mounts: value.Mounts ?? [], Ports: value.Ports ?? {} })
            })()
            : '{}'
        const controls = Array.isArray(containers) && containers.length > 0 && containers[0] !== null
            && typeof containers[0] === 'object' && !Array.isArray(containers[0])
            ? containers[0] as Record<string, unknown>
            : {}
        const statusOutput = typeof controls.StatusOutput === 'string' ? controls.StatusOutput : rows
        const statusInvalidUtf8 = controls.StatusInvalidUtf8 === true
        const statusStderr = typeof controls.StatusStderr === 'string' ? controls.StatusStderr : ''
        const statusExitCode = Number(controls.StatusExitCode ?? 0)
        const identityOutput = typeof controls.IdentityOutput === 'string'
            ? controls.IdentityOutput
            : Array.isArray(containers) && containers.length === 1 ? `${(containers[0] as Record<string, unknown>).ID}\n` : ''
        const identityInvalidUtf8 = controls.IdentityInvalidUtf8 === true
        const identityStderr = typeof controls.IdentityStderr === 'string' ? controls.IdentityStderr : ''
        const identityExitCode = Number(controls.IdentityExitCode ?? 0)
        const inspectOutput = typeof controls.InspectOutput === 'string' ? controls.InspectOutput : defaultInspected
        const inspectStderr = typeof controls.InspectStderr === 'string' ? controls.InspectStderr : ''
        const inspectExitCode = Number(controls.InspectExitCode ?? 0)
        const dependencyInspectOutput = typeof controls.DependencyInspectOutput === 'string' ? controls.DependencyInspectOutput : '{}'
        const architectureOutput = typeof controls.ArchitectureOutput === 'string' ? controls.ArchitectureOutput : 'x86_64\n'
        const abiOutput = typeof controls.AbiOutput === 'string' ? controls.AbiOutput : 'glibc:2.39\n'
        const topologyOutput = topology === '__malformed_json__'
            ? '{'
            : JSON.stringify(topology === '__nonempty_stderr__' ? { services: { api: {} } } : topology)
        const topologyInvalidUtf8 = topology === '__invalid_utf8__'
        const topologyStderr = topology === '__nonempty_stderr__' ? 'runtime diagnostic' : ''
        const startExitCode = Array.isArray(containers) && containers[0] !== null && typeof containers[0] === 'object'
            ? Number((containers[0] as Record<string, unknown>).StartExitCode ?? 0)
            : 0
        const startDelayMs = Array.isArray(containers) && containers[0] !== null && typeof containers[0] === 'object'
            ? Number((containers[0] as Record<string, unknown>).StartDelayMs ?? 0)
            : 0
        const startStderr = Array.isArray(containers) && containers[0] !== null && typeof containers[0] === 'object'
            ? String((containers[0] as Record<string, unknown>).StartStderr ?? '')
            : ''
        const stopExitCode = Array.isArray(containers) && containers[0] !== null && typeof containers[0] === 'object'
            ? Number((containers[0] as Record<string, unknown>).StopExitCode ?? 0)
            : 0
        const buildExitCode = Number(controls.BuildExitCode ?? 0)
        const buildStderr = typeof controls.BuildStderr === 'string' ? controls.BuildStderr : ''
        const buildInvalidUtf8 = controls.BuildInvalidUtf8 === true
        const launcherExitCode = Number(controls.LauncherExitCode ?? 0)
        const launcherStderr = typeof controls.LauncherStderr === 'string' ? controls.LauncherStderr : ''
        const source = `#!/bin/sh
has_argument() {
  expected=$1
  shift
  [ "$0" = "$expected" ] && return 0
  for argument do
    [ "$argument" = "$expected" ] && return 0
  done
  return 1
}
has_dependency_inspect_argument() {
  case "$0" in *'"ConfigImage"'*) return 0;; esac
  for argument do
    case "$argument" in *'"ConfigImage"'*) return 0;; esac
  done
  return 1
}
suffix_7_is_start() {
  [ "$#" -ge 7 ] || return 1
  shift $(( $# - 7 ))
  [ "$1" = --progress ] && [ "$2" = quiet ] && [ "$3" = up ] && [ "$4" = --detach ] && [ "$5" = --wait ] && [ "$6" = --no-deps ] && [ "$7" = api ]
}
suffix_5_is_status() {
  [ "$#" -ge 5 ] || return 1
  shift $(( $# - 5 ))
  [ "$1" = ps ] && [ "$2" = --format ] && [ "$3" = json ] && [ "$4" = --all ] && [ "$5" = api ]
}
suffix_4_is_identity() {
  [ "$#" -ge 4 ] || return 1
  shift $(( $# - 4 ))
  [ "$1" = ps ] && [ "$2" = --quiet ] && [ "$3" = --all ] && [ "$4" = api ]
}
suffix_5_is_running() {
  [ "$#" -ge 5 ] || return 1
  shift $(( $# - 5 ))
  [ "$1" = ps ] && [ "$2" = --format ] && [ "$3" = json ] && [ "$4" = --status ] && [ "$5" = running ]
}
suffix_4_is_build() {
  [ "$#" -ge 4 ] || return 1
  shift $(( $# - 4 ))
  [ "$1" = --progress ] && [ "$2" = quiet ] && [ "$3" = build ] && [ "$4" = api ]
}
suffix_11_is_launcher() {
  [ "$#" -ge 11 ] || return 1
  shift $(( $# - 11 ))
  [ "$1" = --progress ] && [ "$2" = quiet ] && [ "$3" = run ] && [ "$4" = --rm ] && [ "$5" = --no-deps ] && [ "$6" = --entrypoint ] \
    && [ "$7" = /bin/sh ] && [ "$8" = api ] && [ "$9" = -eu ] && [ "\${10}" = -c ] && [ "\${11}" = : ]
}
suffix_1_is_stop() {
  [ "$#" -ge 1 ] || return 1
  shift $(( $# - 1 ))
  [ "$1" = stop ]
}
suffix_2_is_architecture() {
  [ "$#" -ge 2 ] || return 1
  shift $(( $# - 2 ))
  [ "$1" = uname ] && [ "$2" = -m ]
}
suffix_has_abi_command() {
  [ "$#" -ge 3 ] || return 1
  shift $(( $# - 3 ))
  [ "$1" = -eu ] && [ "$2" = -c ]
}
if has_argument config "$@" && has_argument --no-env-resolution "$@"; then
  printf '%s' ${shellQuote(topologyStderr)} >&2
  ${topologyInvalidUtf8 ? "printf '\\377'" : `printf '%s' ${shellQuote(topologyOutput)}`}
elif suffix_7_is_start "$@"; then
  printf '%s' ${shellQuote(startStderr)} >&2
  ${startDelayMs === 0 ? ':' : `/bin/sleep ${(startDelayMs / 1_000).toFixed(3)}`}
  exit ${startExitCode}
elif suffix_5_is_status "$@"; then
  printf '%s' ${shellQuote(statusStderr)} >&2
  ${statusInvalidUtf8 ? "printf '\\377'" : `printf '%s' ${shellQuote(statusOutput)}`}
  exit ${statusExitCode}
elif suffix_4_is_identity "$@"; then
  printf '%s' ${shellQuote(identityStderr)} >&2
  ${identityInvalidUtf8 ? "printf '\\377'" : `printf '%s' ${shellQuote(identityOutput)}`}
  exit ${identityExitCode}
elif suffix_1_is_stop "$@"; then
  exit ${stopExitCode}
elif suffix_4_is_build "$@"; then
  ${buildInvalidUtf8 ? "printf '\\377' >&2" : `printf '%s' ${shellQuote(buildStderr)} >&2`}
  exit ${buildExitCode}
elif suffix_11_is_launcher "$@"; then
  printf '%s' ${shellQuote(launcherStderr)} >&2
  exit ${launcherExitCode}
elif suffix_5_is_running "$@"; then
  exit 0
elif has_argument inspect "$@" && has_dependency_inspect_argument "$@"; then
  printf '%s' ${shellQuote(dependencyInspectOutput)}
elif has_argument exec "$@" && suffix_2_is_architecture "$@"; then
  printf '%s' ${shellQuote(architectureOutput)}
elif has_argument exec "$@" && suffix_has_abi_command "$@"; then
  printf '%s' ${shellQuote(abiOutput)}
elif has_argument exec "$@" && has_argument --workdir "$@"; then
  exit 0
elif has_argument inspect "$@"; then
  printf '%s' ${shellQuote(inspectStderr)} >&2
  printf '%s' ${shellQuote(inspectOutput)}
  exit ${inspectExitCode}
else
  if [ -n "${'$'}{SECRET_CANARY:-}" ]; then
    printf '%s' "${'$'}SECRET_CANARY"
  else
    printf '%s' ${shellQuote(canary)}
  fi
  exit 7
fi
`
        writeFileSync(path, source)
        chmodSync(path, 0o755)
        return { canonicalPath: path, invocationPath: join(directory, 'docker'), sha256: sha(source), executionMode: 'verified-path' }
    }

    async function topologyEvidence(topology: unknown, containers: unknown = [], options: {
        readonly runtimeExecutable?: typeof runtimeInput.executable
        readonly expectedMountSources?: readonly string[]
        readonly coldStartLimitMillis?: number
        readonly batchId?: string
        readonly observationWindow?: ReturnType<typeof observationWindow>
        readonly env?: Readonly<Record<string, string>>
        readonly timeoutMs?: number
        readonly activeProfiles?: readonly string[]
        readonly composeFiles?: readonly { readonly reference: string; readonly canonicalPath: string; readonly source: string; readonly sha256: string }[]
        readonly ports?: readonly number[]
        readonly authority?: Parameters<typeof createRuntimeAdapter>[1]
    } = {}) {
        const declaredBindSources = topology !== null && typeof topology === 'object' && !Array.isArray(topology)
            && (topology as Record<string, unknown>).services !== null
            && typeof (topology as Record<string, unknown>).services === 'object'
            && !Array.isArray((topology as Record<string, unknown>).services)
            ? [...new Set(Object.values((topology as Record<string, unknown>).services as Record<string, unknown>)
                .flatMap((service) => service !== null && typeof service === 'object' && !Array.isArray(service)
                    && Array.isArray((service as Record<string, unknown>).volumes)
                    ? ((service as Record<string, unknown>).volumes as unknown[]).flatMap((volume) => volume !== null
                        && typeof volume === 'object' && !Array.isArray(volume)
                        && (volume as Record<string, unknown>).type === 'bind'
                        && typeof (volume as Record<string, unknown>).source === 'string'
                        && isAbsolute((volume as Record<string, string>).source)
                        && normalize((volume as Record<string, string>).source) === (volume as Record<string, string>).source
                        && !(volume as Record<string, string>).source.includes('\0')
                        ? [(volume as Record<string, string>).source]
                        : [])
                    : []))].sort()
            : []
        const observedTopology = topology !== null && typeof topology === 'object' && !Array.isArray(topology)
            && (topology as Record<string, unknown>).services !== null
            && typeof (topology as Record<string, unknown>).services === 'object'
            && !Array.isArray((topology as Record<string, unknown>).services)
            ? {
                ...(topology as Record<string, unknown>),
                services: Object.fromEntries(Object.entries((topology as Record<string, unknown>).services as Record<string, unknown>).map(([id, service]) => [
                    id,
                    service !== null && typeof service === 'object' && !Array.isArray(service)
                        ? {
                            ...service,
                            labels: Object.prototype.hasOwnProperty.call(service, 'labels')
                                ? (service as Record<string, unknown>).labels
                                : { 'dev.b0dea.cockpit.stack-id': stack, 'dev.b0dea.cockpit.config-sha256': configSha256 },
                        }
                        : service,
                ])),
            }
            : topology
        const observedContainers = Array.isArray(containers)
            ? containers.map((candidate, index) => {
                if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
                const value = candidate as Record<string, unknown>
                const project = typeof value.Project === 'string' ? value.Project : 'synthetic'
                const service = typeof value.Service === 'string' ? value.Service : 'api'
                return {
                    ...value,
                    ID: typeof value.ID === 'string' && /^[a-f0-9]{64}$/.test(value.ID) ? value.ID : sha(`runtime container ${index}`),
                    Labels: value.Labels ?? `com.docker.compose.project=${project},com.docker.compose.service=${service},dev.b0dea.cockpit.config-sha256=${configSha256},dev.b0dea.cockpit.stack-id=${stack}`,
                }
            })
            : containers
        const runtimeExecutable = options.runtimeExecutable ?? executable(observedTopology, observedContainers)
        const selectedBatchId = options.batchId ?? batchId
        const source = readFileSync(composePath, 'utf8')
        const runtime = createRuntimeAdapter({
            ...runtimeInput,
            runtime: { ...runtimeInput.runtime, executableSha256: runtimeExecutable.sha256 },
            executable: runtimeExecutable,
            operation: 'validate',
            cwd: directory,
            composeFiles: options.composeFiles ?? [{ reference: '编排.yml', canonicalPath: composePath, source, sha256: sha(source) }],
            projectName: 'synthetic',
            env: options.env ?? { PATH: process.env.PATH ?? '/usr/bin', SECRET_CANARY: canary },
            ports: options.ports ?? [],
            labels: { stackId: stack, configSha256, batchId: selectedBatchId },
            stackId: stack,
            coldStartLimitMillis: options.coldStartLimitMillis ?? 60_000,
            expectedMountSources: options.expectedMountSources ?? declaredBindSources,
            timeoutMs: options.timeoutMs ?? runtimeInput.timeoutMs,
            ...(options.activeProfiles === undefined ? {} : { activeProfiles: options.activeProfiles }),
        }, options.authority)
        if (runtime.kind !== 'preview') throw new Error(`runtime fixture refused: ${JSON.stringify(runtime.diagnostics)}`)
        let step: ExecutionStep | undefined
        const admitted = await observeRuntimeTopology({
            runtimePlan: runtime.plan,
            stackId: stack,
            configSha256,
            batchId: selectedBatchId,
            observationWindow: options.observationWindow ?? observationWindow(),
            execute: async (candidate) => {
                step = candidate
                const outcome = await executeProbe(candidate)
                expect(outcome.kind).toBe('complete')
                expect(outcome.stdout.toString()).not.toContain(canary)
                return outcome
            },
        })
        if (!step) throw new Error('topology step was not executed')
        const planned = { kind: 'planned' as const, step }
        return { runtime, planned, admitted, runtimeExecutable }
    }

    async function drainAuthority(topology: Awaited<ReturnType<typeof topologyEvidence>>) {
        if (topology.admitted.kind !== 'complete') throw new Error('topology fixture unavailable')
        const home = mkdtempSync(join(tmpdir(), 'cockpit-runtime-drain-'))
        const namespace = await selectStateRoot({ platform: 'linux', home, cockpitId: runtimeCockpit })
        if (namespace.kind !== 'complete') throw new Error('state namespace unavailable')
        const holderId = `holder:${sha('runtime holder')}:session` as HolderId
        const checkout = `checkout:${sha('runtime checkout')}` as CheckoutId
        const seeded = await transactState(namespace.value, namespace.value.paths.coordination(stack), { ownerId: holderId }, () => ({
            format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId: runtimeCockpit,
            subjectId: stack, revision: 0, updatedAt: new Date().toISOString(),
            value: { holders: [{ holderId, checkoutId: checkout, claimedAt: new Date().toISOString() }],
                lease: { offset: 0, ports: { WEB: 3000 }, released: false, declaration: { step: 100, count: 1, bases: { WEB: 3000 } } },
                lastReleasedHolder: null, drain: null },
        }))
        if (seeded.kind !== 'complete') throw new Error('coordination fixture unavailable')
        const reserved = await reserveDrain({ namespace: namespace.value, request: {
            purpose: 'down', stackId: stack, holderId, requesterId: holderId,
            configSha256, planDigest: sha('stop plan'), operationBasis: sha('operation basis'),
            generation: sha('operation generation'), targetIds: [stack],
            actions: [{ stage: 'runtime-stop', targetId: stack, validForMs: 30_000 }], expectedCoordinationRevision: 0,
        } })
        if (reserved.kind !== 'complete') throw new Error('drain fixture unavailable')
        const attempted = await reserveDrainAttempt({ namespace: namespace.value, reservation: reserved.reservation })
        if (attempted.kind !== 'complete') throw new Error('drain attempt fixture unavailable')
        return { ...attempted, namespace: namespace.value }
    }

    function recordingExecutor() {
        const steps: ExecutionStep[] = []
        return { steps, execute: async (step: ExecutionStep) => { steps.push(step); return executeProbe(step) } }
    }


    const running = (controls: Record<string, unknown> = {}) => ({
        ID: containerId, Project: 'synthetic', Service: 'api', State: 'running', Health: '', ExitCode: 0, ...controls,
    })

    async function admittedTopology(...args: Parameters<typeof topologyEvidence>): Promise<RuntimeTopologyEvidence> {
        const result = await topologyEvidence(...args)
        if (result.admitted.kind !== 'complete') throw new Error(result.admitted.reason)
        return result.admitted.topology
    }

    type Alter = (step: ExecutionStep, outcome: ExecuteProbeOutcome) => ExecuteProbeOutcome

    /** Starts (or, given expectedContainerId, revalidates) one service against the fixture runtime. */
    async function serviceRun(topology: RuntimeTopologyEvidence, options: { service?: string; expectedContainerId?: string; alter?: Alter } = {}) {
        const steps: ExecutionStep[] = []
        const execute = async (step: ExecutionStep) => {
            steps.push(step)
            const outcome = await executeProbe(step)
            return options.alter ? options.alter(step, outcome) : outcome
        }
        const service = options.service ?? 'api'
        const outcome = options.expectedContainerId === undefined
            ? await startRuntimeService({ topology, service, execute })
            : await revalidateRuntimeService({ topology, service, expectedContainerId: options.expectedContainerId, execute })
        // Step ids read runtime:<tool>:<stage>:<service>.
        return { steps, outcome, stages: steps.map((step) => step.id.split(':')[2]) }
    }

    async function healthyEvidence(topology: RuntimeTopologyEvidence, options: { service?: string; expectedContainerId?: string } = {}) {
        const { outcome } = await serviceRun(topology, options)
        if (outcome.kind !== 'observed') throw new Error(`runtime service fixture ${outcome.kind}`)
        const evidence = admitRuntimeServiceHealth(outcome.observation)
        if (!evidence) throw new Error('runtime service fixture is not healthy')
        return evidence
    }

    function failureContext(outcome: RuntimeServiceOutcome) {
        return outcome.kind === 'failure' && outcome.logs ? consumeRuntimeServiceFailureForLogs(outcome.logs) : undefined
    }

    /** Moves one step's receipt, so a test can place it before or after its neighbours. */
    function shiftReceipt(stage: string, field: 'startedAt' | 'finishedAt', to: (receipt: NonNullable<ExecuteProbeOutcome['receipt']>) => string): Alter {
        return (step, outcome) => step.id.split(':')[2] === stage && outcome.receipt
            ? { ...outcome, receipt: { ...outcome.receipt, [field]: to(outcome.receipt) } } as ExecuteProbeOutcome
            : outcome
    }

    it('settles the drain as stopped only after the fenced stop and a fresh negative observation', async () => {
        const topology = await topologyEvidence({ services: { api: {} } })
        if (topology.admitted.kind !== 'complete') throw new Error('topology fixture unavailable')
        const drain = await drainAuthority(topology)
        const recorded = recordingExecutor()
        const startedAt = Date.now()
        const stopped = await stopRuntime({ topology: topology.admitted.topology, attempt: drain, execute: recorded.execute })
        expect(stopped.kind).toBe('stopped')
        if (stopped.kind !== 'stopped') return
        const [stop, observation] = recorded.steps
        expect(recorded.steps.map((step) => step.argv.slice(-1)[0])).toEqual(['stop', 'running'])
        expect(stop!.spawnNotAfter).toBe(drain.attempt.validThrough)
        expect(stop!.executionFence).toEqual(stopped.fence)
        expect(stop!.timeoutMs).toBeLessThanOrEqual(Date.parse(drain.attempt.validThrough) - startedAt)
        expect(observation!.executionFence).toBeUndefined()
        // One attempt runs once: its fence still holds the first stop, so a second stop never starts.
        const replayed = recordingExecutor()
        expect(await stopRuntime({ topology: topology.admitted.topology, attempt: drain, execute: replayed.execute }))
            .toMatchObject({ kind: 'not-started', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED })
        expect(replayed.steps).toHaveLength(1)
        // A service that ignores SIGTERM holds `compose stop` for Compose's 10s stop grace, so the
        // stop gets that grace on top of the ordinary command budget.
        const budgeted = await topologyEvidence({ services: { api: {} } }, [], { timeoutMs: 10_000 })
        if (budgeted.admitted.kind !== 'complete') throw new Error('topology fixture unavailable')
        const budgetedSteps = recordingExecutor()
        await stopRuntime({ topology: budgeted.admitted.topology, attempt: await drainAuthority(budgeted), execute: budgetedSteps.execute })
        expect(budgetedSteps.steps[0]!.timeoutMs).toBe(20_000)
        // Compose stops a dependent before its dependency, so a two-level stack pays the grace twice.
        const layered = await topologyEvidence({ services: { api: {}, web: { depends_on: { api: {} } } } }, [], { timeoutMs: 10_000 })
        if (layered.admitted.kind !== 'complete') throw new Error('topology fixture unavailable')
        const layeredSteps = recordingExecutor()
        await stopRuntime({ topology: layered.admitted.topology, attempt: await drainAuthority(layered), execute: layeredSteps.execute })
        // 10s budget + 2 x 10s grace, held to the 30s the fixture attempt remains valid.
        expect(layeredSteps.steps[0]!.timeoutMs).toBeGreaterThan(25_000)
        const record = await readState(drain.namespace.paths.coordination(stack))
        if (record.kind !== 'complete') throw new Error('runtime attempt record unavailable')
        expect(reduceDrainOutcome({ outcome: stopped.outcome, record: record.value }))
            .toMatchObject({ holders: [], lease: { released: true }, drain: null })
    })

    it('settles the drain as failed only when the stop provably never started', async () => {
        const startedTopology = await topologyEvidence({ services: { api: {} } }, [{ StopExitCode: 9 }])
        if (startedTopology.admitted.kind !== 'complete') throw new Error('topology fixture unavailable')
        const startedDrain = await drainAuthority(startedTopology)
        const started = recordingExecutor()
        expect(await stopRuntime({ topology: startedTopology.admitted.topology, attempt: startedDrain, execute: started.execute }))
            .toMatchObject({ kind: 'unavailable' })
        expect(started.steps).toHaveLength(1)

        const topology = await topologyEvidence({ services: { api: {} } })
        if (topology.admitted.kind !== 'complete') throw new Error('topology fixture unavailable')
        const drain = await drainAuthority(topology)
        writeFileSync(topology.runtimeExecutable.canonicalPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
        const failed = await stopRuntime({ topology: topology.admitted.topology, attempt: drain, execute: async (step) => {
            const outcome = await executeProbe(step)
            expect(outcome).toMatchObject({ kind: 'refusal', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED, execution: { started: false, signal: null } })
            expect(outcome).not.toHaveProperty('receipt')
            return outcome
        } })
        expect(failed).toMatchObject({ kind: 'not-started', code: ENVIRONMENT_CODES.EXECUTION_PRECONDITION_CHANGED, outcome: { kind: 'failure' } })
    })

    it('uses the secret-blind config argv and retains only bounded topology fields', async () => {
        const topology = {
            services: {
                db: { image: 'synthetic', environment: { SECRET: 'topology-value-canary' } },
                api: {
                    depends_on: { db: { condition: 'service_started', required: true } },
                    volumes: [
                        { type: 'bind', source: '/workspace/应用', target: '/app' },
                        { type: 'volume', source: 'cache', target: '/cache' },
                    ],
                    healthcheck: { test: ['CMD', 'true'] },
                    environment: { SECRET: 'topology-value-canary' },
                },
            },
            volumes: { cache: { name: 'synthetic_cache' } },
        }
        const { planned, admitted } = await topologyEvidence(topology)

        expect(planned.step.argv.slice(-4)).toEqual(['config', '--format', 'json', '--no-env-resolution'])
        expect(planned.step.argv).not.toContain('--no-interpolate')
        expect(planned.step.env.COMPOSE_DISABLE_ENV_FILE).toBe('1')
        expect(planned.step.env).not.toHaveProperty('SECRET_CANARY')
        expect(admitted.kind).toBe('complete')
        if (admitted.kind !== 'complete') return
        expect(admitted.topology.services).toEqual([
            { id: 'api', dependsOn: ['db'], bindMountSources: ['/workspace/应用'], namedVolumeMounts: [{ source: 'cache', name: 'synthetic_cache', target: '/cache' }], healthcheck: true },
            { id: 'db', dependsOn: [], bindMountSources: [], namedVolumeMounts: [], healthcheck: false },
        ])
        expect(resolveRuntimeServiceOrder(admitted.topology)).toEqual(['db', 'api'])
        expect(isRuntimeTopologyEvidence(admitted.topology)).toBe(true)
        expect(admitted.topology).toEqual(expect.objectContaining({
            stackId: stack,
            configSha256,
            batchId,
            runtimeVersion: runtimeInput.runtime.version,
            composeVersion: runtimeInput.composeVersion,
            executableSha256: expect.any(String),
            projectName: 'synthetic',
            cwd: directory,
            observationWindow: expect.objectContaining({ startedAt: expect.any(String), expiresAt: expect.any(String) }),
        }))
        expect(admitted.observations).toEqual([
            expect.objectContaining({ code: ENVIRONMENT_CODES.RUNTIME_UNAVAILABLE, observed: expect.objectContaining({ value: true }) }),
            expect.objectContaining({ code: ENVIRONMENT_CODES.MOUNT_POSTURE_UNAVAILABLE, observed: expect.objectContaining({ value: true }) }),
        ])
        expect(admitted.observations.every(isRuntimeObservation)).toBe(true)
        expect(JSON.stringify(admitted)).not.toContain('topology-value-canary')
        expect(JSON.stringify(admitted)).not.toContain(canary)
    })

    it('retains named-volume runtime identity and holds every start to the declared cold start', async () => {
        const image = `synthetic.invalid/runtime@sha256:${sha('runtime image')}`
        const topology = {
            services: {
                api: {
                    image,
                    labels: { 'dev.b0dea.cockpit.stack-id': stack, 'dev.b0dea.cockpit.config-sha256': configSha256 },
                    volumes: [{ type: 'volume', source: 'product-data', target: '/workspace/data' }],
                },
            },
            volumes: { 'product-data': { name: 'synthetic_product-data' } },
        }
        const { admitted } = await topologyEvidence(topology)
        expect(admitted.kind).toBe('complete')
        if (admitted.kind !== 'complete') return
        expect(admitted.topology.services).toEqual([{
            id: 'api', dependsOn: [], bindMountSources: [], healthcheck: false,
            namedVolumeMounts: [{ source: 'product-data', name: 'synthetic_product-data', target: '/workspace/data' }],
        }])
        expect((await topologyEvidence({ ...topology, volumes: { 'product-data': { name: '../escaped' } } })).admitted.kind).toBe('unavailable')

        // `up --wait` returns only once the service is running and healthy, and a first start may
        // pull or build its image, so every start is held to the declared cold start plus the stop
        // grace of a container whose configuration changed. Holding the rest to the command budget
        // killed a first `up` moments before its container became healthy.
        const pinnedEvidence = (await topologyEvidence(topology, [], { timeoutMs: 10_000, coldStartLimitMillis: 60_000 })).admitted
        if (pinnedEvidence.kind !== 'complete') throw new Error(pinnedEvidence.reason)
        expect((await serviceRun(pinnedEvidence.topology)).steps[0]!.timeoutMs).toBe(70_000)
        const built = { services: { api: {
            build: { context: directory, dockerfile: 'Dockerfile' },
            labels: { 'dev.b0dea.cockpit.stack-id': stack, 'dev.b0dea.cockpit.config-sha256': configSha256 },
            healthcheck: { test: ['CMD', 'true'], interval: '25s' },
        } } }
        const builtEvidence = (await topologyEvidence(built, [], { timeoutMs: 10_000, coldStartLimitMillis: 60_000 })).admitted
        if (builtEvidence.kind !== 'complete') throw new Error(builtEvidence.reason)
        expect((await serviceRun(builtEvidence.topology)).steps[0]!.timeoutMs).toBe(70_000)
        // A declared budget beyond five minutes is honoured, not cut to a fixed window: a service
        // healthy after 330s of a 600s budget was killed at 300s and reported unhealthy.
        const longEvidence = (await topologyEvidence(built, [], { timeoutMs: 10_000, coldStartLimitMillis: 600_000 })).admitted
        if (longEvidence.kind !== 'complete') throw new Error(longEvidence.reason)
        expect((await serviceRun(longEvidence.topology)).steps[0]!.timeoutMs).toBe(610_000)
    })

    it('projects only the exact authenticated runtime environment used for topology admission', async () => {
        const config = CockpitConfig.parse(parse(readFileSync('fixtures/registries/generated-environment.toml', 'utf8')))
        const home = mkdtempSync(join(tmpdir(), 'cockpit-runtime-environment-'))
        try {
            const namespace = await selectStateRoot({ platform: 'linux', home, cockpitId: runtimeCockpit })
            if (namespace.kind !== 'complete') throw new Error('runtime environment state unavailable')
            const leaseObservedAt = new Date().toISOString()
            const checkout = checkoutId({ checkoutPath: '/tmp/work' })
            const lease = await leasePortFamilyFixture({
                namespace: namespace.value,
                stackId: stack,
                holderId: `holder:${sha('runtime environment holder')}:session` as HolderId,
                checkoutId: checkout,
                config: config.ports,
                now: leaseObservedAt,
                listenerTimeoutMs: 100,
                listenerEvidence: Array.from({ length: config.ports.count }, (_, index) => ({
                    ports: [config.ports.bases.APP_HOST_PORT! + index * config.ports.step],
                    observation: { state: 'available' as const, value: [], observedAt: leaseObservedAt, producer: 'runtime-environment-listener' },
                })),
            })
            if (lease.kind !== 'complete') throw new Error(JSON.stringify(lease))
            const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
            if (entrypoints.kind !== 'complete') throw new Error(JSON.stringify(entrypoints))
            const portLeaseProjection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
            if (!portLeaseProjection) throw new Error('runtime environment port authority unavailable')
            const expectedPort = lease.lease.ports.APP_HOST_PORT!
            // A compose-first stack's own file reads the leased variable and its sibling directory variable.
            const ownCompose = 'services:\n  app:\n    image: busybox\n    ports: ["${APP_HOST_PORT:-4100}:3000"]\n    volumes: ["${APP_DIR}:/app"]\n    labels: ["owner=${COCKPIT_OWNER_ID:?owner required}", "stack=${COCKPIT_STACK_ID:?stack required}"]\n'
            const ownPath = join(directory, 'compose.own.yml')
            writeFileSync(ownPath, ownCompose)
            const ownFile = { reference: 'compose.own.yml', canonicalPath: ownPath, source: ownCompose, sha256: sha(ownCompose) }
            const ownProjection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
            if (!ownProjection) throw new Error('compose-first port authority unavailable')
            const ownPlan = createRuntimeAdapter({
                ...runtimeInput, operation: 'validate', cwd: directory, projectName: 'synthetic',
                composeFiles: [ownFile], env: { PATH: process.env.PATH ?? '/usr/bin' },
                ports: [expectedPort], labels: {},
            }, { ownComposeFiles: true, cockpitId: runtimeCockpit, stackId: stack, portLeaseProjection: ownProjection,
                siblingDirectories: { APP_DIR: '/synthetic/siblings/app' } })
            expect(ownPlan, JSON.stringify(ownPlan)).toMatchObject({ kind: 'preview' })
            const owned = await topologyEvidence({ services: { app: { image: 'busybox', labels: {
                'dev.b0dea.cockpit.stack-id': stack, 'dev.b0dea.cockpit.config-sha256': configSha256,
            } } } }, [], {
                composeFiles: [ownFile], env: { PATH: process.env.PATH ?? '/usr/bin' }, ports: [expectedPort],
                authority: { ownComposeFiles: true, cockpitId: runtimeCockpit, stackId: stack,
                    portLeaseProjection: ownProjection, siblingDirectories: { APP_DIR: '/synthetic/siblings/app' } },
            })
            if (owned.admitted.kind !== 'complete') throw new Error(owned.admitted.reason)
            expect(ownCompose).toContain('${COCKPIT_OWNER_ID:?owner required}')
            expect(ownCompose).toContain('${COCKPIT_STACK_ID:?stack required}')
            expect(owned.planned.step.argv).not.toContain('--no-interpolate')
            expect(owned.planned.step.env).toMatchObject({
                APP_HOST_PORT: String(expectedPort),
                APP_DIR: '/synthetic/siblings/app',
                COCKPIT_OWNER_ID: runtimeCockpit,
                COCKPIT_STACK_ID: stack,
                COMPOSE_DISABLE_ENV_FILE: '1',
            })
            expect(projectRuntimeExecutionEnvironment(owned.admitted.topology)).toEqual({
                PATH: process.env.PATH ?? '/usr/bin', APP_HOST_PORT: String(expectedPort), APP_DIR: '/synthetic/siblings/app',
                COCKPIT_OWNER_ID: runtimeCockpit, COCKPIT_STACK_ID: stack,
            })
            expect(projectRuntimeExecutionEnvironment({ ...owned.admitted.topology })).toBeUndefined()
            // A reference with neither a default nor a leased variable would resolve to empty.
            const unset = `${ownCompose}    environment: ["TOKEN=\${UNDECLARED}"]\n`
            writeFileSync(ownPath, unset)
            expect(createRuntimeAdapter({
                ...runtimeInput, operation: 'validate', cwd: directory, projectName: 'synthetic',
                composeFiles: [{ ...ownFile, source: unset, sha256: sha(unset) }],
                env: { PATH: process.env.PATH ?? '/usr/bin' }, ports: [expectedPort],
                labels: { stackId: stack, configSha256, batchId }, stackId: stack,
                coldStartLimitMillis: 60_000, expectedMountSources: [],
            }, { ownComposeFiles: true, cockpitId: runtimeCockpit, stackId: stack,
                portLeaseProjection: projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })! })).toMatchObject({
                kind: 'refusal', diagnostics: [{ message: 'compose artifact contains unresolved or unsafe data' }],
            })
            rmSync(ownPath, { force: true })
        } finally {
            rmSync(home, { recursive: true, force: true })
        }
    })

    it('reads the KEY=VALUE label list Compose prints once an override merges labels', async () => {
        const merged = [`dev.b0dea.cockpit.config-sha256=${configSha256}`, 'dev.b0dea.cockpit.probe=merged', `dev.b0dea.cockpit.stack-id=${stack}`]
        const { admitted } = await topologyEvidence({ services: { api: { labels: merged } } })
        expect(admitted.kind).toBe('complete')
        for (const labels of [[...merged, `dev.b0dea.cockpit.stack-id=stack:${sha('other')}`], ['dev.b0dea.cockpit.stack-id'], merged.slice(1)]) {
            expect((await topologyEvidence({ services: { api: { labels } } })).admitted.kind).toBe('unavailable')
        }
    })

    it('closes cyclic, unknown, malformed, and value-bearing topology without reflecting input', async () => {
        const hostile = 'hostile-topology-canary'
        const candidates = [
            { services: { api: { depends_on: { worker: {} } }, worker: { depends_on: { api: {} } } } },
            { services: { api: { depends_on: { missing: {} } } } },
            { services: { api: { depends_on: hostile } } },
            { services: { api: { volumes: [{ type: 'bind', source: hostile }] } } },
        ]
        for (const topology of candidates) {
            const { admitted } = await topologyEvidence(topology)
            expect(admitted.kind).toBe('unavailable')
            expect(JSON.stringify(admitted)).not.toContain(hostile)
        }
    })

    it.each([
        ['absent', {}],
        ['wrong stack', { 'dev.b0dea.cockpit.stack-id': `stack:${sha('other stack')}`, 'dev.b0dea.cockpit.config-sha256': configSha256 }],
        ['wrong configuration', { 'dev.b0dea.cockpit.stack-id': stack, 'dev.b0dea.cockpit.config-sha256': sha('other configuration') }],
    ])('rejects %s canonical topology ownership labels before service planning', async (_case, labels) => {
        const result = await topologyEvidence({ services: { api: { labels } } })
        expect(result.admitted.kind).toBe('unavailable')
        if (result.admitted.kind === 'complete') {
            expect((await serviceRun(result.admitted.topology)).steps).toEqual([])
        }
    })

    it.each(['__malformed_json__', '__invalid_utf8__', '__nonempty_stderr__'])('closes unreadable topology output %s', async (topology) => {
        expect((await topologyEvidence(topology)).admitted.kind).toBe('unavailable')
    })

    it('bounds the topology graph before ordering it', async () => {
        const services = Object.fromEntries(Array.from({ length: 4_097 }, (_, index) => [`service-${index}`, {}]))
        expect((await topologyEvidence({ services })).admitted.kind).toBe('unavailable')
    })

    it('rejects copied topology evidence and topology read outside its observation window', async () => {
        const base = await topologyEvidence({ services: { api: {} } })
        expect(base.admitted.kind).toBe('complete')
        if (base.admitted.kind !== 'complete') return
        const copy = structuredClone(base.admitted.topology)
        expect(isRuntimeTopologyEvidence(copy)).toBe(false)
        expect(resolveRuntimeServiceOrder(copy as never)).toEqual([])
        expect(await serviceRun(copy as never)).toMatchObject({ outcome: { kind: 'failure' }, steps: [] })

        for (const window of [
            observationWindow(-120_000, -60_000),
            observationWindow(60_000, 120_000),
            observationWindow(60_000, -60_000),
        ]) {
            expect(await observeRuntimeTopology({
                runtimePlan: base.runtime.plan, stackId: stack, configSha256, batchId, observationWindow: window, execute: executeProbe,
            })).toMatchObject({ kind: 'unavailable' })
        }
    })

    it('rejects topology authority after the clock moves before its observation window', async () => {
        const base = await topologyEvidence({ services: { api: {} } })
        expect(base.admitted.kind).toBe('complete')
        if (base.admitted.kind !== 'complete') return

        vi.useFakeTimers()
        vi.setSystemTime(Date.parse(base.admitted.topology.observationWindow.startedAt) - 1)
        try {
            expect(isRuntimeTopologyEvidence(base.admitted.topology)).toBe(false)
            expect(resolveRuntimeServiceOrder(base.admitted.topology)).toEqual([])
            expect(await serviceRun(base.admitted.topology)).toMatchObject({ outcome: { kind: 'failure' }, steps: [] })
        } finally {
            vi.useRealTimers()
        }
    })

    it('starts one service through exact Compose steps and admits its healthy container', async () => {
        const topology = await admittedTopology({ services: { api: { healthcheck: { test: ['CMD', 'true'] } } } }, [
            running({ Name: 'synthetic-api-1', Health: 'healthy', Labels: `com.docker.compose.project=synthetic,com.docker.compose.service=api,dev.b0dea.cockpit.config-sha256=${configSha256},dev.b0dea.cockpit.stack-id=${stack}` }),
        ])
        const { steps, stages, outcome } = await serviceRun(topology)
        expect(stages).toEqual(['start', 'status', 'identity', 'health'])
        expect(steps[0]!.argv.slice(-7)).toEqual(['--progress', 'quiet', 'up', '--detach', '--wait', '--no-deps', 'api'])
        expect(steps[0]!.labels.operation).toBe('up')
        expect(steps[1]!.argv.slice(-5)).toEqual(['ps', '--format', 'json', '--all', 'api'])
        expect(steps[2]!.argv.slice(-4)).toEqual(['ps', '--quiet', '--all', 'api'])
        expect(steps[3]!.argv.slice(-4)).toEqual(['inspect', '--format', expect.any(String), containerId])
        if (outcome.kind !== 'observed') throw new Error(outcome.kind)
        expect(outcome.stop?.argv.slice(-2)).toEqual(['stop', 'api'])
        const evidence = admitRuntimeServiceHealth(outcome.observation)
        expect(evidence).toEqual(expect.objectContaining({
            stackId: stack, configSha256, batchId, service: 'api', containerId, state: 'running', health: 'healthy',
        }))
        expect(isRuntimeServiceEvidence(evidence)).toBe(true)
        expect(isRuntimeServiceEvidence({ ...evidence })).toBe(false)
    })

    it('issues mount materialization only from exact current container mounts', async () => {
        const inspected = {
            ID: containerId,
            State: 'running',
            Health: '',
            Labels: {
                'com.docker.compose.project': 'synthetic',
                'com.docker.compose.service': 'api',
                'dev.b0dea.cockpit.config-sha256': configSha256,
                'dev.b0dea.cockpit.stack-id': stack,
            },
            Mounts: [{ Type: 'bind', Source: '/workspace/应用', Destination: '/app' }],
            Ports: {},
        }
        const result = await topologyEvidence({ services: { api: {
            volumes: [{ type: 'bind', source: '/workspace/应用', target: '/app' }],
        } } }, [{
            ID: containerId, Project: 'synthetic', Service: 'api', State: 'running', Health: '', ExitCode: 0,
            InspectOutput: JSON.stringify(inspected),
        }])
        if (result.admitted.kind !== 'complete') throw new Error(result.admitted.reason)
        const topology = result.admitted.topology
        const service = { evidence: await healthyEvidence(topology) }

        expect(observeRuntimeMountMaterialization({
            topology,
            services: [service.evidence],
            observedAt: service.evidence.observedAt,
        })).toMatchObject({
            code: ENVIRONMENT_CODES.MOUNT_MATERIALIZATION_UNAVAILABLE,
            observed: { state: 'available', value: true },
            applicability: { state: 'required', posture: 'running-stack' },
        })
        expect(observeRuntimeMountMaterialization({
            topology,
            services: [{ ...service.evidence } as never],
            observedAt: service.evidence.observedAt,
        })).toMatchObject({ observed: { state: 'unavailable' } })
        expect(() => observeRuntimeMountMaterialization({
            topology: { ...topology } as never,
            services: [service.evidence],
            observedAt: service.evidence.observedAt,
        })).toThrow('runtime mount evidence is not authentic')
    })

    it('refuses an unexpected published UDP binding instead of omitting it from current runtime evidence', async () => {
        const inspected = {
            ID: containerId,
            State: 'running',
            Health: '',
            Labels: {
                'com.docker.compose.project': 'synthetic',
                'com.docker.compose.service': 'api',
                'dev.b0dea.cockpit.config-sha256': configSha256,
                'dev.b0dea.cockpit.stack-id': stack,
            },
            Mounts: [],
            Ports: { '5353/udp': [{ HostIp: '127.0.0.1', HostPort: '5353' }] },
        }
        const result = await topologyEvidence({ services: { api: {} } }, [{
            ID: containerId, Project: 'synthetic', Service: 'api', State: 'running', Health: '', ExitCode: 0,
            InspectOutput: JSON.stringify(inspected),
        }])
        if (result.admitted.kind !== 'complete') throw new Error(result.admitted.reason)
        const { stages, outcome } = await serviceRun(result.admitted.topology)
        expect(stages.at(-1)).toBe('health')
        expect(outcome).toMatchObject({ kind: 'failure' })
    })

    // A runtime that publishes 0.0.0.0 and :: but forwards only IPv4 loopback leaves the IPv6
    // companion unreachable; the stack is still serving every declared listener.
    it.each([
        ['IPv4 publication', ['0.0.0.0']],
        ['dual-stack publication forwarded only on IPv4 loopback', ['0.0.0.0', '::']],
    ] as const)('issues port health only from the exact lease, publication, listeners, and fresh service reread (%s)', async (_case, hostIps) => {
        const server = createServer()
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('listener fixture unavailable')
        const published = address.port
        const spareServer = createServer()
        spareServer.listen(0, '127.0.0.1')
        await once(spareServer, 'listening')
        const spareAddress = spareServer.address()
        if (!spareAddress || typeof spareAddress === 'string') throw new Error('listener fixture unavailable')
        const spare = spareAddress.port
        spareServer.close()
        await once(spareServer, 'close')
        const foreign = createServer()
        const home = mkdtempSync(join(tmpdir(), 'cockpit-runtime-port-health-'))
        try {
            const namespace = await selectStateRoot({ platform: 'linux', home, cockpitId: runtimeCockpit })
            if (namespace.kind !== 'complete') throw new Error('state namespace unavailable')
            const holderId = `holder:${sha('runtime port health holder')}:session` as HolderId
            const lease = await leasePortFamilyFixture({
                namespace: namespace.value, stackId: stack,
                holderId,
                checkoutId: checkoutId({ checkoutPath: '/tmp/work' }),
                config: { step: 100, count: 1, bases: { APP_HOST_PORT: published, SPARE_HOST_PORT: spare } },
                now: new Date().toISOString(), listenerTimeoutMs: 100,
                listenerEvidence: [{ ports: [published, spare], observation: {
                    state: 'available', value: [], observedAt: new Date().toISOString(), producer: 'runtime-port-health-fixture',
                } }],
            })
            if (lease.kind !== 'complete') throw new Error(JSON.stringify(lease))
            const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
            if (entrypoints.kind !== 'complete') throw new Error(JSON.stringify(entrypoints))
            const projection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
            if (!projection) throw new Error('port projection unavailable')
            const inspected = JSON.stringify({
                ID: containerId, State: 'running', Health: '',
                Labels: { 'com.docker.compose.project': 'synthetic', 'com.docker.compose.service': 'api',
                    'dev.b0dea.cockpit.config-sha256': configSha256, 'dev.b0dea.cockpit.stack-id': stack },
                Mounts: [], Ports: { '3000/tcp': hostIps.map((HostIp) => ({ HostIp, HostPort: String(published) })) },
            })
            const result = await topologyEvidence({ services: { api: { ports: [{ target: 3000, published: String(published),
                protocol: 'tcp' }] } } }, [{
                ID: containerId, Project: 'synthetic', Service: 'api', State: 'running', Health: '', ExitCode: 0,
                InspectOutput: inspected,
            }], { ports: [published, spare], authority: { ownComposeFiles: true, cockpitId: runtimeCockpit, stackId: stack,
                portLeaseProjection: projection } })
            if (result.admitted.kind !== 'complete') throw new Error(result.admitted.reason)
            const topology = result.admitted.topology
            const observeService = (revalidate: boolean) => healthyEvidence(topology, revalidate ? { expectedContainerId: containerId } : {})
            const service = await observeService(false)
            await expect(observeRuntimePortFamily({ topology: { ...topology } as never, services: [service],
                namespace: namespace.value, listenerTimeoutMs: 1_000, revalidate: async () => [service] })).rejects.toThrow(
                'runtime port evidence is not authentic',
            )
            await expect(observeRuntimePortFamily({ topology, services: [service],
                namespace: namespace.value, listenerTimeoutMs: 1_000,
                revalidate: async () => [await observeService(true)] })).resolves.toMatchObject({
                code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION, observed: { state: 'available', value: true },
                applicability: { state: 'required', posture: 'running-stack' },
            })
            await expect(observeRuntimePortFamily({ topology, services: [service],
                namespace: namespace.value, listenerTimeoutMs: 1_000, revalidate: async () => [service] })).resolves.toMatchObject({
                observed: { state: 'unavailable' },
            })
            foreign.listen(spare, '127.0.0.1')
            await once(foreign, 'listening')
            await expect(observeRuntimePortFamily({ topology, services: [service],
                namespace: namespace.value, listenerTimeoutMs: 1_000,
                revalidate: async () => [await observeService(true)] })).resolves.toMatchObject({
                code: ENVIRONMENT_CODES.PORT_FAMILY_COLLISION, observed: { state: 'available', value: false },
                remedy: expect.stringContaining(`127.0.0.1:${spare} has a listener outside the stack`),
            })
            foreign.close()
            let callbackMutation: unknown
            const raced = await observeRuntimePortFamily({ topology, services: [service], namespace: namespace.value,
                listenerTimeoutMs: 1_000, revalidate: async () => {
                    const refreshed = await observeService(true)
                    callbackMutation = await transactState(namespace.value, namespace.value.paths.coordination(stack),
                        { ownerId: holderId }, (current) => ({
                            ...current!, revision: current!.revision + 1, updatedAt: new Date().toISOString(),
                            value: {
                                ...(current!.value as object), holders: [], lastReleasedHolder: holderId,
                                lease: { ...((current!.value as { lease: object }).lease), released: true },
                            },
                        } as never))
                    return [refreshed]
                } })
            expect(callbackMutation).toMatchObject({ kind: 'complete' })
            expect(raced).toMatchObject({ observed: { state: 'unavailable' } })
        } finally {
            server.close()
            foreign.close()
            rmSync(home, { recursive: true, force: true })
        }
    })

    it.each([
        ['within budget', 60_000, true],
        ['over budget', 1, false],
    ] as const)('measures an authentic service cold start %s', async (_case, coldStartLimitMillis, expectedPass) => {
        const container = {
            ID: containerId, Project: 'synthetic', Service: 'api', State: 'running', Health: '', ExitCode: 0,
        }
        const current = await topologyEvidence({ services: { api: {} } }, [container], { coldStartLimitMillis })
        if (current.admitted.kind !== 'complete') throw new Error(current.admitted.reason)
        const evidence = await healthyEvidence(current.admitted.topology)

        const observation = observeRuntimeServiceColdStart({ services: [evidence] })
        expect(observation).toMatchObject({
            code: ENVIRONMENT_CODES.MACHINE_COLD_START_EXCEEDED,
            source: 'api', observed: { state: 'available' },
            expectation: { kind: 'maximum', value: coldStartLimitMillis },
        })
        expect(observation.observed.state === 'available' && typeof observation.observed.value === 'number'
            && observation.observed.value > 0).toBe(true)
        expect(observation.observed.state === 'available' && typeof observation.observed.value === 'number'
            && observation.observed.value <= coldStartLimitMillis).toBe(expectedPass)
    })

    it('excludes services behind inactive Compose profiles from the lifecycle topology', async () => {
        const container = { ID: containerId, Project: 'synthetic', Service: 'api', State: 'running', Health: '', ExitCode: 0 }
        const { admitted } = await topologyEvidence({
            services: {
                api: {},
                dormant: { profiles: ['runtime_probe'] },
            },
        }, [container])
        expect(admitted.kind).toBe('complete')
        if (admitted.kind !== 'complete') return
        expect(admitted.topology.services).toEqual([expect.objectContaining({ id: 'api' })])
        expect((await serviceRun(admitted.topology)).outcome.kind).toBe('observed')
        expect(await serviceRun(admitted.topology, { service: 'dormant' })).toMatchObject({ outcome: { kind: 'failure' }, steps: [] })
    })

    it('includes services selected by an authenticated active Compose profile', async () => {
        const containers = [
            { ID: containerId, Project: 'synthetic', Service: 'api', State: 'running', Health: '', ExitCode: 0 },
            { ID: sha('profile container'), Project: 'synthetic', Service: 'profiled', State: 'running', Health: '', ExitCode: 0 },
        ]
        const { admitted, planned } = await topologyEvidence({
            services: {
                api: {},
                profiled: { profiles: ['runtime_probe'] },
            },
        }, containers, { activeProfiles: ['runtime_probe'] })
        expect(admitted.kind).toBe('complete')
        if (admitted.kind !== 'complete' || planned.kind !== 'planned') return
        expect(planned.step.argv).toContain('runtime_probe')
        expect(admitted.topology.services.map(({ id }) => id)).toEqual(['api', 'profiled'])
        expect((await serviceRun(admitted.topology, { service: 'profiled' })).stages[0]).toBe('start')
    })

    it('rejects non-local bind sources before service start', async () => {
        const legitimate = await topologyEvidence({ services: { api: { volumes: [
            { type: 'bind', source: '/workspace/应用', target: '/app' },
            { type: 'volume', source: 'cache', target: '/cache' },
        ] } }, volumes: { cache: { name: 'synthetic_cache' } } }, [], { expectedMountSources: ['/workspace/应用'] })
        expect(legitimate.admitted.kind).toBe('complete')

        const extra = await topologyEvidence({ services: { api: { volumes: [
            { type: 'bind', source: '/workspace/应用', target: '/app' },
            { type: 'bind', source: '/private/undeclared', target: '/escape' },
            { type: 'volume', source: 'cache', target: '/cache' },
        ] } }, volumes: { cache: { name: 'synthetic_cache' } } }, [], { expectedMountSources: ['/workspace/应用'] })
        expect(extra.admitted).toEqual({ kind: 'unavailable', reason: 'the bind mounts Compose resolves differ from the declared mount sources',
            mounts: { missing: [], unexpected: ['/private/undeclared'] } })

        const unmounted = await topologyEvidence({ services: { api: { volumes: [
            { type: 'bind', source: '/workspace/应用', target: '/app' },
        ] } } }, [], { expectedMountSources: ['/workspace/worker', '/workspace/应用'] })
        expect(unmounted.admitted).toEqual({ kind: 'unavailable', reason: 'the bind mounts Compose resolves differ from the declared mount sources',
            mounts: { missing: ['/workspace/worker'], unexpected: [] } })

        // A bind inside a declared checkout mounts it; a sibling directory sharing its name prefix does not.
        const subpath = await topologyEvidence({ services: { api: { volumes: [
            { type: 'bind', source: '/workspace/应用/api', target: '/app' },
        ] } } }, [], { expectedMountSources: ['/workspace/应用'] })
        expect(subpath.admitted.kind).toBe('complete')
        const prefixed = await topologyEvidence({ services: { api: { volumes: [
            { type: 'bind', source: '/workspace/应用/api', target: '/app' },
            { type: 'bind', source: '/workspace/应用-copy', target: '/copy' },
        ] } } }, [], { expectedMountSources: ['/workspace/应用'] })
        expect(prefixed.admitted).toEqual({ kind: 'unavailable', reason: 'the bind mounts Compose resolves differ from the declared mount sources',
            mounts: { missing: [], unexpected: ['/workspace/应用-copy'] } })
        // The deeper checkout owns a nested bind, so the outer one still has to be mounted itself.
        const nested = await topologyEvidence({ services: { api: { volumes: [
            { type: 'bind', source: '/workspace/应用/worker/src', target: '/app' },
        ] } } }, [], { expectedMountSources: ['/workspace/应用', '/workspace/应用/worker'] })
        expect(nested.admitted).toEqual({ kind: 'unavailable', reason: 'the bind mounts Compose resolves differ from the declared mount sources',
            mounts: { missing: ['/workspace/应用'], unexpected: [] } })
        // A declared host path inside a checkout bound whole reaches the container through that bind.
        const held = await topologyEvidence({ services: { api: { volumes: [
            { type: 'bind', source: '/workspace/应用', target: '/app' },
        ] } } }, [], { expectedMountSources: ['/workspace/应用', '/workspace/应用/.cache'] })
        expect(held.admitted.kind).toBe('complete')
    })

    it('rejects service evidence after the clock moves before its observation window', async () => {
        const container = { ID: containerId, Project: 'synthetic', Service: 'api', State: 'running', Health: '', ExitCode: 0 }
        const { admitted } = await topologyEvidence({ services: { api: {} } }, [container])
        if (admitted.kind !== 'complete') throw new Error(admitted.reason)
        const health = { evidence: await healthyEvidence(admitted.topology) }

        vi.useFakeTimers()
        vi.setSystemTime(Date.parse(health.evidence.observationWindow.startedAt) - 1)
        try {
            expect(isRuntimeServiceEvidence(health.evidence)).toBe(false)
        } finally {
            vi.useRealTimers()
        }
    })

    it.each([
        ['starting', [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'running', Health: 'starting', ExitCode: 0 }]],
        ['unhealthy', [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'running', Health: 'unhealthy', ExitCode: 0 }]],
        ['restarting', [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'restarting', Health: '', ExitCode: 0 }]],
        ['paused', [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'paused', Health: '', ExitCode: 0 }]],
        ['dead', [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'dead', Health: '', ExitCode: 0 }]],
        ['removing', [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'removing', Health: '', ExitCode: 0 }]],
        ['exited failure', [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'exited', Health: '', ExitCode: 1 }]],
        ['exited success', [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'exited', Health: '', ExitCode: 0 }]],
        ['missing', []],
        ['duplicate', [
            { ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'running', Health: 'healthy', ExitCode: 0 },
            { ID: sha('duplicate container'), Name: 'synthetic-api-2', Project: 'synthetic', Service: 'api', State: 'running', Health: 'healthy', ExitCode: 0 },
        ]],
        ['swapped service', [{ ID: containerId, Name: 'synthetic-worker-1', Project: 'synthetic', Service: 'worker', State: 'running', Health: 'healthy', ExitCode: 0 }]],
        ['swapped project', [{ ID: containerId, Name: 'other-api-1', Project: 'other', Service: 'api', State: 'running', Health: 'healthy', ExitCode: 0 }]],
        ['swapped configuration', [{
            ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'running', Health: 'healthy', ExitCode: 0,
            Labels: `com.docker.compose.project=synthetic,com.docker.compose.service=api,dev.b0dea.cockpit.config-sha256=${sha('stale configuration')},dev.b0dea.cockpit.stack-id=${stack}`,
        }]],
        ['swapped stack', [{
            ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'running', Health: 'healthy', ExitCode: 0,
            Labels: `com.docker.compose.project=synthetic,com.docker.compose.service=api,dev.b0dea.cockpit.config-sha256=${configSha256},dev.b0dea.cockpit.stack-id=stack:${sha('other stack')}`,
        }]],
    ])('keeps healthchecked service %s unavailable', async (_label, containers) => {
        const { admitted } = await topologyEvidence({ services: { api: { healthcheck: { test: ['CMD', 'true'] } } } }, containers)
        expect(admitted.kind).toBe('complete')
        if (admitted.kind !== 'complete') return
        const { outcome } = await serviceRun(admitted.topology)
        expect(outcome.kind === 'observed' && admitRuntimeServiceHealth(outcome.observation)).toBeFalsy()
        // A container Compose reports in a non-healthy state is observed, so its logs can be read; one
        // that is absent, duplicated or owned by another service, project, stack or configuration is not.
        expect(outcome.kind).toBe(['starting', 'unhealthy', 'restarting', 'paused', 'dead', 'removing', 'exited failure', 'exited success'].includes(_label)
            ? 'observed' : 'failure')
    })

    it('admits an unchecked running service only when the runtime reports no health state', async () => {
        for (const [health, healthy] of [['', true], ['healthy', false]] as const) {
            const containers = [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'running', Health: health, ExitCode: 0 }]
            const { outcome } = await serviceRun(await admittedTopology({ services: { api: {} } }, containers))
            expect(outcome.kind === 'observed' && admitRuntimeServiceHealth(outcome.observation) !== undefined).toBe(healthy)
        }
    })

    it.each([
        { disable: true },
        { test: ['NONE'] },
    ])('treats a disabled healthcheck as unchecked %#', async (healthcheck) => {
        const containers = [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'running', Health: '', ExitCode: 0 }]
        const { admitted } = await topologyEvidence({ services: { api: { healthcheck } } }, containers)
        if (admitted.kind !== 'complete') throw new Error('topology fixture unavailable')
        expect(admitted.topology.services[0].healthcheck).toBe(false)
        await expect(healthyEvidence(admitted.topology)).resolves.toMatchObject({ health: null })
    })

    it('accepts bounded scalar healthcheck argv from normalized Compose JSON', async () => {
        const { admitted } = await topologyEvidence({ services: { api: { healthcheck: { test: ['CMD', true, 42, 0.5] } } } })
        expect(admitted.kind).toBe('complete')
        if (admitted.kind === 'complete') expect(admitted.topology.services[0].healthcheck).toBe(true)
    })

    it.each([
        { test: [null] },
        { test: [{}] },
        { test: [[]] },
        { test: Array.from({ length: 4_097 }, () => 'arg') },
    ])('rejects malformed or excessive normalized healthcheck argv %#', async (healthcheck) => {
        expect((await topologyEvidence({ services: { api: { healthcheck } } })).admitted.kind).toBe('unavailable')
    })

    it('binds each topology and service observation to a unique issuance', async () => {
        const base = await topologyEvidence({ services: { api: {} } }, [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'running', Health: '', ExitCode: 0 }])
        if (base.admitted.kind !== 'complete') throw new Error('topology fixture unavailable')
        const window = observationWindow()
        const issuances: string[] = []
        for (let index = 0; index < 2; index += 1) {
            expect(await observeRuntimeTopology({ runtimePlan: base.runtime.plan, stackId: stack, configSha256, batchId, observationWindow: window,
                execute: (step) => { issuances.push(step.labels.issuanceId!); return executeProbe(step) } })).toMatchObject({ kind: 'complete' })
        }
        expect(issuances[0]).not.toBe(issuances[1])

        const first = await serviceRun(base.admitted.topology)
        const second = await serviceRun(base.admitted.topology)
        expect(first.outcome.kind).toBe('observed')
        expect(first.steps[1]!.labels.issuanceId).not.toBe(second.steps[1]!.labels.issuanceId)
    })

    it('rejects a status receipt that starts before the start finished', async () => {
        const topology = await admittedTopology({ services: { api: {} } }, [running()])
        let startFinishedAt = ''
        const { outcome, stages } = await serviceRun(topology, { alter: (step, result) => {
            if (step.id.split(':')[2] === 'start' && result.receipt) startFinishedAt = result.receipt.finishedAt
            return shiftReceipt('status', 'startedAt', () => new Date(Date.parse(startFinishedAt) - 1).toISOString())(step, result)
        } })
        expect(stages).toEqual(['start', 'status'])
        expect(outcome).toMatchObject({ kind: 'failure' })
        expect(outcome).not.toHaveProperty('logs')
    })

    it('rejects an inspect receipt that starts before container identity completes', async () => {
        const topology = await admittedTopology({ services: { api: {} } }, [running()])
        let identityFinishedAt = ''
        const { outcome, stages } = await serviceRun(topology, { alter: (step, result) => {
            if (step.id.split(':')[2] === 'identity' && result.receipt) identityFinishedAt = result.receipt.finishedAt
            return shiftReceipt('health', 'startedAt', () => new Date(Date.parse(identityFinishedAt) - 1).toISOString())(step, result)
        } })
        expect(stages).toEqual(['start', 'status', 'identity', 'health'])
        expect(outcome).toMatchObject({ kind: 'failure' })
    })

    it('stops at a failed start and offers its logs and the stop of the started service', async () => {
        const { outcome, stages } = await serviceRun(await admittedTopology({ services: { api: {} } }, [running({ StartExitCode: 9 })]))
        expect(stages).toEqual(['start'])
        expect(outcome).toMatchObject({ kind: 'failure', stop: { argv: expect.arrayContaining(['stop', 'api']) } })
        expect(failureContext(outcome)).toMatchObject({ stage: 'start', service: 'api', containerId: null })
    })

    it('rejects start stderr even when quiet progress was requested', async () => {
        const { outcome, stages } = await serviceRun(await admittedTopology({ services: { api: {} } }, [running({ StartStderr: 'unexpected progress' })]))
        expect(stages).toEqual(['start'])
        expect(failureContext(outcome)).toMatchObject({ stage: 'start' })
    })

    it('rejects topology and health receipts completed in the future', async () => {
        const base = await topologyEvidence({ services: { api: {} } }, [{ ID: containerId, Name: 'synthetic-api-1', Project: 'synthetic', Service: 'api', State: 'running', Health: '', ExitCode: 0 }])
        expect(await observeRuntimeTopology({
            runtimePlan: base.runtime.plan, stackId: stack, configSha256, batchId, observationWindow: observationWindow(-20_000, 60_000),
            execute: async (step) => shiftReceipt('topology', 'finishedAt', () => new Date(Date.now() + 5_000).toISOString())(step, await executeProbe(step)),
        })).toMatchObject({ kind: 'unavailable' })
        if (base.admitted.kind !== 'complete') throw new Error('topology fixture unavailable')
        const future = await serviceRun(base.admitted.topology, { alter: shiftReceipt('health', 'finishedAt', () => new Date(Date.now() + 5_000).toISOString()) })
        expect(future.stages.at(-1)).toBe('health')
        expect(future.outcome).toMatchObject({ kind: 'failure' })
    })

    it.each(['API', '--api', 'àpi', 'api service'])('rejects non-exact ASCII service selector %s', async (service) => {
        const { admitted } = await topologyEvidence({ services: { api: {} } })
        if (admitted.kind !== 'complete') throw new Error('topology fixture unavailable')
        expect(await serviceRun(admitted.topology, { service })).toMatchObject({ outcome: { kind: 'failure' }, steps: [] })
    })

    it('keeps an unhealthy observation for failure logs without admitting it as health', async () => {
        const containers = [{ ID: containerId, Project: 'synthetic', Service: 'api', State: 'running', Health: 'unhealthy', ExitCode: 1 }]
        const { outcome } = await serviceRun(await admittedTopology({ services: { api: { healthcheck: { test: ['CMD', 'true'] } } } }, containers))
        if (outcome.kind !== 'observed') throw new Error(outcome.kind)
        expect(admitRuntimeServiceHealth(outcome.observation)).toBeUndefined()
        expect(admitRuntimeServiceHealth({ ...outcome.observation })).toBeUndefined()
    })

    describe('service revalidation and early failure evidence', () => {
        it('revalidates an exact persisted container without issuing another start', async () => {
            const topology = await admittedTopology({ services: { api: {} } }, [running()])
            const { steps, stages, outcome } = await serviceRun(topology, { expectedContainerId: containerId })
            expect(stages).toEqual(['status', 'identity', 'health'])
            expect(JSON.stringify(steps)).not.toContain('"up"')
            expect(steps[0]!.argv.slice(-5)).toEqual(['ps', '--format', 'json', '--all', 'api'])
            expect(steps[1]!.argv.slice(-4)).toEqual(['ps', '--quiet', '--all', 'api'])
            expect(steps[2]!.argv.at(-1)).toBe(containerId)
            if (outcome.kind !== 'observed') throw new Error(outcome.kind)
            expect(outcome).not.toHaveProperty('stop')
            expect(admitRuntimeServiceHealth(outcome.observation)).toBeDefined()
        })

        it.each([
            ['missing', [], 'stale', ['status']],
            ['replacement', [running({ ID: sha('replacement container') })], 'stale', ['status']],
            ['malformed', [running({ StatusOutput: '{' })], 'failure', ['status']],
            ['refused', [running({ StatusExitCode: 9 })], 'failure', ['status']],
        ])('classifies a %s completed-container record from its status', async (_label, containers, expected, stages) => {
            const run = await serviceRun(await admittedTopology({ services: { api: {} } }, containers), { expectedContainerId: containerId })
            expect(run.outcome.kind).toBe(expected)
            expect(run.stages).toEqual(stages)
        })

        it('runs nothing for a non-exact container id or an expired topology window', async () => {
            const topology = await admittedTopology({ services: { api: {} } }, [running()])
            expect(await serviceRun(topology, { expectedContainerId: containerId.toUpperCase() })).toMatchObject({ outcome: { kind: 'failure' }, steps: [] })
            vi.useFakeTimers()
            vi.setSystemTime(Date.parse(topology.observationWindow.expiresAt) + 1)
            try {
                expect(await serviceRun(topology, { expectedContainerId: containerId })).toMatchObject({ outcome: { kind: 'failure' }, steps: [] })
            } finally {
                vi.useRealTimers()
            }
        })

        it('requires the identity receipt to follow the status receipt', async () => {
            const topology = await admittedTopology({ services: { api: {} } }, [running()])
            let statusFinishedAt = ''
            const { outcome, stages } = await serviceRun(topology, { expectedContainerId: containerId, alter: (step, result) => {
                if (step.id.split(':')[2] === 'status' && result.receipt) statusFinishedAt = result.receipt.finishedAt
                return shiftReceipt('identity', 'startedAt', () => new Date(Date.parse(statusFinishedAt) - 1).toISOString())(step, result)
            } })
            expect(stages).toEqual(['status', 'identity'])
            expect(outcome).toEqual({ kind: 'failure' })
        })

        it.each(['start', 'status', 'identity'] as const)('issues one log context for a %s that exits non-zero', async (stage) => {
            const { outcome, stages } = await serviceRun(await admittedTopology({ services: { api: {} } }, [
                running({ [`${stage[0].toUpperCase()}${stage.slice(1)}ExitCode`]: 9 }),
            ]))
            expect(stages.at(-1)).toBe(stage)
            if (outcome.kind !== 'failure' || !outcome.logs) throw new Error('no failure evidence')
            expect(consumeRuntimeServiceFailureForLogs({ ...outcome.logs } as never)).toBeUndefined()
            expect(consumeRuntimeServiceFailureForLogs(outcome.logs)).toMatchObject({
                stage, projectName: 'synthetic', service: 'api', containerId: null,
            })
            expect(consumeRuntimeServiceFailureForLogs(outcome.logs)).toBeUndefined()
        })

        it('preserves the authenticated Compose prefix and file bindings for early logs', async () => {
            const secondPath = join(directory, 'compose.override.yml')
            writeFileSync(secondPath, 'services: {}\n')
            const topology = await topologyEvidence({ services: { api: {} } }, [running({ StartStderr: 'failure' })], { composeFiles: [
                { reference: '编排.yml', canonicalPath: composePath, source: 'services: {}\n', sha256: sha('services: {}\n') },
                { reference: 'compose.override.yml', canonicalPath: secondPath, source: 'services: {}\n', sha256: sha('services: {}\n') },
            ] })
            if (topology.admitted.kind !== 'complete') throw new Error(topology.admitted.reason)
            const context = failureContext((await serviceRun(topology.admitted.topology)).outcome)
            expect(context?.composeArgvPrefix).toEqual([
                'compose', '--project-directory', directory,
                '--file', composePath,
                '--file', secondPath,
                '--project-name', 'synthetic',
            ])
            expect(context?.paths).toEqual([composePath, secondPath])
            expect(context?.env.COMPOSE_DISABLE_ENV_FILE).toBe('1')
            expect(context?.consumedFiles.map(({ path, argvIndexes }) => ({ path, argvIndexes }))).toEqual([
                { path: topology.runtimeExecutable.canonicalPath, argvIndexes: [0] },
                { path: composePath, argvIndexes: [5] },
                { path: secondPath, argvIndexes: [7] },
            ])
            expect(context?.filesystemChecks).toEqual([])
        })

        // Absence, a process failure or stderr is the runtime's own account and earns a log read;
        // output that cannot be read as the one expected row is not, and stops the start there.
        it.each([
            ['status stderr', { StatusStderr: 'runtime diagnostic' }, 'status', true],
            ['empty status', { StatusOutput: '' }, 'status', true],
            ['status for another project', { Project: 'other' }, 'status', false],
            ['two status rows', { Duplicate: true }, 'status', false],
            ['status that is not UTF-8', { StatusInvalidUtf8: true }, 'status', false],
            ['status that is not JSON', { StatusOutput: '{' }, 'status', false],
            ['status of another shape', { StatusOutput: '[]' }, 'status', false],
            ['status with an invalid id', { StatusOutput: JSON.stringify({ ID: 'not-an-id', Project: 'synthetic', Service: 'api' }) }, 'status', false],
            ['identity stderr', { IdentityStderr: 'runtime diagnostic' }, 'identity', true],
            ['empty identity', { IdentityOutput: '' }, 'identity', true],
            ['identity that exits non-zero', { IdentityExitCode: 9 }, 'identity', true],
            ['identity that is not UTF-8', { IdentityInvalidUtf8: true }, 'identity', false],
            ['identity that is not a container id', { IdentityOutput: 'not-a-container-id\n' }, 'identity', false],
            ['identity of another container', { IdentityOutput: `${sha('replacement container')}\n` }, 'identity', false],
        ] as const)('stops at %s', async (_label, controls, stage, logs) => {
            const containers = 'Duplicate' in controls ? [running(), running({ ID: sha('duplicate container') })] : [running(controls)]
            const { outcome, stages } = await serviceRun(await admittedTopology({ services: { api: {} } }, containers))
            expect(stages.at(-1)).toBe(stage)
            expect(outcome).toMatchObject({ kind: 'failure', stop: expect.anything() })
            expect(failureContext(outcome)?.stage).toBe(logs ? stage : undefined)
        })

        it('reports a failed start rather than the unreadable status after it', async () => {
            const { outcome, stages } = await serviceRun(await admittedTopology({ services: { api: {} } }, [
                running({ StartStderr: 'first failure', StatusOutput: '{' }),
            ]))
            expect(stages).toEqual(['start'])
            expect(failureContext(outcome)).toMatchObject({ stage: 'start' })
        })

        it('issues inspect-failure evidence with the authenticated full container identity', async () => {
            const { outcome } = await serviceRun(await admittedTopology({ services: { api: {} } }, [running({ InspectExitCode: 9 })]))
            expect(failureContext(outcome)).toMatchObject({ stage: 'inspect', projectName: 'synthetic', service: 'api', containerId })
        })

        it.each([
            ['stderr', { InspectStderr: 'runtime diagnostic' }],
            ['malformed', { InspectOutput: '{' }],
            ['wrong identity', { InspectOutput: JSON.stringify({ ID: sha('replacement container'), State: 'running', Health: '', Labels: {} }) }],
            ['wrong labels', { InspectOutput: JSON.stringify({ ID: containerId, State: 'running', Health: '', Labels: { 'com.docker.compose.project': 'other' } }) }],
            ['unknown state', { State: 'unknown' }],
        ])('treats complete but structurally invalid %s inspect output as an inspect failure', async (_label, controls) => {
            const { outcome } = await serviceRun(await admittedTopology({ services: { api: {} } }, [running(controls)]))
            expect(failureContext(outcome)).toMatchObject({ stage: 'inspect' })
        })

        it.each([
            ['healthy', 'healthy'],
            ['unhealthy', 'unhealthy'],
        ])('observes structurally valid %s inspect output', async (_label, health) => {
            const { outcome } = await serviceRun(await admittedTopology({ services: { api: { healthcheck: { test: ['CMD', 'true'] } } } }, [
                running({ Health: health, ExitCode: health === 'healthy' ? 0 : 1 }),
            ]))
            expect(outcome).toMatchObject({ kind: 'observed', observation: { health } })
        })

        it('rejects start evidence whose receipt falls outside the observation window', async () => {
            const topology = await admittedTopology({ services: { api: {} } }, [running()])
            const { outcome, stages } = await serviceRun(topology, {
                alter: shiftReceipt('start', 'finishedAt', () => new Date(Date.parse(topology.observationWindow.expiresAt) + 1).toISOString()),
            })
            expect(stages).toEqual(['start'])
            expect(outcome).toMatchObject({ kind: 'failure' })
            expect(outcome).not.toHaveProperty('logs')
        })
    })

    describe('runtime lifecycle projection', () => {
        it('projects stable service chronology without consuming topology authority', async () => {
            const result = await topologyEvidence({
                services: {
                    db: {},
                    api: { depends_on: ['db'], volumes: [{ type: 'bind', source: '/workspace/应用', target: '/app' }], healthcheck: { test: ['CMD', 'true'] } },
                },
            })
            if (result.admitted.kind !== 'complete') throw new Error(result.admitted.reason)

            const first = projectRuntimeLifecycle(result.admitted.topology)
            const second = projectRuntimeLifecycle(result.admitted.topology)
            expect(first).toBeDefined()
            expect(second).toBeDefined()
            if (!first || !second) return
            const envelope = first
            expect(envelope.topology).toBe(result.admitted.topology)
            expect(resolveRuntimeServiceOrder(result.admitted.topology)).toEqual(['db', 'api'])
            expect(second.semantics).toEqual(envelope.semantics)
            expect(envelope?.semantics).toEqual(expect.objectContaining({
                stackId: stack,
                configSha256,
                runtimeVersion: runtimeInput.runtime.version,
                composeVersion: runtimeInput.composeVersion,
                projectName: 'synthetic',
                topology: {
                    order: ['db', 'api'],
                    services: [
                        { id: 'api', dependsOn: ['db'], bindMountSources: ['/workspace/应用'], namedVolumeMounts: [], healthcheck: true },
                        { id: 'db', dependsOn: [], bindMountSources: [], namedVolumeMounts: [], healthcheck: false },
                    ],
                },
                runtimeChecks: { coldStartLimitMillis: 60_000, expectedMountSources: ['/workspace/应用'] },
            }))
            expect(Object.keys(envelope?.semantics ?? {}).sort()).toEqual([
                'composeVersion', 'configSha256', 'projectName', 'runtimeChecks', 'runtimeVersion', 'services', 'stackId', 'topology',
            ].sort())
            expect(envelope?.semantics.services.map(({ id }) => id)).toEqual(['db', 'api'])
            expect(envelope?.semantics.services[1]?.healthAcceptance).toEqual({ state: 'running', health: 'healthy' })
            expect(envelope?.semantics.services[0]?.healthAcceptance).toEqual({ state: 'running', health: null })
        })

        it('canonicalizes mount expectations and refuses duplicates at the owning boundary', async () => {
            const topology = { services: { api: { volumes: [
                { type: 'bind', source: '/workspace/zeta', target: '/zeta' },
                { type: 'bind', source: '/workspace/alpha', target: '/alpha' },
            ] } } }
            const first = await topologyEvidence(topology, [], { expectedMountSources: ['/workspace/zeta', '/workspace/alpha'] })
            if (first.admitted.kind !== 'complete') throw new Error(first.admitted.reason)
            const second = await topologyEvidence(topology, [], {
                runtimeExecutable: first.runtimeExecutable,
                expectedMountSources: ['/workspace/alpha', '/workspace/zeta'],
            })
            if (second.admitted.kind !== 'complete') throw new Error(second.admitted.reason)
            const firstProjection = projectRuntimeLifecycle(first.admitted.topology)
            const secondProjection = projectRuntimeLifecycle(second.admitted.topology)
            if (!firstProjection || !secondProjection) throw new Error('projection unavailable')

            expect(firstProjection?.semantics)
                .toEqual(secondProjection?.semantics)
            const duplicate = createRuntimeAdapter({
                ...runtimeInput,
                operation: 'validate',
                stackId: stack,
                coldStartLimitMillis: 60_000,
                expectedMountSources: ['/workspace/alpha', '/workspace/alpha'],
            })
            expect(duplicate).toEqual(expect.objectContaining({ kind: 'refusal', result: null }))
            expect('plan' in duplicate).toBe(false)
        })

        it('retains every stable execution field and only types the future inspect operand', async () => {
            const result = await topologyEvidence({ services: { api: { healthcheck: { test: ['CMD', 'true'] } } } }, [{
                ID: containerId, Project: 'synthetic', Service: 'api', State: 'running', Health: 'healthy', ExitCode: 0,
            }])
            if (result.admitted.kind !== 'complete') throw new Error(result.admitted.reason)
            const projection = projectRuntimeLifecycle(result.admitted.topology)
            if (!projection) throw new Error('projection unavailable')
            const envelope = projection
            if (!envelope) throw new Error('projection consumption failed')
            const service = envelope.semantics.services[0]
            if (!service) throw new Error('service projection missing')

            expect(Object.keys(service.start).sort()).toEqual([
                'argv', 'argv0', 'compensation', 'consumedFiles', 'cwd', 'env', 'expected', 'filesystemChecks',
                'paths', 'ports', 'stderrLimitBytes', 'stdoutLimitBytes', 'timeoutCeilingMs',
            ].sort())
            expect(service.inspect.argv.slice(-3)).toEqual([
                '--format',
                expect.stringContaining('dev.b0dea.cockpit.config-sha256'),
                { kind: 'runtime-container-id', service: 'api' },
            ])
            expect(JSON.stringify(envelope.semantics)).not.toContain(batchId)
            expect(JSON.stringify(envelope.semantics)).not.toContain('issuanceId')
            expect(JSON.stringify(envelope.semantics)).not.toContain('spawnNotAfter')
            expect(JSON.stringify(envelope.semantics)).not.toContain('observedAt')

            const { steps } = await serviceRun(result.admitted.topology)
            for (const [projected, live] of [
                [service.start, steps[0]!],
                [service.status, steps[1]!],
                [service.identity, steps[2]!],
            ] as const) {
                expect(projected).toEqual({
                    argv: live.argv,
                    argv0: live.argv0,
                    cwd: live.cwd,
                    env: live.env,
                    timeoutCeilingMs: live.timeoutMs,
                    stdoutLimitBytes: live.stdoutLimitBytes,
                    stderrLimitBytes: live.stderrLimitBytes,
                    paths: live.paths,
                    ports: live.ports,
                    expected: live.expected,
                    consumedFiles: live.consumedFiles,
                    filesystemChecks: live.filesystemChecks,
                    compensation: live.compensation,
                })
            }
            const substituted = service.inspect.argv.map((part) => typeof part === 'string' ? part : containerId)
            expect(steps[3]!.argv).toEqual(substituted)
            expect(service.inspect.timeoutCeilingMs).toBe(result.runtime.plan.steps[0]?.timeoutMs)
            expect(steps[3]!.timeoutMs).toBeLessThanOrEqual(service.inspect.timeoutCeilingMs)
            for (const execution of [service.start, service.status, service.identity, service.inspect]) {
                expect(execution.consumedFiles[0]).toEqual(expect.objectContaining({
                    executable: true,
                    executionMode: result.runtimeExecutable.executionMode,
                }))
            }
        })

        it('changes stable semantics when authenticated material runtime inputs change', async () => {
            const topology = { services: { api: {} } }
            const first = await topologyEvidence(topology)
            if (first.admitted.kind !== 'complete') throw new Error(first.admitted.reason)
            const projection = projectRuntimeLifecycle(first.admitted.topology)
            if (!projection) throw new Error('projection unavailable')
            const baseline = projection?.semantics
            if (!baseline) throw new Error('semantics unavailable')
            const variants = [
                ['safe environment', { env: { PATH: process.env.PATH ?? '/usr/bin', DOCKER_CONTEXT: 'changed' } }, topology],
                ['timeout ceiling', { timeoutMs: runtimeInput.timeoutMs - 1 }, topology],
                ['cold-start check', { coldStartLimitMillis: 59_999 }, topology],
                ['mount check', { expectedMountSources: ['/workspace/other'] }, { services: { api: { volumes: [
                    { type: 'bind', source: '/workspace/other', target: '/other' },
                ] } } }],
                ['argv0', { runtimeExecutable: { ...first.runtimeExecutable, invocationPath: join(directory, 'alternate', 'docker') } }, topology],
            ] as const
            for (const [name, options, changedTopology] of variants) {
                let result: Awaited<ReturnType<typeof topologyEvidence>>
                try {
                    result = name === 'mount check'
                        ? await topologyEvidence(changedTopology, [], options)
                        : await topologyEvidence(changedTopology, [], { runtimeExecutable: first.runtimeExecutable, ...options })
                } catch (error) {
                    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
                }
                if (result.admitted.kind !== 'complete') throw new Error(`${name}: ${result.admitted.reason}`)
                const changed = projectRuntimeLifecycle(result.admitted.topology)
                if (!changed) throw new Error('changed projection unavailable')
                const changedSemantics = changed?.semantics
                if (name === 'mount check') expect(changedSemantics?.runtimeChecks.expectedMountSources).toEqual(['/workspace/other'])
                expect(changedSemantics).not.toEqual(baseline)
            }
        })

        it('keeps issuance, batch, observation window, and live container timing out of stable semantics', async () => {
            const topology = { services: { api: {} } }
            const first = await topologyEvidence(topology)
            if (first.admitted.kind !== 'complete') throw new Error(first.admitted.reason)
            const second = await topologyEvidence(topology, [], {
                runtimeExecutable: first.runtimeExecutable,
                batchId: sha('another runtime batch'),
                observationWindow: observationWindow(-500, 30_000),
            })
            if (second.admitted.kind !== 'complete') throw new Error(second.admitted.reason)
            const firstProjection = projectRuntimeLifecycle(first.admitted.topology)
            const secondProjection = projectRuntimeLifecycle(second.admitted.topology)
            if (!firstProjection || !secondProjection) throw new Error('projection unavailable')
            const firstSemantics = firstProjection?.semantics
            const secondSemantics = secondProjection?.semantics

            expect(secondSemantics).toEqual(firstSemantics)
            const source = JSON.stringify(firstSemantics)
            expect(source).not.toContain(first.admitted.topology.batchId)
            expect(source).not.toContain(second.admitted.topology.batchId)
            expect(source).not.toContain(first.admitted.topology.observationWindow.startedAt)
            expect(source).not.toContain('issuanceId')
            expect(source).not.toContain('containerId')
            expect(source).not.toContain('spawnNotAfter')
        })

        it('refuses copied and stale topology evidence', async () => {
            const result = await topologyEvidence({ services: { api: {} } })
            if (result.admitted.kind !== 'complete') throw new Error(result.admitted.reason)
            expect(projectRuntimeLifecycle({ ...result.admitted.topology } as never)).toBeUndefined()

            const projection = projectRuntimeLifecycle(result.admitted.topology)
            if (!projection) throw new Error('projection unavailable')
            vi.useFakeTimers()
            vi.setSystemTime(Date.parse(result.admitted.topology.observationWindow.expiresAt) + 1)
            try {
                expect(projectRuntimeLifecycle(result.admitted.topology)).toBeUndefined()
                expect(isRuntimeTopologyEvidence(projection.topology)).toBe(false)
            } finally {
                vi.useRealTimers()
            }
        })

        it('refuses a canonical lifecycle envelope larger than one MiB', async () => {
            const services = Object.fromEntries(Array.from({ length: 800 }, (_, index) => [
                `service${index.toString().padStart(4, '0')}`,
                {},
            ]))
            const result = await topologyEvidence({ services })
            if (result.admitted.kind !== 'complete') throw new Error(result.admitted.reason)

            expect(projectRuntimeLifecycle(result.admitted.topology)).toBeUndefined()
            expect(resolveRuntimeServiceOrder(result.admitted.topology)).toHaveLength(800)
        })
    })
})
