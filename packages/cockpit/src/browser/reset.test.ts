import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { executeProbe } from '../environment-exec/execute.js'
import { beginOperatorReset, runReset } from '../environment/application.js'
import { createDestructiveCommandAdapters } from '../environment/destructive-composition.js'
import { createLifecycleCommandAdapters } from '../environment/lifecycle-composition.js'
import { resolveObservationPostures } from '../environment/observations.js'
import { resolveLifecycleStage } from '../environment/lifecycle-stage.js'
import { observeConfiguration } from '../environment/state.js'
import { assertBrowserArtifactRegistration, resolveBrowserRuntime } from './runtime.js'
import { publishComposeOwnership } from '../../test-support/compose-ownership-fixture.js'
import { recordSyntheticMeasurement } from '../../test-support/runtime-measurement-fixture.js'

const roots: string[] = []
const run = promisify(execFile)
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('wipes produced browser artifacts through operator reset and preserves an undeclared output that fails registration', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-browser-reset-')))
    const stateHome = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-browser-home-')))
    roots.push(root, stateHome)
    await run('git', ['init', '--quiet', root])
    const artifacts = { runner: '.browser/runner', mcp: '.playwright-mcp', cli: '.playwright-cli', auth: '.browser/auth', debugger: '.browser/debugger' }
    const declarations = Object.values(artifacts)
    const configPath = join(root, 'cockpit.toml')
    await recordSyntheticMeasurement(root)
    await writeFile(configPath, [
        '[cockpit]', 'name = "synthetic-browser"', 'siblings_root = "siblings"',
        '[[sibling]]', 'slug = "web"', 'dir = "web"', 'mount = "always"', 'acquire = "none"', 'var = "WEB_DIR"', 'toolchain = "none"', 'purpose = "Synthetic web"',
        '[ports]', 'step = 10', 'count = 1', 'bases = { WEB_PORT = 61350 }',
        '[environment]', 'addressing = "port"', 'authentication = "real"',
        'posture_requirements = [{ requirement = "synthetic-browser", addressing = "port", authentication = "real" }]',
        'compose_files = ["compose.yml"]', 'resettable_volumes = []',
        `generated_host_paths = ${JSON.stringify(declarations)}`,
        'install_policies = [{ toolchain = "node", volume = "node-modules", lockfile = "package-lock.json", install = ["npm", "ci"], load_probe = ["npm", "test"] }]',
        '[environment.machine]', 'runtime_memory_mb = 1024', 'runtime_cpus = 1', 'free_disk_mb = 1024', 'cold_start_seconds = 30', '',
    ].join('\n'))
    const siblingPath = join(root, 'siblings', 'web')
    const mounts = [
        { type: 'bind', source: siblingPath, target: '/web' },
        ...declarations.map((path, index) => ({ type: 'bind', source: join(root, path), target: `/artifacts/${index}` })),
    ]
    await writeFile(join(root, 'compose.yml'), `services:\n  web:\n    image: synthetic.invalid/web\n    volumes:\n${mounts.map((mount) => `      - type: bind\n        source: ${JSON.stringify(mount.source)}\n        target: ${mount.target}\n`).join('')}`)
    await writeFile(join(root, 'docker'), [
        '#!/bin/sh',
        'if [ "$1" = "version" ]; then printf "27.1.2\\n"; exit 0; fi',
        'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then printf "2.39.2\\n"; exit 0; fi',
        'if [ "$1" = "info" ] && [ "$3" = "[{{json .OperatingSystem}},{{json .Name}},{{json .OSType}}]" ]; then printf \'%s\\n\' \'["Docker Desktop","docker-desktop","linux"]\'; exit 0; fi',
        'if [ "$1" = "info" ]; then printf "2147483648|2\\n"; exit 0; fi',
        'if [ "$1" = "compose" ]; then',
        '  case " $*" in',
        '    *" config --format json --no-env-resolution") /bin/cat "$PWD/topology.json"; exit 0;;',
        '    *" stop"|*" ps --format json --status running") exit 0;;',
        '    *) exit 64;;',
        '  esac',
        'fi',
        'if [ "$1" = "context" ]; then /bin/cat "$PWD/selection.json"; exit 0; fi',
        'if [ "$1" = "--host" ]; then exit 0; fi',
        'exit 64', '',
    ].join('\n'), { mode: 0o700 })
    await writeFile(join(root, 'selection.json'), '{"context":"default","endpoint":"unix:///tmp/synthetic.sock"}\n')
    const input = { configPath, env: { PATH: `${root}:/usr/bin:/bin`, HOME: stateHome }, sessionId: 'browser-test', timeoutMs: 5_000, dockerContext: 'default' }
    const lifecycle = createLifecycleCommandAdapters({ configPath, env: input.env, sessionId: input.sessionId, timeoutMs: input.timeoutMs }, executeProbe)
    const loaded = await lifecycle.load({ configPath })
    if (loaded.kind !== 'complete') throw Error(`fixture lifecycle refused: ${JSON.stringify(loaded)}`)
    await publishComposeOwnership(root, loaded.result)
    await writeFile(join(root, 'topology.json'), JSON.stringify({ services: { web: {
        labels: { 'dev.b0dea.cockpit.stack-id': loaded.result.stackId, 'dev.b0dea.cockpit.config-sha256': loaded.result.runtimeSha256 },
        volumes: mounts,
    } } }))
    expect(await lifecycle.withAcquiredPorts(loaded.result, async (value) => value)).toBeDefined()
    const now = new Date().toISOString()
    const configuration = (await observeConfiguration({ path: configPath, stackId: loaded.result.stackId, observedAt: now })).find(({ code }) => code === 'CONFIG_STALE')!
    const authority = await resolveObservationPostures({ configuration, cockpitId: loaded.result.cockpitId, checkoutPath: root, variant: { kind: 'shared' } })
    const stage = await resolveLifecycleStage({ namespace: loaded.result.namespace, stackId: loaded.result.stackId, observedAt: now })
    if (stage.kind !== 'complete') throw Error('fixture lifecycle stage refused')
    const produced: string[] = []
    for (const declaration of declarations) {
        await mkdir(join(root, declaration), { recursive: true })
        const path = `${declaration}/output.json`
        await writeFile(join(root, path), '{"synthetic":"rendered artifact"}', { mode: 0o600 })
        produced.push(path)
    }
    const image = (name: string) => ({ reference: `synthetic.invalid/${name}@sha256:${'a'.repeat(64)}`, driverVersion: '1.2.3' })
    const runtime = resolveBrowserRuntime({
        postures: { authorities: [authority], stages: [stage.authority] },
        images: { runner: image('runner'), mcp: image('mcp') }, project: { lockfile: 'package-lock.json', sha256: 'b'.repeat(64), driverVersion: '1.2.3' },
        endpoint: 'ws://localhost:3001/', maxClients: 1,
        proxy: { serverPort: 3000, proxyPort: 3001, allowedHosts: ['localhost:3001'] }, resolver: [],
        authentication: { policy: 'serialized', states: [{ worker: 'shared', path: `${artifacts.auth}/output.json`, source: 'seeded' }] },
        data: { mode: 'seeded', isolated: true, reachesProduction: false }, requestPreapproval: false, headed: false, artifacts,
    })
    expect(runtime.generatedHostPaths).toEqual(declarations)
    expect(() => assertBrowserArtifactRegistration(runtime, produced)).not.toThrow()
    const control = 'unregistered-output.json'
    await writeFile(join(root, control), '{"synthetic":"undeclared control"}')
    expect(() => assertBrowserArtifactRegistration(runtime, [...produced, control])).toThrow('unregistered')

    const adapters = createDestructiveCommandAdapters(input, executeProbe)
    const preview = await runReset({ configPath }, adapters)
    expect(preview.kind, JSON.stringify(preview)).toBe('preview')
    if (preview.kind !== 'preview') throw Error('public reset preview refused')
    expect(preview.result.targets).toHaveLength(runtime.generatedHostPaths.length)
    expect(preview.result.targets.map(({ declaration }) => declaration).sort()).toEqual([...runtime.generatedHostPaths].sort())
    for (const path of produced) await expect(access(join(root, path))).resolves.toBeUndefined()
    const session = await beginOperatorReset({ configPath }, adapters)
    if (!('decide' in session)) throw Error(`operator reset refused: ${JSON.stringify(session)}`)
    const result = await session.decide('approve')
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete', result: { change: 'reset' } })
    for (const declaration of runtime.generatedHostPaths) await expect(access(join(root, declaration))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, control), 'utf8')).toBe('{"synthetic":"undeclared control"}')
    expect(() => assertBrowserArtifactRegistration(runtime, [control])).toThrow('unregistered')
    await expect(session.decide('approve')).resolves.toMatchObject({ kind: 'refusal' })
}, 30_000)
