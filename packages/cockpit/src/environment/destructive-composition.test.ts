import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { runDown, runReset } from './application.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import * as lifecycleComposition from './lifecycle-composition.js'
import * as ports from './ports.js'
import { createDestructiveCommandAdapters } from './destructive-composition.js'
import { consumeRuntimeLifecycleProjection } from './runtime.js'
import { publishComposeOwnership } from '../../test-support/compose-ownership-fixture.js'

const roots: string[] = []
const run = promisify(execFile)

afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('destructive command composition', () => {
    it.each(['unix:///synthetic home/docker.sock'])(
        'forwards the exact local host %s and controlled-runtime authority to the lifecycle owner', (host) => {
            const authority = Object.freeze({ kind: 'runtime-measurement-probe-authority' as const })
            const profiles = ['runtime_probe']
            const lifecycleFactory = vi.spyOn(lifecycleComposition, 'createLifecycleCommandAdapters')
            createDestructiveCommandAdapters({
                configPath: '/tmp/cockpit.toml', env: { PATH: '/usr/bin:/bin', HOME: '/tmp', DOCKER_HOST: host },
                sessionId: 'cockpit-cli', timeoutMs: 5_000, dockerContext: 'default',
                activeProfiles: profiles, runtimeMeasurementProbeAuthority: authority,
            }, vi.fn() as never)
            profiles.push('later_profile')
            expect(lifecycleFactory).toHaveBeenCalledWith(expect.objectContaining({
                activeProfiles: ['runtime_probe'], runtimeMeasurementProbeAuthority: authority,
                env: { PATH: '/usr/bin:/bin', HOME: '/tmp', DOCKER_HOST: host },
            }), expect.any(Function))
        })

    it('rejects accessor-backed controlled-runtime authority without invoking it', async () => {
        const getter = vi.fn(() => Object.freeze({ kind: 'runtime-measurement-probe-authority' as const }))
        const execute = vi.fn()
        const adapters = createDestructiveCommandAdapters({
            configPath: '/tmp/cockpit.toml', env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
            sessionId: 'cockpit-cli', timeoutMs: 5_000, dockerContext: 'default',
            get runtimeMeasurementProbeAuthority() { return getter() },
        }, execute as never)
        await expect(adapters.load({ configPath: '/tmp/cockpit.toml' })).resolves.toMatchObject({ kind: 'refusal' })
        expect(getter).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    it('exposes only load, observe, observeReclaim, and execute and cannot mint an operator reset session', async () => {
        const adapters = createDestructiveCommandAdapters({
            configPath: '/tmp/cockpit.toml',
            env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
            dockerContext: 'default',
        }, vi.fn() as never)

        expect(Object.keys(adapters).sort()).toEqual(['execute', 'load', 'observe', 'observeReclaim'])
        expect(adapters).not.toHaveProperty('beginOperatorReset')
        expect(adapters).not.toHaveProperty('decide')
        expect(JSON.stringify(adapters)).not.toContain('continuation')
    })

    // A local DOCKER_HOST is selected through the default context, so only a remote host, a
    // host beside an explicit context, or a TLS override can diverge from the selected daemon.
    it.each([
        ['a remote host', { DOCKER_HOST: 'tcp://127.0.0.1:2375' }, 'default'],
        ['a Windows pipe on a POSIX host', { DOCKER_HOST: 'npipe:////./pipe/docker_engine' }, 'default'],
        ['a remote pipe server', { DOCKER_HOST: 'npipe:////synthetic.invalid/pipe/docker_engine' }, 'default'],
        ['a pipe traversal', { DOCKER_HOST: 'npipe:////./pipe/../docker_engine' }, 'default'],
        ['a pipe beside an explicit context', { DOCKER_HOST: 'npipe:////./pipe/docker_engine', DOCKER_CONTEXT: 'synthetic' }, 'synthetic'],
        ['a local host beside an explicit context', { DOCKER_HOST: 'unix:///tmp/other.sock', DOCKER_CONTEXT: 'synthetic' }, 'synthetic'],
        ['a local host under a named context', { DOCKER_HOST: 'unix:///tmp/other.sock' }, 'synthetic'],
        ['a TLS override', { DOCKER_TLS_VERIFY: '1' }, 'default'],
    ] as const)('refuses %s that can diverge from the selected daemon', async (_label, overrides, dockerContext) => {
        const execute = vi.fn<(_step: never) => Promise<ExecuteProbeOutcome>>()
        const adapters = createDestructiveCommandAdapters({
            configPath: '/tmp/cockpit.toml',
            env: { PATH: '/usr/bin:/bin', HOME: '/tmp', ...overrides },
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
            dockerContext,
        }, execute as never)

        await expect(adapters.load({ configPath: '/tmp/cockpit.toml' })).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }],
        })
        expect(execute).not.toHaveBeenCalled()
    })

    it('observes real checkout, state, runtime, ports, and bounded reclaim evidence through owner APIs', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-destructive-observe-')))
        const stateHome = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-destructive-home-')))
        roots.push(root, stateHome)
        await run('git', ['init', '--quiet', root])
        const configPath = join(root, 'cockpit.toml')
        await writeFile(configPath, [
            '[cockpit]',
            'name = "synthetic-cockpit"',
            'siblings_root = "siblings"',
            '',
            '[[sibling]]',
            'slug = "api"',
            'dir = "api"',
            'mount = "always"',
            'acquire = "none"',
            'var = "API_DIR"',
            'toolchain = "none"',
            'purpose = "Synthetic API"',
            '',
            '[ports]',
            'step = 10',
            'count = 1',
            'bases = { WEB_PORT = 61340 }',
            '',
            '[environment]',
            'compose_files = ["compose.yml"]',
            'resettable_volumes = []',
            'generated_host_paths = []',
            'install_policies = [{ toolchain = "node", volume = "node-modules", lockfile = "package-lock.json", install = ["npm", "ci"], load_probe = ["npm", "test"] }]',
            'runtime_measurements = [{ runtime = "docker-desktop", compose_floor = "2.20.0", measured_on = "2026-09-26", candidate = "passed", broken_control = "rejected", status = "supported" }]',
            '',
            '[environment.machine]',
            'runtime_memory_mb = 1024',
            'runtime_cpus = 1',
            'free_disk_mb = 1024',
            'cold_start_seconds = 30',
            '',
        ].join('\n'))
        const siblingPath = join(root, 'siblings', 'api')
        await writeFile(join(root, 'compose.yml'), [
            'services:',
            '  api:',
            '    image: synthetic.invalid/api',
            '    volumes:',
            '      - type: bind',
            `        source: ${JSON.stringify(siblingPath)}`,
            '        target: /api',
            '',
        ].join('\n'))
        const dockerPath = join(root, 'docker')
        await writeFile(dockerPath, [
            '#!/bin/sh',
            `if [ -f ${JSON.stringify(join(root, 'daemon-stopped'))} ]; then printf "Cannot connect to the Docker daemon\\n" >&2; exit 1; fi`,
            'if [ "$1" = "--host" ]; then shift 2; fi',
            'if [ "$1" = "version" ]; then printf "27.1.2\\n"; exit 0; fi',
            'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then printf "2.39.2\\n"; exit 0; fi',
            'if [ "$1" = "info" ] && [ "$3" = "[{{json .OperatingSystem}},{{json .Name}},{{json .OSType}}]" ]; then printf \'%s\\n\' \'["Docker Desktop","docker-desktop","linux"]\'; exit 0; fi',
            'if [ "$1" = "info" ]; then printf "2147483648|2\\n"; exit 0; fi',
            'if [ "$1" = "compose" ] && printf "%s\\n" "$*" | /usr/bin/grep -q " config "; then printf x >> "$PWD/topology-reads"; /bin/cat "$PWD/topology.json"; exit 0; fi',
            'if [ "$1" = "compose" ] && printf "%s\\n" "$*" | /usr/bin/grep -q " up "; then /usr/bin/touch "$PWD/runtime-up"; exit 0; fi',
            'if [ "$1" = "compose" ] && printf "%s\\n" "$*" | /usr/bin/grep -q " stop"; then /bin/rm -f "$PWD/runtime-up"; exit 0; fi',
            'if [ "$1" = "compose" ] && printf "%s\\n" "$*" | /usr/bin/grep -q " ps --format json"; then if [ -f "$PWD/runtime-up" ]; then /bin/cat "$PWD/runtime.json"; fi; exit 0; fi',
            'if [ "$1" = "compose" ] && printf "%s\\n" "$*" | /usr/bin/grep -q " ps --quiet"; then if [ -f "$PWD/runtime-up" ]; then printf "%s\\n" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; fi; exit 0; fi',
            'if [ "$1" = "compose" ]; then exit 0; fi',
            'if [ "$1" = "volume" ] && [ "$2" = "ls" ]; then /bin/cat "$PWD/volume-discovery.jsonl"; exit 0; fi',
            'if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then shift 4; for volume_name do printf "{\\"name\\":\\"%s\\",\\"generation\\":\\"\\"}\\n" "$volume_name"; done; exit 0; fi',
            'if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then /bin/cat "$PWD/inspect.json"; exit 0; fi',
            'if [ "$1" = "context" ]; then /bin/cat "$PWD/selection.json"; exit 0; fi',
            'exit 0',
            '',
        ].join('\n'), { mode: 0o700 })
        await chmod(dockerPath, 0o700)
        await writeFile(join(root, 'selection.json'), '{"context":"default","endpoint":"unix:///tmp/synthetic.sock"}\n')
        await writeFile(join(root, 'volume-discovery.jsonl'), Array.from({ length: 12 }, (_, index) => JSON.stringify({
            id: `synthetic-volume-${index.toString().padStart(2, '0')}`,
            name: `synthetic-volume-${index.toString().padStart(2, '0')}`,
            labels: {}, referenced: false, bytes: '1B',
        })).join('\n') + '\n')
        await writeFile(join(root, 'runtime-up'), '')
        const input = Object.freeze({
            configPath,
            env: Object.freeze({ PATH: `${root}:/usr/bin:/bin`, HOME: stateHome }),
            sessionId: 'cockpit-cli',
            timeoutMs: 5_000,
            dockerContext: 'default',
        })
        const lifecycle = createLifecycleCommandAdapters({
            configPath, env: input.env, sessionId: input.sessionId, timeoutMs: input.timeoutMs,
        }, executeProbe)
        const loaded = await lifecycle.load({ configPath })
        expect(loaded.kind, JSON.stringify(loaded)).toBe('complete')
        if (loaded.kind !== 'complete') return
        await publishComposeOwnership(root, loaded.result)
        await writeFile(join(root, 'topology.json'), JSON.stringify({ services: { api: {
            labels: {
                'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
                'dev.b0dea.cockpit.config-sha256': loaded.result.source.sha256,
            },
            volumes: [{ type: 'bind', source: siblingPath, target: '/api' }],
        } } }))
        await writeFile(join(root, 'runtime.json'), JSON.stringify({ ID: 'a'.repeat(12), Name: 'synthetic-api-1',
            Project: 'synthetic-cockpit', Service: 'api', State: 'running', Health: '', ExitCode: 0,
            Labels: `com.docker.compose.project=synthetic-cockpit,com.docker.compose.service=api,dev.b0dea.cockpit.config-sha256=${loaded.result.source.sha256},dev.b0dea.cockpit.stack-id=${loaded.result.stackId}`,
        }))
        await writeFile(join(root, 'inspect.json'), JSON.stringify({ ID: 'a'.repeat(64), State: 'running', Health: '', Labels: {
            'com.docker.compose.project': 'synthetic-cockpit', 'com.docker.compose.service': 'api',
            'dev.b0dea.cockpit.config-sha256': loaded.result.source.sha256,
            'dev.b0dea.cockpit.stack-id': loaded.result.stackId,
        } }))
        const acquired = await lifecycle.withAcquiredPorts(loaded.result, async (value) => value)
        expect(acquired).toBeDefined()

        let activeInspections = 0
        let maximumActiveInspections = 0
        let inspectionCalls = 0
        let rejectInspections: 'none' | 'first' | 'all' = 'none'
        const trackedExecute = async (step: Parameters<typeof executeProbe>[0]) => {
            if (!step.labels.resourceKind?.endsWith('-inspection')) return executeProbe(step)
            inspectionCalls += 1
            const inspectionCall = inspectionCalls
            activeInspections += 1
            maximumActiveInspections = Math.max(maximumActiveInspections, activeInspections)
            try {
                await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
                if (rejectInspections === 'all' || rejectInspections === 'first' && inspectionCall === 1) throw new Error('synthetic inspection failure')
                return await executeProbe(step)
            } finally {
                activeInspections -= 1
            }
        }
        const adapters = createDestructiveCommandAdapters(input, trackedExecute)
        const destructive = await adapters.load({ configPath })
        expect(destructive).toMatchObject({
            kind: 'complete',
            result: {
                stackId: loaded.result.stackId,
                checkoutId: loaded.result.checkoutId,
                instance: {
                    launcher: { stackId: loaded.result.stackId, checkoutId: loaded.result.checkoutId },
                    claimInventory: [{ stackId: loaded.result.stackId, checkoutId: loaded.result.checkoutId }],
                },
            },
        })
        if (destructive.kind !== 'complete') return
        await expect(adapters.load({ configPath: join(root, 'other.toml') })).resolves.toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'LIFECYCLE_EVIDENCE_INVALID' }],
        })

        const observation = await adapters.observe(destructive.result)
        const runtime = observation && !('diagnostics' in observation) ? consumeRuntimeLifecycleProjection(observation.runtime) : undefined

        expect(observation).toMatchObject({
            instance: { launcher: { stackId: loaded.result.stackId, checkoutId: loaded.result.checkoutId } },
            down: {
                stackId: loaded.result.stackId,
                coordinationAddress: loaded.result.namespace.paths.coordination(loaded.result.stackId),
                declaredCacheIds: [],
                dependencyCaches: [],
                discovery: { resources: expect.arrayContaining([
                    expect.objectContaining({ id: 'synthetic-volume-00', kind: 'volume' }),
                    expect.objectContaining({ id: 'synthetic-volume-11', kind: 'volume' }),
                ]) },
            },
            reset: {
                stackId: loaded.result.stackId,
                coordinationAddress: loaded.result.namespace.paths.coordination(loaded.result.stackId),
                requesterHolderId: loaded.result.holderId,
                resettableVolumes: [],
                generatedHostPaths: [],
            },
        })
        expect(runtime?.semantics.topology.services).toContainEqual(expect.objectContaining({
            id: 'api', bindMountSources: [siblingPath],
        }))
        // Twelve volumes fit one inspection chunk, so Docker is asked once rather than once per volume.
        expect(inspectionCalls).toBe(1)
        expect(maximumActiveInspections).toBeLessThanOrEqual(4)

        // A drain step re-reads reclaim evidence for the checkout root readiness measured, without
        // measuring the runtime again.
        const topologyReads = () => readFile(join(root, 'topology-reads'), 'utf8').then((text) => text.length, () => 0)
        const readsBefore = await topologyReads()
        const reclaimOnly = await adapters.observeReclaim!(destructive.result)
        expect(reclaimOnly).toMatchObject({ down: { cwd: observation && 'down' in observation ? observation.down.cwd : '', discovery: { resources: expect.any(Array) } } })
        expect(reclaimOnly).not.toHaveProperty('runtime')
        expect(await topologyReads()).toBe(readsBefore)

        // A resource that vanishes between listing and inspection fails one round; one more
        // complete round covers it, and evidence that keeps failing still fails closed.
        rejectInspections = 'first'
        activeInspections = 0
        maximumActiveInspections = 0
        inspectionCalls = 0
        await expect(adapters.observe(destructive.result)).resolves.toMatchObject({ down: { discovery: { resources: expect.any(Array) } } })
        expect(inspectionCalls).toBe(2)
        rejectInspections = 'all'
        inspectionCalls = 0
        await expect(adapters.observe(destructive.result)).resolves.toBeUndefined()
        expect(inspectionCalls).toBe(2)
        expect(activeInspections).toBe(0)
        expect(maximumActiveInspections).toBeLessThanOrEqual(4)
        rejectInspections = 'none'

        await writeFile(join(root, 'daemon-stopped'), '')
        const stoppedDown = await runDown({ configPath }, adapters)
        await rm(join(root, 'daemon-stopped'))
        expect(stoppedDown).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'RUNTIME_UNAVAILABLE' }] })
        expect(JSON.stringify(stoppedDown)).not.toContain('DRAIN_ATTEMPT_REPAIR_REQUIRED')

        const preview = await runReset({ configPath }, adapters)
        expect(preview).toMatchObject({
            kind: 'preview',
            result: { stackId: loaded.result.stackId, targets: [], noop: true },
        })
        expect(JSON.stringify(preview)).not.toContain('continuation')
        expect(JSON.stringify(preview)).not.toContain('authority')

        if (!acquired || acquired.leaseResult.kind !== 'complete') throw new Error('port acquisition unavailable')
        const released = await ports.compensateAcquiredPortHolder({
            namespace: loaded.result.namespace, leaseResult: acquired.leaseResult,
            now: new Date().toISOString(),
        })
        expect(released.kind).toBe('complete')
    })
})
