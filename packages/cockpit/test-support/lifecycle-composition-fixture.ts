import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { executeProbe } from '../src/environment-exec/execute.js'
import { runUp } from '../src/environment/application.js'
import type { ExecutionStep, StackId } from '../src/environment/contract.js'
import { createLifecycleCommandAdapters } from '../src/environment/lifecycle-composition.js'
import { recordLifecycleStarted } from '../src/environment/lifecycle-stage.js'
import { admitDependencyRuntime, createDependencyRuntimePlan } from '../src/environment/dependency-runtime.js'
import { observeDependencyLoad } from '../src/environment/installs.js'
import { checkoutId, composeProjectName } from '../src/environment/identity.js'
import { projectDependencyRuntime } from '../src/environment/runtime.js'
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
    if (runtimeMeasurement === 'supported') await recordSyntheticMeasurement(checkout)
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

async function generatedFixture(options: Readonly<{ secondSibling?: boolean; dataMode?: 'empty' | 'seeded' | 'restored'; layout?: 'root' | 'nested' | 'worktree'; toolchain?: 'none' }> = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-lifecycle-generated-')))
    roots.push(root)
    const mainCheckout = join(root, 'checkout')
    const gitCheckout = options.layout === 'worktree' ? join(root, 'linked') : mainCheckout
    const checkout = options.layout && options.layout !== 'root' ? join(gitCheckout, 'cockpit') : gitCheckout
    const home = join(root, 'home')
    await Promise.all([mkdir(mainCheckout), mkdir(home)])
    await run('git', ['init', '--quiet', mainCheckout])
    if (options.layout === 'worktree') {
        await run('git', ['-C', mainCheckout, '-c', 'user.name=Synthetic Maintainer', '-c', 'user.email=maintainer@example.invalid',
            'commit', '--quiet', '--allow-empty', '-m', 'Initialize synthetic checkout'])
        await run('git', ['-C', mainCheckout, 'worktree', 'add', '--quiet', '--detach', gitCheckout])
    }
    await mkdir(checkout, { recursive: true })
    await Promise.all([mkdir(join(checkout, 'fixtures')), mkdir(join(checkout, 'app')),
        ...(options.secondSibling ? [mkdir(join(checkout, 'worker'))] : [])])
    let base = (await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8'))
        .replace('compose_file = "compose.generated.yml"', 'compose_file = "generated/compose.yml"')
        .replace('name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."')
        .replace('default_mode = "seeded"', `default_mode = "${options.dataMode ?? 'seeded'}"`)
        .replace('subject = "data-default"\nsubject_id = "seeded"', `subject = "data-default"\nsubject_id = "${options.dataMode ?? 'seeded'}"`)
    if (options.toolchain === 'none') base = base.replace('toolchain = \"node\"', 'toolchain = \"none\"')
    if (options.secondSibling) {
        const serviceStart = base.indexOf('[[environment.generated.services]]')
        const volumeStart = base.indexOf('[[environment.generated.volumes]]')
        const workerService = base.slice(serviceStart, volumeStart)
            .replaceAll('id = "app"', 'id = "worker"')
            .replaceAll('sibling = "app"', 'sibling = "worker"')
            .replaceAll('service = "app"', 'service = "worker"')
            .replaceAll('APP_HOST_PORT', 'WORKER_HOST_PORT')
            .replaceAll('source = "dependencies"', 'source = "worker-dependencies"')
        const decision = (id: string, nextId: string, replacements: Readonly<Record<string, string>>) => {
            const start = base.indexOf(`[[environment.generated.decisions.entries]]\nid = "${id}"`)
            const end = base.indexOf('[[environment.generated.decisions.entries]]', start + 1)
            let block = base.slice(start, end < 0 ? undefined : end)
            for (const [from, to] of Object.entries(replacements)) block = block.replaceAll(from, to)
            return block.replace(`id = "${id}"`, `id = "${nextId}"`)
        }
        const workerDecisions = [
            decision('service-app', 'service-worker', { 'subject_id = "app"': 'subject_id = "worker"' }),
            decision('volume-dependencies', 'volume-worker-dependencies', { 'subject_id = "dependencies"': 'subject_id = "worker-dependencies"' }),
            decision('mount-dependencies', 'mount-worker-dependencies', { 'subject_id = "app:volume:dependencies:/workspace/node_modules"': 'subject_id = "worker:volume:worker-dependencies:/workspace/node_modules"' }),
            decision('mount-data', 'mount-worker-data', { 'subject_id = "app:volume:product-data:/workspace/data"': 'subject_id = "worker:volume:product-data:/workspace/data"' }),
            decision('mount-source', 'mount-worker-source', { 'subject_id = "app:bind:.:/workspace/source"': 'subject_id = "worker:bind:.:/workspace/source"' }),
            decision('mount-environment', 'mount-worker-environment', { 'subject_id = "app:environment-file:.env:/workspace/.env"': 'subject_id = "worker:environment-file:.env:/workspace/.env"' }),
            decision('port-http', 'port-worker-http', { 'subject_id = "app:http"': 'subject_id = "worker:http"' }),
        ].join('\n')
        base = base
            .replace('[ports.bases]', [
                '[[sibling]]',
                'slug = "worker"',
                'dir = "worker"',
                'mount = "always"',
                'acquire = "none"',
                'var = "WORKER_DIR"',
                'toolchain = "python"',
                'purpose = "Synthetic worker"',
                '',
                '[[sibling.environment_files]]',
                'template = ".env.example"',
                'instance = ".env"',
                '',
                '[ports.bases]',
            ].join('\n'))
            .replace('APP_HOST_PORT = 4100', 'APP_HOST_PORT = 4100\nWORKER_HOST_PORT = 8100')
            .replace('[environment.generated]', [
                '[[environment.install_policies]]',
                'toolchain = "python"',
                'volume = "worker-dependencies"',
                'lockfile = "package-lock.json"',
                'install = [ "npm", "ci" ]',
                'load_probe = [ "node", "probe.mjs", "load" ]',
                '',
                '[environment.generated]',
            ].join('\n'))
            .replace('[[environment.generated.volumes]]', `${workerService}\n[[environment.generated.volumes]]`)
            .replace('[[environment.generated.volumes]]\nid = "product-data"', [
                '[[environment.generated.volumes]]',
                'id = "worker-dependencies"',
                'purpose = "dependencies"',
                'install_policy = "worker-dependencies"',
                'target = "/workspace/node_modules"',
                '',
                '[environment.generated.volumes.provenance]',
                'source = "overlay.toml"',
                'observed_on = "2026-09-26"',
                'kind = "declared"',
                'reason = "Synthetic declaration"',
                '',
                '[[environment.generated.volumes]]',
                'id = "product-data"',
            ].join('\n'))
            .concat('\n', workerDecisions)
    }
    const configPath = join(checkout, 'cockpit.toml')
    await writeFile(configPath, [
        '[environment]',
        'addressing = "hostname"',
        'authentication = "bypassed"',
        'posture_requirements = [{ requirement = "synthetic-route", addressing = "hostname", authentication = "bypassed" }]',
        '',
        '[environment.machine]',
        'runtime_memory_mb = 1024',
        'runtime_cpus = 1',
        'free_disk_mb = 1024',
        'cold_start_seconds = 30',
        '',
        base,
    ].join('\n'))
    await writeFile(join(checkout, 'fixtures/personas.json'), '[{"id":"first"}]\n')
    await recordSyntheticMeasurement(checkout)
    await writeFile(join(checkout, 'app/.env'), [
        'MESSAGES_TOKEN=synthetic-token',
        'MESSAGES_URL=https://app:3000/messages',
        'ALLOW_MESSAGES_EGRESS=0',
        '',
    ].join('\n'))
    await writeFile(join(checkout, 'app/.node-version'), '22.0.0\n')
    await writeFile(join(checkout, 'app/package-lock.json'), '{"lockfileVersion":3}\n')
    if (options.secondSibling) {
        await writeFile(join(checkout, 'worker/.env'), 'WORKER_TOKEN=synthetic-token\n')
        await writeFile(join(checkout, 'worker/.node-version'), '22.0.0\n')
        await writeFile(join(checkout, 'worker/package-lock.json'), '{"lockfileVersion":3}\n')
    }
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
    return { root, checkout, mainCheckout, gitCheckout, home, configPath, dockerPath }
}

async function configureGeneratedDocker(
    candidate: Awaited<ReturnType<typeof generatedFixture>>,
    context: Readonly<{ stackId: string; cockpitId: string; runtimeSha256: string }>,
    generation: string,
    options: Readonly<{ portOffset?: number; failNeedle?: string; secondSibling?: boolean; sourceDirectory?: string; environmentFile?: string; build?: Readonly<{ context: string; dockerfile?: string }> }> = {},
) {
    const containerId = 'a'.repeat(64)
    const shortId = containerId.slice(0, 12)
    const project = `cockpit-${generation.slice(0, 12)}`
    const image = 'node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5'
    const failurePath = join(candidate.root, 'docker-failure-needle')
    await writeFile(failurePath, `${options.failNeedle ?? ''}\n`)
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const services = options.secondSibling ? ['app', 'worker'] : ['app']
    const dockerFixture = {
        containerId,
        shortId,
        projectName: composeProjectName({ cockpitName: 'generated-environment', stackId: context.stackId as StackId }),
        stackId: context.stackId,
        sourceSha256: context.runtimeSha256,
        generation,
        image,
        imageId: `sha256:${'b'.repeat(64)}`,
        dependencyVolume: `${project}_dependencies`,
        services,
        portOffset: options.portOffset ?? 0,
        topology: {
            volumes: {
                dependencies: { name: `${project}_dependencies` },
                ...(options.secondSibling ? { 'worker-dependencies': { name: `${project}_worker-dependencies` } } : {}),
                'product-data': { name: `${project}_product-data` },
            },
            services: Object.fromEntries(services.map((service) => [service, {
                profiles: ['application'],
                ...(options.build ? { build: { ...options.build, context: join(candidate.checkout, service, options.build.context), dockerfile: options.build.dockerfile ?? 'Dockerfile' } } : { image }),
                healthcheck: { test: ['CMD', 'true'] },
                labels: {
                    'dev.b0dea.cockpit.stack-id': context.stackId,
                    'dev.b0dea.cockpit.config-sha256': context.runtimeSha256,
                    'dev.b0dea.cockpit.generation-id': generation,
                    'dev.b0.cockpit.generated': '1',
                    'dev.b0.cockpit.generation': generation,
                    'dev.b0.cockpit.source-sha256': context.runtimeSha256,
                },
                volumes: [
                    { type: 'bind', source: join(candidate.checkout, service, options.sourceDirectory ?? '.'), target: '/workspace/source' },
                    { type: 'bind', source: join(candidate.checkout, service, options.environmentFile ?? '.env'), target: '/workspace/.env' },
                    { type: 'volume', source: service === 'app' ? 'dependencies' : 'worker-dependencies', target: '/workspace/node_modules' },
                    { type: 'volume', source: 'product-data', target: '/workspace/data' },
                ],
            }])),
        },
    }
    const psRow = (service: string) => JSON.stringify({
        ID: String.fromCharCode(97 + services.indexOf(service)).repeat(12),
        Project: dockerFixture.projectName,
        Service: service,
    })
    const serviceSelection = services.map((service, index) =>
        `${index === 0 ? 'if' : 'elif'} has ${shellQuote(service)} "$@"; then selected=${shellQuote(service)};`,
    ).join(' ') + ' fi'
    const status = (service: string) => JSON.stringify({
        ID: service === 'app' ? containerId : 'b'.repeat(64), State: 'running', Health: 'healthy',
        Mounts: (dockerFixture.topology.services[service]?.volumes ?? []).filter(({ type }) => type === 'bind')
            .map(({ source, target }) => ({ Type: 'bind', Source: source, Destination: target })),
        Ports: {},
        Labels: {
            'dev.b0dea.cockpit.stack-id': dockerFixture.stackId,
            'dev.b0dea.cockpit.config-sha256': dockerFixture.sourceSha256,
            'com.docker.compose.project': dockerFixture.projectName,
            'com.docker.compose.service': service,
        },
    })
    const mounts = (service: string) => JSON.stringify({
        ID: service === 'app' ? containerId : 'b'.repeat(64),
        Image: dockerFixture.imageId,
        ConfigImage: image,
        Labels: { stack: dockerFixture.stackId, config: dockerFixture.sourceSha256, generation,
            generatedGeneration: generation, source: dockerFixture.sourceSha256,
            project: dockerFixture.projectName, service },
        Mounts: [{ Type: 'volume', Name: service === 'app' ? dockerFixture.dependencyVolume
            : dockerFixture.dependencyVolume.replace('_dependencies', '_worker-dependencies'),
        Destination: '/workspace/node_modules' }],
    })
    const stoppedPath = join(candidate.root, 'runtime-stopped')
    const removedPath = join(candidate.root, 'runtime-removed')
    const resource = JSON.stringify({ id: containerId, name: 'synthetic-app', labels: {
        'dev.b0dea.cockpit.stack-id': context.stackId,
        'dev.b0dea.cockpit.config-sha256': context.runtimeSha256,
        'dev.b0dea.cockpit.owner-id': context.cockpitId,
    }, referenced: false, bytes: '0B' })
    const effectivePorts = JSON.stringify({ services: Object.fromEntries(services.map((service) =>
        [service, { ports: [{ target: 3000, published: '%s' }] }])) })
    const effectivePortArguments = services.map((service) =>
        `"$(( ${service === 'app' ? 'APP_HOST_PORT' : 'WORKER_HOST_PORT'} + ${dockerFixture.portOffset} ))"`,
    ).join(' ')
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
    network|volume|image) [ "$2" = ls ] || exit 64; exit 0 ;;
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
            if has --no-env-resolution "$@"; then
                printf '%s' ${shellQuote(JSON.stringify(dockerFixture.topology))}
            else
                printf ${shellQuote(effectivePorts)} ${effectivePortArguments}
            fi
            exit 0
        fi
        if has ps "$@"; then
            if [ -f ${shellQuote(stoppedPath)} ]; then exit 0; fi
            selected=all
            ${serviceSelection}
            if has --format "$@"; then
                case "$selected" in
${services.map((service) => `                    ${service}) printf '%s\\n' ${shellQuote(psRow(service))} ;;`).join('\n')}
                    *) printf '%s\\n' ${shellQuote(services.map(psRow).join('\n'))} ;;
                esac
                exit 0
            fi
            if has --quiet "$@"; then
                case "$selected" in
${services.map((service, index) => `                    ${service}) printf '%s\\n' ${shellQuote(String.fromCharCode(97 + index).repeat(64))} ;;`).join('\n')}
                    *) printf '%s\\n' ${shellQuote(containerId)} ;;
                esac
                exit 0
            fi
            exit 64
        fi
        if has exec "$@"; then
            case "$joined" in
                *'data.mjs fresh-volume'*)
                    printf '%s' ${shellQuote(JSON.stringify({ volume: 'product-data', state: 'empty', generation }))}
                    exit 0 ;;
            esac
        fi
        if has up "$@"; then /bin/rm -f ${shellQuote(stoppedPath)} ${shellQuote(removedPath)}; exit 0; fi
        if has exec "$@"; then exit 0; fi ;;
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
                service=app
                for value do
                    case "$value" in ''|*[!b]*) continue ;; esac
                    if [ "${'${#value}'}" -ge 12 ] && [ "${'${#value}'}" -le 64 ]; then service=worker; break; fi
                done
                format=''
                while [ "$#" -gt 0 ]; do
                    if [ "$1" = --format ]; then shift; format=${'${1-}'}; break; fi
                    shift
                done
                case "$format" in
                    *NetworkSettings.Ports*)
                        if [ "$service" = worker ]; then printf '%s' ${shellQuote(status('worker'))};
                        else printf '%s' ${shellQuote(status('app'))}; fi ;;
                    *Mounts*)
                        if [ "$service" = worker ]; then printf '%s' ${shellQuote(mounts('worker'))};
                        else printf '%s' ${shellQuote(mounts('app'))}; fi ;;
                    *)
                        if [ "$service" = worker ]; then printf '%s' ${shellQuote(status('worker'))};
                        else printf '%s' ${shellQuote(status('app'))}; fi ;;
                esac
                exit 0 ;;
            exec)
                if has uname "$@"; then printf 'x86_64\\n'; exit 0; fi
                case "$joined" in *'getconf GNU_LIBC_VERSION'*) printf 'glibc:2.36\\n' ;; esac
                exit 0 ;;
        esac ;;
    run) exit 0 ;;
esac
exit 64
`, { mode: 0o700 })
    await chmod(candidate.dockerPath, 0o700)
    return { containerId }
}

async function runGeneratedScenario(options: Readonly<{ portOffset?: number; failNeedle?: string; dependencyLoadOnly?: boolean; secondSibling?: boolean; forgedProgress?: boolean; failedVendorEvidence?: boolean; dataMode?: 'empty' | 'seeded' | 'restored'; layout?: 'root' | 'nested' | 'worktree'; toolchain?: 'none' }> = {}) {
    const candidate = await generatedFixture(options)
    const steps: ExecutionStep[] = []
    const adapters = createLifecycleCommandAdapters({
        configPath: candidate.configPath,
        env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
        sessionId: 'generated-production',
        timeoutMs: 5_000,
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
    const generation = createHash('sha256').update(`generated-environment\0${loaded.result.runtimeSha256}`).digest('hex')
    const docker = await configureGeneratedDocker(candidate, loaded.result, generation, options)
    listenerProbeControl.enabled = true
    let dependencyOutcome: Awaited<ReturnType<typeof adapters.completeGeneratedDependencies>> | undefined
    const selectedAdapters = options.dependencyLoadOnly ? {
        ...adapters,
        completeGeneratedDependencies: async (...args: Parameters<typeof adapters.completeGeneratedDependencies>) => {
            const [, runtime, services] = args
            const evidence = services.find(({ service }) => service === 'app')
            if (!evidence) throw new Error('dependency service fixture unavailable')
            const projection = projectDependencyRuntime({ topology: runtime.topology, evidence, service: 'app', volume: 'dependencies' })
            if (!projection) throw new Error('dependency runtime fixture unavailable')
            const plan = createDependencyRuntimePlan({ runtime: projection })
            if (plan.kind !== 'planned') throw new Error(plan.reason)
            const admitted = admitDependencyRuntime({ plan,
                inspectOutcome: await adapters.execute(plan.inspect),
                architectureOutcome: await adapters.execute(plan.architecture),
                abiOutcome: await adapters.execute(plan.abi) })
            if (admitted.kind !== 'complete') throw new Error(admitted.reason)
            const observation = await observeDependencyLoad({ binding: admitted.binding,
                env: {}, load: ['/bin/true'], timeoutMs: 5_000,
                stdoutLimitBytes: 65_536, stderrLimitBytes: 65_536 }, { execute: adapters.execute })
            if (!observation || observation.observed.state !== 'available') throw new Error('dependency load fixture unavailable')
            return { kind: 'complete' as const, status: 0 as const, diagnostics: [], result: [observation] }
        },
    } : options.failedVendorEvidence ? {
        ...adapters,
        completeGeneratedVendors: async (...args: Parameters<typeof adapters.completeGeneratedVendors>) => {
            const healthy = await adapters.completeGeneratedVendors(...args)
            await writeFile(join(candidate.root, 'docker-failure-needle'), 'vendor.mjs route\n')
            const failed = await adapters.completeGeneratedVendors(...args)
            if (healthy.kind !== 'complete' || failed.kind !== 'refusal') throw new Error('vendor substitution fixture unavailable')
            return { ...healthy, progressEvidence: failed.progressEvidence }
        },
    } : options.forgedProgress ? {
        ...adapters,
        completeGeneratedDependencies: async (...args: Parameters<typeof adapters.completeGeneratedDependencies>) => ({
            ...await adapters.completeGeneratedDependencies(...args),
            progress: { applied: ['dependency:other:stamp'], notApplied: ['dependency:other:load'] },
        }),
        completeGeneratedVendors: async (...args: Parameters<typeof adapters.completeGeneratedVendors>) => ({
            ...await adapters.completeGeneratedVendors(...args),
            progress: { applied: ['vendor:other:loader'], notApplied: ['vendor:other:route'] },
        }),
    } : options.secondSibling ? {
        ...adapters,
        completeGeneratedDependencies: async (...args: Parameters<typeof adapters.completeGeneratedDependencies>) => {
            dependencyOutcome = await adapters.completeGeneratedDependencies(...args)
            return dependencyOutcome
        },
    } : adapters
    const result = await runUp({ configPath: candidate.configPath }, selectedAdapters)
    return { candidate, adapters, context: loaded.result, docker, generation, result, steps, dependencyOutcome }
}

return { fixture, generatedFixture, configureGeneratedDocker, runGeneratedScenario }
}
