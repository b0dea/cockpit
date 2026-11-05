import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { executeProbe } from '../src/environment-exec/execute.js'
import { decodeLifecycleRecord, runUp } from '../src/environment/application/lifecycle.js'
import { readState } from '../src/environment/state.js'
import type { ExecutionStep, StackId } from '../src/environment/contract.js'
import { createLifecycleCommandAdapters } from '../src/environment/lifecycle-composition.js'
import { recordLifecycleStarted } from '../src/environment/lifecycle-stage.js'
import { composeProjectName } from '../src/environment/identity.js'
import { syncGeneratedEnvironment } from '../src/generated-environment/command.js'
import { publishComposeOwnership } from './compose-ownership-fixture.js'
import { recordSyntheticMeasurement } from './runtime-measurement-fixture.js'

const run = promisify(execFile)

type ListenerProbeControl = {
    enabled: boolean
    active: number
    maximumActive: number
    calls: number
    delayMs: number
}

export function createLifecycleCompositionFixtureSupport(
    roots: string[],
    listenerProbeControl: ListenerProbeControl,
) {
async function fixture(portCount = 2, runtimeMeasurement: 'supported' | 'unmeasured' = 'supported') {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-lifecycle-composition-')))
    roots.push(root)
    const checkout = join(root, 'checkout')
    const home = join(root, 'home')
    await Promise.all([mkdir(checkout), mkdir(home)])
    await run('git', ['init', '--quiet', checkout])
    const configPath = join(checkout, 'cockpit.toml')
    const composePath = join(checkout, 'compose.yml')
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
        `count = ${portCount}`,
        'bases = { APP_PORT = 61230 }',
        '',
        '[environment]',
        'compose_files = ["compose.yml"]',
        'entrypoint_derivatives = [{ name = "web", kind = "entrypoint", port = "APP_PORT", path = "/" }]',
        '',
        '[environment.machine]',
        'runtime_memory_mb = 1024',
        'runtime_cpus = 1',
        'free_disk_mb = 1024',
        'cold_start_seconds = 30',
        '',
    ].join('\n'))
    await writeFile(composePath, 'services: {}\n')
    if (runtimeMeasurement === 'supported') await recordSyntheticMeasurement(home)
    const dockerPath = join(root, 'docker')
    await writeFile(dockerPath, [
        '#!/bin/sh',
        'if [ "$1" = "version" ]; then printf "27.1.2\\n"; exit 0; fi',
        'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then printf "2.39.2\\n"; exit 0; fi',
        'if [ "$1" = "info" ] && [ "$3" = "[{{json .OperatingSystem}},{{json .Name}},{{json .OSType}}]" ]; then printf \'%s\\n\' \'["Docker Desktop","docker-desktop","linux"]\'; exit 0; fi',
        'if [ "$1" = "info" ]; then printf "2147483648|2\\n"; exit 0; fi',
        'if [ "$1" = "compose" ]; then /bin/cat "$PWD/topology.json"; exit 0; fi',
        'exit 64',
        '',
    ].join('\n'), { mode: 0o700 })
    await chmod(dockerPath, 0o700)
    return { root, checkout, home, configPath, composePath, dockerPath }
}

// A one-service stack run from its own compose.yml, with a resettable data volume, against a
// scripted docker that answers the topology, inspection and lifecycle calls the owners make.
async function stackFixture(options: Readonly<{ seed?: readonly string[]; memoryMb?: number; profiles?: readonly string[] }> = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-lifecycle-stack-')))
    roots.push(root)
    const checkout = join(root, 'checkout')
    const home = join(root, 'home')
    await Promise.all([mkdir(checkout), mkdir(home)])
    await run('git', ['init', '--quiet', checkout])
    // A synced cockpit has its .cockpit directory, where up records the inputs the stack started on.
    await Promise.all([mkdir(join(checkout, 'app')), mkdir(join(checkout, '.cockpit'))])
    const configPath = join(checkout, 'cockpit.toml')
    await writeFile(configPath, [
        '[cockpit]',
        'name = "stack-environment"',
        'siblings_root = "."',
        '',
        '[[sibling]]',
        'slug = "app"',
        'dir = "app"',
        'mount = "always"',
        'acquire = "none"',
        'var = "APP_DIR"',
        'purpose = "Synthetic application"',
        '',
        '[ports.bases]',
        'APP_HOST_PORT = 4100',
        '',
        '[environment]',
        'compose_files = ["compose.yml"]',
        'resettable_volumes = ["product-data"]',
        ...(options.seed ? [`seed = { argv = ${JSON.stringify(options.seed)}, timeout_seconds = 30 }`] : []),
        'addressing = "hostname"',
        'authentication = "bypassed"',
        'posture_requirements = [{ requirement = "synthetic-route", addressing = "hostname", authentication = "bypassed" }]',
        '',
        '[environment.machine]',
        `runtime_memory_mb = ${options.memoryMb ?? 1024}`,
        'runtime_cpus = 1',
        'free_disk_mb = 1024',
        'cold_start_seconds = 30',
        '',
    ].join('\n'))
    await writeFile(join(checkout, 'compose.yml'), [
        'services:',
        '  app:',
        `    image: ${STACK_IMAGE}`,
        ...(options.profiles ? [`    profiles: ${JSON.stringify(options.profiles)}`] : []),
        '    ports: ["127.0.0.1:${APP_HOST_PORT:-4100}:3000"]',
        '    volumes: ["./app:/workspace/source", "product-data:/workspace/data"]',
        'volumes:',
        '  product-data: {}',
        '',
    ].join('\n'))
    await recordSyntheticMeasurement(home)
    const dockerPath = join(root, 'docker')
    await writeFile(dockerPath, [
        '#!/bin/sh',
        'if [ "$1" = "version" ]; then printf "27.1.2\\n"; exit 0; fi',
        'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then printf "2.39.2\\n"; exit 0; fi',
        'if [ "$1" = "info" ] && [ "$3" = "[{{json .OperatingSystem}},{{json .Name}},{{json .OSType}}]" ]; then printf \'%s\\n\' \'["Docker Desktop","docker-desktop","linux"]\'; exit 0; fi',
        'if [ "$1" = "info" ]; then printf "2147483648|2\\n"; exit 0; fi',
        'exit 64',
        '',
    ].join('\n'), { mode: 0o700 })
    await chmod(dockerPath, 0o700)
    return { root, checkout, home, configPath, dockerPath }
}

const STACK_IMAGE = 'node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5'

async function configureStackDocker(
    candidate: Awaited<ReturnType<typeof stackFixture>>,
    context: Readonly<{ stackId: string; cockpitId: string; runtimeSha256: string }>,
    // Further directories under the checkout that the app service bind-mounts.
    binds: readonly string[] = [],
    healthcheck = true,
    profiles?: readonly string[],
) {
    await publishComposeOwnership(candidate.checkout, context)
    const containerId = 'a'.repeat(64)
    const projectName = composeProjectName({ cockpitName: 'stack-environment', stackId: context.stackId as StackId })
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const labels = { 'dev.b0dea.cockpit.stack-id': context.stackId, 'dev.b0dea.cockpit.config-sha256': context.runtimeSha256 }
    const topology = {
        volumes: { 'product-data': { name: `${projectName}_product-data` } },
        services: { app: {
            image: STACK_IMAGE,
            ...profiles ? { profiles } : {},
            ...healthcheck ? { healthcheck: { test: ['CMD', 'true'] } } : {},
            labels,
            volumes: [
                { type: 'bind', source: join(candidate.checkout, 'app'), target: '/workspace/source' },
                ...binds.map((path) => ({ type: 'bind', source: join(candidate.checkout, path), target: `/workspace/${path}` })),
                { type: 'volume', source: 'product-data', target: '/workspace/data' },
            ],
        } },
    }
    const psRow = JSON.stringify({ ID: containerId.slice(0, 12), Project: projectName, Service: 'app', State: 'running',
        Health: healthcheck ? 'healthy' : '', Status: 'Up 1 minute', ExitCode: 0 })
    const status = JSON.stringify({ ID: containerId, State: 'running', Health: healthcheck ? 'healthy' : '',
        Mounts: [{ Type: 'bind', Source: join(candidate.checkout, 'app'), Destination: '/workspace/source' },
            ...binds.map((path) => ({ Type: 'bind', Source: join(candidate.checkout, path), Destination: `/workspace/${path}` }))],
        Ports: {}, Labels: { ...labels, 'com.docker.compose.project': projectName, 'com.docker.compose.service': 'app' } })
    const stoppedPath = join(candidate.root, 'runtime-stopped')
    const removedPath = join(candidate.root, 'runtime-removed')
    const resource = JSON.stringify({ id: containerId, name: 'synthetic-app', labels: {
        ...labels, 'dev.b0dea.cockpit.owner-id': context.cockpitId }, referenced: false, bytes: '0B' })
    const effectivePorts = JSON.stringify({ services: { app: { ports: [{ target: 3000, published: '%s' }] } } })
    // A call whose arguments contain the needle file's line fails, so a test can break one step.
    const failurePath = join(candidate.root, 'docker-failure-needle')
    await writeFile(failurePath, '\n')
    await writeFile(candidate.dockerPath, `#!/bin/sh
IFS= read -r fail_needle < ${shellQuote(failurePath)} || exit 64
joined="$*"
if [ -n "$fail_needle" ]; then
    case "$joined" in *"$fail_needle"*) exit 23 ;; esac
fi
has() {
    expected=$1
    shift
    for value do
        [ "$value" != "$expected" ] || return 0
    done
    return 1
}
if [ "$1" = --host ]; then shift 2; fi
case "$1" in
    context) [ "$2" = inspect ] || exit 64; printf '%s\\n' '{"context":"default","endpoint":"unix:///tmp/synthetic.sock"}'; exit 0 ;;
    volume)
        case "$2" in
            ls)
                # Only the seed asks for the Compose key beside each name.
                case "$joined" in *'{{.Name}}'*) printf '%s\\t%s\\n' ${shellQuote(`${projectName}_product-data`)} product-data ;; esac
                exit 0 ;;
            inspect)
                created=$(/bin/cat ${shellQuote(join(candidate.root, 'volume-created-at'))} 2>/dev/null || printf '2000-01-01T00:00:00Z')
                shift 4
                for _ do printf '"%s"\\n' "$created"; done
                exit 0 ;;
        esac
        exit 64 ;;
    network|image) [ "$2" = ls ] || exit 64; exit 0 ;;
    builder) [ "$2" = du ] || exit 64; exit 0 ;;
    version) printf '27.1.2\\n'; exit 0 ;;
    info)
        case "$joined" in
            *OperatingSystem*) printf '%s\\n' '["Docker Desktop","docker-desktop","linux"]' ;;
            *) printf '2147483648|2\\n' ;;
        esac
        exit 0 ;;
    compose)
        if [ "$2" = version ]; then printf '2.39.2\\n'; exit 0; fi
        # Like Compose v2, stop reports progress on stderr unless it is told to be quiet.
        if has stop "$@"; then : > ${shellQuote(stoppedPath)}; has quiet "$@" || printf ' Container app Stopped\\n' >&2; exit 0; fi
        if has config "$@"; then
            if has --no-env-resolution "$@"; then printf '%s' ${shellQuote(JSON.stringify(topology))}
            else printf ${shellQuote(effectivePorts)} "$APP_HOST_PORT"; fi
            exit 0
        fi
        if has ps "$@"; then
            if [ -f ${shellQuote(stoppedPath)} ]; then exit 0; fi
            if has --format "$@"; then printf '%s\\n' ${shellQuote(psRow)}; exit 0; fi
            if has --quiet "$@"; then printf '%s\\n' ${shellQuote(containerId)}; exit 0; fi
            exit 64
        fi
        if has restart "$@"; then exit 0; fi
        if has up "$@"; then /bin/rm -f ${shellQuote(stoppedPath)} ${shellQuote(removedPath)}; exit 0; fi ;;
    container)
        case "$2" in
            ls)
                if [ -f ${shellQuote(removedPath)} ]; then exit 0; fi
                # Reclaim discovery lists the stack's labelled containers; its network-holder
                # listing finds none here, since the stack's network is not part of this fixture.
                case "$joined" in
                    *"label=dev.b0dea.cockpit.stack-id="*) printf '%s\\n' ${shellQuote(resource)} ;;
                    *"network="*) ;;
                    *) if has --filter "$@"; then printf '%s\\n' ${shellQuote(containerId)};
                       else printf '%s\\n' ${shellQuote(resource)}; fi ;;
                esac
                exit 0 ;;
            rm) : > ${shellQuote(removedPath)}; exit 0 ;;
            inspect)
                # Docker 29.8.2 runs a template naming a key its typed result lacks, such as .Id,
                # against the raw JSON, where a container without a healthcheck has no State.Health
                # key and a field access on it fails; index returns nothing instead.
                ${healthcheck ? '' : `case "$joined" in *'.State.Health}}'*) printf '%s\\n' 'template parsing error: map has no entry for key "Health"' >&2; exit 1 ;; esac`}
                printf '%s' ${shellQuote(status)}; exit 0 ;;
        esac ;;
esac
exit 64
`, { mode: 0o700 })
    await chmod(candidate.dockerPath, 0o700)
    return { containerId }
}

// `synced` runs the real sync first, for a test that goes on to sync or check that ownership. The
// other scenarios only need the override up hands Compose, and a sync costs dozens of child processes.
async function runStackScenario(options: Readonly<{ seed?: readonly string[]; memoryMb?: number; healthcheck?: boolean; profiles?: readonly string[]; synced?: boolean }> = {}) {
    const candidate = await stackFixture(options)
    if (options.synced) {
        // sync reads the state root from HOME.
        const home = process.env.HOME
        process.env.HOME = candidate.home
        try {
            const synced = await syncGeneratedEnvironment({ configPath: candidate.configPath })
            if (synced.kind !== 'complete') throw new Error(JSON.stringify(synced.diagnostics))
        } finally {
            process.env.HOME = home
        }
    }
    const steps: ExecutionStep[] = []
    const adapters = createLifecycleCommandAdapters({
        configPath: candidate.configPath,
        env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
        sessionId: 'stack-production',
        timeoutMs: 5_000,
        ...options.profiles ? { activeProfiles: options.profiles } : {},
    }, async (step) => {
        steps.push(step)
        return executeProbe(step)
    })
    const loaded = await adapters.load({ configPath: candidate.configPath })
    if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded))
    const started = await recordLifecycleStarted({
        namespace: loaded.result.namespace,
        stackId: loaded.result.stackId,
        holderId: loaded.result.holderId,
        observedAt: new Date().toISOString(),
    })
    if (started.kind === 'refusal') throw new Error(JSON.stringify(started))
    const docker = await configureStackDocker(candidate, loaded.result, [], options.healthcheck, options.profiles)
    listenerProbeControl.enabled = true
    const result = await runUp({ configPath: candidate.configPath }, adapters)
    const recorded = await readState(loaded.result.namespace.paths.lifecycle(loaded.result.stackId))
    const inputs = recorded.kind === 'complete' ? decodeLifecycleRecord(recorded.value, loaded.result)?.value.runtimeInputs : undefined
    return { candidate, adapters, context: loaded.result, docker, result, steps, inputs }
}

return { fixture, stackFixture, configureStackDocker, runStackScenario }
}
