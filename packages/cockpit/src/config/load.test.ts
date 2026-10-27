import { isValidatedWorkOrderPolicy } from '../work-orders/intake.js'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
runtime_measurements = [{ runtime = "docker-desktop", compose_floor = "2.20.0", measured_on = "2026-09-07", candidate = "passed", broken_control = "rejected", status = "supported" }]

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
            },
        })
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
