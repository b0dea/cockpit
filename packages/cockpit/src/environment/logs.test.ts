import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { runLogs } from './application.js'
import { stackId, cockpitId, checkoutId } from './identity.js'
import { loadCockpitConfig } from '../config/load.js'
import { projectGeneratedComposeArtifactAuthority, renderGeneratedEnvironment } from './generated-stack.js'
import { authenticateStabilityCapture, captureRuntimeEvidence, createStabilityCapturePlan, type CapturedRuntimeEvidence } from './evidence.js'
import { admitFailureLogs, collectLogs, failureLogExcerpt, planFailureLogs, planLogs, type FailureLogRecord, type LogRequest } from './logs.js'
import {
    admitRuntimeServiceHealth,
    admitRuntimeServicePlanFailure,
    admitRuntimeServiceObservation,
    admitRuntimeServiceStageOutcome,
    admitRuntimeTopology,
    createRuntimeAdapter,
    createRuntimeServiceHealthPlan,
    createRuntimeServicePlan,
    createRuntimeTopologyPlan,
    type RuntimeAdapterAuthority,
    type RuntimeObservationWindow,
    type RuntimeServiceFailureEvidence,
    type RuntimeServiceObservation,
} from './runtime.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const stack = stackId({ cockpitId: cockpitId({ name: 'synthetic', mainCheckoutPath: '/tmp/main' }), checkoutId: checkoutId({ checkoutPath: '/tmp/work' }), variant: { kind: 'shared' } })
const configSha256 = sha('config')
const failureBatchId = sha('failure log batch')
const failureContainerId = sha('failure log container')
const composeSource = 'services: {}'
const runtimeDirectory = mkdtempSync(join(tmpdir(), 'cockpit-log-runtime-'))
const runtimePath = join(runtimeDirectory, 'runtime')
const runtimeInvocationPath = join(runtimeDirectory, 'docker')
const composePath = join(runtimeDirectory, 'compose.yml')
const composeOverridePath = join(runtimeDirectory, 'compose.override.yml')
const composeOverrideSource = 'services:\n  api: {}'
const runtimeSource = `#!/bin/sh
case "$*" in
  *'/proc/1/stat'*) printf '%s\\n' "\${COCKPIT_PROCESS_IDENTITY:-777 12345}" ;;
  *'cockpit-content-hash'*) printf '%s  -\\n' "\${COCKPIT_CONTENT_HASH}" ;;
  *)
    case "\${COCKPIT_TEST_MODE:-output}" in
      output) printf '%s' "\${COCKPIT_TEST_OUTPUT}"; printf '%s' "\${COCKPIT_TEST_ERROR_OUTPUT}" >&2 ;;
      invalid) printf '\\377' ;;
      hang) trap '' TERM; while :; do /bin/sleep 1; done ;;
      follow) printf '%s' "\${COCKPIT_TEST_OUTPUT}"; touch "\${COCKPIT_TEST_READY}"; while :; do /bin/sleep 1; done ;;
      fail) exit 7 ;;
    esac
  ;;
esac
`
writeFileSync(runtimePath, runtimeSource)
writeFileSync(composePath, composeSource)
writeFileSync(composeOverridePath, composeOverrideSource)
chmodSync(runtimePath, 0o755)
afterAll(() => rmSync(runtimeDirectory, { recursive: true, force: true }))
const input: LogRequest = {
    runtime: 'docker-compose' as const, executable: { canonicalPath: runtimePath, invocationPath: runtimeInvocationPath, sha256: sha(runtimeSource), executionMode: 'verified-path' as const },
    cwd: runtimeDirectory, stackId: stack, configSha256, batchId: sha('log-batch'), containerId: 'synthetic-api-1', runtimeVersion: '27.1.2', composeVersion: '2.29.2',
    projectName: 'synthetic', composeFiles: [{ reference: 'compose.yml', canonicalPath: composePath, source: composeSource, sha256: sha(composeSource) }],
    services: ['api'], service: 'api', since: '2026-09-07T00:00:00Z', tail: 100, follow: true,
    timeoutMs: 10_000, outputLimitBytes: 4096, env: { PATH: '/usr/bin' },
}

function planWithOutput(output: string, patch: Partial<typeof input> = {}) {
    return planLogs({ ...input, ...patch, env: { ...input.env, COCKPIT_TEST_OUTPUT: output, ...(patch.env ?? {}) } })
}

function planWithMode(mode: 'fail' | 'hang' | 'invalid', patch: Partial<typeof input> = {}) {
    return planLogs({ ...input, ...patch, env: { ...input.env, COCKPIT_TEST_MODE: mode, ...(patch.env ?? {}) } })
}

let failureRuntimeIndex = 0
async function failureEvidence(logTimestamp = new Date().toISOString(), logOutput?: string, errorOutput = '', state = 'running', health = '', fixture?: {
    readonly path: string
    readonly observationWindow: RuntimeObservationWindow
}): Promise<RuntimeServiceObservation> {
    const observationWindow: RuntimeObservationWindow = fixture?.observationWindow ?? {
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const path = fixture?.path ?? join(runtimeDirectory, `failure-runtime-${failureRuntimeIndex++}`)
    const topology = JSON.stringify({ services: { api: { ...(health === '' ? {} : { healthcheck: { test: ['CMD', 'true'] } }), labels: {
        'dev.b0dea.cockpit.stack-id': stack,
        'dev.b0dea.cockpit.config-sha256': configSha256,
    } } } })
    const container = {
        ID: failureContainerId,
        Name: 'synthetic-api-1',
        Project: 'synthetic',
        Service: 'api',
        State: state,
        Health: health,
        ExitCode: 0,
        Labels: `com.docker.compose.project=synthetic,com.docker.compose.service=api,dev.b0dea.cockpit.config-sha256=${configSha256},dev.b0dea.cockpit.stack-id=${stack}`,
    }
    const status = JSON.stringify({ ...Object.fromEntries(Object.entries(container).filter(([name]) => name !== 'Labels')), ID: container.ID.slice(0, 12) })
    const inspected = JSON.stringify({
        ID: container.ID,
        State: container.State,
        Health: container.Health,
        Labels: Object.fromEntries(container.Labels.split(',').map((item) => item.split('='))),
        Mounts: [],
        Ports: {},
    })
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
if has_argument config "$@"; then printf '%s' ${shellQuote(topology)}
elif has_argument up "$@"; then :
elif has_argument --quiet "$@"; then printf '%s' ${shellQuote(`${failureContainerId}\n`)}
elif has_argument ps "$@"; then printf '%s' ${shellQuote(status)}
elif has_argument inspect "$@"; then printf '%s' ${shellQuote(inspected)}
elif has_argument logs "$@"; then
  printf '%s' ${shellQuote(logOutput ?? `${logTimestamp} password=failure-canary\n`)}
  printf '%s' ${shellQuote(errorOutput)} >&2
else exit 7
fi
`
    writeFileSync(path, source)
    chmodSync(path, 0o755)
    const executable = { canonicalPath: path, invocationPath: runtimeInvocationPath, sha256: sha(source), executionMode: 'verified-path' as const }
    const runtime = createRuntimeAdapter({
        runtime: { name: 'docker', version: input.runtimeVersion, executableSha256: executable.sha256 },
        composeVersion: input.composeVersion,
        executable,
        operation: 'validate',
        cwd: runtimeDirectory,
        composeFiles: input.composeFiles,
        projectName: 'synthetic',
        env: { PATH: process.env.PATH ?? '/usr/bin' },
        ports: [],
        labels: { stackId: stack, configSha256, batchId: failureBatchId },
        timeoutMs: 10_000,
        stackId: stack,
        coldStartLimitMillis: 60_000,
        expectedMountSources: [],
    })
    if (runtime.kind !== 'preview') throw new Error(runtime.diagnostics[0]?.message ?? 'runtime fixture refused')
    const topologyPlan = createRuntimeTopologyPlan({ runtimePlan: runtime.plan, stackId: stack, configSha256, batchId: failureBatchId, observationWindow })
    if (topologyPlan.kind !== 'planned') throw new Error(topologyPlan.reason)
    const topologyResult = admitRuntimeTopology({ plan: topologyPlan, outcome: await executeProbe(topologyPlan.step) })
    if (topologyResult.kind !== 'complete') throw new Error(topologyResult.reason)
    const servicePlan = createRuntimeServicePlan({ topology: topologyResult.topology, service: 'api' })
    if (servicePlan.kind !== 'planned') throw new Error(servicePlan.reason)
    const startOutcome = await executeProbe(servicePlan.start)
    if (admitRuntimeServiceStageOutcome({ plan: servicePlan, stage: 'start', outcome: startOutcome }).kind !== 'admitted') {
        throw new Error('failure log fixture start admission failed')
    }
    const outcome = await executeProbe(servicePlan.status)
    if (admitRuntimeServiceStageOutcome({ plan: servicePlan, stage: 'status', outcome, startOutcome }).kind !== 'admitted') {
        throw new Error('failure log fixture status admission failed')
    }
    const identityOutcome = await executeProbe(servicePlan.identity)
    if (admitRuntimeServiceStageOutcome({ plan: servicePlan, stage: 'identity', outcome: identityOutcome, startOutcome, statusOutcome: outcome }).kind !== 'admitted') {
        throw new Error('failure log fixture identity admission failed')
    }
    const healthPlan = createRuntimeServiceHealthPlan({ plan: servicePlan, startOutcome, outcome, identityOutcome })
    if (healthPlan.kind !== 'planned') throw new Error(healthPlan.reason)
    const observed = admitRuntimeServiceObservation({ plan: healthPlan, outcome: await executeProbe(healthPlan.step) })
    if (observed.kind !== 'complete') throw new Error(observed.reason)
    return observed.observation
}

async function earlyFailureEvidence(
    logOutput: string,
    logsExit = 0,
    composeFiles = input.composeFiles,
    authority?: RuntimeAdapterAuthority,
): Promise<RuntimeServiceFailureEvidence> {
    const observationWindow: RuntimeObservationWindow = {
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const path = join(runtimeDirectory, `early-failure-runtime-${failureRuntimeIndex++}`)
    const topology = JSON.stringify({ services: { api: { labels: {
        'dev.b0dea.cockpit.stack-id': stack,
        'dev.b0dea.cockpit.config-sha256': configSha256,
    } } } })
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
if has_argument config "$@"; then printf '%s' ${shellQuote(topology)}
elif has_argument up "$@"; then exit 7
elif has_argument logs "$@"; then
  printf '%s' ${shellQuote(logOutput)}
  exit ${logsExit}
else exit 7
fi
`
    writeFileSync(path, source)
    chmodSync(path, 0o755)
    const executable = { canonicalPath: path, invocationPath: runtimeInvocationPath, sha256: sha(source), executionMode: 'verified-path' as const }
    const runtime = createRuntimeAdapter({
        runtime: { name: 'docker', version: input.runtimeVersion, executableSha256: executable.sha256 },
        composeVersion: input.composeVersion,
        executable,
        operation: 'validate',
        cwd: runtimeDirectory,
        composeFiles,
        projectName: 'synthetic',
        env: { PATH: process.env.PATH ?? '/usr/bin' },
        ports: [],
        labels: { stackId: stack, configSha256, batchId: failureBatchId },
        timeoutMs: 10_000,
        stackId: stack,
        coldStartLimitMillis: 60_000,
        expectedMountSources: [],
    }, authority)
    if (runtime.kind !== 'preview') throw new Error(runtime.diagnostics[0]?.message ?? 'runtime fixture refused')
    const topologyPlan = createRuntimeTopologyPlan({ runtimePlan: runtime.plan, stackId: stack, configSha256, batchId: failureBatchId, observationWindow })
    if (topologyPlan.kind !== 'planned') throw new Error(topologyPlan.reason)
    const topologyResult = admitRuntimeTopology({ plan: topologyPlan, outcome: await executeProbe(topologyPlan.step) })
    if (topologyResult.kind !== 'complete') throw new Error(topologyResult.reason)
    const servicePlan = createRuntimeServicePlan({ topology: topologyResult.topology, service: 'api' })
    if (servicePlan.kind !== 'planned') throw new Error(servicePlan.reason)
    const failure = admitRuntimeServicePlanFailure({ plan: servicePlan, stage: 'start', outcome: await executeProbe(servicePlan.start) })
    if (failure.kind !== 'complete') throw new Error(failure.reason)
    return failure.evidence
}

async function evidence(batchId: string, process: string): Promise<CapturedRuntimeEvidence> {
    const plan = createStabilityCapturePlan({
        stackId: stack, configSha256, runtimeExecutable: input.executable, cwd: input.cwd,
        env: { ...input.env, COCKPIT_PROCESS_IDENTITY: process, COCKPIT_CONTENT_HASH: sha('tree') }, containerId: input.containerId,
        batchId, runtime: { name: 'docker', version: input.runtimeVersion }, contentPaths: ['/workspace/api'],
        timeoutMs: 10_000, outputLimitBytes: 1024,
    })
    if (plan.kind !== 'preview') throw new Error('fixture plan refused')
    const results = []
    for (const step of plan.plan.steps) results.push(await executeProbe(step))
    const capture = authenticateStabilityCapture({ plan, results })
    if ('state' in capture) throw new Error(capture.reason)
    const result = captureRuntimeEvidence({ capture })
    if (result.state !== 'available') throw new Error(result.reason)
    return result
}

describe('runtime logs', () => {
    it('admits generated Compose sources only with their exact artifact authority', async () => {
        const loaded = await loadCockpitConfig('fixtures/registries/generated-environment.toml')
        if (loaded.kind !== 'complete' || !loaded.result.config.environment.generated) throw new Error('generated fixture is unavailable')
        const declaration = loaded.result.config.environment.generated
        const rendered = renderGeneratedEnvironment({ declaration, sourceSha256: loaded.result.source.sha256,
            generation: sha('generated log generation'), stackId: stack,
            cockpitId: cockpitId({ name: 'synthetic', mainCheckoutPath: '/tmp/main' }),
            portDefaults: loaded.result.config.ports.bases, siblingDirectories: { app: 'app' } })
        if (rendered.kind !== 'complete') throw new Error(rendered.reason)
        const authority = projectGeneratedComposeArtifactAuthority(rendered)
        if (!authority) throw new Error('generated artifact authority is unavailable')
        const path = join(runtimeDirectory, declaration.compose_file)
        writeFileSync(path, rendered.compose)
        const request = { ...input, configSha256: loaded.result.source.sha256,
            composeFiles: [{ reference: declaration.compose_file, canonicalPath: path,
                source: rendered.compose, sha256: sha(rendered.compose) }] }
        expect(planLogs(request)).toMatchObject({ kind: 'unavailable' })
        expect(planLogs(request, { ...authority })).toMatchObject({ kind: 'unavailable' })
        expect(planLogs(request, authority)).toMatchObject({ kind: 'planned', step: {
            argv: expect.arrayContaining(['container', 'logs', input.containerId]), env: input.env,
        } })
        expect(planLogs({ ...request, configSha256: sha('changed log configuration') }, authority)).toMatchObject({ kind: 'unavailable' })
    })

    it('constructs an immutable bounded runtime-native step for the authenticated container', () => {
        const result = planLogs(input)
        expect(result.kind).toBe('planned')
        if (result.kind !== 'planned') return
        expect(result.step.argv).toEqual([runtimePath, 'container', 'logs', '--timestamps', '--since', input.since, '--tail', '100', '--follow', input.containerId])
        expect(Object.isFrozen(result.step.argv)).toBe(true)
        expect(result.step).toEqual(expect.objectContaining({ timeoutMs: 10_000, stdoutLimitBytes: 4096 }))
    })

    it('reads logs from the local socket or context the lifecycle selected', () => {
        for (const env of [
            { PATH: '/usr/bin', DOCKER_HOST: 'unix:///synthetic/docker.sock' },
            { PATH: '/usr/bin', DOCKER_HOST: 'unix:///synthetic home/docker.sock' },
            { PATH: '/usr/bin', DOCKER_HOST: 'unix:///synthetic/docker%23?#.sock' },
            { PATH: '/usr/bin', DOCKER_CONTEXT: 'synthetic' },
        ] as Readonly<Record<string, string>>[]) {
            const result = planLogs({ ...input, env })
            expect(result.kind, JSON.stringify(env)).toBe('planned')
            if (result.kind === 'planned') expect(result.step.env).toEqual(env)
        }
    })

    it('admits endpoint syntax only at its system platform boundary before planning logs', () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')
        if (!platform?.configurable) throw new Error('process.platform cannot be configured for the OS boundary test')
        try {
            for (const hostPlatform of ['darwin', 'linux', 'freebsd']) {
                Object.defineProperty(process, 'platform', { ...platform, value: hostPlatform })
                for (const endpoint of ['unix:///synthetic home/docker%23?#.sock', 'npipe:////./pipe/docker_engine']) {
                    const env = { PATH: '/usr/bin', DOCKER_HOST: endpoint }
                    const result = planLogs({ ...input, env })
                    const admitted = endpoint.startsWith('unix:') && (hostPlatform === 'darwin' || hostPlatform === 'linux')
                    expect(result.kind, `${hostPlatform}: ${endpoint}`).toBe(admitted ? 'planned' : 'unavailable')
                    if (result.kind === 'planned') expect(result.step.env).toEqual(env)
                }
            }
        } finally {
            Object.defineProperty(process, 'platform', platform)
        }
    })

    it('refuses remote, ambiguous and malformed Docker endpoints before planning logs', () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')
        if (!platform?.configurable) throw new Error('process.platform cannot be configured for the OS boundary test')
        try {
            for (const hostPlatform of ['darwin', 'linux']) {
                Object.defineProperty(process, 'platform', { ...platform, value: hostPlatform })
                for (const endpoint of [
                    'tcp://127.0.0.1:2375', 'ssh://synthetic.invalid',
                    'npipe:////./pipe/docker_engine',
                    'unix://synthetic.invalid/socket', 'unix:////synthetic.invalid/socket', 'unix:///',
                    'unix:///tmp/docker.sock\0', 'unix:///tmp/docker.sock\n',
                ]) {
                    expect(planLogs({ ...input, env: { PATH: '/usr/bin', DOCKER_HOST: endpoint } }), endpoint)
                        .toMatchObject({ kind: 'unavailable' })
                }
            }
        } finally {
            Object.defineProperty(process, 'platform', platform)
        }
    })

    it('binds collection to the authenticated container identity rather than a replaceable Compose service', () => {
        const authenticatedContainerId = sha('authenticated container')
        const result = planLogs({ ...input, containerId: authenticatedContainerId })

        expect(result.kind).toBe('planned')
        if (result.kind !== 'planned') return
        expect(result.step.argv.at(-1)).toBe(authenticatedContainerId)
        expect(result.step.argv).not.toContain(input.service)
        expect(result.step.labels.containerId).toBe(authenticatedContainerId)
    })

    it('refuses an accessor-backed request without reading it', () => {
        let reads = 0
        const volatile = { ...input }
        Object.defineProperty(volatile, 'service', {
            enumerable: true,
            get: () => ++reads === 1 ? 'api' : 'worker',
        })
        const result = planLogs(volatile)
        expect(result).toEqual({
            kind: 'unavailable',
            code: 'RUNTIME_UNMEASURED',
            reason: 'log request must be readable JSON data',
        })
        expect(reads).toBe(0)
    })

    it('refuses non-object and inexact nested request shapes without throwing', () => {
        const { proxy, revoke } = Proxy.revocable({}, {})
        revoke()
        const malformed = [
            null,
            7,
            {},
            { ...input, ignoredDecision: 'accept' },
            { ...input, executable: null },
            { ...input, executable: { ...input.executable, ignoredDecision: 'accept' } },
            { ...input, composeFiles: [{ ...input.composeFiles[0], ignoredDecision: 'accept' }] },
            { ...input, env: [] },
            { ...input, restartBatches: ['a'] },
            { ...input, restartBatches: ['a', 'b', 'c'] },
            proxy,
        ]

        for (const value of malformed) {
            expect(() => planLogs(value as never)).not.toThrow()
            expect(planLogs(value as never)).toEqual(expect.objectContaining({ kind: 'unavailable' }))
        }
    })

    it.each([{ service: '--all' }, { service: 'worker' }, { since: 'yesterday' }, { since: '2026-02-30T00:00:00Z' }, { configSha256: 'unbound' }, { tail: -1 }, { timeoutMs: 0 }, { outputLimitBytes: 20_000_000 }, { runtime: 'other' }, { batchId: 'unbound' }, { containerId: '--privileged' }, { executable: { ...input.executable, invocationPath: '/tmp/not-docker' } }, { env: { PATH: '$UNRESOLVED' } }, { env: { PATH: 'x\0y' } }, { env: { PATH: '/usr/bin', DOCKER_HOST: 'tcp://127.0.0.1:2375' } }, { env: { PATH: '/usr/bin', DOCKER_TLS_VERIFY: '1' } }])('refuses ambiguous or unbounded requests', (patch) => {
        expect(planLogs({ ...input, ...patch } as typeof input).kind).toBe('unavailable')
    })

    it.each([
        ['source digest', { composeFiles: [{ ...input.composeFiles[0], sha256: sha('forged') }] }],
        ['canonical relation', { composeFiles: [{ ...input.composeFiles[0], canonicalPath: '/tmp/other/compose.yml' }] }],
        ['remote reference', { composeFiles: [{ ...input.composeFiles[0], reference: 'https://invalid.test/compose.yml' }] }],
        ['unresolved source', { composeFiles: [{ ...input.composeFiles[0], source: 'services: $SERVICE', sha256: sha('services: $SERVICE') }] }],
        ['remote include', { composeFiles: [{ ...input.composeFiles[0], source: 'include: https://invalid.test/compose.yml', sha256: sha('include: https://invalid.test/compose.yml') }] }],
        ['remote build', { composeFiles: [{ ...input.composeFiles[0], source: 'services:\n  api:\n    build: https://invalid.test/repo.git', sha256: sha('services:\n  api:\n    build: https://invalid.test/repo.git') }] }],
    ])('authenticates compose artifact %s before spawn', (_label, patch) => {
        expect(planLogs({ ...input, ...patch }).kind).toBe('unavailable')
    })

    it('normalizes records, redacts values, and forwards cancellation', async () => {
        const plan = planWithOutput('2026-09-07T00:00:01Z password=hunter2 restarted\n'); if (plan.kind !== 'planned') return
        const signal = new AbortController().signal
        const execute = vi.fn(executeProbe)
        const result = await collectLogs(plan, execute, signal)
        expect(execute).toHaveBeenCalledWith(plan.step, { signal })
        expect(result).toEqual({ kind: 'complete', records: [expect.objectContaining({ service: 'api', message: 'password=[redacted]', restart: false })] })
        expect(JSON.stringify(result)).not.toContain('hunter2')
    })

    it('preserves native container stdout and stderr attribution', async () => {
        const plan = planWithOutput('2026-09-07T00:00:01Z stdout\n', {
            env: { ...input.env, COCKPIT_TEST_ERROR_OUTPUT: '2026-09-07T00:00:02Z stderr\n' },
        }); if (plan.kind !== 'planned') return

        const result = await collectLogs(plan, executeProbe)

        expect(result.kind === 'complete' && result.records.map(({ stream, message }) => [stream, message])).toEqual([
            ['stdout', 'stdout'],
            ['stderr', 'stderr'],
        ])
    })

    it('cancels a bounded follow through the execution owner', async () => {
        const plan = planWithMode('hang'); if (plan.kind !== 'planned') return
        const controller = new AbortController()
        queueMicrotask(() => controller.abort())

        const result = await collectLogs(plan, executeProbe, controller.signal)

        expect(result).toEqual({ kind: 'cancelled', records: [] })
    })

    it('returns cancelled with authenticated redacted records after stopping a running follow', async () => {
        const ready = join(runtimeDirectory, 'follow-ready')
        const controller = new AbortController()
        const { since, tail, follow, ...request } = input
        const result = runLogs({ configPath: '/synthetic/cockpit.toml', service: input.service,
            since, tail, follow, json: true }, {
            observe: async () => ({ request: { ...request, env: { ...input.env,
                COCKPIT_TEST_MODE: 'follow', COCKPIT_TEST_READY: ready,
                COCKPIT_TEST_OUTPUT: '2026-09-07T00:00:01Z token=follow-canary\n',
            } } }),
            execute: executeProbe,
            signal: controller.signal,
        })
        try {
            await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5_000 })
        } finally {
            controller.abort()
        }

        const outcome = await result
        expect(outcome).toMatchObject({ kind: 'cancelled', status: 130, diagnostics: [],
            result: { json: true, records: [{ stream: 'stdout', timestamp: '2026-09-07T00:00:01Z' }] } })
        expect(JSON.stringify(outcome)).not.toContain('follow-canary')
    })

    it('enforces the public tail bound before observing a runtime', async () => {
        for (const tail of [0, 10_001]) {
            const observe = vi.fn()
            const result = await runLogs({ configPath: '/synthetic/cockpit.toml', service: input.service,
                since: input.since, tail, follow: false, json: true }, { observe, execute: executeProbe })
            expect(result).toMatchObject({ kind: 'refusal', status: 2 })
            expect(observe).not.toHaveBeenCalled()
            expect(planLogs({ ...input, tail })).toMatchObject({ kind: 'unavailable' })
        }
    })

    it.each(['{"token":"canary"}', '{"nested":{"credential":"canary"}}', '{"nested":{"private_key":"canary"}}', '{"Authorization":"Bearer canary"}', '{"PASSWD":"canary"}', 'private-key=canary', '{"message":"token=canary"}', '"token=canary"', 'secret="two words"', 'Authorization: Bearer canary', 'passwd=canary'])('redacts structured and scalar secret form %s', async (message) => {
        const plan = planWithOutput(`2026-09-07T00:00:01Z ${message}\n`); if (plan.kind !== 'planned') return
        const result = await collectLogs(plan, executeProbe)
        expect(JSON.stringify(result)).not.toContain('canary')
        expect(JSON.stringify(result)).not.toContain('two words')
    })

    it.each([
        ['password=correct-horse battery-staple', ['correct-horse', 'battery-staple']],
        ['Authorization: Bearer auth-alpha auth-beta', ['auth-alpha', 'auth-beta']],
        ['token=comma-alpha,comma-beta', ['comma-alpha', 'comma-beta']],
        ['secret=semi-alpha;semi-beta', ['semi-alpha', 'semi-beta']],
        ['credential=multi-alpha multi-beta,multi-gamma;multi-delta', ['multi-alpha', 'multi-beta', 'multi-gamma', 'multi-delta']],
    ])('redacts the full unstructured secret-bearing remainder: %s', async (message, canaries) => {
        const plan = planWithOutput(`2026-09-07T00:00:01Z ${message}\n`); if (plan.kind !== 'planned') return

        const rendered = JSON.stringify(await collectLogs(plan, executeProbe))

        for (const canary of canaries) expect(rendered).not.toContain(canary)
        expect(rendered).toContain('[redacted]')
    })

    it('refuses accessor-backed log authority without reading it', async () => {
        const plan = planWithOutput('2026-09-07T00:00:01Z safe\n'); if (plan.kind !== 'planned') return
        const outcome = await executeProbe(plan.step)
        let reads = 0
        const volatile = { ...plan }
        Object.defineProperty(volatile, 'step', {
            enumerable: true,
            get: () => ++reads === 1 ? plan.step : { ...plan.step, labels: { ...plan.step.labels, batchId: sha('forged') } },
        })

        const result = await collectLogs(volatile, async () => outcome)

        expect(result).toEqual(expect.objectContaining({ kind: 'unavailable', code: 'RUNTIME_UNMEASURED' }))
        expect(reads).toBe(0)
    })

    it.each([' {', ''])('refuses a partial sensitive container with header %j', async header => {
        const plan = planWithOutput(`2026-09-07T00:00:01Z "credentials":${header}\n2026-09-07T00:00:01Z "value":"pretty-canary"\n`)
        if (plan.kind !== 'planned') throw new Error('partial container log plan failed')
        const result = await collectLogs(plan, executeProbe)
        expect(result.kind).toBe('unavailable')
        expect(JSON.stringify(result)).not.toContain('pretty-canary')
    })

    it('fails closed when a valid structured record exceeds the redaction nesting bound', async () => {
        const message = `${'['.repeat(100)}{"token":"deep-canary"}${']'.repeat(100)}`
        const plan = planWithOutput(`2026-09-07T00:00:01Z ${message}\n`); if (plan.kind !== 'planned') return
        const result = await collectLogs(plan, executeProbe)
        expect(result.kind).toBe('unavailable')
        expect(JSON.stringify(result)).not.toContain('deep-canary')
    })

    it('enforces the byte cap and exact execution cohort', async () => {
        const limited = planWithOutput('123456789', { outputLimitBytes: 8 }); if (limited.kind !== 'planned') return
        expect((await collectLogs(limited, executeProbe)).code).toBe('EXECUTION_STDOUT_LIMIT')
        const original = planWithOutput(''); if (original.kind !== 'planned') return
        const outcome = await executeProbe(original.step)
        const relabelled = planLogs({ ...input, batchId: sha('stale') }); if (relabelled.kind !== 'planned') return
        expect((await collectLogs(relabelled, async () => outcome)).kind).toBe('unavailable')
    })

    it('does not accept caller-authored success provenance', async () => {
        const plan = planLogs(input); if (plan.kind !== 'planned') return
        const forged = { kind: 'complete', stdout: Buffer.from('2026-09-07T00:00:01Z forged\n') }
        expect((await collectLogs(plan, async () => forged as never)).kind).toBe('unavailable')
    })

    it.each(['null', 'revoked', 'extra complete', 'forged refusal', 'extra refusal'])('rejects a hostile callback outcome: %s', async (kind) => {
        const plan = planWithOutput('2026-09-07T00:00:01Z safe\n'); if (plan.kind !== 'planned') return
        const complete = await executeProbe(plan.step)
        const aborted = new AbortController()
        aborted.abort()
        const refusal = await executeProbe(plan.step, { signal: aborted.signal })
        const revoked = Proxy.revocable(complete, {})
        if (kind === 'revoked') revoked.revoke()
        const candidate = kind === 'null' ? null
            : kind === 'revoked' ? revoked.proxy
                : kind === 'extra complete' ? { ...complete, extra: true }
                    : kind === 'extra refusal' ? { ...refusal, extra: true }
                        : { ...refusal }

        const result = await collectLogs(plan, async () => candidate as never)

        expect(result).toEqual(expect.objectContaining({ kind: 'unavailable', code: 'RUNTIME_UNMEASURED' }))
    })

    it('contains rejected, unreadable, and unrelated callback outcomes', async () => {
        const plan = planWithOutput('2026-09-07T00:00:01Z safe\n'); if (plan.kind !== 'planned') return
        await expect(collectLogs(plan, async () => { throw new Error('executor rejected') })).resolves.toEqual(expect.objectContaining({ kind: 'unavailable', code: 'RUNTIME_UNMEASURED' }))
        const unreadable = { kind: 'complete' }
        Object.defineProperty(unreadable, 'execution', { enumerable: true, get: () => { throw new Error('unreadable') } })
        expect((await collectLogs(plan, async () => unreadable as never)).code).toBe('RUNTIME_UNMEASURED')
        const unrelated = await executeProbe({ ...plan.step, id: 'runtime:logs:unrelated' })
        expect((await collectLogs(plan, async () => unrelated)).code).toBe('RUNTIME_UNMEASURED')
    })

    it('rejects a genuine outcome from a caller-authored log command', async () => {
        const planned = planWithOutput(''); if (planned.kind !== 'planned') return
        const forgedStep = {
            ...planned.step,
            argv: [process.execPath, '-e', "process.stdout.write('2026-09-07T00:00:01Z forged\\n')"] as [string, ...string[]],
            consumedFiles: [],
        }
        const outcome = await executeProbe(forgedStep)
        expect((await collectLogs({ kind: 'planned', step: forgedStep }, async () => outcome)).kind).toBe('unavailable')
    })

    it('rejects impossible calendar timestamps and unexpected compose prefixes', async () => {
        const impossible = planWithOutput('2026-02-30T00:00:01Z invalid\n'); if (impossible.kind !== 'planned') return
        const prefixed = planWithOutput('different-api-1 | 2026-09-07T00:00:01Z wrong\n'); if (prefixed.kind !== 'planned') return
        expect((await collectLogs(impossible, executeProbe)).kind).toBe('unavailable')
        expect((await collectLogs(prefixed, executeProbe)).kind).toBe('unavailable')
    })

    it('orders accepted offset timestamps by their actual instant', async () => {
        const plan = planWithOutput('2026-09-07T02:00:02+02:00 later\n2026-09-07T00:00:01Z earlier\n'); if (plan.kind !== 'planned') return
        const result = await collectLogs(plan, executeProbe)
        expect(result.kind === 'complete' && result.records.map(({ message }) => message)).toEqual(['earlier', 'later'])
    })

    it('collects a plan using the accepted relative since form', async () => {
        const plan = planWithOutput('2026-09-07T00:00:01Z safe\n', { since: '30s' }); if (plan.kind !== 'planned') return
        expect((await collectLogs(plan, executeProbe)).kind).toBe('complete')
    })

    it('derives restart markers only from ordered authenticated captures inside this log interval', async () => {
        const beforeBatch = sha('before')
        const afterBatch = sha('after')
        const before = await evidence(beforeBatch, '777 12345')
        const plan = planWithOutput('2026-09-07T00:00:01Z producer says restart 99\n', { restartBatches: [beforeBatch, afterBatch] }); if (plan.kind !== 'planned') return
        const logOutcome = await executeProbe(plan.step)
        const after = await evidence(afterBatch, '888 54321')
        const execute = async () => logOutcome
        const result = await collectLogs(plan, execute, undefined, { before, after })
        expect(result.kind === 'complete' && result.records.map(({ restart }) => restart)).toEqual([false, true])
        expect((await collectLogs(plan, execute, undefined, { before, after: { ...after, command: { ...after.command, containerId: 'other' } } })).kind).toBe('unavailable')
        expect((await collectLogs(plan, execute, undefined, { before, after: { ...after, configSha256: sha('other') } })).kind).toBe('unavailable')
        expect((await collectLogs(plan, execute)).kind).toBe('unavailable')
        const unrelatedPlan = planLogs({ ...input, restartBatches: [sha('other-before'), sha('other-after')] })
        if (unrelatedPlan.kind !== 'planned') return
        expect((await collectLogs(unrelatedPlan, execute, undefined, { before, after })).kind).toBe('unavailable')
    })

    it.each([null, 7, {}, { before: {}, after: {}, extra: true }])('rejects malformed restart authority %#', async (restart) => {
        const plan = planWithOutput(''); if (plan.kind !== 'planned') return
        await expect(collectLogs(plan, executeProbe, undefined, restart as never)).resolves.toEqual(expect.objectContaining({ kind: 'unavailable', code: 'RUNTIME_UNMEASURED' }))
    })

    it('keeps malformed, invalid UTF-8, and failed capture explicitly unavailable', async () => {
        const malformed = planWithOutput('garbage'); if (malformed.kind !== 'planned') return
        const invalid = planWithMode('invalid'); if (invalid.kind !== 'planned') return
        const failed = planWithMode('fail'); if (failed.kind !== 'planned') return
        expect((await collectLogs(malformed, executeProbe)).kind).toBe('unavailable')
        expect((await collectLogs(invalid, executeProbe)).kind).toBe('unavailable')
        expect((await collectLogs(failed, executeProbe)).code).toBe('EXECUTION_STEP_FAILED')
    })
})

describe('authenticated failure logs', () => {
    // A restart policy replays one crash per start: the excerpt showed the same line four times, and
    // labelled Compose's merged output as stdout.
    it('shows each distinct failure line once with its count and claims a stream only when one was observed', () => {
        const line = (stream: FailureLogRecord['stream'], message: string) => ({ stream, message }) as FailureLogRecord
        const crash = [line('stdout', 'listening'), ...Array.from({ length: 4 }, () => line('stderr', 'Error: boom'))]
        expect(failureLogExcerpt('api', crash)).toBe('service api wrote 5 log lines before it failed: stdout: listening | stderr: Error: boom (4 times)')
        expect(failureLogExcerpt('api', [line('combined', 'Error: boom'), line('combined', 'Error: boom')]))
            .toBe('service api wrote 2 log lines before it failed: Error: boom (2 times)')
    })

    const bounds = { tail: 50, timeoutMs: 5_000, outputLimitBytes: 4_096 }

    it('targets one full admitted container with explicit finite bounds', async () => {
        const evidence = await failureEvidence()
        const plan = planFailureLogs({ evidence, ...bounds })
        expect(plan.kind).toBe('planned')
        if (plan.kind !== 'planned') return
        expect(plan.step.argv).toEqual([
            plan.step.argv[0],
            'container',
            'logs',
            '--follow=false',
            '--timestamps',
            '--since',
            evidence.observationWindow.startedAt,
            '--until',
            evidence.observationWindow.expiresAt,
            '--tail',
            '50',
            failureContainerId,
        ])
        expect(plan.step).toEqual(expect.objectContaining({ timeoutMs: 5_000, stdoutLimitBytes: 4_096 }))
        expect(plan.step.argv.join(' ')).not.toContain('api')

        const outcome = await executeProbe(plan.step)
        const admitted = admitFailureLogs({ plan, outcome })
        expect(admitted).toEqual({
            kind: 'complete',
            records: [expect.objectContaining({ containerId: failureContainerId, service: 'api', stream: 'stdout', message: 'password=[redacted]' })],
        })
        expect(JSON.stringify(admitted)).not.toContain('failure-canary')
        expect(admitFailureLogs({ plan, outcome }).kind).toBe('unavailable')
        expect(planFailureLogs({ evidence, ...bounds }).kind).toBe('unavailable')
    })

    it('targets an authenticated service when startup failed before a container identity existed', async () => {
        const timestamp = new Date().toISOString()
        const composeFiles = [
            ...input.composeFiles,
            { reference: 'compose.override.yml', canonicalPath: composeOverridePath, source: composeOverrideSource, sha256: sha(composeOverrideSource) },
        ]
        const evidence = await earlyFailureEvidence(`${timestamp} startup failed\n`, 0, composeFiles)
        const plan = planFailureLogs({ evidence, ...bounds })
        expect(plan.kind).toBe('planned')
        if (plan.kind !== 'planned') return
        expect(plan.step.argv).toEqual([
            plan.step.argv[0],
            'compose',
            '--project-directory',
            runtimeDirectory,
            '--file',
            composePath,
            '--file',
            composeOverridePath,
            '--project-name',
            'synthetic',
            'logs',
            '--no-color',
            '--no-log-prefix',
            '--timestamps',
            '--since',
            plan.step.labels.since,
            '--until',
            plan.step.labels.until,
            '--tail',
            '50',
            '--follow=false',
            '--',
            'api',
        ])
        expect(plan.step.argv.slice(-2)).toEqual(['--', 'api'])
        expect(plan.step.argv).not.toContain('container')
        expect(plan.step.env.COMPOSE_DISABLE_ENV_FILE).toBe('1')
        expect(plan.step.paths).toEqual([composePath, composeOverridePath])
        expect(plan.step.consumedFiles.map(({ path, argvIndexes }) => [path, argvIndexes])).toEqual([
            [plan.step.argv[0], [0]],
            [composePath, [5]],
            [composeOverridePath, [7]],
        ])
        expect(plan.step.filesystemChecks).toEqual([])

        const admitted = admitFailureLogs({ plan, outcome: await executeProbe(plan.step) })
        expect(admitted).toEqual({
            kind: 'complete',
            records: [expect.objectContaining({ containerId: null, service: 'api', stream: 'combined', message: 'startup failed' })],
        })

        // A cockpit's own Compose file inside a product repository runs from that repository.
        mkdirSync(join(runtimeDirectory, 'shop'), { recursive: true })
        const productPath = join(runtimeDirectory, 'shop', 'compose.yml')
        writeFileSync(productPath, composeSource)
        const product = await earlyFailureEvidence(`${timestamp} startup failed\n`, 0,
            [{ reference: 'shop/compose.yml', canonicalPath: productPath, source: composeSource, sha256: sha(composeSource) }],
            { ownComposeFiles: true, cockpitId: cockpitId({ name: 'synthetic', mainCheckoutPath: '/tmp/main' }), stackId: stack })
        const productPlan = planFailureLogs({ evidence: product, ...bounds })
        expect(productPlan.kind).toBe('planned')
        if (productPlan.kind !== 'planned') return
        expect(productPlan.step.argv.slice(2, 4)).toEqual(['--project-directory', join(runtimeDirectory, 'shop')])
    })

    it('treats authenticated empty early-failure output as complete', async () => {
        const evidence = await earlyFailureEvidence('')
        const plan = planFailureLogs({ evidence, ...bounds })
        if (plan.kind !== 'planned') throw new Error(plan.reason)
        expect(admitFailureLogs({ plan, outcome: await executeProbe(plan.step) })).toEqual({ kind: 'complete', records: [] })
    })

    it('retains the authenticated Compose-file preconditions for early-failure logs', async () => {
        const composeFiles = [
            ...input.composeFiles,
            { reference: 'compose.override.yml', canonicalPath: composeOverridePath, source: composeOverrideSource, sha256: sha(composeOverrideSource) },
        ]
        const evidence = await earlyFailureEvidence('', 0, composeFiles)
        const plan = planFailureLogs({ evidence, ...bounds })
        if (plan.kind !== 'planned') throw new Error(plan.reason)
        writeFileSync(composeOverridePath, `${composeOverrideSource}\n# changed`)
        try {
            expect(admitFailureLogs({ plan, outcome: await executeProbe(plan.step) })).toEqual({
                kind: 'unavailable',
                code: 'EXECUTION_PRECONDITION_CHANGED',
                service: 'api',
                records: [],
            })
        } finally {
            writeFileSync(composeOverridePath, composeOverrideSource)
        }
    })

    it('keeps early-failure log execution refusal named and service-scoped', async () => {
        const evidence = await earlyFailureEvidence('', 9)
        const plan = planFailureLogs({ evidence, ...bounds })
        if (plan.kind !== 'planned') throw new Error(plan.reason)
        expect(admitFailureLogs({ plan, outcome: await executeProbe(plan.step) })).toEqual({
            kind: 'unavailable',
            code: 'EXECUTION_STEP_FAILED',
            service: 'api',
            records: [],
        })
    })

    it('consumes early-failure evidence once and rejects copied evidence', async () => {
        const evidence = await earlyFailureEvidence('')
        expect(planFailureLogs({ evidence: { ...evidence } as never, ...bounds }).kind).toBe('unavailable')
        expect(planFailureLogs({ evidence, ...bounds }).kind).toBe('planned')
        expect(planFailureLogs({ evidence, ...bounds }).kind).toBe('unavailable')
    })

    it('accepts no caller-authored runtime, batch, service, or container identity', async () => {
        const evidence = await failureEvidence()
        for (const candidate of [
            structuredClone(evidence),
            { ...evidence, batchId: sha('caller batch') },
            { ...evidence, service: 'worker' },
            { ...evidence, containerId: sha('caller container') },
        ]) {
            expect(planFailureLogs({ evidence: candidate as never, ...bounds }).kind).toBe('unavailable')
        }
        expect(planFailureLogs({ evidence, ...bounds, follow: true } as never).kind).toBe('unavailable')
    })

    it.each([
        { tail: -1 },
        { tail: 100_001 },
        { timeoutMs: 0 },
        { timeoutMs: 300_001 },
        { outputLimitBytes: 0 },
        { outputLimitBytes: 16_777_217 },
    ])('rejects a missing or excessive finite bound %#', async (patch) => {
        const evidence = await failureEvidence()
        expect(planFailureLogs({ evidence, ...bounds, ...patch }).kind).toBe('unavailable')
    })

    it('admits only the exact executor-issued plan outcome', async () => {
        const first = planFailureLogs({ evidence: await failureEvidence(), ...bounds })
        const second = planFailureLogs({ evidence: await failureEvidence(), ...bounds })
        if (first.kind !== 'planned' || second.kind !== 'planned') throw new Error('failure log fixture refused')
        const outcome = await executeProbe(first.step)
        expect(admitFailureLogs({ plan: second, outcome }).kind).toBe('unavailable')
        expect(admitFailureLogs({ plan: { ...first } as never, outcome }).kind).toBe('unavailable')
        expect(admitFailureLogs({
            plan: first,
            outcome: { kind: 'complete', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } as never,
        }).kind).toBe('unavailable')
    })

    it('binds same-window failure-log plans to distinct producer issuance', async () => {
        const timestamp = new Date().toISOString()
        const fixture = {
            path: join(runtimeDirectory, `failure-runtime-shared-${failureRuntimeIndex++}`),
            observationWindow: {
                startedAt: new Date(Date.now() - 10_000).toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
        }
        const first = planFailureLogs({ evidence: await failureEvidence(timestamp, undefined, '', 'running', '', fixture), ...bounds })
        const second = planFailureLogs({ evidence: await failureEvidence(timestamp, undefined, '', 'running', '', fixture), ...bounds })
        if (first.kind !== 'planned' || second.kind !== 'planned') throw new Error('failure log fixture refused')
        expect(first.step.labels.issuanceId).not.toBe(second.step.labels.issuanceId)
        const firstOutcome = await executeProbe(first.step)
        expect(admitFailureLogs({ plan: second, outcome: firstOutcome }).kind).toBe('unavailable')
        expect(admitFailureLogs({ plan: first, outcome: firstOutcome }).kind).toBe('complete')
        expect(admitFailureLogs({ plan: second, outcome: await executeProbe(second.step) }).kind).toBe('complete')
    })

    it('captures failure-log caller envelopes once', async () => {
        const evidence = await failureEvidence()
        const reads = { evidence: 0, tail: 0, timeout: 0, output: 0 }
        const plan = planFailureLogs({
            get evidence() { reads.evidence++; return evidence },
            get tail() { reads.tail++; return bounds.tail },
            get timeoutMs() { reads.timeout++; return bounds.timeoutMs },
            get outputLimitBytes() { reads.output++; return bounds.outputLimitBytes },
        })
        expect(plan.kind).toBe('planned')
        expect(reads).toEqual({ evidence: 1, tail: 1, timeout: 1, output: 1 })
        if (plan.kind !== 'planned') return
        const outcome = await executeProbe(plan.step)
        let planReads = 0
        let outcomeReads = 0
        expect(admitFailureLogs({
            get plan() { planReads++; return plan },
            get outcome() { outcomeReads++; return outcome },
        }).kind).toBe('complete')
        expect({ planReads, outcomeReads }).toEqual({ planReads: 1, outcomeReads: 1 })
    })

    it('rejects a failure-log receipt completed in the future', async () => {
        const plan = planFailureLogs({ evidence: await failureEvidence(), ...bounds })
        if (plan.kind !== 'planned') throw new Error(plan.reason)
        const outcome = await executeProbe(plan.step)
        vi.useFakeTimers()
        vi.setSystemTime(Date.now() - 5_000)
        try {
            expect(admitFailureLogs({ plan, outcome }).kind).toBe('unavailable')
        } finally {
            vi.useRealTimers()
        }
    })

    it.each([
        ['outside window', '1970-01-01T00:00:00.000Z'],
        ['malformed timestamp prefix', 'not-a-timestamp'],
    ])('rejects %s records', async (_case, timestamp) => {
        const plan = planFailureLogs({ evidence: await failureEvidence(timestamp), ...bounds })
        if (plan.kind !== 'planned') throw new Error(plan.reason)
        expect(admitFailureLogs({ plan, outcome: await executeProbe(plan.step) }).kind).toBe('unavailable')
    })

    it('accepts separately timestamped multiline output and rejects an unframed continuation', async () => {
        const first = new Date().toISOString()
        const second = new Date(Date.now() + 1).toISOString()
        const framed = await failureEvidence(first, `${first} first line\n${second} second line\n`)
        const framedPlan = planFailureLogs({ evidence: framed, ...bounds })
        if (framedPlan.kind !== 'planned') throw new Error(framedPlan.reason)
        const admitted = admitFailureLogs({ plan: framedPlan, outcome: await executeProbe(framedPlan.step) })
        expect(admitted.kind === 'complete' && admitted.records.map(({ message }) => message)).toEqual(['first line', 'second line'])

        const unframed = await failureEvidence(first, `${first} first line\ncontinuation without timestamp\n`)
        const unframedPlan = planFailureLogs({ evidence: unframed, ...bounds })
        if (unframedPlan.kind !== 'planned') throw new Error(unframedPlan.reason)
        expect(admitFailureLogs({ plan: unframedPlan, outcome: await executeProbe(unframedPlan.step) }).kind).toBe('unavailable')
    })

    it('admits timestamped stderr-only logs with stream provenance', async () => {
        const timestamp = new Date().toISOString()
        const evidence = await failureEvidence(timestamp, '', `${timestamp} token=stderr-canary\n`)
        const plan = planFailureLogs({ evidence, ...bounds })
        if (plan.kind !== 'planned') throw new Error(plan.reason)
        expect(admitFailureLogs({ plan, outcome: await executeProbe(plan.step) })).toEqual({
            kind: 'complete',
            records: [expect.objectContaining({ stream: 'stderr', message: 'token=[redacted]' })],
        })
    })

    it('deterministically merges timestamped stdout and stderr records', async () => {
        const timestamp = new Date().toISOString()
        const evidence = await failureEvidence(timestamp, `${timestamp} stdout line\n`, `${timestamp} stderr line\n`)
        const plan = planFailureLogs({ evidence, ...bounds })
        if (plan.kind !== 'planned') throw new Error(plan.reason)
        const admitted = admitFailureLogs({ plan, outcome: await executeProbe(plan.step) })
        expect(admitted.kind === 'complete' && admitted.records.map(({ stream, message }) => [stream, message])).toEqual([
            ['stdout', 'stdout line'],
            ['stderr', 'stderr line'],
        ])
    })

    it('orders RFC3339Nano records at full precision before message text', async () => {
        const prefix = new Date().toISOString().slice(0, 19)
        const earlier = `${prefix}.000000001Z`
        const later = `${prefix}.000000009Z`
        const evidence = await failureEvidence(earlier, `${later} a-later\n${earlier} z-earlier\n`)
        const plan = planFailureLogs({ evidence, ...bounds })
        if (plan.kind !== 'planned') throw new Error(plan.reason)
        const admitted = admitFailureLogs({ plan, outcome: await executeProbe(plan.step) })
        expect(admitted.kind === 'complete' && admitted.records.map(({ message }) => message)).toEqual(['z-earlier', 'a-later'])
    })

    it('preserves source order for equal timestamps from the same stream', async () => {
        const timestamp = new Date().toISOString()
        const evidence = await failureEvidence(timestamp, `${timestamp} z-first\n${timestamp} a-second\n`)
        const plan = planFailureLogs({ evidence, ...bounds })
        if (plan.kind !== 'planned') throw new Error(plan.reason)
        const admitted = admitFailureLogs({ plan, outcome: await executeProbe(plan.step) })
        expect(admitted.kind === 'complete' && admitted.records.map(({ message }) => message)).toEqual(['z-first', 'a-second'])
    })

    it('rejects stdout and stderr that exceed the combined output cap', async () => {
        const timestamp = new Date().toISOString()
        const evidence = await failureEvidence(timestamp, `${timestamp} stdout\n`, `${timestamp} stderr\n`)
        const plan = planFailureLogs({ evidence, ...bounds, outputLimitBytes: 60 })
        if (plan.kind !== 'planned') throw new Error(plan.reason)
        expect(admitFailureLogs({ plan, outcome: await executeProbe(plan.step) }).kind).toBe('unavailable')
    })

    it('rejects malformed stderr framing', async () => {
        const timestamp = new Date().toISOString()
        const evidence = await failureEvidence(timestamp, `${timestamp} stdout line\n`, 'stderr without timestamp\n')
        const plan = planFailureLogs({ evidence, ...bounds })
        if (plan.kind !== 'planned') throw new Error(plan.reason)
        expect(admitFailureLogs({ plan, outcome: await executeProbe(plan.step) }).kind).toBe('unavailable')
    })

    it.each([
        ['unhealthy', 'running', 'unhealthy'],
        ['restarting', 'restarting', ''],
        ['exited', 'exited', ''],
    ])('plans authenticated failure logs for an observed %s container', async (_case, state, health) => {
        const observation = await failureEvidence(new Date().toISOString(), undefined, '', state, health)
        expect(planFailureLogs({ evidence: observation, ...bounds }).kind).toBe('planned')
    })

    it('does not accept copied or health-only evidence for the failure-log purpose', async () => {
        const observation = await failureEvidence()
        expect(planFailureLogs({ evidence: { ...observation } as never, ...bounds }).kind).toBe('unavailable')
        const health = admitRuntimeServiceHealth({ observation })
        expect(health.kind).toBe('complete')
        if (health.kind === 'complete') expect(planFailureLogs({ evidence: health.evidence as never, ...bounds }).kind).toBe('unavailable')
        expect(planFailureLogs({ evidence: observation, ...bounds }).kind).toBe('planned')

        const reverseOrder = await failureEvidence()
        expect(planFailureLogs({ evidence: reverseOrder, ...bounds }).kind).toBe('planned')
        expect(admitRuntimeServiceHealth({ observation: reverseOrder }).kind).toBe('complete')
    })
})
