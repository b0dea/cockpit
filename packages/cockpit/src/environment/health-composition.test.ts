import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { runDoctor, runPreflight } from './application.js'
import { recordLifecycleSeeded, recordLifecycleStarted } from './lifecycle-stage.js'
import { checkoutId, cockpitId, holderId, stackId } from './identity.js'
import { selectStateRoot } from './state.js'
import { createHealthCommandAdapters } from './health-composition.js'

const run = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { readonly configuredRuntime?: boolean; readonly machineOnly?: boolean; readonly unmeasured?: boolean; readonly malformedDisk?: boolean } = {}) {
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
            options.unmeasured
                ? 'runtime_measurements = [{ runtime = "docker-desktop", recorded_on = "2026-09-26", status = "unmeasured" }]'
                : 'runtime_measurements = [{ runtime = "docker-desktop", compose_floor = "2.20.0", measured_on = "2026-09-26", candidate = "passed", broken_control = "rejected", status = "supported" }]',
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
    if (options.configuredRuntime) await writeFile(join(checkout, 'compose.yml'), 'services: {}\n')
    await run('git', ['-C', checkout, 'add', 'cockpit.toml'])
    await run('git', ['-C', checkout, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'fixture'])

    const cockpit = cockpitId({ name: 'synthetic-cockpit', mainCheckoutPath: checkout })
    const currentCheckout = checkoutId({ checkoutPath: checkout })
    const stack = stackId({ cockpitId: cockpit, checkoutId: currentCheckout, variant: { kind: 'shared' } })
    const holder = holderId({ stackId: stack, checkoutId: currentCheckout, sessionId: 'health-fixture' })
    if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('fixture platform is unsupported')
    const selected = await selectStateRoot({ platform: process.platform, home, checkoutRoots: [checkout], cockpitId: cockpit })
    if (selected.kind !== 'complete') throw new Error('fixture state root was refused')
    const observedAt = new Date().toISOString()
    await recordLifecycleStarted({ namespace: selected.value, stackId: stack, holderId: holder, observedAt })
    await recordLifecycleSeeded({ namespace: selected.value, stackId: stack, holderId: holder, observedAt: new Date().toISOString() })
    if (options.configuredRuntime || options.machineOnly) {
        const sourceSha256 = (await import('node:crypto')).createHash('sha256').update(await readFile(configPath)).digest('hex')
        await writeFile(join(checkout, 'topology.json'), JSON.stringify({ services: { api: { labels: {
            'dev.b0dea.cockpit.stack-id': stack,
            'dev.b0dea.cockpit.config-sha256': sourceSha256,
        } } } }))
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
        const diskPath = join(root, 'df')
        await writeFile(diskPath, options.malformedDisk
            ? '#!/bin/sh\nprintf "malformed disk evidence\\n"\n'
            : '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nsynthetic 2048 1536 512 75%% /\\n"\n', { mode: 0o700 })
        await chmod(diskPath, 0o700)
    }
    return { root, checkout, home, configPath }
}

async function surfaceOverrideFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-health-surface-override-')))
    roots.push(root)
    const configPath = join(root, 'cockpit.toml')
    const entryPoint = await readFile(resolve('packages/cockpit/surfaces/skills/bootstrap.skill.md'), 'utf8')
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
name = "bootstrap"
feature = "skills"
source = "surfaces/bootstrap-override.json"
replaces = { name = "bootstrap", sha256 = "${'a'.repeat(64)}" }
sources = [
  { path = "skills/bootstrap/SKILL.md", bytes = ${JSON.stringify(entryPoint.replace('Bootstrap this cockpit', 'Bootstrap this synthetic cockpit'))} },
  { path = "skills/bootstrap/procedures/onboarding.md", bytes = ${JSON.stringify(procedure)} },
]
`)
    return { root, configPath }
}

describe('production health adapter composition', () => {
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
                name: 'bootstrap',
                feature: 'skills',
                recordedSha256: 'a'.repeat(64),
                overlaySource: 'surfaces/bootstrap-override.json',
            }],
            changedOverrideOriginals: [{
                code: 'OVERRIDDEN_CORE_CHANGED',
                name: 'bootstrap',
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
        const candidate = await fixture()
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: process.env.PATH, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(execute.mock.calls.some(([step]) => step.id === 'git-health')).toBe(true)
        expect(result.result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ owner: 'environment-state' }),
            expect.objectContaining({ owner: 'git-observation' }),
            expect.objectContaining({ owner: 'environment-claims' }),
            expect.objectContaining({ owner: 'environment-port-coordination' }),
            expect.objectContaining({ owner: 'lifecycle-stage' }),
            expect.objectContaining({ owner: 'environment-template-seeding' }),
        ]))
        expect(result.result.checks.find(({ owner }) => owner === 'lifecycle-stage')?.measured).toBe(false)
    })

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

    it('routes configured host and runtime checks through authentic owner plans', async () => {
        const candidate = await fixture({ configuredRuntime: true })
        const execute = vi.fn(executeProbe)
        const adapters = createHealthCommandAdapters({
            configPath: candidate.configPath,
            env: { PATH: `${candidate.root}:/usr/bin:/bin`, HOME: candidate.home },
            timeoutMs: 5_000,
        }, execute)

        const result = await runDoctor({ configPath: candidate.configPath }, adapters)

        expect(execute.mock.calls.map(([step]) => step.id)).toEqual(expect.arrayContaining([
            'runtime:docker-compose:topology:synthetic-cockpit',
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
                argv0: join(candidate.root, 'df'),
                consumedFiles: [expect.objectContaining({
                    path: join(candidate.root, 'df'), executable: true,
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
                reason: 'Runtime docker-desktop is not supported by a complete measurement row (docker info: OperatingSystem "Docker Desktop", '
                    + `Name "docker-desktop", OSType "linux"; host ${process.platform}; measured rows: docker-desktop (unmeasured)). `
                    + 'Measure it with: cockpit runtime measure --config <cockpit.toml> --image <local-image> --write',
            }),
        ]))
    })

    it('fails closed when machine-floor disk evidence is malformed', async () => {
        const candidate = await fixture({ machineOnly: true, unmeasured: true, malformedDisk: true })
        const execute = vi.fn(executeProbe)
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
        const candidate = await fixture()
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
