import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { loadCockpitConfig } from '../config/load.js'
import { GeneratedEnvironment } from '../schema.js'
import type { ExecutionStep, StackId } from './contract.js'
import type { ResolvedExecutable } from './executable.js'
import { externalDependencyTemplateFragments } from './templates.js'
import { isExternalDependencyObservation, isExternalDependencyObservationProjection, observeExternalDependencies, observeExternalDependency, planExternalDependency, projectExternalDependencyProgress, verifyExternalDependency } from './external-dependencies.js'
import { projectGeneratedRuntimeAuthority, renderGeneratedEnvironment } from './generated-stack.js'
import {
    admitRuntimeServiceHealth,
    admitRuntimeServiceObservation,
    admitRuntimeServiceStageOutcome,
    admitRuntimeTopology,
    createRuntimeAdapter,
    createRuntimeServiceHealthPlan,
    createRuntimeServicePlan,
    createRuntimeTopologyPlan,
} from './runtime.js'

const scratch: string[] = []

function workspace(): string {
    const path = mkdtempSync(join(tmpdir(), 'cockpit-external-dependency-'))
    scratch.push(path)
    return path
}

afterEach(() => {
    vi.useRealTimers()
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

function executable(path: string): ResolvedExecutable {
    return { canonicalPath: path, invocationPath: path, sha256: createHash('sha256').update(requireBytes(path)).digest('hex'), executionMode: 'staged' }
}

function requireBytes(path: string): Buffer {
    return readFileSync(path)
}

function operation(argv: readonly [string, ...string[]], service = 'app') {
    return {
        location: 'in-stack' as const,
        service,
        cwd: '.',
        argv,
        timeout_seconds: 5,
        provenance: { source: 'overlay.toml', observed_on: '2026-09-26', kind: 'declared' as const, reason: 'synthetic product verifier' },
    }
}

function vendor(posture: 'bypassed' | 'stubbed' | 'substituted' | 'vendor-sandbox' | 'record-replay' | 'absent-and-gated' = 'stubbed') {
    const probe = (mode: string) => operation(['node', 'verifier.mjs', mode])
    const route = posture === 'bypassed'
        ? operation(['node', 'verifier.mjs', 'bypass-placeholder', 'cockpit:absent:mailer'])
        : posture === 'record-replay' ? probe('record-replay') : posture === 'absent-and-gated' ? probe('absent-gated') : probe('route')
    return {
        id: 'mailer', posture, reason: `synthetic ${posture} boundary`,
        provenance: { source: 'overlay.toml', observed_on: '2026-09-26', kind: 'declared' as const, reason: 'fixture' },
        endpoints: [{ variable: 'MAILER_URL', sink: 'http://app:4010/api', runtime_service: 'app', supplier: { sibling: 'web', template: '.env.example' } }],
        loader_probe: probe('loader'), route_probe: route, egress_probe: probe('egress'),
        normalize_empty: true as const, placeholder: 'cockpit:absent:mailer',
        shadow_files: [{ sibling: 'web', instance: '.env', probe: probe('shadow') }],
        callback_reachability: { reachable: false, alternative: 'recorded local capture', reason: 'no public callback route' },
        ...(posture === 'vendor-sandbox' ? { expiry: { expires_on: '2026-12-31', reason: 'fixed synthetic account window', probe: probe('expiry') } } : {}),
        ...(posture === 'stubbed' ? { stub: { validates: ['required envelope'], rejection_probe: probe('stub-rejection'), outage_probe: probe('stub-outage') } } : {}),
    }
}

function protocolVendor(controlMode = 'callback-controls') {
    return {
        ...vendor(),
        callback_reachability: { reachable: true, alternative: 'local receiver', reason: 'synthetic route' },
        callback: {
            feature_flag: 'LOCAL_CALLBACKS', enable: operation(['node', 'verifier.mjs', 'callback-enable']), timestamp_source: operation(['node', 'verifier.mjs', 'callback-timestamp']),
            fresh_window_seconds: 60, fixture: { path: 'fixtures/callback.bin', sha256: createHash('sha256').update('{"event":"created","value":1}\n').digest('hex'), immutable_raw_bytes: true as const },
            sign: operation(['node', 'verifier.mjs', 'callback-sign']), dispatch: operation(['node', 'verifier.mjs', 'callback-dispatch']),
            order: ['enable', 'timestamp', 'sign', 'dispatch'] as const, verifier_source: 'src/callback-verifier.ts', tamper_probe: operation(['node', 'verifier.mjs', controlMode]),
        },
        tls: { generate_at_start: operation(['node', 'verifier.mjs', 'tls-generate']), append_trust_probe: operation(['node', 'verifier.mjs', 'tls-trust']), hostname_probe: operation(['node', 'verifier.mjs', 'tls-hostname']), verification: 'required' as const },
    }
}

function harness(root: string) {
    const docker = join(root, 'docker')
    const compose = join(root, 'compose.generated.yml')
    const verifier = join(root, 'verifier.mjs')
    mkdirSync(join(root, 'fixtures'), { recursive: true })
    writeFileSync(join(root, 'fixtures/callback.bin'), '{"event":"created","value":1}\n')
    writeFileSync(docker, '#!/bin/sh\nwhile [ "$1" != "exec" ]; do shift; done\nshift\n[ "$1" = "--workdir" ] && shift 2\n[ "$1" = "-T" ] && shift\nshift\nexec "$@"\n')
    chmodSync(docker, 0o700)
    writeFileSync(compose, 'services: {}\n')
    writeFileSync(verifier, `
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const mode = process.argv[2]
const statePath = '.external-probe-state.json'
const read = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { key: randomBytes(32).toString('hex'), deliveries: [] }
const write = (state) => writeFileSync(statePath, JSON.stringify(state))
const raw = Buffer.from('{"event":"created","value":1}\\n')
const signature = (state, timestamp, bytes) => createHmac('sha256', Buffer.from(state.key, 'hex')).update(String(timestamp)).update(bytes).digest('hex')
let state = read()
let ok = ['loader', 'route', 'shadow', 'egress', 'expiry', 'absent-gated'].includes(mode)
if (mode === 'bypass-placeholder') ok = process.argv[3] === 'cockpit:absent:mailer'
if (mode === 'record-replay') { state.capture = raw.toString('base64'); write(state); ok = Buffer.from(state.capture, 'base64').equals(raw) }
if (mode === 'callback-enable') { state.enabled = true; write(state); ok = true }
if (mode === 'callback-timestamp') { ok = state.enabled === true; if (ok) { state.timestamp = Date.now(); write(state) } }
if (mode === 'callback-sign') { ok = Number.isSafeInteger(state.timestamp) && Date.now() - state.timestamp < 60_000; if (ok) { state.signature = signature(state, state.timestamp, raw); write(state) } }
if (mode === 'callback-dispatch') { ok = state.enabled === true && state.signature === signature(state, state.timestamp, raw) && Date.now() - state.timestamp < 60_000 && !state.deliveries.includes(state.signature); if (ok) { state.deliveries.push(state.signature); write(state) } }
if (mode === 'callback-controls') {
  const altered = Buffer.from('{ "event": "created", "value": 1 }\\n')
  const stale = Date.now() - 120_000
  const candidateRejectsStale = Date.now() - stale >= 60_000
  const candidateRejectsReplay = state.deliveries.includes(state.signature)
  const candidateRejectsAltered = state.signature !== signature(state, state.timestamp, altered)
  const earlySuccessTrapAccepts = 200 === 200
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(altered.toString())))
  const reserializedTrapAccepts = signature(state, state.timestamp, reserialized) === signature(state, state.timestamp, Buffer.from(JSON.stringify(JSON.parse(raw.toString()))))
  ok = candidateRejectsStale && candidateRejectsReplay && candidateRejectsAltered && earlySuccessTrapAccepts && reserializedTrapAccepts
}
if (mode === 'tls-generate') { state.ca = randomBytes(24).toString('hex'); write(state); ok = true }
if (mode === 'tls-trust') ok = typeof state.ca === 'string' && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0'
if (mode === 'tls-hostname') ok = typeof state.ca === 'string'
if (mode === 'stub-rejection') { state.rejectedInvalidEnvelope = true; write(state); ok = true }
if (mode === 'stub-outage') ok = state.rejectedInvalidEnvelope === true
if (mode === 'fail') ok = false
process.exit(ok ? 0 : 7)
`)
    return {
        root,
        executable: executable(docker),
        composeFiles: [{ path: compose, sha256: createHash('sha256').update('services: {}\n').digest('hex') }],
        projectName: 'synthetic-stack',
        publicEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdoutLimitBytes: 4096, stderrLimitBytes: 4096,
    }
}

async function authoritativeHarness(root: string, vendors = [vendor()]) {
    const runtime = harness(root)
    const stack = `stack:${createHash('sha256').update('synthetic stack').digest('hex')}` as StackId
    const configSha256 = createHash('sha256').update('synthetic configuration').digest('hex')
    const generation = '9'.repeat(64)
    const cockpitId = `cockpit:external-dependency:${'e'.repeat(64)}`
    const batchId = createHash('sha256').update('synthetic batch').digest('hex')
    const containerId = createHash('sha256').update('synthetic backend container').digest('hex')
    const requiresGuard = vendors.some((item) => 'egress_guard' in item && item.egress_guard !== undefined)
    const docker = runtime.executable.canonicalPath
    const labels = {
        'com.docker.compose.project': 'synthetic-stack',
        'com.docker.compose.service': 'app',
        'dev.b0dea.cockpit.stack-id': stack,
        'dev.b0dea.cockpit.config-sha256': configSha256,
        'dev.b0.cockpit.generated': '1',
        'dev.b0.cockpit.generation': generation,
        'dev.b0.cockpit.source-sha256': configSha256,
    }
    const loaded = await loadCockpitConfig(resolve('fixtures/registries/generated-environment.toml'))
    if (loaded.kind !== 'complete' || !loaded.result.config.environment.generated) throw new Error('generated fixture unavailable')
    const declaration = structuredClone(loaded.result.config.environment.generated)
    declaration.vendors = structuredClone(vendors) as unknown as typeof declaration.vendors
    declaration.services[0]!.ports = []
    const vendorDecision = declaration.decisions.entries.find(({ subject }) => subject === 'vendor')
    declaration.decisions.entries = [
        ...declaration.decisions.entries.filter(({ subject }) => subject !== 'vendor' && subject !== 'port'),
        ...vendors.map((item, index) => ({
            ...(vendorDecision ?? declaration.decisions.entries[0]!), id: `vendor-${index}`, subject: 'vendor' as const, subject_id: item.id,
        })),
    ]
    const parsedDeclaration = GeneratedEnvironment.safeParse(declaration)
    if (!parsedDeclaration.success) throw new Error(parsedDeclaration.error.message)
    const rendered = renderGeneratedEnvironment({
        declaration, sourceSha256: configSha256, generation, stackId: stack,
        cockpitId, portDefaults: { APP_HOST_PORT: 4100 }, siblingDirectories: { app: 'app', web: 'web' },
    })
    if (rendered.kind !== 'complete') throw new Error(rendered.reason)
    const parsedCompose = parseYaml(rendered.compose) as {
        services: { app: { image: string; volumes?: { type: string; source: string; target: string }[] } }
        volumes?: Record<string, unknown>
    }
    const service = parsedCompose.services.app
    const resolvedVolumes = (service.volumes ?? []).map((volume) => volume.type === 'bind'
        ? { ...volume, source: resolve(root, volume.source) }
        : volume)
    const expectedMountSources = resolvedVolumes.filter(({ type }) => type === 'bind').map(({ source }) => source).sort()
    const volumeRegistry = Object.fromEntries(Object.keys(parsedCompose.volumes ?? {}).map((source) => [source, { name: `synthetic_${source}` }]))
    const inspectedMounts = resolvedVolumes.filter(({ type }) => type === 'bind').map(({ source, target }) => ({
        Type: 'bind', Source: source, Destination: target,
    }))
    writeFileSync(docker, `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const stopped = existsSync('.backend-stopped')
const labels = ${JSON.stringify(labels)}
const mounts = ${JSON.stringify(inspectedMounts)}
const container = ${JSON.stringify({ ID: containerId, Name: 'synthetic-app-1', Project: 'synthetic-stack', Service: 'app', State: 'running', Health: 'healthy', ExitCode: 0 })}
if (args.includes('config') && args.includes('--no-env-resolution')) {
  process.stdout.write(readFileSync('topology.yml', 'utf8'))
} else if (args.includes('--progress') && args.includes('up')) {
  process.exit(0)
} else if (args.includes('ps') && args.includes('--format') && args.includes('json')) {
  if (!stopped) process.stdout.write(JSON.stringify({ ...container, ID: container.ID.slice(0, 12), Labels: Object.entries(labels).map(([key, value]) => key + '=' + value).join(',') }))
} else if (args.includes('ps') && args.includes('--quiet')) {
  if (!stopped) process.stdout.write(container.ID + '\\n')
} else if (args.includes('inspect')) {
  if (!stopped) process.stdout.write(JSON.stringify({ ID: container.ID, State: container.State, Health: container.Health, Labels: labels, Mounts: mounts, Ports: {} }))
  else process.exitCode = 7
} else if (args.includes('exec')) {
  const execIndex = args.indexOf('exec')
  let cursor = execIndex + 1
  let guarded = false
  if (args[cursor] === '--env') {
    guarded = args[cursor + 1] === 'ALLOW_SYNTHETIC_BACKEND=1'
    cursor += 2
  }
  if (args[cursor] === '--workdir') cursor += 2
  if (args[cursor] === '-T') cursor += 1
  cursor += 1
  const mode = args.at(-1)
  if (mode === 'egress' && ${JSON.stringify(requiresGuard)} && !guarded) process.exit(9)
  const result = spawnSync(args[cursor], args.slice(cursor + 1), { stdio: 'inherit', env: process.env })
  process.exit(result.status ?? 8)
} else process.exit(7)
`)
    chmodSync(docker, 0o700)
    const composePath = runtime.composeFiles[0]!.path
    const topologyPath = join(root, 'topology.yml')
    const topologySource = JSON.stringify({
        services: { app: { image: service.image, labels, healthcheck: { test: ['CMD', 'true'] }, volumes: resolvedVolumes } },
        volumes: volumeRegistry,
    })
    writeFileSync(topologyPath, topologySource)
    const runtimeExecutable = executable(docker)
    const compose = { path: composePath, sha256: createHash('sha256').update(rendered.compose).digest('hex') }
    const adapter = createRuntimeAdapter({
        runtime: { name: 'docker', version: '27.1.2', executableSha256: runtimeExecutable.sha256 },
        composeVersion: '2.39.2', executable: runtimeExecutable, operation: 'validate', cwd: root,
        composeFiles: [{ reference: 'topology.yml', canonicalPath: topologyPath, source: topologySource, sha256: createHash('sha256').update(topologySource).digest('hex') }],
        projectName: 'synthetic-stack', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, ports: [],
        labels: { stackId: stack, configSha256, batchId }, timeoutMs: 5_000,
        stackId: stack, coldStartLimitMillis: 60_000, expectedMountSources,
    })
    if (adapter.kind !== 'preview') throw new Error(`runtime adapter fixture unavailable: ${JSON.stringify(adapter)}`)
    const window = { startedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }
    const topologyPlan = createRuntimeTopologyPlan({ runtimePlan: adapter.plan, stackId: stack, configSha256, batchId, observationWindow: window })
    if (topologyPlan.kind !== 'planned') throw new Error(topologyPlan.reason)
    const admittedTopology = admitRuntimeTopology({ plan: topologyPlan, outcome: await executeProbe(topologyPlan.step) })
    if (admittedTopology.kind !== 'complete') throw new Error(admittedTopology.reason)
    const servicePlan = createRuntimeServicePlan({ topology: admittedTopology.topology, service: 'app' })
    if (servicePlan.kind !== 'planned') throw new Error(servicePlan.reason)
    const startOutcome = await executeProbe(servicePlan.start)
    if (admitRuntimeServiceStageOutcome({ plan: servicePlan, stage: 'start', outcome: startOutcome }).kind !== 'admitted') throw new Error('runtime start fixture unavailable')
    const statusOutcome = await executeProbe(servicePlan.status)
    if (admitRuntimeServiceStageOutcome({ plan: servicePlan, stage: 'status', outcome: statusOutcome, startOutcome }).kind !== 'admitted') throw new Error('runtime status fixture unavailable')
    const identityOutcome = await executeProbe(servicePlan.identity)
    if (admitRuntimeServiceStageOutcome({ plan: servicePlan, stage: 'identity', outcome: identityOutcome, startOutcome, statusOutcome }).kind !== 'admitted') throw new Error('runtime identity fixture unavailable')
    const healthPlan = createRuntimeServiceHealthPlan({ plan: servicePlan, startOutcome, outcome: statusOutcome, identityOutcome })
    if (healthPlan.kind !== 'planned') throw new Error(healthPlan.reason)
    const observed = admitRuntimeServiceObservation({ plan: healthPlan, outcome: await executeProbe(healthPlan.step) })
    if (observed.kind !== 'complete') throw new Error(observed.reason)
    const health = admitRuntimeServiceHealth({ observation: observed.observation })
    if (health.kind !== 'complete') throw new Error(health.reason)
    writeFileSync(composePath, rendered.compose)
    mkdirSync(join(root, 'app'), { recursive: true })
    const siblingIdentity = statSync(join(root, 'app'))
    const hostInputRoots = { app: { path: join(root, 'app'), dev: siblingIdentity.dev, ino: siblingIdentity.ino } }
    const generatedAuthority = projectGeneratedRuntimeAuthority({
        hostInputRoots, rendered, topology: admittedTopology.topology,
        runtime: { ...runtime, publicEnv: { ...runtime.publicEnv, COCKPIT_OWNER_ID: cockpitId, COCKPIT_STACK_ID: stack },
            executable: runtimeExecutable, composeFiles: [compose], projectName: 'synthetic-stack', serviceAuthority: { topology: admittedTopology.topology, evidence: health.evidence } },
    })
    if (!generatedAuthority) throw new Error('generated runtime authority unavailable')
    const authorityRuntime = {
        ...runtime,
        publicEnv: { ...runtime.publicEnv, COCKPIT_OWNER_ID: cockpitId, COCKPIT_STACK_ID: stack },
        executable: runtimeExecutable,
        composeFiles: [compose],
        projectName: 'synthetic-stack',
        serviceAuthority: { topology: admittedTopology.topology, evidence: health.evidence },
    }
    return { ...authorityRuntime, generatedAuthority,
        authoritySource: { hostInputRoots, rendered, topology: admittedTopology.topology, runtime: authorityRuntime } }
}

describe('external dependency boundary', () => {
    it('pins a stubbed dependency through both suppliers and product loader', async () => {
        const root = workspace()
        const declaration = vendor()
        const runtime = await authoritativeHarness(root, [declaration])
        const fragments = externalDependencyTemplateFragments(declaration)
        const planned = planExternalDependency({ authority: runtime.generatedAuthority, declaration, fragments, runtime, observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        expect(planned.kind).toBe('complete')
        expect(planned).toMatchObject({ dependency: { id: 'mailer', posture: 'stubbed', measurement: 'pending' } })
        if (planned.kind !== 'complete') return
        const composeSteps = planned.steps.filter(({ step }) => step.argv[1] === 'compose')
        expect(composeSteps.length).toBeGreaterThan(0)
        for (const { step } of composeSteps) expect(step.env.COMPOSE_DISABLE_ENV_FILE).toBe('1')

        const result = await verifyExternalDependency(planned, { execute: executeProbe })
        expect(result.kind, JSON.stringify(result)).toBe('complete')
        expect(result).toMatchObject({ dependency: { id: 'mailer', posture: 'stubbed', measurement: 'measured' } })
        const healthPlan = planExternalDependency({ purpose: 'health', authority: runtime.generatedAuthority, declaration, fragments, runtime, observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        if (healthPlan.kind !== 'complete') throw new Error(JSON.stringify(healthPlan))
        expect(healthPlan.steps.map(({ role }) => role)).toEqual(['loader', 'route', 'shadow:web:.env', 'egress'])
        const health = await verifyExternalDependency(healthPlan, { execute: executeProbe })
        const observation = observeExternalDependency({ evidence: health, authority: runtime.generatedAuthority })
        expect(observation).toMatchObject({ state: 'available', dependency: { id: 'mailer' } })
        const expectedObservation = {
            stackId: observation!.stackId,
            sourceSha256: runtime.authoritySource.rendered.manifest[0]!.sourceSha256,
            generation: runtime.authoritySource.rendered.manifest[0]!.generation,
            purpose: 'health' as const,
            dependencyId: 'mailer',
        }
        expect(isExternalDependencyObservationProjection(observation)).toBe(true)
        expect(isExternalDependencyObservationProjection(observation, expectedObservation)).toBe(true)
        expect(isExternalDependencyObservationProjection(observation, { ...expectedObservation, stackId: `stack:${'1'.repeat(64)}` as StackId })).toBe(false)
        expect(isExternalDependencyObservationProjection(observation, { ...expectedObservation, sourceSha256: '1'.repeat(64) })).toBe(false)
        expect(isExternalDependencyObservationProjection(observation, { ...expectedObservation, generation: '1'.repeat(64) })).toBe(false)
        expect(isExternalDependencyObservationProjection(observation, { ...expectedObservation, purpose: 'startup' })).toBe(false)
        expect(isExternalDependencyObservationProjection(observation, { ...expectedObservation, dependencyId: 'payments' })).toBe(false)
        expect(isExternalDependencyObservationProjection({ ...observation })).toBe(false)
        expect(isExternalDependencyObservationProjection({ ...observation }, expectedObservation)).toBe(false)
        let expectationReads = 0
        const accessorExpectation = { ...expectedObservation }
        Object.defineProperty(accessorExpectation, 'dependencyId', { enumerable: true, get: () => { expectationReads += 1; return 'mailer' } })
        expect(isExternalDependencyObservationProjection(observation, accessorExpectation)).toBe(false)
        expect(isExternalDependencyObservationProjection(observation, new Proxy(expectedObservation, {
            ownKeys: () => { expectationReads += 1; throw new Error('must not run') },
        }))).toBe(false)
        expect(isExternalDependencyObservationProjection(observation, { ...expectedObservation, extra: true } as typeof expectedObservation)).toBe(false)
        expect(expectationReads).toBe(0)
        let proxyEvaluations = 0
        const proxyInput = new Proxy({ evidence: health, authority: runtime.generatedAuthority }, {
            ownKeys: () => { proxyEvaluations += 1; throw new Error('must not run') },
        })
        expect(observeExternalDependency(proxyInput)).toBeUndefined()
        expect(observeExternalDependencies(new Proxy({
            authority: runtime.generatedAuthority, purpose: 'health' as const, observations: [observation!],
        }, { ownKeys: () => { proxyEvaluations += 1; throw new Error('must not run') } }))).toBeUndefined()
        expect(proxyEvaluations).toBe(0)
        const replacement = await authoritativeHarness(workspace(), [declaration])
        expect(observeExternalDependencies({ authority: replacement.generatedAuthority, purpose: 'health', observations: [observation!] })).toBeUndefined()
        expect(observeExternalDependencies({ authority: runtime.generatedAuthority, purpose: 'startup', observations: [observation!] })).toBeUndefined()
        const reissued = projectGeneratedRuntimeAuthority(runtime.authoritySource)
        expect(reissued).toBeDefined()
        const aggregate = observeExternalDependencies({ authority: reissued!, purpose: 'health', observations: [observation!] })
        expect(aggregate).toMatchObject({ observed: { state: 'available' }, applicability: { posture: 'external-dependencies' } })
        expect(isExternalDependencyObservation(aggregate)).toBe(true)
        expect(isExternalDependencyObservation(aggregate, 'health')).toBe(true)
        expect(isExternalDependencyObservation(aggregate, 'startup')).toBe(false)
        expect(isExternalDependencyObservation({ ...aggregate! })).toBe(false)
        expect(observeExternalDependency({ evidence: result, authority: runtime.generatedAuthority })).toMatchObject({ state: 'available' })
        expect(planned.steps.map(({ role }) => role)).toEqual(['loader', 'route', 'shadow:web:.env', 'egress', 'stub-rejection', 'stub-outage'])
        expect(JSON.stringify({ planned, result })).not.toMatch(/secret|credential/i)
    })

    it('requires one current authenticated observation for every configured dependency', async () => {
        const root = workspace()
        const mailer = vendor('bypassed')
        const search = {
            ...vendor('bypassed'), id: 'search', placeholder: 'cockpit:absent:search',
            endpoints: [{ variable: 'SEARCH_URL', sink: 'http://app:4020/api', runtime_service: 'app', supplier: { sibling: 'web', template: '.env.example' } }],
        }
        const runtime = await authoritativeHarness(root, [mailer, search])
        const observations = []
        for (const declaration of [mailer, search]) {
            const plan = planExternalDependency({
                purpose: 'health', authority: runtime.generatedAuthority, declaration,
                fragments: externalDependencyTemplateFragments(declaration), runtime,
                observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }],
            })
            if (plan.kind !== 'complete') throw new Error(JSON.stringify(plan))
            const evidence = await verifyExternalDependency(plan, { execute: executeProbe })
            const observation = observeExternalDependency({ evidence, authority: runtime.generatedAuthority })
            if (!observation) throw new Error('external observation unavailable')
            observations.push(observation)
        }
        expect(observeExternalDependencies({ authority: runtime.generatedAuthority, purpose: 'health', observations: observations.slice(0, 1) })).toBeUndefined()
        expect(observeExternalDependencies({ authority: runtime.generatedAuthority, purpose: 'health', observations })).toMatchObject({ observed: { state: 'available' } })
    })

    it.each(['bypassed', 'stubbed', 'substituted', 'vendor-sandbox', 'record-replay', 'absent-and-gated'] as const)(
        'reports the %s posture with its reason and measured state', async (posture) => {
            const root = workspace()
            const declaration = vendor(posture)
            const planned = planExternalDependency({ declaration, fragments: externalDependencyTemplateFragments(declaration), runtime: harness(root), observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
            expect(planned.kind).toBe('complete')
            if (planned.kind !== 'complete') return
            await expect(verifyExternalDependency(planned, { execute: executeProbe })).resolves.toMatchObject({ dependency: { posture, reason: `synthetic ${posture} boundary`, measurement: 'measured' } })
            expect(planned.dependency.callback).toEqual({ reachable: false, alternative: 'recorded local capture', reason: 'no public callback route' })
        },
    )

    it('runs callback, TLS, and stub controls in the declared safety order', async () => {
        const root = workspace()
        const declaration = protocolVendor()
        const planned = planExternalDependency({ declaration, fragments: externalDependencyTemplateFragments(declaration), runtime: harness(root), observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        expect(planned.kind).toBe('complete')
        if (planned.kind !== 'complete') return
        expect(planned.steps.map(({ role }) => role)).toEqual([
            'tls-generate', 'tls-trust', 'tls-hostname', 'loader', 'route', 'shadow:web:.env', 'egress',
            'callback-enable', 'callback-timestamp', 'callback-sign', 'callback-dispatch', 'callback-controls', 'stub-rejection', 'stub-outage',
        ])
        const verified = await verifyExternalDependency(planned, { execute: executeProbe })
        expect(verified.kind, JSON.stringify(verified)).toBe('complete')
    })

    it('refuses when the callback verifier does not reject its broken controls', async () => {
        const root = workspace()
        const declaration = protocolVendor('fail')
        const planned = planExternalDependency({ declaration, fragments: externalDependencyTemplateFragments(declaration), runtime: harness(root), observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        expect(planned.kind, JSON.stringify(planned)).toBe('complete')
        if (planned.kind !== 'complete') return
        await expect(verifyExternalDependency(planned, { execute: executeProbe })).resolves.toMatchObject({ kind: 'refusal', failedRole: 'callback-controls' })
    })

    it('refuses expired sandboxes, missing shadows, mismatched pins, and unavailable declarations', () => {
        const root = workspace()
        const sandbox = vendor('vendor-sandbox')
        vi.useFakeTimers()
        vi.setSystemTime('2027-01-01T00:00:00.000Z')
        expect(planExternalDependency({ declaration: sandbox, fragments: externalDependencyTemplateFragments(sandbox), runtime: harness(root), observedAt: '2027-01-01T00:00:00.000Z', presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })).toMatchObject({ kind: 'unmeasured', code: 'EXTERNAL_DEPENDENCY_EXPIRED' })
        vi.useRealTimers()
        expect(planExternalDependency({ declaration: vendor(), fragments: externalDependencyTemplateFragments(vendor()), runtime: harness(root), observedAt: '2026-09-26T12:00:00.000Z', presentShadowFiles: [] })).toMatchObject({ kind: 'unmeasured', code: 'EXTERNAL_DEPENDENCY_SHADOW_UNAVAILABLE' })
        const fragments = externalDependencyTemplateFragments(vendor())
        const mismatched = fragments.kind === 'complete' ? { ...fragments, runtime: [{ ...fragments.runtime[0]!, value: 'http://other-stub:4010' }] } : fragments
        expect(planExternalDependency({ declaration: vendor(), fragments: mismatched, runtime: harness(root), observedAt: '2026-09-26T12:00:00.000Z', presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })).toMatchObject({ kind: 'unmeasured' })
        expect(planExternalDependency({ declaration: {}, fragments: { kind: 'refusal', reason: 'missing' }, runtime: harness(root), observedAt: '2026-09-26T12:00:00.000Z', presentShadowFiles: [] })).toMatchObject({ kind: 'unmeasured' })
    })

    it('refuses a failed real-route probe and rejects forged or replayed evidence', async () => {
        const root = workspace()
        const loaderDeclaration = { ...vendor(), loader_probe: operation(['node', 'verifier.mjs', 'fail']) }
        const loaderPlan = planExternalDependency({ declaration: loaderDeclaration, fragments: externalDependencyTemplateFragments(loaderDeclaration), runtime: harness(root), observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        expect(loaderPlan.kind).toBe('complete')
        if (loaderPlan.kind === 'complete') {
            const failed = await verifyExternalDependency(loaderPlan, { execute: executeProbe })
            expect(failed).toMatchObject({ kind: 'refusal', failedRole: 'loader' })
            expect(projectExternalDependencyProgress(failed)).toEqual({
                applied: [], attempted: ['loader'],
                notApplied: ['route', 'shadow:web:.env', 'egress', 'stub-rejection', 'stub-outage'],
            })
        }
        const declaration = { ...vendor(), route_probe: operation(['node', 'verifier.mjs', 'fail']) }
        const runtime = await authoritativeHarness(root, [declaration])
        const planned = planExternalDependency({ authority: runtime.generatedAuthority, declaration, fragments: externalDependencyTemplateFragments(declaration), runtime, observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        expect(planned.kind).toBe('complete')
        if (planned.kind !== 'complete') return
        const failed = await verifyExternalDependency(planned, { execute: executeProbe })
        expect(failed).toMatchObject({ kind: 'refusal', failedRole: 'route' })
        expect(projectExternalDependencyProgress(failed)).toEqual({
            applied: ['loader'], attempted: ['route'],
            notApplied: ['shadow:web:.env', 'egress', 'stub-rejection', 'stub-outage'],
        })
        const observation = observeExternalDependency({ evidence: failed, authority: runtime.generatedAuthority })
        expect(projectExternalDependencyProgress(observation)).toEqual({
            applied: ['loader'], attempted: ['route'],
            notApplied: ['shadow:web:.env', 'egress', 'stub-rejection', 'stub-outage'],
        })
        expect(projectExternalDependencyProgress({ ...observation })).toBeUndefined()
        await expect(verifyExternalDependency(planned, { execute: executeProbe })).resolves.toMatchObject({ kind: 'unmeasured' })
        const secondDeclaration = vendor()
        const second = planExternalDependency({ declaration: secondDeclaration, fragments: externalDependencyTemplateFragments(secondDeclaration), runtime: harness(root), observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        if (second.kind !== 'complete') return
        await expect(verifyExternalDependency(second, { execute: async () => ({ kind: 'complete' } as never) })).resolves.toMatchObject({ kind: 'unmeasured', code: 'EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE' })

        const cachedSource = planExternalDependency({ declaration: secondDeclaration, fragments: externalDependencyTemplateFragments(secondDeclaration), runtime: harness(root), observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        const cachedTarget = planExternalDependency({ declaration: secondDeclaration, fragments: externalDependencyTemplateFragments(secondDeclaration), runtime: harness(root), observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        if (cachedSource.kind !== 'complete' || cachedTarget.kind !== 'complete') return
        const cachedOutcomes = await Promise.all(cachedSource.steps.map(({ step }) => executeProbe(step)))
        await expect(verifyExternalDependency(cachedTarget, { execute: async () => cachedOutcomes.shift()! }))
            .resolves.toMatchObject({ kind: 'unmeasured', code: 'EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE' })
    })

    it('scopes the egress flag to a freshly authenticated local backend', async () => {
        const root = workspace()
        const declaration = {
            ...vendor(), nonempty_variables: ['MAILER_TOKEN'],
            egress_guard: { flag: 'ALLOW_SYNTHETIC_BACKEND', enabled_value: '1', local_service: 'app' },
        }
        const fragments = externalDependencyTemplateFragments(declaration)
        expect(fragments).toMatchObject({ kind: 'complete', nonempty: [{ variable: 'MAILER_TOKEN', value: 'cockpit:absent:mailer' }] })
        expect(JSON.stringify(fragments)).not.toContain('ALLOW_SYNTHETIC_BACKEND')
        const runtime = await authoritativeHarness(root, [declaration])
        expect(planExternalDependency({
            declaration, fragments,
            runtime: { ...runtime, publicEnv: { PATH: runtime.publicEnv.PATH! },
                serviceAuthority: { topology: runtime.serviceAuthority.topology, evidence: { ...runtime.serviceAuthority.evidence } as never } },
            observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }],
        })).toMatchObject({ kind: 'unmeasured', code: 'EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE' })
        const planned = planExternalDependency({ authority: runtime.generatedAuthority, declaration, fragments, runtime,
            observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        expect(planned.kind, JSON.stringify(planned)).toBe('complete')
        if (planned.kind !== 'complete') return
        const egress = planned.steps.find(({ role }) => role === 'egress')
        expect(egress?.step.argv).toContain('ALLOW_SYNTHETIC_BACKEND=1')
        expect(planned.steps.filter(({ role }) => role !== 'egress').every(({ step }) => !step.argv.includes('ALLOW_SYNTHETIC_BACKEND=1'))).toBe(true)
        const verified = await verifyExternalDependency(planned, { execute: executeProbe })
        expect(verified.kind, JSON.stringify(verified)).toBe('complete')
    })

    it('refuses egress when the authenticated backend stops after planning', async () => {
        const root = workspace()
        const declaration = {
            ...vendor(), egress_guard: { flag: 'ALLOW_SYNTHETIC_BACKEND', enabled_value: '1', local_service: 'app' },
        }
        const runtime = await authoritativeHarness(root, [declaration])
        const planned = planExternalDependency({ authority: runtime.generatedAuthority, declaration,
            fragments: externalDependencyTemplateFragments(declaration), runtime,
            observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        expect(planned.kind, JSON.stringify(planned)).toBe('complete')
        if (planned.kind !== 'complete') return
        writeFileSync(join(root, '.backend-stopped'), '')
        await expect(verifyExternalDependency(planned, { execute: executeProbe })).resolves.toMatchObject({
            kind: 'unmeasured', code: 'EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE',
        })
    })

    it('requires a guarded egress probe to run in its authenticated local service', async () => {
        const root = workspace()
        const runtime = harness(root)
        const guarded = {
            ...vendor(), egress_guard: { flag: 'ALLOW_SYNTHETIC_BACKEND', enabled_value: '1', local_service: 'app' },
        }
        const mismatch = { ...guarded, egress_probe: operation(['node', 'verifier.mjs', 'egress'], 'worker') }
        expect(planExternalDependency({ declaration: mismatch, fragments: externalDependencyTemplateFragments(mismatch), runtime, observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })).toMatchObject({
            kind: 'unmeasured', code: 'EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE', message: 'egress guard must target its authenticated local service',
        })
        const host = { ...guarded, egress_probe: { ...guarded.egress_probe, location: 'host' as const, service: undefined } }
        expect(planExternalDependency({ declaration: host, fragments: externalDependencyTemplateFragments(host), runtime, observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })).toMatchObject({
            kind: 'unmeasured', code: 'EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE', message: 'egress guard must target its authenticated local service',
        })
    })

    it('uses the execution clock for sandbox expiry before and after planning', async () => {
        vi.useFakeTimers()
        const root = workspace()
        const declaration = vendor('vendor-sandbox')
        vi.setSystemTime('2027-01-01T00:00:00.000Z')
        expect(planExternalDependency({ declaration, fragments: externalDependencyTemplateFragments(declaration), runtime: harness(root), observedAt: '2026-01-01T00:00:00.000Z', presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })).toMatchObject({
            kind: 'unmeasured', code: 'EXTERNAL_DEPENDENCY_EXPIRED',
        })

        vi.setSystemTime('2026-12-31T23:59:58.000Z')
        const planned = planExternalDependency({ declaration, fragments: externalDependencyTemplateFragments(declaration), runtime: harness(root), observedAt: '2099-01-01T00:00:00.000Z', presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        expect(planned.kind).toBe('complete')
        if (planned.kind !== 'complete') return
        expect(planned.steps.every(({ step }) => step.spawnNotAfter === '2026-12-31T23:59:59.999Z')).toBe(true)
        const execute = vi.fn(async (step: ExecutionStep) => {
            const outcome = await executeProbe(step)
            vi.setSystemTime('2027-01-01T00:00:00.000Z')
            return outcome
        })
        const evidence = await verifyExternalDependency(planned, { execute })
        expect(evidence).toMatchObject({ kind: 'unmeasured', code: 'EXTERNAL_DEPENDENCY_EXPIRED' })
        expect(execute).toHaveBeenCalledTimes(1)
        expect(projectExternalDependencyProgress(evidence)).toEqual({
            applied: ['loader'],
            notApplied: ['route', 'shadow:web:.env', 'sandbox-expiry', 'egress'],
        })
        expect(projectExternalDependencyProgress({ ...evidence })).toBeUndefined()
    })

    it('does not let a future reporting clock extend callback execution', () => {
        const root = workspace()
        const declaration = protocolVendor()
        const planned = planExternalDependency({ declaration, fragments: externalDependencyTemplateFragments(declaration), runtime: harness(root), observedAt: '2099-01-01T00:00:00.000Z', presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        expect(planned.kind).toBe('complete')
        if (planned.kind !== 'complete') return
        const callbackSteps = planned.steps.filter(({ role }) => role.startsWith('callback-'))
        expect(callbackSteps).toHaveLength(5)
        expect(callbackSteps.every(({ step }) => step.spawnNotAfter !== undefined && Date.parse(step.spawnNotAfter) <= Date.now() + 60_000)).toBe(true)
    })

    it('refuses non-runtime and unsafe public environment values before planning', () => {
        const root = workspace()
        const declaration = vendor()
        const fragments = externalDependencyTemplateFragments(declaration)
        const base = harness(root)
        for (const publicEnv of [
            { ...base.publicEnv, SECRET_CANARY: 'must-not-enter-a-plan' },
            { ...base.publicEnv, DOCKER_CONTEXT: 'local\0trailing' },
        ]) {
            const result = planExternalDependency({ declaration, fragments, runtime: { ...base, publicEnv }, observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
            expect(result).toMatchObject({ kind: 'unmeasured', code: 'EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE' })
            expect(JSON.stringify(result)).not.toContain('must-not-enter-a-plan')
        }
    })

    it('does not propagate caller labels into dependency plans', () => {
        const root = workspace()
        const declaration = vendor()
        const runtime = { ...harness(root), labels: { authorization: 'label-secret-canary' } }
        const planned = planExternalDependency({ declaration, fragments: externalDependencyTemplateFragments(declaration), runtime, observedAt: new Date().toISOString(), presentShadowFiles: [{ sibling: 'web', instance: '.env' }] })
        expect(planned.kind).toBe('complete')
        expect(JSON.stringify(planned)).not.toContain('label-secret-canary')
    })
})
