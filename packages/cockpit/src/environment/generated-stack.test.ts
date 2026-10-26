import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'

import { loadCockpitConfig } from '../config/load.js'
import { executeProbe } from '../environment-exec/execute.js'
import type { CheckoutId, HolderId, StackId } from './contract.js'
import { admitGeneratedObservation, createGeneratedObservationExecution, inspectGeneratedEnvironment, inspectGeneratedRuntimeAuthority, isGeneratedObservation, isGeneratedObservationAdmission, observeGeneratedEnvironment, projectGeneratedComposeArtifactAuthority, projectGeneratedRuntimeAuthority, renderGeneratedEnvironment, resolveGeneratedDataOperation, type GeneratedEnvironmentResult } from './generated-stack.js'
import { deriveEntrypoints, projectPortLeaseResult } from './ports.js'
import { leasePortFamilyFixture } from '../../test-support/port-lease-fixture.js'
import { admitRuntimeTopology, createRuntimeAdapter, createRuntimeTopologyPlan } from './runtime.js'
import { selectStateRoot } from './state.js'

const fixturePath = resolve('fixtures/registries/generated-environment.toml')
const sourceSha256 = 'b'.repeat(64)
const generation = 'c'.repeat(64)
const stackId = `stack:${'d'.repeat(64)}` as StackId
const cockpitId = `cockpit:generated-environment:${'e'.repeat(64)}`
const resolvedInput = { sourceSha256, generation, stackId, cockpitId, portDefaults: { APP_HOST_PORT: 4100 }, siblingDirectories: { app: 'app' } } as const
const nativeOptions = { encoding: 'utf8' as const, timeout: 30_000, killSignal: 'SIGKILL' as const, maxBuffer: 1_048_576 }

async function declaration() {
    const loaded = await loadCockpitConfig(fixturePath)
    expect(loaded.kind).toBe('complete')
    if (loaded.kind !== 'complete') throw new Error('synthetic generated environment fixture did not load')
    const generated = loaded.result.config.environment.generated
    expect(generated).toBeDefined()
    return structuredClone(generated!)
}

async function rendered(): Promise<Extract<GeneratedEnvironmentResult, { kind: 'complete' }>> {
    const result = renderGeneratedEnvironment({ declaration: await declaration(), ...resolvedInput })
    expect(result.kind).toBe('complete')
    if (result.kind !== 'complete') throw new Error(result.reason)
    return result
}

async function generatedAuthority(result: Extract<GeneratedEnvironmentResult, { kind: 'complete' }>, root: string, reportedPort?: number) {
    const docker = join(root, 'docker')
    const compose = join(root, 'compose.generated.yml')
    const parsedCompose = parseYaml(result.compose) as {
        services: { app: { image: string; ports?: unknown[]; volumes?: { type: string; source: string; target: string }[] } }
        volumes?: Record<string, unknown>
    }
    const service = parsedCompose.services.app
    let effectivePort: number | undefined
    let portLeaseProjection: ReturnType<typeof projectPortLeaseResult>
    if ((service.ports?.length ?? 0) > 0) {
        const selected = await selectStateRoot({ platform: 'linux', home: root, cockpitId: cockpitId as never })
        if (selected.kind !== 'complete') throw new Error('port state unavailable')
        const observedAt = new Date().toISOString()
        const lease = await leasePortFamilyFixture({
            namespace: selected.value, stackId,
            holderId: `holder:${'a'.repeat(64)}:session` as HolderId,
            checkoutId: `checkout:${'b'.repeat(64)}` as CheckoutId,
            config: { step: 10, count: 1, bases: { APP_HOST_PORT: 4100 } },
            now: observedAt, listenerTimeoutMs: 1_000,
            listenerEvidence: [{
                ports: [4100],
                observation: { state: 'available', value: [], observedAt, producer: 'generated-port-control' },
            }],
        })
        if (lease.kind !== 'complete') throw new Error(`port lease unavailable: ${JSON.stringify(lease)}`)
        const entrypoints = deriveEntrypoints({ lease: lease.lease, declarations: [] })
        if (entrypoints.kind !== 'complete') throw new Error('port entrypoints unavailable')
        portLeaseProjection = projectPortLeaseResult({ leaseResult: lease, entrypointResult: entrypoints })
        if (!portLeaseProjection) throw new Error('port projection unavailable')
        effectivePort = lease.lease.ports.APP_HOST_PORT!
    }
    const resolvedVolumes = (service.volumes ?? []).map((volume) => volume.type === 'bind'
        ? { ...volume, source: resolve(root, volume.source) }
        : volume)
    const expectedMountSources = resolvedVolumes.filter(({ type }) => type === 'bind').map(({ source }) => source).sort()
    const volumeRegistry = Object.fromEntries(Object.keys(parsedCompose.volumes ?? {}).map((source) => [source, { name: `synthetic_${source}` }]))
    const labels = {
        'dev.b0dea.cockpit.stack-id': stackId, 'dev.b0dea.cockpit.config-sha256': sourceSha256,
        'dev.b0.cockpit.generated': '1', 'dev.b0.cockpit.generation': generation,
        'dev.b0.cockpit.source-sha256': sourceSha256,
    }
    const topologyConfig = {
        services: { app: {
            image: service.image, labels, healthcheck: { test: ['CMD', 'true'] },
            ...(resolvedVolumes.length === 0 ? {} : { volumes: resolvedVolumes }),
            ...(effectivePort === undefined ? {} : { ports: [{ target: 3000, published: String(reportedPort ?? effectivePort) }] }),
        } },
        ...(Object.keys(volumeRegistry).length === 0 ? {} : { volumes: volumeRegistry }),
    }
    await writeFile(docker, `#!${process.execPath}
const args = process.argv.slice(2)
if (args.includes('config')) process.stdout.write(${JSON.stringify(JSON.stringify(topologyConfig))})
else process.exit(7)
`)
    await chmod(docker, 0o700)
    await writeFile(compose, result.compose)
    const executable = { canonicalPath: docker, invocationPath: docker, sha256: createHash('sha256').update(await readFile(docker)).digest('hex'), executionMode: 'staged' as const }
    const canonicalNode = realpathSync(process.execPath)
    const nodeExecutable = { canonicalPath: canonicalNode, invocationPath: process.execPath, sha256: createHash('sha256').update(await readFile(canonicalNode)).digest('hex'), executionMode: 'verified-path' as const }
    const composeSha256 = createHash('sha256').update(result.compose).digest('hex')
    const batchId = 'f'.repeat(64)
    const runtime = createRuntimeAdapter({
        runtime: { name: 'docker', version: '27.1.2', executableSha256: executable.sha256 }, composeVersion: '2.39.2', executable,
        operation: 'validate', cwd: root, composeFiles: [{ reference: 'compose.generated.yml', canonicalPath: compose, source: result.compose, sha256: composeSha256 }],
        projectName: 'synthetic', env: {}, labels: { stackId, configSha256: sourceSha256, batchId }, timeoutMs: 5_000,
        stackId, coldStartLimitMillis: 60_000, expectedMountSources,
        ports: effectivePort === undefined ? [] : [effectivePort],
    }, {
        generatedComposeAuthority: projectGeneratedComposeArtifactAuthority(result)!,
        ...(portLeaseProjection === undefined ? {} : { portLeaseProjection }),
    })
    if (runtime.kind !== 'preview') throw new Error(`runtime preview unavailable: ${JSON.stringify(runtime)}`)
    const topologyPlan = createRuntimeTopologyPlan({
        runtimePlan: runtime.plan, stackId, configSha256: sourceSha256, batchId,
        observationWindow: { startedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    })
    if (topologyPlan.kind !== 'planned') throw new Error(topologyPlan.reason)
    const topologyOutcome = await executeProbe(topologyPlan.step)
    const topology = admitRuntimeTopology({ plan: topologyPlan, outcome: topologyOutcome })
    if (topology.kind !== 'complete') throw new Error(`${topology.reason}: ${JSON.stringify(topologyOutcome)}`)
    const publicEnv: Readonly<Record<string, string>> = effectivePort === undefined ? {} : { APP_HOST_PORT: String(effectivePort) }
    const observationRuntime = { root, executable, composeFiles: [{ path: compose, sha256: composeSha256 }], projectName: 'synthetic', publicEnv, stdoutLimitBytes: 4_096, stderrLimitBytes: 1_024, hostExecutables: { [process.execPath]: nodeExecutable } }
    const authority = projectGeneratedRuntimeAuthority({
        rendered: result, topology: topology.topology,
        runtime: observationRuntime,
    })
    if (!authority) throw new Error('generated runtime authority unavailable')
    return { authority, topology: topology.topology, runtime: observationRuntime }
}

describe('generated environment rendering', () => {
    it('keeps renderer-issued observation expectations immutable', async () => {
        const result = await rendered()
        const observation = result.observations.find(({ id }) => id === 'image:app:manifest')!
        const architectures = observation.expected.architectures as readonly string[]
        const original = [...architectures]
        expect(Reflect.set(architectures, '0', 'synthetic-unsupported')).toBe(false)
        expect(observation.expected.architectures).toEqual(original)
    })

    it('admits one effective Compose port measurement and rejects a mismatched published port', async () => {
        const result = await rendered()
        const observation = result.observations.find(({ kind }) => kind === 'compose-variable')!
        const goodRoot = await mkdtemp(join(tmpdir(), 'cockpit-generated-port-good-'))
        const brokenRoot = await mkdtemp(join(tmpdir(), 'cockpit-generated-port-broken-'))
        try {
            const good = await generatedAuthority(result, goodRoot)
            expect(projectGeneratedRuntimeAuthority({
                rendered: result,
                topology: good.topology,
                runtime: { ...good.runtime, publicEnv: { APP_HOST_PORT: '4200' } },
            })).toBeUndefined()
            const goodExecution = createGeneratedObservationExecution({ authority: good.authority, observation })
            if (goodExecution.kind !== 'planned') throw new Error(goodExecution.reason)
            expect(admitGeneratedObservation({ execution: goodExecution, outcome: await executeProbe(goodExecution.step) }))
                .toMatchObject({ kind: 'complete', id: 'compose-variables' })

            const broken = await generatedAuthority(result, brokenRoot, 4200)
            const brokenExecution = createGeneratedObservationExecution({ authority: broken.authority, observation })
            if (brokenExecution.kind !== 'planned') throw new Error(brokenExecution.reason)
            expect(admitGeneratedObservation({ execution: brokenExecution, outcome: await executeProbe(brokenExecution.step) }))
                .toMatchObject({ kind: 'failed', id: 'compose-variables', reason: expect.stringContaining('ports did not match') })
        } finally {
            await rm(goodRoot, { recursive: true, force: true })
            await rm(brokenRoot, { recursive: true, force: true })
        }
    })

    it('admits only the authentic executor result for one renderer-issued observation', async () => {
        const generated = await declaration()
        generated.vendors = []
        generated.decisions.entries = generated.decisions.entries.filter(({ subject }) => subject !== 'vendor' && subject !== 'port')
        generated.services[0]!.ports = []
        const { service: _service, ...manifestProbe } = generated.services[0]!.image.manifest_probe
        generated.services[0]!.image.manifest_probe = {
            ...manifestProbe,
            location: 'host', cwd: '.',
            argv: [process.execPath, '-e', 'process.exit(0)'],
        }
        const result = renderGeneratedEnvironment({ declaration: generated, ...resolvedInput })
        if (result.kind !== 'complete') throw new Error(result.reason)
        const root = await mkdtemp(join(tmpdir(), 'cockpit-generated-observation-'))
        const observation = result.observations.find(({ id }) => id === 'image:app:manifest')!
        const nodeSha256 = createHash('sha256').update(await readFile(process.execPath)).digest('hex')
        await mkdir(join(root, 'app'), { recursive: true })
        await writeFile(join(root, 'app', '.node-version'), '22.0.0\n')
        const harness = await generatedAuthority(result, root)
        const { authority } = harness
        const envelope = inspectGeneratedRuntimeAuthority(authority)
        expect(envelope).toBeDefined()
        if (!envelope) throw new Error('generated runtime envelope unavailable')
        expect(Reflect.set(envelope.runtime.composeFiles[0]!, 'sha256', 'f'.repeat(64))).toBe(false)
        expect(Reflect.set(envelope.runtime.publicEnv, 'PATH', '/synthetic/untrusted')).toBe(false)
        const execution = createGeneratedObservationExecution({
            authority,
            observation,
        })
        if (execution.kind !== 'planned') throw new Error(execution.reason)
        const outcome = await executeProbe(execution.step)
        const admission = admitGeneratedObservation({ execution, outcome })

        expect(admission).toMatchObject({ kind: 'complete', id: observation.id, target: observation.target, stackId, sourceSha256, generation })
        expect(isGeneratedObservationAdmission(admission)).toBe(true)
        expect(isGeneratedObservationAdmission({ ...admission })).toBe(false)
        const second = renderGeneratedEnvironment({ declaration: generated, ...resolvedInput })
        if (second.kind !== 'complete') throw new Error(second.reason)
        const secondInspection = inspectGeneratedEnvironment({ rendered: second, candidates: second.manifest.map(({ path, bytes }) => ({ path, bytes })), now: '2026-09-26' })
        expect(observeGeneratedEnvironment({ rendered: second, inspection: secondInspection, admissions: [admission!] })).toBeUndefined()
        const inspection = inspectGeneratedEnvironment({ rendered: result, candidates: result.manifest.map(({ path, bytes }) => ({ path, bytes })), now: '2026-09-26' })
        const aggregate = observeGeneratedEnvironment({ rendered: result, inspection, admissions: [admission!] })
        expect(aggregate).toMatchObject({ observed: { state: 'unavailable' }, applicability: { posture: 'generated-environment' } })
        expect(isGeneratedObservation(aggregate)).toBe(true)
        expect(isGeneratedObservation({ ...aggregate! })).toBe(false)
        expect(admitGeneratedObservation({ execution, outcome })).toBeUndefined()
        expect(createGeneratedObservationExecution({ authority: { ...authority }, observation })).toMatchObject({ kind: 'unavailable' })
        expect(observeGeneratedEnvironment({ rendered: result, inspection: { ...inspection }, admissions: [] })).toBeUndefined()
        const staticObservations = result.observations.filter(({ id }) => id === 'mount:app:/workspace/source'
            || id === 'toolchain:app:app/.node-version' || id === 'mount:app:/workspace/.env')
        const staticAdmissions = []
        for (const candidate of staticObservations) {
            const planned = createGeneratedObservationExecution({ authority, observation: candidate })
            if (planned.kind !== 'planned') throw new Error(planned.reason)
            staticAdmissions.push(admitGeneratedObservation({ execution: planned, outcome: await executeProbe(planned.step) }))
        }
        expect(staticAdmissions.map((candidate) => candidate?.kind)).toEqual(['failed', 'complete', 'complete'])
        let nestedEvaluations = 0
        const executableProxy = new Proxy(harness.runtime.executable, { get: () => { nestedEvaluations += 1; throw new Error('must not run') } })
        expect(projectGeneratedRuntimeAuthority({
            rendered: result, topology: harness.topology, runtime: { ...harness.runtime, executable: executableProxy },
        })).toBeUndefined()
        const hostProxy = new Proxy(harness.runtime.hostExecutables[process.execPath]!, { get: () => { nestedEvaluations += 1; throw new Error('must not run') } })
        expect(projectGeneratedRuntimeAuthority({
            rendered: result, topology: harness.topology,
            runtime: { ...harness.runtime, hostExecutables: { [process.execPath]: hostProxy } },
        })).toBeUndefined()
        const accessor = Object.defineProperty({}, 'canonicalPath', { enumerable: true, get: () => { nestedEvaluations += 1; return process.execPath } })
        expect(projectGeneratedRuntimeAuthority({
            rendered: result, topology: harness.topology, runtime: { ...harness.runtime, executable: accessor as never },
        })).toBeUndefined()
        expect(nestedEvaluations).toBe(0)
        const dataOperation = generated.data.modes[0]!.probes[0]!
        const dataStep = resolveGeneratedDataOperation({ authority, operation: dataOperation, context: { id: 'data:empty:probe:0', phase: 'probe' } })
        expect(dataStep).toMatchObject({
            id: 'data:empty:probe:0',
            cwd: root, env: {}, labels: {}, ports: [], compensation: [],
        })
        expect(dataStep?.argv.slice(0, 2)).toEqual([harness.runtime.executable.canonicalPath, 'compose'])
        expect(dataStep?.consumedFiles[1]?.sha256).toBe(result.manifest.find(({ path }) => path === generated.compose_file)?.sha256)
        expect(resolveGeneratedDataOperation({ authority: { ...authority }, operation: dataOperation, context: { id: 'data:empty:probe:0', phase: 'probe' } })).toBeUndefined()
        expect(resolveGeneratedDataOperation({
            authority, operation: { ...dataOperation, argv: [...dataOperation.argv, '--undeclared'] }, context: { id: 'data:empty:probe:0', phase: 'probe' },
        })).toBeUndefined()
        await rm(root, { recursive: true, force: true })
    })

    it('enforces declared service resource ceilings in Compose without inventing limits', async () => {
        const original = await declaration()
        const resources = { memory_mb: 768, cpus: 0.5, provenance: original.services[0]!.provenance }
        const limited = { ...original, services: original.services.map(service => ({ ...service, resources })) }
        const result = renderGeneratedEnvironment({ declaration: limited, ...resolvedInput })
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') throw new Error(result.reason)
        const compose = parseYaml(result.compose)
        expect(compose.services.app).toMatchObject({ mem_limit: '768m', cpus: 0.5 })
        expect(result.decisions).toContain('- Resource ceilings:')
        const unlimited = parseYaml((await rendered()).compose)
        expect(unlimited.services.app).not.toHaveProperty('mem_limit')
        expect(unlimited.services.app).not.toHaveProperty('cpus')
        for (const invalid of [{ ...resources, memory_mb: 0 }, { ...resources, cpus: 0 }, { ...resources, memory_mb: 1.5 }, { ...resources, cpus: Infinity }, { ...resources, cpus: Number.MIN_VALUE }, { ...resources, cpus: Number.MAX_VALUE }, { ...resources, memory_mb: 5 }]) {
            const rejected = renderGeneratedEnvironment({ declaration: { ...limited, services: limited.services.map(service => ({ ...service, resources: invalid })) }, ...resolvedInput })
            expect(rejected.kind).toBe('refusal')
        }
    })

    it('renders and admits the synthetic generated environment', async () => {
        const result = await rendered()
        const again = await rendered()
        expect(again).toEqual(result)
        const reordered = await declaration()
        reordered.services[0]!.mounts.reverse()
        expect(renderGeneratedEnvironment({ declaration: reordered, ...resolvedInput })).toMatchObject({ kind: 'complete', compose: result.compose })
        expect(result.compose).toContain('${APP_HOST_PORT:-4100}:3000')
        expect(result.compose).toContain('node@sha256:83f487e0a63425e5')
        expect(result.compose).toContain("[ -n \"$${MESSAGES_TOKEN:-}\" ] || unset MESSAGES_TOKEN")
        expect(result.compose).toContain("timeout 30s 'node' 'vendor.mjs' 'tls-generate'")
        expect(result.compose.match(/timeout 30s 'node' 'vendor\.mjs' 'tls-generate'/g)).toHaveLength(1)
        expect(result.compose.indexOf("'vendor.mjs' 'tls-generate'")).toBeLessThan(result.compose.indexOf('exec "$$@"'))
        expect(result.compose).not.toContain('ALLOW_MESSAGES_EGRESS')
        expect(result.secretsTemplates['app/.env.example']).toBe('MESSAGES_TOKEN=cockpit:absent:messages\nMESSAGES_URL=https://app:3000/messages\n')
        expect(result.decisions).toContain('- Vendor posture: "stubbed"')
        expect(result.replay).toEqual({ profiles: ['application'], mounts: [
            'app:bind:.:/workspace/source',
            'app:environment-file:app/.env:/workspace/.env',
            'app:volume:dependencies:/workspace/node_modules',
            'app:volume:product-data:/workspace/data',
        ], route: 'generated-compose' })
        const composeAuthority = projectGeneratedComposeArtifactAuthority(result)!
        expect(composeAuthority).toMatchObject({ kind: 'generated-compose-artifact-authority' })

        const root = await mkdtemp(join(tmpdir(), 'cockpit-generated-compose-'))
        try {
            const composePath = join(root, 'compose.yml')
            const absentSource = join(root, 'app', '.env')
            await writeFile(composePath, result.compose)
            await expect(stat(absentSource)).rejects.toMatchObject({ code: 'ENOENT' })
            const native = spawnSync('docker', ['compose', '-f', composePath, '--profile', 'application', 'config', '--format', 'json'], {
                cwd: root,
                ...nativeOptions,
                env: { PATH: process.env.PATH ?? '/usr/bin:/bin', MESSAGES_TOKEN: 'x\" ]; printf injected; #' },
            })
            if (native.error) {
                expect({ kind: 'unavailable', reason: (native.error as NodeJS.ErrnoException).code ?? 'native Compose did not return' }).toMatchObject({ kind: 'unavailable' })
            } else {
                expect(native.status, native.stderr).toBe(0)
                const admitted = JSON.parse(native.stdout) as { services: { app: { entrypoint: string[]; ports: { target: number; published: string }[]; environment: Record<string, string>; labels: Record<string, string> } }; volumes: Record<string, { labels: Record<string, string> }>; networks: { default: { labels: Record<string, string> } } }
                expect(admitted.services.app.ports).toEqual([expect.objectContaining({ target: 3000, published: '4100' })])
                expect(admitted.services.app.environment).toMatchObject({ MESSAGES_URL: 'https://app:3000/messages', MESSAGES_TOKEN: 'cockpit:absent:messages' })
                expect(admitted.services.app.entrypoint[3]).toContain('[ -n "$${MESSAGES_TOKEN:-}" ] || unset MESSAGES_TOKEN')
                expect(admitted.services.app.entrypoint[3]).toContain('exec "$$@"')
                expect(admitted.services.app.entrypoint[3]).not.toContain('printf injected')
                const ownership = { 'dev.b0dea.cockpit.stack-id': stackId, 'dev.b0dea.cockpit.config-sha256': sourceSha256, 'dev.b0dea.cockpit.owner-id': cockpitId, 'dev.b0dea.cockpit.generation-id': generation }
                expect(admitted.services.app.labels).toMatchObject(ownership)
                expect(admitted.volumes.dependencies.labels).toMatchObject(ownership)
                expect(admitted.networks.default.labels).toMatchObject(ownership)
            }
            await expect(stat(absentSource)).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('keeps host publication independent from the container endpoint', async () => {
        const generated = await declaration()
        const first = renderGeneratedEnvironment({ declaration: generated, ...resolvedInput })
        const second = renderGeneratedEnvironment({ declaration: generated, ...resolvedInput, portDefaults: { APP_HOST_PORT: 4200 } })
        expect(first.kind).toBe('complete')
        expect(second.kind).toBe('complete')
        if (first.kind !== 'complete' || second.kind !== 'complete') return
        const firstPort = (parseYaml(first.compose) as { services: { app: { ports: string[] } } }).services.app.ports[0]
        const secondPort = (parseYaml(second.compose) as { services: { app: { ports: string[] } } }).services.app.ports[0]
        expect(firstPort).toBe('${APP_HOST_PORT:-4100}:3000')
        expect(secondPort).toBe('${APP_HOST_PORT:-4200}:3000')
        expect(renderGeneratedEnvironment({ declaration: generated, ...resolvedInput, stackId: 'stack:invalid' })).toMatchObject({ kind: 'refusal', code: 'GENERATED_INPUT_INVALID' })
        const otherConfig = renderGeneratedEnvironment({ declaration: generated, ...resolvedInput, sourceSha256: 'f'.repeat(64) })
        expect(otherConfig.kind).toBe('complete')
        if (otherConfig.kind === 'complete') expect(otherConfig.compose).toContain(`dev.b0dea.cockpit.config-sha256: ${'f'.repeat(64)}`)
    })

    it('parks deterministic one-shot failures and records dependency meaning', async () => {
        const generated = await declaration()
        const job = structuredClone(generated.services[0]!)
        job.id = 'job'
        job.role = 'one-shot'
        job.one_shot_failure = 'park'
        job.profiles = []
        job.command = ['node', '-e', 'process.exit(7)']
        job.ports = []
        job.mounts = []
        job.dependencies = [{ service: 'app', condition: 'service_healthy', reason: 'The job consumes the application route' }]
        job.toolchain_pins = []
        job.image.manifest_probe.service = 'job'
        if (job.image.registry_auth_probe) job.image.registry_auth_probe.service = 'job'
        job.health.probe.service = 'job'
        job.health.tool_probe.service = 'job'
        generated.services.push(job)
        generated.decisions.entries.push({
            ...generated.decisions.entries[0]!, id: 'service-job', subject: 'service', subject_id: 'job',
            decision: 'Run one bounded job', reason: 'The synthetic operation is deterministic',
        })
        const result = renderGeneratedEnvironment({ declaration: generated, ...resolvedInput })
        expect(result.kind).toBe('complete')
        if (result.kind !== 'complete') return
        const compose = parseYaml(result.compose) as { services: { job: { entrypoint: string[]; depends_on: { app: Record<string, unknown> }; profiles?: string[] } } }
        expect(compose.services.job.entrypoint[3]).toContain('parked for inspection')
        expect(compose.services.job.depends_on.app).toEqual({ condition: 'service_healthy', required: true, 'x-cockpit-reason': 'The job consumes the application route' })
        expect(compose.services.job).not.toHaveProperty('profiles')
        expect(result.observations).toContainEqual(expect.objectContaining({
            id: 'startup:job:launcher', kind: 'image-startup-launcher',
            launcher: {
                image: job.image.reference,
                entrypoint: '/bin/sh',
                argv: ['-eu', '-c', 'command -v tail >/dev/null'],
                timeoutSeconds: 30,
            },
            expected: { timeoutExecutable: null, parkExecutable: 'tail' },
        }))
    })

    it('keeps health property, tool availability and unavailable execution distinct', async () => {
        const result = await rendered()
        const generated = await declaration()
        expect(result.observations).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'health:app:property', expected: { service: 'app', role: 'property' } }),
            expect.objectContaining({ id: 'health:app:tool', expected: { service: 'app', role: 'tool-availability' } }),
        ]))
        const image = generated.services[0]!.image.reference
        const present = spawnSync('docker', ['image', 'inspect', image], nativeOptions)
        if (present.error || present.status !== 0) {
            expect({ kind: 'unavailable', reason: 'declared image is not locally available' }).toMatchObject({ kind: 'unavailable' })
        } else {
            const candidate = spawnSync('docker', ['run', '--rm', '--entrypoint', 'node', image, '-e', 'process.exit(0)'], nativeOptions)
            const absentTool = spawnSync('docker', ['run', '--rm', '--entrypoint', 'missing-synthetic-tool', image, '--version'], nativeOptions)
            const brokenProperty = spawnSync('docker', ['run', '--rm', '--entrypoint', 'node', image, '-e', 'process.exit(42)'], nativeOptions)
            expect(candidate.status, candidate.stderr).toBe(0)
            expect(absentTool.status).not.toBe(0)
            expect(brokenProperty.status).toBe(42)
        }
    })

    it('binds ownership, canonical drift and every preflight observation', async () => {
        const result = await rendered()
        const generated = await declaration()
        const candidates = result.manifest.map(({ path, bytes }) => ({ path, bytes }))
        expect(result.manifest.map(({ path, ownership, sourceSha256: source, generation: version }) => ({ path, ownership, source, version }))).toEqual([
            { path: 'app/.env.example', ownership: 'whole-file', source: sourceSha256, version: generation },
            { path: 'compose.generated.yml', ownership: 'whole-file', source: sourceSha256, version: generation },
            { path: 'docs/cockpit/environment-decisions.md', ownership: 'whole-file', source: sourceSha256, version: generation },
        ])
        expect(result.observations.map(({ kind }) => new Set([kind])).length).toBeGreaterThan(0)
        expect(new Set(result.observations.map(({ kind }) => kind))).toEqual(new Set(['mount-lstat', 'registry-auth', 'image-manifest', 'toolchain-pin', 'compose-variable', 'health-probe', 'image-startup-launcher']))
        expect(inspectGeneratedEnvironment({ rendered: result, candidates, now: '2026-09-26' })).toEqual({ kind: 'passed' })

        const drifted = candidates.map((candidate) => candidate.path === 'compose.generated.yml' ? { ...candidate, bytes: `${candidate.bytes}# drift\n` } : candidate)
        expect(inspectGeneratedEnvironment({ rendered: result, candidates: drifted, now: '2026-09-26' })).toMatchObject({ kind: 'refusal', code: 'GENERATED_ARTIFACT_DRIFT', target: 'compose.generated.yml' })
        expect(inspectGeneratedEnvironment({ rendered: result, candidates: [...candidates, { path: 'consumer.yml', bytes: '' }], now: '2026-09-26' })).toMatchObject({ kind: 'refusal', code: 'GENERATED_PATH_UNOWNED' })
        expect(inspectGeneratedEnvironment({ rendered: structuredClone(result), candidates, now: '2026-09-26' })).toMatchObject({ kind: 'refusal', code: 'GENERATED_RENDER_UNAUTHENTICATED' })
        const changedMount = structuredClone(generated)
        changedMount.services[0]!.mounts.find(({ kind }) => kind === 'bind')!.source_type = 'file'
        const changedMountRendered = renderGeneratedEnvironment({ declaration: changedMount, ...resolvedInput })
        expect(changedMountRendered.kind).toBe('complete')
        if (changedMountRendered.kind === 'complete') expect(inspectGeneratedEnvironment({ rendered: changedMountRendered, candidates, now: '2026-09-26' })).toMatchObject({ kind: 'refusal', code: 'GENERATED_ARTIFACT_DRIFT', target: 'compose.generated.yml' })
        const auth = result.observations.find(({ kind }) => kind === 'registry-auth')
        expect(auth?.expected).toEqual({ requirement: 'build-time-only', credentialValues: 'excluded' })
        const toolchain = result.observations.find(({ kind }) => kind === 'toolchain-pin')
        expect(toolchain?.expected).toMatchObject({ action: 'diagnose-only' })
    })

    it('rejects incomplete, duplicate, stale, future, sensitive and divergent decision logs', async () => {
        const result = await rendered()
        const generated = await declaration()
        const candidates = result.manifest.map(({ path, bytes }) => ({ path, bytes }))
        const replaceDecision = (mutate: (bytes: string) => string) => candidates.map((candidate) => candidate.path === generated.decisions.path ? { ...candidate, bytes: mutate(candidate.bytes) } : candidate)
        const inspect = (candidateFiles: typeof candidates, now = '2026-09-26') => inspectGeneratedEnvironment({ rendered: result, candidates: candidateFiles, now })

        expect(inspect(replaceDecision((bytes) => bytes.replace(/^## vendor:messages[\s\S]*$/m, '')))).toMatchObject({ kind: 'refusal', code: 'GENERATED_DECISION_COVERAGE' })
        expect(inspect(replaceDecision((bytes) => `${bytes}\n## vendor:messages\n`))).toMatchObject({ kind: 'refusal', code: 'GENERATED_DECISION_DUPLICATE' })
        const duplicateDeclaration = structuredClone(generated)
        duplicateDeclaration.decisions.entries.push({ ...duplicateDeclaration.decisions.entries[0], id: 'other-id' })
        expect(renderGeneratedEnvironment({ declaration: duplicateDeclaration, ...resolvedInput })).toMatchObject({ kind: 'refusal', code: 'GENERATED_DECLARATION_INVALID' })
        const stale = structuredClone(generated)
        stale.decisions.entries[0]!.decided_on = '2024-01-01'
        const staleRendered = renderGeneratedEnvironment({ declaration: stale, ...resolvedInput })
        expect(staleRendered.kind).toBe('complete')
        if (staleRendered.kind === 'complete') expect(inspectGeneratedEnvironment({ rendered: staleRendered, candidates: staleRendered.manifest.map(({ path, bytes }) => ({ path, bytes })), now: '2026-09-26' })).toMatchObject({ kind: 'refusal', code: 'GENERATED_DECISION_STALE' })
        const future = structuredClone(generated)
        future.decisions.entries[0]!.decided_on = '2027-01-01'
        const futureRendered = renderGeneratedEnvironment({ declaration: future, ...resolvedInput })
        expect(futureRendered.kind).toBe('complete')
        if (futureRendered.kind === 'complete') expect(inspectGeneratedEnvironment({ rendered: futureRendered, candidates: futureRendered.manifest.map(({ path, bytes }) => ({ path, bytes })), now: '2026-09-26' })).toMatchObject({ kind: 'refusal', code: 'GENERATED_DECISION_FUTURE' })
        const sensitive = structuredClone(generated)
        sensitive.decisions.entries[0]!.reason = '-----BEGIN PRIVATE KEY-----'
        const sensitiveRendered = renderGeneratedEnvironment({ declaration: sensitive, ...resolvedInput })
        expect(sensitiveRendered.kind).toBe('complete')
        if (sensitiveRendered.kind === 'complete') expect(inspectGeneratedEnvironment({ rendered: sensitiveRendered, candidates: sensitiveRendered.manifest.map(({ path, bytes }) => ({ path, bytes })), now: '2026-09-26' })).toMatchObject({ kind: 'refusal', code: 'GENERATED_DECISION_SENSITIVE' })
        const quotedSensitive = structuredClone(generated)
        quotedSensitive.decisions.entries[0]!.reason = 'recorded response {"credential":"synthetic-canary"}'
        const quotedSensitiveRendered = renderGeneratedEnvironment({ declaration: quotedSensitive, ...resolvedInput })
        expect(quotedSensitiveRendered.kind).toBe('complete')
        if (quotedSensitiveRendered.kind === 'complete') expect(inspectGeneratedEnvironment({ rendered: quotedSensitiveRendered, candidates: quotedSensitiveRendered.manifest.map(({ path, bytes }) => ({ path, bytes })), now: '2026-09-26' })).toMatchObject({ kind: 'refusal', code: 'GENERATED_DECISION_SENSITIVE' })
    })

    it('refuses malformed declarations, aliases and missing literal port defaults', async () => {
        const generated = await declaration()
        expect(renderGeneratedEnvironment({ declaration: generated, ...resolvedInput, portDefaults: {} })).toMatchObject({ kind: 'refusal', code: 'GENERATED_TEMPLATE_INVALID' })
        expect(renderGeneratedEnvironment({ declaration: generated, ...resolvedInput, siblingDirectories: {} })).toMatchObject({ kind: 'refusal', code: 'GENERATED_TEMPLATE_INVALID' })
        generated.vendors[0]!.nonempty_variables = ['MESSAGES_URL']
        expect(renderGeneratedEnvironment({ declaration: generated, ...resolvedInput })).toMatchObject({ kind: 'refusal', code: 'GENERATED_DECLARATION_INVALID' })
    })

    it('rejects proxies and accessors without evaluating caller code', async () => {
        let evaluated = 0
        const accessor = Object.defineProperty({}, 'declaration', { enumerable: true, get: () => { evaluated += 1; throw new Error('must not run') } })
        expect(renderGeneratedEnvironment(accessor as never)).toMatchObject({ kind: 'refusal', code: 'GENERATED_INPUT_INVALID' })
        const proxy = new Proxy({}, { get: () => { evaluated += 1; throw new Error('must not run') } })
        expect(renderGeneratedEnvironment(proxy as never)).toMatchObject({ kind: 'refusal', code: 'GENERATED_INPUT_INVALID' })

        const result = await rendered()
        const candidate = Object.defineProperty({}, 'path', { enumerable: true, get: () => { evaluated += 1; throw new Error('must not run') } })
        expect(inspectGeneratedEnvironment({ rendered: result, candidates: [candidate as never], now: '2026-09-26' })).toMatchObject({ kind: 'refusal', code: 'GENERATED_INSPECTION_INVALID' })
        expect(inspectGeneratedEnvironment(new Proxy({}, { get: () => { evaluated += 1; throw new Error('must not run') } }) as never)).toMatchObject({ kind: 'refusal', code: 'GENERATED_INSPECTION_INVALID' })
        expect(evaluated).toBe(0)
    })

    it('bounds captured input by UTF-8 bytes', async () => {
        const generated = await declaration()
        expect(renderGeneratedEnvironment({
            declaration: generated,
            ...resolvedInput,
            siblingDirectories: { app: '\u20ac'.repeat(11_184_811) },
        })).toMatchObject({ kind: 'refusal', code: 'GENERATED_INPUT_INVALID' })
    })

    it('loads the committed synthetic fixture bytes', async () => {
        expect((await readFile(fixturePath, 'utf8')).length).toBeGreaterThan(1_000)
        expect((await declaration()).compose_file).toBe('compose.generated.yml')
    })
})
