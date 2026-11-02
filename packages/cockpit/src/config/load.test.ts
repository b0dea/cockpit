import { isValidatedWorkOrderPolicy } from '../work-orders/intake.js'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import {
    EXECUTION_FAILURE_CODES,
    ENVIRONMENT_CODES,
    REFUSAL_CODES,
    type EnvironmentCommandOutcome,
    type ExecutionFailureCode,
    type ExecutionStep,
    type EnvironmentDiagnostic,
    type RefusalCode,
    type SetupRefusalEvidence,
} from '../environment/contract.js'
import { consumeLoadedConfigProjection, consumeMachineFloorConfigProjection, consumeWorkEnvironmentConfigProjection, loadCockpitConfig, projectMachineFloorConfig, projectWorkEnvironmentConfig } from './load.js'

const scratch: string[] = []

const validConfig = [
    '[cockpit]',
    'name = "synthetic-cockpit"',
    'siblings_root = "siblings"',
    '',
    '[[sibling]]',
    'slug = "api"',
    'dir = "api-service"',
    'remote = "ssh://example.invalid/api.git"',
    'branch = "main"',
    'mount = "always"',
    'acquire = "auto"',
    'var = "API_DIR"',
    'toolchain = "node"',
    'purpose = "Synthetic API"',
    '',
    '[ports]',
    'step = 100',
    'count = 4',
    'bases = { APP_PORT = 4100 }',
    '',
].join('\n')

const browserArtifactPaths = ['.browser/runner', '.browser/mcp', '.browser/cli', '.browser/auth', '.browser/debugger']
const workEnvironmentConfig = `${validConfig.replace(
    'purpose = "Synthetic API"',
    'purpose = "Synthetic API"\nenvironment_files = [{ template = ".env.example", instance = ".env" }]',
)}
[workorders]
attempt_cap = 1
wip_cap = 2
programme_wip_cap = 1

[environment]
addressing = "port"
authentication = "bypassed"
posture_requirements = [{ requirement = "synthetic-browser", addressing = "port", authentication = "bypassed" }]
generated_host_paths = ${JSON.stringify(browserArtifactPaths)}

[browser]
harnesses = [{ target = "codexcli", version = "0.149.0" }]
images = { runner = { reference = "synthetic.invalid/runner@sha256:${'a'.repeat(64)}", driver_version = "1.2.3" }, mcp = { reference = "synthetic.invalid/mcp@sha256:${'b'.repeat(64)}", driver_version = "1.2.3" } }
project = { lockfile = "package-lock.json", sha256 = "${'c'.repeat(64)}", driver_version = "1.2.3" }
max_clients = 1
proxy = { server_port = 3000, proxy_port = 3001, allowed_hosts = ["localhost:3001"] }
resolver = []
authentication = { policy = "none", states = [] }
data = { mode = "empty", isolated = true, reaches_production = false }
request_preapproval = true
headed = false
artifacts = { runner = ".browser/runner", mcp = ".browser/mcp", cli = ".browser/cli", auth = ".browser/auth", debugger = ".browser/debugger" }

[testing]
stages = [{ id = "unit", command = ["npm", "test"], requires_stack = false }]
gates = [{ id = "focused", tier = "targeted", stages = ["unit"], changes = "Isolated behavior" }]
native_hooks = { install = "inspect" }
`

function fixture(bytes: string | Buffer = validConfig): string {
    const directory = mkdtempSync(join(tmpdir(), 'cockpit-config-load-'))
    const configPath = join(directory, 'cockpit.toml')
    writeFileSync(configPath, bytes)
    scratch.push(directory)
    return configPath
}

afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('canonical cockpit config loader', () => {
    it('refuses configuration bytes beyond the parser input budget', async () => {
        const outcome = await loadCockpitConfig(fixture(Buffer.alloc(1_048_577, 0x20)))

        expect(outcome).toMatchObject({
            kind: 'refusal',
            diagnostics: [expect.objectContaining({
                code: 'CONFIG_UNREADABLE',
                message: 'cockpit configuration exceeds the 1048576-byte input limit',
            })],
        })
    })

    it('loads one fully populated environment configuration', async () => {
        const populated = `${validConfig.replace(
            'purpose = "Synthetic API"',
            'purpose = "Synthetic API"\nenvironment_files = [{ template = ".env.example", instance = ".env" }]',
        )}
[environment]
addressing = "hostname"
authentication = "real"
resettable_volumes = ["api-session-data"]
generated_host_paths = [".cockpit/generated/session"]
compose_files = ["compose.yml"]
entrypoint_derivatives = [{ name = "web", kind = "entrypoint", port = "APP_PORT", path = "/" }]
install_policies = [{ toolchain = "node", volume = "node-modules", lockfile = "package-lock.json", install = ["npm", "ci"], load_probe = ["node", "--eval", "require('zod')"] }]

[environment.machine]
runtime_memory_mb = 4096
runtime_cpus = 2
free_disk_mb = 8192
cold_start_seconds = 300
`

        const outcome = await loadCockpitConfig(fixture(populated))

        expect(outcome.kind).toBe('complete')
        if (outcome.kind === 'complete') {
            expect(outcome.result.config.sibling[0]).toMatchObject({
                environment_files: [{ template: '.env.example', instance: '.env' }],
            })
            expect(outcome.result.config.environment).toMatchObject({
                addressing: 'hostname',
                authentication: 'real',
                resettable_volumes: ['api-session-data'],
                generated_host_paths: ['.cockpit/generated/session'],
                compose_files: ['compose.yml'],
                install_policies: [expect.objectContaining({ toolchain: 'node', lockfile: 'package-lock.json' })],
            })
        }
    })

    it('freezes the closed environment diagnostic vocabularies', () => {
        expect(Object.isFrozen(ENVIRONMENT_CODES)).toBe(true)
        expect(Object.isFrozen(EXECUTION_FAILURE_CODES)).toBe(true)
        expect(Object.isFrozen(REFUSAL_CODES)).toBe(true)
        expectTypeOf<'EXECUTION_TIMEOUT'>().toMatchTypeOf<ExecutionFailureCode>()
        expectTypeOf<'EXECUTION_TIMEOUT'>().toMatchTypeOf<RefusalCode>()
        expectTypeOf<'INSTALL_POLICY_MISSING'>().toMatchTypeOf<RefusalCode>()
        expectTypeOf<'INSTALL_POLICY_AMBIGUOUS'>().toMatchTypeOf<RefusalCode>()
        expectTypeOf<'ARBITRARY_CODE'>().not.toMatchTypeOf<RefusalCode>()
        expectTypeOf<{ severity: 'error'; code: 'ARBITRARY_CODE'; message: string }>()
            .not.toMatchTypeOf<EnvironmentDiagnostic>()
    })

    it('reads one canonical TOML source and returns typed config with path provenance', async () => {
        const configPath = fixture()

        const outcome = await loadCockpitConfig(configPath)

        expect(outcome).toEqual({
            kind: 'complete',
            status: 0,
            diagnostics: [],
            result: {
                config: expect.objectContaining({
                    cockpit: expect.objectContaining({ name: 'synthetic-cockpit', siblings_root: 'siblings' }),
                    sibling: [expect.objectContaining({ slug: 'api', acquire: 'auto', mount: 'always' })],
                }),
                source: {
                    path: realpathSync(resolve(configPath)),
                    byteLength: Buffer.byteLength(validConfig),
                    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                },
                runtimeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                // The fixture writes no guard host keys, so their empty defaults are not an operator statement.
                guardHostsStated: false,
            },
        })
    })

    it('keeps the runtime identity across edits that reach no container and changes it with one that does', async () => {
        const identity = async (bytes: string) => {
            const loaded = await loadCockpitConfig(fixture(bytes))
            if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded.diagnostics))
            return { file: loaded.result.source.sha256, runtime: loaded.result.runtimeSha256 }
        }
        const machine = (coldStart: number) => `\n[environment]\ncompose_files = ["compose.yml"]\nresettable_volumes = ["data"]\n[environment.machine]\nruntime_memory_mb = 512\nruntime_cpus = 1\nfree_disk_mb = 1024\ncold_start_seconds = ${coldStart}\n`
        const floored = await identity(`${validConfig}${machine(120)}`)
        // The floor, the cold-start budget and the reset list are held on the host, not in a
        // container, so raising them leaves a running stack alone.
        for (const hostOnly of [
            `${validConfig}${machine(600)}`,
            `${validConfig}${machine(120).replace('runtime_memory_mb = 512', 'runtime_memory_mb = 1024')}`,
            `${validConfig}${machine(120).replace('["data"]', '["data", "cache"]')}`,
        ]) expect((await identity(hostOnly)).runtime, hostOnly).toBe(floored.runtime)
        const base = await identity(validConfig)
        const unused ='[[sibling]]\nslug = "docs"\ndir = "docs"\nmount = "none"\nacquire = "none"\nvar = "DOCS_DIR"\npurpose = "Synthetic docs"\n'
        for (const cosmetic of [
            validConfig.replace('purpose = "Synthetic API"', 'purpose = "Synthetic API, described again"'),
            `# a comment\n${validConfig.replaceAll(' = ', '   =   ')}`,
            `${validConfig}\n[guards]\nprotected_branches = ["main", "release"]\n`,
            validConfig.replace('branch = "main"', 'branch = "trunk"'),
            validConfig.replace('[ports]', `${unused}\n[ports]`),
        ]) {
            const edited = await identity(cosmetic)
            expect(edited.file).not.toBe(base.file)
            expect(edited.runtime, cosmetic).toBe(base.runtime)
        }
        for (const runtime of [
            validConfig.replace('APP_PORT = 4100', 'APP_PORT = 4200'),
            validConfig.replace('dir = "api-service"', 'dir = "api"'),
            validConfig.replace('[ports]', `${unused.replace('mount = "none"', 'mount = "always"')}\n[ports]`),
        ]) expect((await identity(runtime)).runtime, runtime).not.toBe(base.runtime)
    })

    it('reports provenance from the native canonical config path', async () => {
        const directory = mkdtemp()
        const canonicalDirectory = join(directory, 'canonical')
        const aliasDirectory = join(directory, 'alias')
        mkdirSync(canonicalDirectory)
        mkdirSync(aliasDirectory)
        const canonicalPath = join(canonicalDirectory, 'cockpit.toml')
        const aliasPath = join(aliasDirectory, 'cockpit.toml')
        writeFileSync(canonicalPath, validConfig)
        symlinkSync(canonicalPath, aliasPath)

        const outcome = await loadCockpitConfig(aliasPath)

        expect(outcome.kind).toBe('complete')
        if (outcome.kind === 'complete') expect(outcome.result.source.path).toBe(realpathSync(canonicalPath))
    })

    it('refuses copied or extended configuration projections', async () => {
        const loaded = await loadCockpitConfig(fixture())
        if (loaded.kind === 'refusal') throw new Error('fixture configuration did not load')

        expect(consumeLoadedConfigProjection({ ...loaded.result } as never)).toBeUndefined()
        expect(consumeLoadedConfigProjection({ ...loaded.result, privateValue: 'config-secret-canary' } as never))
            .toBeUndefined()
        expect(consumeLoadedConfigProjection(loaded.result)).toMatchObject({
            source: loaded.result.source,
            config: { cockpit: { name: 'synthetic-cockpit' } },
        })
    })

    it('consumes a configuration projection exactly once', async () => {
        const loaded = await loadCockpitConfig(fixture())
        if (loaded.kind === 'refusal') throw new Error('fixture configuration did not load')

        expect(consumeLoadedConfigProjection(loaded.result)).toBeDefined()
        expect(consumeLoadedConfigProjection(loaded.result)).toBeUndefined()
    })

    it('projects the machine floor from the authenticated loaded revision exactly once', async () => {
        const loaded = await loadCockpitConfig(fixture(`${validConfig}
[environment]
[environment.machine]
runtime_memory_mb = 4096
runtime_cpus = 2.5
free_disk_mb = 8192
cold_start_seconds = 30
`))
        if (loaded.kind === 'refusal') throw new Error('fixture configuration did not load')
        const projection = projectMachineFloorConfig(loaded.result)

        expect(projection).toBeDefined()
        expect(consumeMachineFloorConfigProjection({ ...projection } as never)).toBeUndefined()
        expect(consumeMachineFloorConfigProjection(projection!)).toEqual({
            cockpitName: 'synthetic-cockpit',
            source: loaded.result.source,
            runtimeSha256: loaded.result.runtimeSha256,
            floor: { runtimeMemoryMb: 4096, runtimeCpus: 2.5, freeDiskMb: 8192 },
        })
        expect(consumeMachineFloorConfigProjection(projection!)).toBeUndefined()
        expect(consumeLoadedConfigProjection(loaded.result)).toBeDefined()
    })

    it('projects one immutable source-bound work environment before independently consuming its parent', async () => {
        const loaded = await loadCockpitConfig(fixture(workEnvironmentConfig))
        if (loaded.kind === 'refusal') throw new Error(`fixture configuration did not load: ${JSON.stringify(loaded.diagnostics)}`)
        const projection = projectWorkEnvironmentConfig(loaded.result)

        expect(projection).toBeDefined()
        expect(consumeWorkEnvironmentConfigProjection({ ...projection } as never)).toBeUndefined()
        const consumed = consumeWorkEnvironmentConfigProjection(projection!)
        expect(consumed).toMatchObject({
            cockpitName: 'synthetic-cockpit',
            cockpitRoot: resolve(loaded.result.source.path, '..'),
            siblingsRoot: 'siblings',
            source: loaded.result.source,
            siblings: [{ slug: 'api', dir: 'api-service', environmentFiles: [{ template: '.env.example', instance: '.env' }] }],
            workOrderPolicy: { cockpitCap: 2, programmeCap: 1, attemptCap: 1 },
            generatedHostPaths: browserArtifactPaths,
            browser: {
                harnesses: [{ target: 'codexcli', version: '0.149.0' }],
                engine: 'chromium',
                networkExposure: '<loopback>',
                maxClients: 1,
                data: { mode: 'empty', isolated: true, reachesProduction: false },
                artifacts: { runner: '.browser/runner', mcp: '.browser/mcp', cli: '.browser/cli', auth: '.browser/auth', debugger: '.browser/debugger' },
            },
            testing: { nativeHookInstall: 'inspect', declarations: { stages: [{ id: 'unit', command: ['npm', 'test'], requiresStack: false }] } },
        })
        expect(isValidatedWorkOrderPolicy(consumed?.workOrderPolicy)).toBe(true)
        expect(isValidatedWorkOrderPolicy({ ...consumed?.workOrderPolicy })).toBe(false)
        expect(Object.isFrozen(consumed?.testing?.declarations)).toBe(true)
        expect(Object.isFrozen(consumed?.testing?.declarations.stages)).toBe(true)
        expect(Object.isFrozen(consumed?.testing?.declarations.stages[0]?.command)).toBe(true)
        expect(Object.isFrozen(consumed?.testing?.declarations.gates)).toBe(true)
        expect(consumed).not.toHaveProperty('attemptCap')
        expect(consumed).not.toHaveProperty('staleParkDays')
        expect(consumeWorkEnvironmentConfigProjection(projection!)).toBeUndefined()
        expect(consumeLoadedConfigProjection(loaded.result)).toBeDefined()
    })

    it('retains explicit browser engine, manifest identity and configured proxy lease', async () => {
        const configured = workEnvironmentConfig.replace('[browser]\n', '[browser]\nengine = "webkit"\nnetwork_exposure = "*.example.invalid"\nnetwork_exposure_reason = "Declared isolated service access"\n')
            .replace('runner = { reference =', 'runner = { architectures = ["arm64"], reference =')
            .replace('max_clients = 1', 'runner_health_measurement = { duration_seconds = 15, provenance = { source = "synthetic-browser.toml", observed_on = "2026-10-24", kind = "measured", reason = "Synthetic readiness measurement" } }\nmax_clients = 1')
            .replace('bases = { APP_PORT = 4100 }', 'bases = { APP_PORT = 4100, BROWSER_PORT = 3001 }')
            .replace('project = { lockfile =', `project = { manifest = "package.json", manifest_sha256 = "${'d'.repeat(64)}", lockfile =`)
            .replace('proxy = { server_port =', 'proxy = { host_variable = "BROWSER_PORT", server_port =')
        const loaded = await loadCockpitConfig(fixture(configured))
        if (loaded.kind === 'refusal') throw new Error(`fixture configuration did not load: ${JSON.stringify(loaded.diagnostics)}`)
        const consumed = consumeWorkEnvironmentConfigProjection(projectWorkEnvironmentConfig(loaded.result)!)
        expect(consumed?.browser).toMatchObject({ engine: 'webkit', networkExposure: '*.example.invalid', networkExposureReason: 'Declared isolated service access',
            images: { runner: { architectures: ['arm64'] } }, runnerHealthMeasurement: { duration_seconds: 15, provenance: { kind: 'measured' } },
            project: { manifest: 'package.json', manifestSha256: 'd'.repeat(64) }, proxy: { hostVariable: 'BROWSER_PORT' } })
        expect(consumed?.browser?.proxy).not.toHaveProperty('widerExposure')
        for (const variable of ['MISSING_PORT', 'APP_PORT']) {
            const invalid = await loadCockpitConfig(fixture(configured.replace('host_variable = "BROWSER_PORT"', `host_variable = "${variable}"`)))
            expect(invalid).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'CONFIG_SCHEMA_INVALID' }] })
        }
    })

    it('rejects mismatched browser ownership and malformed testing references at the canonical load boundary', async () => {
        const mismatched = await loadCockpitConfig(fixture(workEnvironmentConfig.replace('generated_host_paths = [', 'generated_host_paths = [".unregistered", ')))
        expect(mismatched).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'CONFIG_SCHEMA_INVALID' }] })
        const malformedTesting = await loadCockpitConfig(fixture(workEnvironmentConfig.replace('stages = ["unit"]', 'stages = ["missing"]')))
        expect(malformedTesting).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'CONFIG_SCHEMA_INVALID' }] })
    })

    it('preserves the exact generated host path declaration consumed by the destructive adapter', async () => {
        const loaded = await loadCockpitConfig(fixture(workEnvironmentConfig))
        if (loaded.kind === 'refusal') throw new Error('fixture configuration did not load')
        const work = projectWorkEnvironmentConfig(loaded.result)
        const consumed = consumeWorkEnvironmentConfigProjection(work!)
        const parent = consumeLoadedConfigProjection(loaded.result)

        expect(consumed?.generatedHostPaths).toEqual(browserArtifactPaths)
        expect(parent?.config.environment.generated_host_paths).toEqual(consumed?.generatedHostPaths)
    })

    it('keeps an inaccessible source and nested config snapshot behind the public result identity', async () => {
        const source = `${validConfig}
[environment]
install_policies = [{ toolchain = "node", volume = "node-modules", lockfile = "package-lock.json", install = ["npm", "ci"], load_probe = ["npm", "test"] }]
`
        const loaded = await loadCockpitConfig(fixture(source))
        if (loaded.kind === 'refusal') throw new Error('fixture configuration did not load')
        const expectedPath = loaded.result.source.path
        ;(loaded.result.source as { path: string }).path = '/synthetic/forged.toml'
        loaded.result.config.sibling[0]!.dir = 'forged'
        loaded.result.config.environment.install_policies[0]!.install[0] = 'forged'

        const consumed = consumeLoadedConfigProjection(loaded.result)

        expect(consumed).toMatchObject({
            source: { path: expectedPath },
            config: {
                sibling: [expect.objectContaining({ dir: 'api-service' })],
                environment: { install_policies: [expect.objectContaining({ install: ['npm', 'ci'] })] },
            },
        })
    })

    it.each([
        {
            label: 'missing',
            arrange: () => join(mkdtemp(), 'missing.toml'),
            code: 'CONFIG_NOT_FOUND',
        },
        {
            label: 'unreadable',
            arrange: () => {
                const directory = mkdtemp()
                const configPath = join(directory, 'cockpit.toml')
                mkdirSync(configPath)
                return configPath
            },
            code: 'CONFIG_UNREADABLE',
        },
        { label: 'invalid UTF-8', arrange: () => fixture(Buffer.from([0xff])), code: 'CONFIG_ENCODING_INVALID' },
        { label: 'invalid TOML', arrange: () => fixture('[cockpit\nname ='), code: 'CONFIG_PARSE_INVALID' },
        { label: 'unknown key', arrange: () => fixture(`${validConfig}\nunknown = true\n`), code: 'CONFIG_SCHEMA_INVALID' },
        {
            label: 'schema invalid',
            arrange: () => fixture(validConfig.replace('acquire = "auto"', 'acquire = "none"')),
            code: 'CONFIG_SCHEMA_INVALID',
        },
    ])('refuses $label input without a partial config', async ({ arrange, code }) => {
        const outcome = await loadCockpitConfig(arrange())

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', result: null, status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code })])
        expect(JSON.stringify(outcome)).not.toContain('ssh://example.invalid/api.git')
    })

    it('refuses a host operation that names an executable other than node, naming the operation', async () => {
        const image = `node@sha256:${'d'.repeat(64)}`
        const withManifestProbe = (argv: readonly string[]) => `${readFileSync(resolve('examples/minimal/cockpit.toml'), 'utf8')}
[[environment.generated.services]]
id = "idle"
sibling = "api"
command = ["node", "-e", "setInterval(() => {}, 1000)"]
image = { reference = "${image}", reason = "Synthetic sidecar", architectures = ["arm64"], manifest_probe = { location = "host", cwd = ".", argv = ${JSON.stringify(argv)}, timeout_seconds = 30 } }
health = { property = "the process answers", probe = { location = "in-stack", service = "idle", cwd = ".", argv = ["node", "-e", "0"], timeout_seconds = 10 }, interval_seconds = 5, timeout_seconds = 3, retries = 4, start_period_seconds = 20 }
`
        const refused = await loadCockpitConfig(fixture(withManifestProbe(['docker', 'image', 'inspect', image])))
        expect(refused).toMatchObject({ kind: 'refusal', result: null, diagnostics: [{
            severity: 'error', code: 'GENERATED_HOST_EXECUTABLE_UNSUPPORTED',
            message: expect.stringContaining('environment.generated.services.1.image.manifest_probe runs "docker" on the host'),
            fix: expect.stringContaining('location = "in-stack"'),
        }] })

        expect((await loadCockpitConfig(fixture(withManifestProbe(['node', '-e', '0'])))).kind).toBe('complete')
    })

    it('names port families whose bases overlap across stacks and the step that separates them', async () => {
        const overlapping = await loadCockpitConfig(fixture(validConfig.replace(
            'bases = { APP_PORT = 4100 }', 'bases = { API_HOST_PORT = 4200, WEB_HOST_PORT = 4300 }')))
        expect(overlapping).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'CONFIG_SCHEMA_INVALID' }] })
        expect(overlapping.diagnostics[0]!.message).toContain(
            "ports.bases.WEB_HOST_PORT: API_HOST_PORT (4200) and WEB_HOST_PORT (4300) overlap: stack 1's API_HOST_PORT is stack 0's WEB_HOST_PORT with step 100; set [ports] step above the bases' spread (at least 101)")

        const separated = await loadCockpitConfig(fixture(validConfig.replace(
            'step = 100', 'step = 200').replace('bases = { APP_PORT = 4100 }', 'bases = { API_HOST_PORT = 4200, WEB_HOST_PORT = 4300 }')))
        expect(separated.kind).toBe('complete')
    })

    it('tells a deleted configuration in a cockpit checkout apart from a mistyped path', async () => {
        const directory = mkdtemp()
        const configPath = join(directory, 'cockpit.toml')
        expect((await loadCockpitConfig(configPath)).diagnostics).toEqual([{ severity: 'error', code: 'CONFIG_NOT_FOUND',
            message: 'cockpit configuration was not found', target: configPath }])
        recordSyncedConfig(directory, 'cockpit.toml')
        expect((await loadCockpitConfig(configPath)).diagnostics).toEqual([{ severity: 'error', code: 'CONFIG_NOT_FOUND',
            message: 'cockpit.toml is missing from a cockpit checkout (.cockpit/ is present); every cockpit command and guarded agent call reads it',
            target: configPath, fix: `git -C ${directory} restore -- cockpit.toml (it is committed), then retry` }])
        // A mistyped --config was never committed, so restoring it from git cannot work.
        const mistyped = join(directory, 'nope.toml')
        expect((await loadCockpitConfig(mistyped)).diagnostics).toEqual([{ severity: 'error', code: 'CONFIG_NOT_FOUND',
            message: `nope.toml does not exist; this cockpit checkout was synced from ${configPath}`,
            target: mistyped, fix: 'check the --config path, then retry' }])
        // An unreadable manifest chooses no remedy; it never turns the refusal into a crash.
        chmodSync(join(directory, '.cockpit', 'generated-environment-ownership.json'), 0o000)
        try {
            expect((await loadCockpitConfig(configPath)).diagnostics).toEqual([{ severity: 'error', code: 'CONFIG_NOT_FOUND',
                message: 'cockpit configuration was not found', target: configPath }])
        } finally { chmodSync(join(directory, '.cockpit', 'generated-environment-ownership.json'), 0o600) }
    })

    it('renders a missing-config recovery command as exact literal Git argv', async () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), "cockpit config '$(touch injected); ")))
        scratch.push(directory)
        const configName = "-cockpit'$(touch injected-file).toml"
        const configPath = join(directory, configName)
        const bin = join(directory, 'bin')
        const capture = join(directory, 'argv.json')
        recordSyncedConfig(directory, configName)
        mkdirSync(bin)
        const git = join(bin, 'git')
        writeFileSync(git, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))\n`)
        chmodSync(git, 0o755)

        const outcome = await loadCockpitConfig(configPath)
        expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'CONFIG_NOT_FOUND', fix: expect.any(String) }] })
        const command = outcome.diagnostics[0]!.fix!.replace(/ \(it is committed\), then retry$/, '')
        const executed = spawnSync('/bin/sh', ['-c', command], { cwd: directory, encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CAPTURE: capture } })

        expect(executed.status, executed.stderr).toBe(0)
        expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['-C', directory, 'restore', '--', configName])
        expect(() => readFileSync(join(directory, 'injected'))).toThrow()
        expect(() => readFileSync(join(directory, 'injected-file'))).toThrow()
    })

    it('keeps the executor contract resolved and policy-free', () => {
        expectTypeOf<ExecutionStep>().toMatchTypeOf<{
            id: string
            argv: readonly [string, ...string[]]
            cwd: string
            env: Readonly<Record<string, string>>
            timeoutMs: number
            stdoutLimitBytes: number
            stderrLimitBytes: number
            paths: readonly string[]
            ports: readonly number[]
            labels: Readonly<Record<string, string>>
            expected: readonly { kind: string; target: string }[]
            filesystemChecks: readonly {
                path: string
                expected: 'absent' | 'directory' | 'file'
                sha256?: string
            }[]
            compensation: readonly ExecutionStep[]
        }>()
        expectTypeOf<EnvironmentCommandOutcome<unknown>>().not.toBeAny()
        expectTypeOf<{ rawConfig: string }>().not.toMatchTypeOf<SetupRefusalEvidence>()
        expectTypeOf<{ execution: { stdout: string } }>().not.toMatchTypeOf<SetupRefusalEvidence>()
    })
})

function mkdtemp(): string {
    const directory = mkdtempSync(join(tmpdir(), 'cockpit-config-load-'))
    scratch.push(directory)
    return directory
}

// sync records the configuration it read in the ownership manifest; only that file is committed.
function recordSyncedConfig(directory: string, name: string): void {
    mkdirSync(join(directory, '.cockpit'))
    writeFileSync(join(directory, '.cockpit', 'generated-environment-ownership.json'),
        JSON.stringify({ format: 'cockpit-generated-ownership/v3', source: { path: name, sha256: 'a'.repeat(64) } }))
}
