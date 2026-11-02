import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { runDoctor, runPreflight, runUp } from './application.js'
import { recordLifecycleSeeded, recordLifecycleStarted } from './lifecycle-stage.js'
import { checkoutId, cockpitId, composeProjectName, holderId, stackId } from './identity.js'
import { lifecycleHistoryAddress, selectStateRoot, transactState } from './state.js'
import { COMPOSE_OWNERSHIP_FILE } from './compose-ownership.js'
import { createLifecycleCommandAdapters } from './lifecycle-composition.js'
import { createHealthCommandAdapters } from './health-composition.js'
import { syncGeneratedEnvironment, checkGeneratedEnvironment, observeGeneratedApplicationSurfaces } from './generated-application.js'
import { observeEnvSchemas } from './env-schema-observation.js'
import { publishComposeOwnership } from '../../test-support/compose-ownership-fixture.js'
import { loadCockpitConfig } from '../config/load.js'
import { recordSyntheticMeasurement } from '../../test-support/runtime-measurement-fixture.js'

const run = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { readonly configuredRuntime?: boolean; readonly machineOnly?: boolean; readonly unmeasured?: boolean; readonly unseeded?: boolean; readonly uncommitted?: boolean } = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-health-composition-')))
    roots.push(root)
    const checkout = join(root, 'checkout')
    const home = join(root, 'home')
    const siblings = join(checkout, 'siblings')
    await Promise.all([mkdir(checkout), mkdir(home)])
    await mkdir(join(siblings, 'api'), { recursive: true })
    await run('git', ['init', '--quiet', checkout])
    const configPath = join(checkout, 'cockpit.toml')
    const config = [
        '[cockpit]',
        'name = "synthetic-cockpit"',
        'siblings_root = "siblings"',
        '',
        '[[sibling]]',
        'slug = "api"',
        'dir = "api"',
        'mount = "none"',
        'acquire = "none"',
        'var = "API_DIR"',
        'toolchain = "none"',
        'purpose = "Synthetic data"',
        '',
        '[ports]',
        'step = 10',
        'count = 2',
        'bases = { APP_PORT = 61230 }',
        '',
        '[environment]',
        'addressing = "hostname"',
        'authentication = "bypassed"',
        'posture_requirements = [{ requirement = "synthetic-route", addressing = "hostname", authentication = "bypassed" }]',
        '',
        ...(options.configuredRuntime || options.machineOnly ? [
            options.machineOnly ? 'compose_files = []' : 'compose_files = ["compose.yml"]',
            '',
            '[environment.machine]',
            'runtime_memory_mb = 1024',
            'runtime_cpus = 1',
            'free_disk_mb = 1024',
            'cold_start_seconds = 30',
            '',
        ] : []),
    ].join('\n')
    await writeFile(configPath, config)
    if ((options.configuredRuntime || options.machineOnly) && !options.unmeasured) await recordSyntheticMeasurement(home)
    if (options.configuredRuntime) await writeFile(join(checkout, 'compose.yml'), 'services: {}\n')
    if (!options.uncommitted) {
        await run('git', ['-C', checkout, 'add', 'cockpit.toml'])
        await run('git', ['-C', checkout, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'fixture'])
    }

    const cockpit = cockpitId({ name: 'synthetic-cockpit', mainCheckoutPath: checkout })
    const currentCheckout = checkoutId({ checkoutPath: checkout })
    const stack = stackId({ cockpitId: cockpit, checkoutId: currentCheckout, variant: { kind: 'shared' } })
    const holder = holderId({ stackId: stack, checkoutId: currentCheckout, sessionId: 'health-fixture' })
    if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('fixture platform is unsupported')
    const selected = await selectStateRoot({ platform: process.platform, home, checkoutRoots: [checkout], cockpitId: cockpit })
    if (selected.kind !== 'complete') throw new Error('fixture state root was refused')
    const observedAt = new Date().toISOString()
    if (!options.unseeded) {
        await recordLifecycleStarted({ namespace: selected.value, stackId: stack, holderId: holder, observedAt })
        await recordLifecycleSeeded({ namespace: selected.value, stackId: stack, holderId: holder, observedAt: new Date().toISOString() })
    }
    if (options.configuredRuntime || options.machineOnly) {
        const loaded = await loadCockpitConfig(configPath)
        if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded.diagnostics))
        const sourceSha256 = loaded.result.runtimeSha256
        if (options.configuredRuntime) await publishComposeOwnership(checkout, { stackId: stack, cockpitId: cockpit, runtimeSha256: sourceSha256 })
        await writeFile(join(checkout, 'topology.json'), JSON.stringify({ services: { api: { labels: {
            'dev.b0dea.cockpit.stack-id': stack,
            'dev.b0dea.cockpit.config-sha256': sourceSha256,
        } } } }))
        const dockerPath = join(root, 'docker')
        await writeFile(dockerPath, [
            '#!/bin/sh',
            'if [ "$1" = "version" ]; then printf "27.1.2\n"; exit 0; fi',
            'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then printf "2.39.2\n"; exit 0; fi',
            'if [ "$1" = "info" ] && [ "$3" = "[{{json .OperatingSystem}},{{json .Name}},{{json .OSType}}]" ]; then printf \'%s\\n\' \'["Docker Desktop","docker-desktop","linux"]\'; exit 0; fi',
            'if [ "$1" = "info" ]; then printf "2147483648|2\n"; exit 0; fi',
            'if [ "$1" = "compose" ]; then /bin/cat "$PWD/topology.json"; exit 0; fi',
            'exit 64',
            '',
        ].join('\n'), { mode: 0o700 })
        await chmod(dockerPath, 0o700)
    }
    return { root, checkout, home, configPath, stack, namespace: selected.value }
}

async function surfaceOverrideFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-health-surface-override-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    const entryPoint = await readFile(resolve('packages/cockpit/surfaces/skills/cockpit-setup.skill.md'), 'utf8')
    const procedure = await readFile(resolve('packages/cockpit/surfaces/skills/procedures/onboarding.md'), 'utf8')
    const declaration = (await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8'))
        .replace('name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."')
    await Promise.all([
        mkdir(join(root, 'app'), { recursive: true }),
        mkdir(join(root, 'fixtures'), { recursive: true }),
    ])
    await writeFile(join(root, 'app/AGENTS.md'), 'Synthetic sibling guide.\n')
    await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
    await writeFile(configPath, `${declaration.replace(
        'purpose = "Synthetic application"',
        'purpose = "Synthetic application"\nguides = ["AGENTS.md"]',
    )}
[[surfaces.overlays]]
name = "cockpit-setup"
feature = "skills"
source = "surfaces/bootstrap-override.json"
replaces = { name = "cockpit-setup", sha256 = "${'a'.repeat(64)}" }
sources = [
  { path = "skills/cockpit-setup/SKILL.md", bytes = ${JSON.stringify(entryPoint.replace('Bootstrap this cockpit', 'Bootstrap this synthetic cockpit'))} },
  { path = "skills/cockpit-setup/procedures/onboarding.md", bytes = ${JSON.stringify(procedure)} },
]
`)
    return { root, configPath }
}

// Each case drives the real lifecycle owners through dozens of child processes (fenced execution,
// publication helpers, Git and runtime probes), so its wall time scales with machine load rather
// than with the work under test. The budget is sized for four concurrent workers on a busy host.
describe('production health adapter composition', { timeout: 180_000 }, () => {
    it('passes seeded machine-floor health through public routes and refuses changed published surfaces', async () => {
        const candidate = await fixture({ machineOnly: true })
        const address = candidate.namespace.paths.lifecycle(candidate.stack)
        const holder = holderId({ stackId: candidate.stack, checkoutId: checkoutId({ checkoutPath: candidate.checkout }), sessionId: 'health-fixture' })
        expect(await transactState(candidate.namespace, address, { ownerId: holder }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: address.cockpitId, subjectId: candidate.stack,
            revision: 0, updatedAt: new Date().toISOString(), value: { holderId: holder,
                workBasisSha256: '1'.repeat(64), operationGeneration: '2'.repeat(64), completedServices: [] },
        }))).toMatchObject({ kind: 'complete' })
        const api = join(candidate.checkout, 'siblings/api')
        await run('git', ['init', '--quiet', api])
        await run('git', ['-C', api, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
            'commit', '--quiet', '--allow-empty', '-m', 'fixture'])
        await writeFile(join(candidate.checkout, '.gitignore'), '*\n!.gitignore\n!cockpit.toml\n')
        const published = await syncGeneratedEnvironment({ configPath: candidate.configPath })
        expect(published, JSON.stringify(published)).toMatchObject({ kind: 'complete', status: 0 })
        if (published.kind !== 'complete') throw new Error('published application is unavailable')
        expect(observeGeneratedApplicationSurfaces(published.result.application)?.find(row => row.code === 'DIRECTORY_GRANTS_UNAVAILABLE'))
            .toMatchObject({ applicability: { state: 'not-applicable' } })
        await run('git', ['-C', candidate.checkout, 'add', 'cockpit.toml', '.gitignore'])
        await run('git', ['-C', candidate.checkout, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
            'commit', '--quiet', '--allow-empty', '-m', 'publish synthetic surfaces'])
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)
        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)
        expect(preflight, JSON.stringify(preflight)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })
        expect(doctor, JSON.stringify(doctor)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })
        expect(execute.mock.calls.some(([step]) => step.argv.includes('up') || step.argv.includes('stop'))).toBe(false)
        const guide = join(candidate.checkout, 'AGENTS.md')
        if (published.kind !== 'complete') throw new Error('published surface projection is unavailable')
        const entry = published.result.application.surfaceSelftest.entries.find(row => row.path === 'AGENTS.md')
        if (!entry || entry.kind !== 'shared-region' || entry.region.format !== 'markdown-delimited') throw new Error('published guide region is unavailable')
        const guideBytes = await readFile(guide, 'utf8')
        expect(guideBytes).toContain(entry.region.bytes)
        await writeFile(guide, guideBytes.replace(entry.region.bytes, `${entry.region.bytes}Changed owned guidance.\n`))
        const changed = await runPreflight({ configPath: candidate.configPath }, adapters)
        expect(changed).toMatchObject({ kind: 'blocked', status: 2 })
        expect(changed.result.checks).toContainEqual(expect.objectContaining({ code: 'HARNESS_SURFACE_UNAVAILABLE', verdict: 'unavailable' }))
    })

    // One stack serves every comparison race: bringing it up dominates the cost, and each race
    // restores the bytes it changed before the next one starts.
    it('checks a compose-first stack and rejects config, lifecycle and lease changes during comparison probes', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        await rm(join(candidate.checkout, COMPOSE_OWNERSHIP_FILE))
        const listener = createServer()
        await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
        const address = listener.address()
        if (!address || typeof address === 'string') throw new Error('synthetic listener address is unavailable')
        const port = address.port
        await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
        const config = (await readFile(candidate.configPath, 'utf8')).replace('61230', String(port))
            .replace('dir = "api"', 'dir = "api"\nremote = "https://example.invalid/synthetic/api.git"')
            .replace('acquire = "none"', 'acquire = "manual"')
        await writeFile(candidate.configPath, config)
        const image = `example.invalid/synthetic@sha256:${'a'.repeat(64)}`
        await writeFile(join(candidate.checkout, 'compose.yml'), `services:
  api:
    image: ${image}
    healthcheck:
      test: [CMD, 'true']
    ports:
      - target: 3000
        published: "\${APP_PORT:-${port}}"
`)
        await writeFile(join(candidate.checkout, '.gitignore'), '*\n!.gitignore\n!cockpit.toml\n!compose.yml\n')
        const api = join(candidate.checkout, 'siblings/api')
        await run('git', ['init', '--quiet', api])
        await run('git', ['-C', api, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'])
        await run('git', ['-C', api, 'remote', 'add', 'origin', 'https://example.invalid/synthetic/api.git'])
        await run('git', ['-C', api, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
        const branch = (await run('git', ['-C', api, 'branch', '--show-current'])).stdout.trim()
        await run('git', ['-C', api, 'branch', '--set-upstream-to=origin/main', branch])
        const loadedConfig = await loadCockpitConfig(candidate.configPath)
        if (loadedConfig.kind !== 'complete') throw new Error(JSON.stringify(loadedConfig.diagnostics))
        const digest = loadedConfig.result.runtimeSha256
        const project = composeProjectName({ cockpitName: 'synthetic-cockpit', stackId: candidate.stack })
        const docker = join(candidate.root, 'docker')
        await writeFile(docker, `#!${process.execPath}
const args = process.argv.slice(2)
const port = process.env.APP_PORT || '${port}'
const labels = { 'dev.b0dea.cockpit.stack-id': '${candidate.stack}', 'dev.b0dea.cockpit.config-sha256': '${digest}',
    'com.docker.compose.project': '${project}', 'com.docker.compose.service': 'api' }
const id = '${'a'.repeat(64)}'
const output = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
if (args[0] === 'version') output('27.1.2')
else if (args[0] === 'info') output(args.join(' ').includes('OperatingSystem') ? ['Docker Desktop', 'docker-desktop', 'linux'] : '2147483648|2')
else if (args[0] === 'compose' && args[1] === 'version') output('2.39.2')
else if (args[0] === 'compose' && args.includes('config')) output({ services: { api: { image: '${image}', healthcheck: { test: ['CMD', 'true'] }, labels,
    ports: [{ target: 3000, published: args.includes('--no-interpolate') ? '$' + '{APP_PORT}' : port, host_ip: '127.0.0.1', protocol: 'tcp' }] } } })
else if (args[0] === 'compose' && args.includes('ps')) output(args.includes('--quiet') ? id : { ID: id.slice(0, 12), Project: '${project}', Service: 'api', State: 'running', Health: 'healthy', ExitCode: 0 })
else if (args[0] === 'container' && args[1] === 'inspect') output({ ID: id, State: 'running', Health: 'healthy', Labels: labels, Mounts: [],
    Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: port }] } })
else if (args[0] === 'compose' && args.includes('up')) process.exit(0)
else process.exit(64)
`)
        await chmod(docker, 0o700)
        const env = { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home }
        vi.stubEnv('PATH', env.PATH)
        const publication = await syncGeneratedEnvironment({ configPath: candidate.configPath })
        expect(publication, JSON.stringify(publication)).toMatchObject({ kind: 'complete', status: 0 })
        await run('git', ['-C', candidate.checkout, 'add', 'cockpit.toml', 'compose.yml', '.gitignore'])
        await run('git', ['-C', candidate.checkout, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'publish synthetic runtime'])
        let listening = false
        let changeDuringComparison: (() => Promise<void>) | undefined
        const execute = vi.fn(async (step: Parameters<typeof executeProbe>[0]) => {
            const result = await executeProbe(step)
            if (step.id === 'git:api:comparison-url' && changeDuringComparison) {
                const change = changeDuringComparison
                changeDuringComparison = undefined
                await change()
            }
            if (step.argv.includes('up') && !listening) {
                await new Promise<void>(resolve => listener.listen(Number(step.env.APP_PORT ?? port), '127.0.0.1', resolve))
                listening = true
            }
            return result
        })
        try {
            const up = await runUp({ configPath: candidate.configPath }, createLifecycleCommandAdapters({
                configPath: candidate.configPath, env, sessionId: 'synthetic-health-runtime', timeoutMs: 5_000,
            }, execute))
            expect(up, JSON.stringify(up)).toMatchObject({ kind: 'complete', status: 0 })
            expect(execute.mock.calls.map(([step]) => step.id)).toEqual(expect.arrayContaining([
                `runtime:docker-compose:topology:${project}`, 'runtime:measure:resources', 'runtime:measure:free-disk',
            ]))
            const checked = await checkGeneratedEnvironment({ configPath: candidate.configPath })
            expect(checked, JSON.stringify(checked)).toMatchObject({ kind: 'complete', status: 0 })
            const statePath = candidate.namespace.paths.lifecycle(candidate.stack).path
            const before = await readFile(statePath, 'utf8')
            execute.mockClear()
            const adapters = createHealthCommandAdapters({ configPath: candidate.configPath, env, timeoutMs: 5_000 }, execute)
            const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
            const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)
            expect(preflight, JSON.stringify(preflight)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })
            expect(doctor, JSON.stringify(doctor)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })
            expect(await readFile(statePath, 'utf8')).toBe(before)
            expect(execute.mock.calls.some(([step]) => step.argv.includes('up') || step.argv.includes('stop'))).toBe(false)
            for (const authority of ['config', 'lifecycle', 'lease'] as const) {
                const authorityPath = authority === 'config' ? candidate.configPath
                    : authority === 'lifecycle' ? statePath : candidate.namespace.paths.coordination(candidate.stack).path
                const authorityBytes = await readFile(authorityPath)
                let changed = false
                changeDuringComparison = async () => {
                    await writeFile(authorityPath, authority === 'config' ? `${config}\n# changed during comparison\n` : '{}\n')
                    changed = true
                }
                try {
                    const raced = await runPreflight({ configPath: candidate.configPath }, adapters)
                    expect(changed, authority).toBe(true)
                    expect(raced, `${authority}: ${JSON.stringify(raced)}`).toMatchObject({ kind: 'blocked', status: 2, result: { verdict: 'unavailable' } })
                } finally {
                    await writeFile(authorityPath, authorityBytes)
                }
            }
            // Every race restored distinct bytes, so a lingering change from any of them fails here.
            const restored = await runPreflight({ configPath: candidate.configPath }, adapters)
            expect(restored, JSON.stringify(restored)).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'pass' } })
            await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
            listening = false
            const stopped = await runPreflight({ configPath: candidate.configPath }, adapters)
            expect(stopped).toMatchObject({ kind: 'blocked', status: 2 })
            expect(stopped.result.checks).toContainEqual(expect.objectContaining({ code: 'PORT_FAMILY_COLLISION', verdict: 'fail' }))
        } finally {
            if (listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
        }
    })

    it('runs every check that needs no running stack before the first bring-up, and names the bring-up', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true, uncommitted: true })
        // The synthetic runtime reports 2 GiB, so this floor cannot be met.
        await writeFile(candidate.configPath, (await readFile(candidate.configPath, 'utf8'))
            .replace('runtime_memory_mb = 1024', 'runtime_memory_mb = 99999999'))
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)
        const fix = `npx --no cockpit up --config ${candidate.configPath}`

        expect(preflight).toMatchObject({ kind: 'blocked', status: 2, result: { verdict: 'fail' } })
        expect(doctor).toMatchObject({ kind: 'complete', status: 0, result: { verdict: 'fail' } })
        for (const outcome of [preflight, doctor]) {
            expect(outcome.diagnostics[0]).toMatchObject({
                severity: 'error', code: 'STATE_UNSEEDED', target: candidate.configPath,
                message: expect.stringContaining(`fix: ${fix}`), fix,
            })
            expect(outcome.result.checks).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'GIT_STATE_UNHEALTHY', verdict: 'fail' }),
                expect.objectContaining({ code: 'MACHINE_MEMORY_BELOW_FLOOR', verdict: 'fail' }),
                expect.objectContaining({ code: 'SIBLING_MISSING', verdict: 'pass' }),
                expect.objectContaining({ code: 'MOUNT_MATERIALIZATION_UNAVAILABLE', verdict: 'not-applicable',
                    reason: expect.stringContaining('observed only while the stack runs') }),
            ]))
        }
    })

    it('says a sleeping stack is asleep and to run up, and still checks what needs no running stack', async () => {
        const candidate = await fixture({ configuredRuntime: true })
        const holder = holderId({ stackId: candidate.stack, checkoutId: checkoutId({ checkoutPath: candidate.checkout }), sessionId: 'slept-session' })
        // What `sleep` leaves behind: no session holds the stack and its port lease is released.
        const address = candidate.namespace.paths.coordination(candidate.stack)
        const asleep = await transactState(candidate.namespace, address, { ownerId: holder }, () => ({
            format: 'cockpit-state/v1' as const, kind: 'coordination' as const, cockpitId: address.cockpitId,
            subjectId: candidate.stack, revision: 0, updatedAt: new Date().toISOString(),
            value: { holders: [], lastReleasedHolder: holder, drain: null, restore: null,
                lease: { offset: 0, ports: { APP_PORT: 61230 }, released: true, declaration: { step: 10, count: 1, bases: { APP_PORT: 61230 } } } },
        }))
        expect(asleep.kind).toBe('complete')
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(preflight).toMatchObject({ kind: 'blocked', status: 2 })
        expect(doctor).toMatchObject({ kind: 'complete', status: 0 })
        for (const outcome of [preflight, doctor]) {
            expect(outcome.diagnostics[0]).toMatchObject({
                severity: 'error', code: 'STACK_NOT_RUNNING', target: candidate.stack,
                message: expect.stringContaining('is asleep'),
                fix: `npx --no cockpit up --config ${candidate.configPath}`,
            })
            expect(outcome.result.checks).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'MACHINE_MEMORY_BELOW_FLOOR', verdict: 'pass' }),
                expect.objectContaining({ code: 'RUNNING_CHECKOUT_MISMATCH', verdict: 'not-applicable',
                    reason: expect.stringContaining('observed only while the stack runs') }),
            ]))
            expect(outcome.result.verdict).not.toBe('pass')
        }
    })

    it('names a cockpit root that is not a Git checkout instead of an unavailable observation', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        await rm(join(candidate.checkout, '.git'), { recursive: true, force: true })
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)

        expect(preflight).toMatchObject({ kind: 'blocked', status: 2, diagnostics: [{
            severity: 'error', code: 'SETUP_PATH_TYPE_INVALID', target: candidate.configPath,
            message: expect.stringContaining(`git -C ${candidate.checkout} init`),
        }] })

        // A cockpit that declares no runtime depends on its Git working tree all the same, so doctor names it.
        const surfacesOnly = await fixture({ unseeded: true })
        await rm(join(surfacesOnly.checkout, '.git'), { recursive: true, force: true })
        const doctor = await runDoctor({ configPath: surfacesOnly.configPath }, createHealthCommandAdapters({
            configPath: surfacesOnly.configPath, env: { PATH: process.env.PATH, HOME: surfacesOnly.home }, timeoutMs: 5_000,
        }, executeProbe))
        expect(doctor.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'ENVIRONMENT_NOT_DECLARED' }),
            expect.objectContaining({ code: 'SETUP_PATH_TYPE_INVALID', message: expect.stringContaining(`git -C ${surfacesOnly.checkout} init`) }),
        ]))
    })

    it('names a cockpit repository with no commits yet once, with the commands that commit it', async () => {
        const candidate = await fixture({ machineOnly: true, uncommitted: true })
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)

        const git = preflight.diagnostics.filter(({ code, target }) => ['GIT_STATE_UNHEALTHY', 'CHECKOUT_ADJACENCY_UNHEALTHY',
            'RUNNING_CHECKOUT_MISMATCH'].includes(code) || target === 'git')
        expect(git).toEqual([expect.objectContaining({
            code: 'GIT_STATE_UNHEALTHY',
            message: expect.stringContaining('has no commits yet'),
            fix: expect.stringContaining(`git -C ${candidate.checkout} add -A && git -C ${candidate.checkout} commit`),
        })])

        // Doctor checks an uncommitted cockpit that declares no runtime; preflight, the runtime gate, still only refuses it.
        const surfacesOnly = await fixture({ unseeded: true, uncommitted: true })
        // A mounted sibling runs nothing while no runtime is declared, so no Docker is needed.
        await writeFile(surfacesOnly.configPath, (await readFile(surfacesOnly.configPath, 'utf8')).replace('mount = "none"', 'mount = "always"'))
        const surfacesAdapters = createHealthCommandAdapters({
            configPath: surfacesOnly.configPath, env: { PATH: '/usr/bin:/bin', HOME: surfacesOnly.home }, timeoutMs: 5_000,
        }, executeProbe)
        const doctor = await runDoctor({ configPath: surfacesOnly.configPath }, surfacesAdapters)
        expect(doctor.diagnostics[0]).toMatchObject({ code: 'ENVIRONMENT_NOT_DECLARED' })
        expect(doctor.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'GIT_STATE_UNHEALTHY', verdict: 'fail' }),
            expect.objectContaining({ code: 'RUNTIME_UNMEASURED', verdict: 'not-applicable', reason: expect.stringContaining('declares no runtime') }),
        ]))
        expect(doctor.diagnostics.map(({ code }) => code)).not.toContain('RUNTIME_UNAVAILABLE')
        expect((await runPreflight({ configPath: surfacesOnly.configPath }, surfacesAdapters)).diagnostics.map(({ code }) => code))
            .toEqual(['ENVIRONMENT_NOT_DECLARED'])
    })

    it('warns from doctor when Codex on this machine has not trusted the published guard hook', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        await mkdir(join(candidate.checkout, '.codex'))
        await writeFile(join(candidate.checkout, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] } }))
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(doctor.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'CODEX_HOOK_UNTRUSTED',
            message: expect.stringContaining(`Codex has not trusted the guard hook in ${join(candidate.checkout, '.codex/hooks.json')}`) }))
    })

    it('warns from doctor when PATH holds a relative entry, under which the guard asks before every command', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        const doctor = async (PATH: string) => runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath, env: { PATH, HOME: candidate.home }, timeoutMs: 5_000,
        }, executeProbe))
        const warning = expect.objectContaining({ severity: 'warning', code: 'GUARD_SEARCH_PATH_RELATIVE', target: 'PATH' })

        expect((await doctor('/usr/bin:/bin')).diagnostics).not.toContainEqual(warning)
        expect((await doctor('/usr/bin:./node_modules/.bin:/bin')).diagnostics).toContainEqual(expect.objectContaining({ code: 'GUARD_SEARCH_PATH_RELATIVE',
            message: expect.stringContaining('PATH holds the relative entry "./node_modules/.bin"') }))
        expect((await doctor('/usr/bin::/bin')).diagnostics).toContainEqual(expect.objectContaining({ code: 'GUARD_SEARCH_PATH_RELATIVE',
            message: expect.stringContaining('an empty entry, from a stray colon, is the working directory') }))
    })

    it('warns from doctor when the cockpit has work orders but the Codex CLI that grades them is not on PATH', async () => {
        const candidate = await fixture({ configuredRuntime: true, unseeded: true })
        const doctor = async () => runDoctor({ configPath: candidate.configPath }, createHealthCommandAdapters({
            configPath: candidate.configPath, env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home }, timeoutMs: 5_000,
        }, executeProbe))
        const warning = expect.objectContaining({ severity: 'warning', code: 'EVALUATOR_UNAVAILABLE', target: 'workorders' })

        expect((await doctor()).diagnostics).not.toContainEqual(warning)
        await mkdir(join(candidate.checkout, 'workorders'))
        expect((await doctor()).diagnostics).toContainEqual(warning)
        await writeFile(join(candidate.root, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        expect((await doctor()).diagnostics).not.toContainEqual(warning)
    })

    it('preserves a lifecycle owner refusal before observing Docker', async () => {
        const candidate = await fixture({ configuredRuntime: true })
        const history = lifecycleHistoryAddress(candidate.namespace, candidate.stack)
        if (!history) throw new Error('fixture lifecycle history address is unavailable')
        await writeFile(history.path, '{}\n')
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:${process.env.PATH}`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)

        for (const outcome of [preflight, doctor]) {
            expect(outcome.result).toMatchObject({ verdict: 'unavailable', checks: [] })
            expect(outcome.diagnostics).toContainEqual({
                severity: 'error', code: 'STATE_RECORD_MALFORMED', target: history.path,
                message: 'state record is malformed or does not match its address',
                fix: 'inspect lifecycle state and history before explicit recovery or adoption',
            })
        }
        expect(execute.mock.calls.some(([step]) => step.argv0 === join(candidate.root, 'docker'))).toBe(false)
    })

    it('inspects active surface overrides through an authenticated generated preview', async () => {
        const candidate = await surfaceOverrideFixture()
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.root },
            timeoutMs: 5_000,
        }, execute)

        const result = await adapters.inspectSurfaceOverrides?.(candidate.configPath)

        expect(result).toMatchObject({
            kind: 'complete',
            activeOverrides: [{
                name: 'cockpit-setup',
                feature: 'skills',
                recordedSha256: 'a'.repeat(64),
                overlaySource: 'surfaces/bootstrap-override.json',
            }],
            changedOverrideOriginals: [{
                code: 'OVERRIDDEN_CORE_CHANGED',
                name: 'cockpit-setup',
                recordedSha256: 'a'.repeat(64),
                overlaySource: 'surfaces/bootstrap-override.json',
            }],
        })
        expect(execute).toHaveBeenCalled()
    }, 120_000)

    it('names unavailable generated override inspection instead of returning an empty complete result', async () => {
        const adapters = createHealthCommandAdapters({
            configPath: '',
            env: { PATH: process.env.PATH },
            timeoutMs: 5_000,
        }, executeProbe)

        const result = await adapters.inspectSurfaceOverrides?.('')

        expect(result).toEqual({
            kind: 'unavailable',
            code: 'SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE',
            reason: 'surface override inspection needs valid command composition input',
        })
        expect(result).not.toHaveProperty('activeOverrides')
    })

    it('refuses override inspection for a different configuration path', async () => {
        const candidate = await fixture()
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const result = await adapters.inspectSurfaceOverrides?.(join(candidate.root, 'other.toml'))

        expect(result).toEqual({
            kind: 'refusal',
            code: 'SURFACE_OVERRIDE_INSPECTION_PATH_MISMATCH',
            reason: 'surface override inspection is bound to the configured cockpit source',
        })
        expect(result).not.toHaveProperty('activeOverrides')
    })

    it('derives steady authority and invokes the real owner producers', async () => {
        // Health needs a declared floor or runtime; with neither, doctor reports ENVIRONMENT_NOT_DECLARED.
        const candidate = await fixture({ machineOnly: true })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, Path: undefined, LC_ALL: undefined, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(execute.mock.calls.some(([step]) => step.id === 'git-health')).toBe(true)
        expect(result.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ owner: 'environment-state' }),
            expect.objectContaining({ owner: 'git-observation' }),
            expect.objectContaining({ owner: 'environment-claims' }),
            expect.objectContaining({ owner: 'runtime-planning', code: 'PORT_FAMILY_COLLISION', verdict: 'not-applicable' }),
            expect.objectContaining({ owner: 'lifecycle-stage' }),
            expect.objectContaining({ owner: 'environment-template-seeding' }),
            expect.objectContaining({ owner: 'environment-template-seeding', code: 'SIBLING_MISSING' }),
            expect.objectContaining({ owner: 'environment-template-seeding', code: 'ENVIRONMENT_KEYS_STALE', verdict: 'pass', measured: true }),
            expect.objectContaining({ owner: 'environment-template-seeding', code: 'ENVIRONMENT_FILE_NOT_FOUND', verdict: 'pass', measured: true }),
        ]))
        expect(result.result.checks.find(({ owner }) => owner === 'lifecycle-stage')?.measured).toBe(false)
    })

    it('observes sibling Git, schemas and every declared template from a nested configuration', async () => {
        const candidate = await fixture({ machineOnly: true })
        const cockpitRoot = join(candidate.checkout, 'control')
        const configPath = join(cockpitRoot, 'cockpit.toml')
        const api = join(candidate.checkout, 'repositories/api')
        const web = join(candidate.checkout, 'repositories/web')
        await Promise.all([mkdir(cockpitRoot), mkdir(api, { recursive: true }), mkdir(web, { recursive: true })])
        const declarations = [
            'remote = "https://example.invalid/api.git"',
            'environment_files = [{ template = "first.template", instance = "first.instance" }, { template = "second.template", instance = "second.instance" }]',
            '',
            '[[sibling]]',
            'slug = "web"',
            'dir = "web"',
            'mount = "none"',
            'acquire = "none"',
            'var = "WEB_DIR"',
            'toolchain = "none"',
            'purpose = "Synthetic web"',
            'environment_files = [{ template = "web.template", instance = "web.instance" }]',
            '',
        ].join('\n')
        const config = await readFile(candidate.configPath, 'utf8')
        await writeFile(configPath, config.replace('siblings_root = "siblings"', 'siblings_root = "../repositories"')
            .replace('acquire = "none"', 'acquire = "manual"')
            .replace('[ports]', `${declarations}\n[ports]`))
        await Promise.all([
            writeFile(join(api, '.env.schema'), 'PUBLIC_NAME=\n'),
            writeFile(join(api, 'first.template'), 'FIRST=\n'),
            writeFile(join(api, 'first.instance'), 'FIRST=synthetic\n'),
            writeFile(join(api, 'second.template'), 'SECOND=\n'),
            writeFile(join(api, 'second.instance'), 'OTHER=synthetic\n'),
            writeFile(join(web, 'web.template'), 'WEB=\n'),
        ])
        await run('git', ['init', '--quiet', '--initial-branch=main', api])
        await run('git', ['-C', api, 'add', '--', '.env.schema', 'first.template', 'second.template'])
        await run('git', ['-C', api, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'fixture'])
        await run('git', ['-C', api, 'remote', 'add', 'origin', 'https://example.invalid/api.git'])
        await run('git', ['-C', api, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
        await run('git', ['-C', api, 'branch', '--set-upstream-to=origin/main', 'main'])
        await writeFile(join(candidate.root, 'varlock'), '#!/bin/sh\nprintf \'%s\\n\' \'{"config":{"PUBLIC_NAME":{}}}\'\n', { mode: 0o700 })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath,
            env: {
                PATH: `${candidate.root}:/usr/bin:/bin`,
                LANG: 'C',
                HOME: candidate.home,
            },
            timeoutMs: 5_000,
        }, execute)

        const observed = await runDoctor({ configPath }, adapters)
        const siblingGit = execute.mock.calls.map(([step]) => step).find(({ id, labels }) =>
            id === 'git-health' && labels.source === `${configPath}:api`)
        expect(siblingGit).toMatchObject({ cwd: api, argv: expect.arrayContaining(['-C', api]) })
        expect(siblingGit?.env).toEqual({ LANG: 'C' })
        expect(observed.result.comparisons).toContainEqual({ sibling: 'api', result: expect.objectContaining({ kind: 'complete', state: 'match' }) })
        expect(observed.result.checks).toContainEqual(expect.objectContaining({
            owner: 'env-schema-observation', verdict: 'pass', measured: [{ sibling: 'api', state: 'valid', keys: 1 }],
        }))
        const checks = observed.result.checks.filter(({ owner }) => owner === 'environment-template-seeding')
        expect(observed.diagnostics).not.toEqual(expect.arrayContaining([expect.objectContaining({ target: 'templates' })]))
        expect(checks).toHaveLength(3)
        expect(checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'SIBLING_MISSING', verdict: 'pass' }),
            expect.objectContaining({ code: 'ENVIRONMENT_KEYS_STALE', verdict: 'fail' }),
            expect.objectContaining({ code: 'ENVIRONMENT_FILE_NOT_FOUND', verdict: 'fail' }),
        ]))
        expect(checks.find(({ code }) => code === 'ENVIRONMENT_KEYS_STALE')?.source).toContain('second.instance')
        expect(checks.find(({ code }) => code === 'ENVIRONMENT_FILE_NOT_FOUND')?.source).toContain('web.instance')

        await rm(web, { recursive: true })
        const missing = await runDoctor({ configPath }, adapters)
        expect(missing.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'SIBLING_MISSING', verdict: 'fail', source: expect.stringContaining('web') }),
        ]))
    }, 120_000)

    it('binds the public command path and never executes for a different configuration', async () => {
        const candidate = await fixture()
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runPreflight({ configPath: join(candidate.root, 'other.toml') }, adapters)

        expect(result).toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
        expect(execute).not.toHaveBeenCalled()
    })

    it('validates every captured environment name before dispatch', async () => {
        const candidate = await fixture({ machineOnly: true })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, 'INVALID=NAME': undefined, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(result).toMatchObject({ result: { verdict: 'unavailable' } })
        expect(execute).not.toHaveBeenCalled()
    })

    it('reports a malformed configuration from preflight and doctor instead of an unavailable source', async () => {
        const candidate = await fixture()
        await writeFile(candidate.configPath, '[cockpit\nname = "synthetic"\n')
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(preflight).toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' },
            diagnostics: [{ code: 'CONFIG_PARSE_INVALID', target: candidate.configPath }] })
        expect(doctor).toMatchObject({ result: { verdict: 'unavailable' },
            diagnostics: [{ code: 'CONFIG_PARSE_INVALID', target: candidate.configPath }] })
        expect(execute).not.toHaveBeenCalled()
    })

    // An unresolvable declared remote made issuing the observation source throw, and a bare catch
    // turned that into an unexplained unavailable source.
    it('names an unresolvable local remote from doctor', async () => {
        const candidate = await fixture()
        await writeFile(join(dirname(candidate.configPath), 'siblings', 'plain-file'), 'not a directory')
        await writeFile(candidate.configPath, (await readFile(candidate.configPath, 'utf8'))
            .replace('dir = "api"\n', 'dir = "api"\nremote = "plain-file/api.git"\n').replace('acquire = "none"', 'acquire = "manual"'))
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.home },
            timeoutMs: 5_000,
        }, executeProbe)

        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(doctor.diagnostics).toContainEqual(expect.objectContaining({ code: 'LIFECYCLE_EVIDENCE_INVALID',
            message: expect.stringContaining('sibling api: cannot resolve declared local remote "plain-file/api.git" (ENOTDIR)') }))
    })

    it('rejects hostile public input without invoking its accessor', async () => {
        const candidate = await fixture()
        let reads = 0
        const input = Object.defineProperty({}, 'configPath', {
            enumerable: true,
            get() { reads += 1; throw new Error('hostile accessor') },
        })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runPreflight(input as never, adapters)

        expect(result).toMatchObject({ kind: 'blocked', result: { verdict: 'unavailable' } })
        expect(reads).toBe(0)
        expect(execute).not.toHaveBeenCalled()
    })

    it('routes declared machine floors through authentic read-only owner plans', async () => {
        const candidate = await fixture({ machineOnly: true })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(execute.mock.calls.map(([step]) => step.id)).toEqual(expect.arrayContaining([
            'runtime:measure:resources', 'runtime:measure:free-disk',
        ]))
        expect(result.diagnostics).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ target: 'host' }),
            expect.objectContaining({ target: 'runtime' }),
        ]))
        expect(result.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ owner: 'host-observation', code: 'MACHINE_MEMORY_BELOW_FLOOR' }),
            expect.objectContaining({ owner: 'host-observation', code: 'MACHINE_CPU_BELOW_FLOOR' }),
            expect.objectContaining({ owner: 'host-observation', code: 'MACHINE_DISK_BELOW_FLOOR' }),
            expect.objectContaining({ owner: 'runtime-planning', code: 'RUNTIME_UNAVAILABLE' }),
            expect.objectContaining({ owner: 'runtime-planning', code: 'MOUNT_POSTURE_UNAVAILABLE' }),
        ]))
    })

    it('keeps machine-only runtime measurement applicable and reports an exact unmeasured reason', async () => {
        const candidate = await fixture({ machineOnly: true, unmeasured: true })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runDoctor({ configPath: candidate.configPath }, adapters)
        const executionOutcomes = await Promise.all(execute.mock.results.map(({ value }) => value))

        expect(execute.mock.calls.map(([step]) => step)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'runtime:measure:free-disk',
                argv0: process.execPath,
                consumedFiles: [expect.objectContaining({
                    path: await realpath(process.execPath), executable: true,
                })],
            }),
        ]))
        const stepIds = execute.mock.calls.map(([step]) => step.id)
        expect(stepIds.indexOf('runtime:measure:free-disk')).toBeLessThan(stepIds.indexOf('git-health'))
        expect(result.diagnostics, JSON.stringify(executionOutcomes)).not.toEqual(expect.arrayContaining([expect.objectContaining({ target: 'host' })]))
        expect(result.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ owner: 'host-observation', code: 'MACHINE_MEMORY_BELOW_FLOOR' }),
            expect.objectContaining({
                owner: 'runtime-planning',
                code: 'RUNTIME_UNMEASURED',
                verdict: 'unavailable',
                reason: 'Runtime docker-desktop on daemon "docker-desktop" has not been measured on this machine (docker info: OperatingSystem "Docker Desktop", '
                    + `Name "docker-desktop", OSType "linux"; engine 27.1.2; host ${process.platform}; `
                    + `measured in ${join(candidate.namespace.root, 'machine', 'runtime-measurements.json')}: none). `
                    + 'Measure it on this machine with: npx --no cockpit runtime measure --config <your cockpit.toml> --image <local-image>',
            }),
        ]))
    })

    it('fails closed when machine-floor disk execution output changes', async () => {
        const candidate = await fixture({ machineOnly: true, unmeasured: true })
        const execute = vi.fn(async (step: Parameters<typeof executeProbe>[0]) => {
            const outcome = await executeProbe(step)
            return step.id === 'runtime:measure:free-disk'
                ? { ...outcome, stdout: Buffer.from('1\n') }
                : outcome
        })
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runDoctor({ configPath: candidate.configPath }, adapters)
        const executionOutcomes = await Promise.all(execute.mock.results.map(({ value }) => value))

        expect(execute.mock.calls.map(([step]) => step.id), JSON.stringify(executionOutcomes)).toContain('runtime:measure:free-disk')
        expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
            code: 'EVIDENCE_UNAVAILABLE',
            target: 'host',
            message: 'host observation producer failed',
        })]))
        expect(result.result.checks).toEqual(expect.arrayContaining([expect.objectContaining({
            owner: 'host-observation',
            code: 'MACHINE_DISK_BELOW_FLOOR',
            verdict: 'unavailable',
            reason: 'machine-disk evidence is missing',
        })]))
    })

    it('reissues exact posture and stage authority after a producer crosses the initial window', async () => {
        const candidate = await fixture({ machineOnly: true })
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-09-26T08:00:00.000Z'))
        let advanced = false
        const execute = async (step: Parameters<typeof executeProbe>[0]) => {
            if (!advanced) {
                advanced = true
                vi.setSystemTime(new Date('2026-09-26T08:00:31.000Z'))
            }
            return executeProbe(step)
        }
        try {
            const adapters = createHealthCommandAdapters({
                configPath: candidate.configPath,
                env: { PATH: process.env.PATH, HOME: candidate.home },
                timeoutMs: 5_000,
            }, execute)

            const result = await runDoctor({ configPath: candidate.configPath }, adapters)

            expect(advanced).toBe(true)
            expect(result.result.checks).not.toEqual([])
            expect(result.result.checks).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ reason: 'observation timestamp does not match the evaluation boundary' }),
            ]))
            expect(result.diagnostics).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ message: expect.stringContaining('authority has expired') }),
            ]))
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('env schema health', () => {
    // Distinctive enough that any copy of it in output or state is unmistakable.
    const SECRET = 'sentinel-resolved-value-7c1e94'
    const schemaOwner = 'env-schema-observation'

    async function withVarlock(candidate: Awaited<ReturnType<typeof fixture>>, body: string | undefined) {
        await writeFile(join(candidate.checkout, 'siblings', 'api', '.env.schema'), 'API_KEY=\n')
        if (body === undefined) return
        const path = join(candidate.root, 'varlock')
        await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
        await chmod(path, 0o700)
    }

    // A varlock report whose values and messages both carry the secret, as a real one can.
    const report = (errors?: Record<string, string>) => JSON.stringify({
        blobFormatVersion: 1,
        config: { API_KEY: { value: SECRET, isSensitive: true }, REGION: { value: SECRET, isSensitive: false } },
        ...(errors ? { errors: { configItems: errors } } : {}),
    })
    const printing = (json: string, exitCode: number) =>
        `cat <<'JSON'\n${json}\nJSON\nprintf '%s\\n' '${SECRET}' >&2\nexit ${exitCode}`

    async function health(candidate: Awaited<ReturnType<typeof fixture>>, options: { readonly path?: string; readonly timeoutMs?: number } = {}) {
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: options.path ?? `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            timeoutMs: options.timeoutMs ?? 5_000,
        }, execute)
        const doctor = await runDoctor({ configPath: candidate.configPath }, adapters)
        const preflight = await runPreflight({ configPath: candidate.configPath }, adapters)
        const row = (result: typeof doctor | typeof preflight) => result.result.checks.find(({ owner }) => owner === schemaOwner)
        return { execute, doctor, preflight, row }
    }

    const varlockCalls = (execute: { readonly mock: { readonly calls: readonly (readonly [Parameters<typeof executeProbe>[0], ...unknown[]])[] } }) =>
        execute.mock.calls.map(([step]) => step).filter(({ id }) => id.startsWith('env-schema:'))

    async function files(directory: string): Promise<string[]> {
        const { readdir } = await import('node:fs/promises')
        const found: string[] = []
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name)
            if (entry.isDirectory()) found.push(...await files(path))
            else if (entry.isFile()) found.push(path)
        }
        return found
    }

    it('reports a valid env schema for a sibling that contains .env.schema', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, printing(report(), 0))

        const { execute, doctor, preflight, row } = await health(candidate)

        expect(varlockCalls(execute)).toHaveLength(2)
        expect(varlockCalls(execute)[0]!.argv.slice(1)).toEqual([
            'load', '--agent', '--format', 'json-full', '--path', join(candidate.checkout, 'siblings', 'api'),
        ])
        for (const result of [doctor, preflight]) {
            expect(row(result)).toMatchObject({
                code: 'ENV_SCHEMA_UNHEALTHY', verdict: 'pass', measured: [{ sibling: 'api', state: 'valid', keys: 2 }],
            })
        }
    })

    it('does not run varlock for a sibling without .env.schema', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, printing(report(), 0))
        await rm(join(candidate.checkout, 'siblings', 'api', '.env.schema'))

        const { execute, doctor, row } = await health(candidate)

        expect(varlockCalls(execute)).toEqual([])
        expect(row(doctor)).toMatchObject({ verdict: 'pass', measured: [] })
    })

    it('never carries a resolved value into output, diagnostics or persisted state', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, printing(report({ API_KEY: `Value ${SECRET} is required but is currently empty`, REGION: `bad value ${SECRET}` }), 1))

        const { doctor, preflight } = await health(candidate)

        const everything = JSON.stringify([doctor, preflight])
        expect(everything).toContain('API_KEY')
        expect(everything).not.toContain(SECRET)
        const persisted = await Promise.all((await files(candidate.home)).map((path) => readFile(path, 'utf8')))
        expect(persisted.length).toBeGreaterThan(0)
        expect(persisted.join('\n')).not.toContain(SECRET)
    })

    it('warns, without failing the row, when varlock is not installed', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, undefined)

        const { doctor, preflight, row } = await health(candidate)

        for (const result of [doctor, preflight]) {
            expect(row(result)).toMatchObject({ verdict: 'pass', measured: [{ sibling: 'api', state: 'tool-missing' }] })
            expect(result.diagnostics).toContainEqual(expect.objectContaining({
                severity: 'warning', code: 'ENV_SCHEMA_TOOL_MISSING', target: 'api', fix: expect.stringContaining('https://varlock.dev'),
            }))
        }
    })

    it('fails preflight naming the invalid keys and the fix', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, printing(report({ DATABASE_URL: 'Value is required but is currently empty', PORT: 'Unable to coerce string to number' }), 1))

        const { preflight, row } = await health(candidate)

        expect(row(preflight)).toMatchObject({ verdict: 'fail', remedy: expect.stringContaining('varlock load') })
        expect(preflight.diagnostics).toContainEqual(expect.objectContaining({
            severity: 'error',
            code: 'ENV_SCHEMA_UNHEALTHY',
            message: expect.stringMatching(/api .*missing required DATABASE_URL.*invalid PORT/),
            fix: expect.stringContaining('varlock load'),
        }))
    })

    it('names a varlock timeout instead of hanging', async () => {
        const candidate = await fixture({ machineOnly: true })
        await withVarlock(candidate, 'sleep 30')

        const { preflight, row } = await health(candidate, { timeoutMs: 400 })

        expect(row(preflight)).toMatchObject({ verdict: 'unavailable' })
        expect(preflight.diagnostics).toContainEqual(expect.objectContaining({
            code: 'ENV_SCHEMA_UNHEALTHY',
            message: expect.stringMatching(/api .*varlock timed out after 400 ms/),
        }))
    })
})
