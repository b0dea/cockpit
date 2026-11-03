import { describe, expect, it } from 'vitest'

import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'
import { Autonomy, Browser, EntrypointDerivative, Environment, InstallPolicy, Sibling, Testing, Work } from './schema.js'
import { CockpitConfig, CustomHarness, Guards, SurfaceDeclaration, SurfaceOverlay } from './schema.js'
import { renderCockpitSchema } from './schema-json.js'
import { compileDraft04Schema } from '../test-support/draft04-validator.js'
import { parse as parseToml, stringify } from 'smol-toml'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCockpitConfig } from './config/load.js'

const provenance = { source: 'overlay.toml', observed_on: '2026-09-26', kind: 'declared', reason: 'Synthetic overlay declaration' }
const publishedCockpitValidator = compileDraft04Schema(JSON.parse(renderCockpitSchema()))

describe('bounded exact project command declarations', () => {
    it('requires sibling instruction pointers to be explicitly opted in', () => {
        const sibling = { slug: 'app', dir: 'app', mount: 'always', acquire: 'none', var: 'APP_DIR', purpose: 'Synthetic source' }
        expect(Sibling.parse(sibling).instruction_pointer).toBe(false)
        expect(Sibling.parse({ ...sibling, instruction_pointer: true }).instruction_pointer).toBe(true)
        expect(Sibling.safeParse({ ...sibling, dir: '.', instruction_pointer: true }).success).toBe(false)
        for (const variable of [
            'DOCKER_HOST', 'COMPOSE_PRODUCT_DIR', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'LIBPATH',
            'SHLIB_PATH', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'PATH', 'IFS',
        ]) {
            expect(Sibling.safeParse({ ...sibling, var: variable }).success, variable).toBe(false)
        }
        expect(Sibling.safeParse({ ...sibling, var: 'SIBLING_COMPOSE_PRODUCT_DIR' }).success).toBe(true)
    })

    it('bounds build and test by Unicode scalars without changing install or load probes', () => {
        const base = { toolchain: 'node', volume: 'dependencies', lockfile: 'package-lock.json', install: ['npm', 'x'.repeat(20_000)], load_probe: ['node', ...Array(4_097).fill('probe')] }
        expect(InstallPolicy.safeParse(base).success).toBe(true)
        for (const field of ['build', 'test']) {
            for (const word of ['a'.repeat(127), 'a'.repeat(128), '😀'.repeat(128), "'".repeat(128)]) {
                expect(InstallPolicy.safeParse({ ...base, [field]: Array(32).fill(word) }).success, `${field}: ${word.length}`).toBe(true)
            }
            for (const argv of [[], [''], Array(33).fill('x'), ['a'.repeat(129)], ['😀'.repeat(129)], ['\ud800'], ['\udfff'], ['x\0'], ['x\n'], ['x\x7f'], ['x\x80'], ['x\x9f']]) {
                expect(InstallPolicy.safeParse({ ...base, [field]: argv }).success, `${field}: ${JSON.stringify(argv)}`).toBe(false)
            }
        }
    })
})

describe('declared guard hosts', () => {
    it('defaults vendor authority separately and refuses normalized duplicates in either declaration', () => {
        expect(Guards.parse({})).toEqual({ hosted_db_hosts: [], vendor_endpoint_hosts: [], protected_branches: ['main', 'master'], allow: [], deny: [] })
        for (const field of ['hosted_db_hosts', 'vendor_endpoint_hosts']) {
            for (const hosts of [['db.example.test', 'db.example.test'], ['db.example.test', '*.db.example.test'], ['*.db.example.test', 'db.example.test'], Array.from({ length: 129 }, (_, index) => `host-${index}.example.test`)]) {
                expect(Guards.safeParse({ [field]: hosts }).success, `${field}: ${hosts}`).toBe(false)
            }
            expect(Guards.safeParse({ [field]: Array.from({ length: 128 }, (_, index) => `host-${index}.example.test`) }).success).toBe(true)
        }
        expect(Guards.parse({ hosted_db_hosts: ['db.example.test'], vendor_endpoint_hosts: ['*.db.example.test'] })).toMatchObject({ hosted_db_hosts: ['db.example.test'], vendor_endpoint_hosts: ['*.db.example.test'] })
    })

    it('accepts bounded command allow and deny rules and rejects ambiguous deny matchers', () => {
        const declared = Guards.parse({
            allow: [{ argv: ['make', 'verify'], reason: 'The repository-owned verification target is read-only.', cwd: '.' }],
            deny: [
                { prefix: ['make', 'release'], reason: 'Release changes shared state.', fix: 'Run make verify instead.' },
                { contains: ['--environment', 'shared'], reason: 'Shared environments are human-operated.' },
            ],
        })
        expect(declared.allow).toEqual([{ argv: ['make', 'verify'], reason: 'The repository-owned verification target is read-only.', cwd: '.' }])
        expect(declared.deny).toHaveLength(2)
        for (const deny of [
            { reason: 'missing matcher' },
            { prefix: ['make'], contains: ['release'], reason: 'ambiguous matcher' },
            { prefix: [], reason: 'empty matcher' },
            { contains: ['x\n'], reason: 'control word' },
        ]) expect(Guards.safeParse({ deny: [deny] }).success, JSON.stringify(deny)).toBe(false)
        for (const allow of [
            { argv: [], reason: 'empty matcher' },
            { argv: ['make'], reason: '' },
            { argv: ['make'], reason: 'valid', cwd: '../outside' },
            { argv: ['make'], reason: 'valid', cwd: '/outside' },
        ]) expect(Guards.safeParse({ allow: [allow] }).success, JSON.stringify(allow)).toBe(false)
    })
})
const stackConfig = {
    cockpit: { name: 'synthetic' },
    sibling: [{ slug: 'app', dir: 'app', mount: 'always', acquire: 'none', var: 'APP_DIR', toolchain: 'node', purpose: 'Synthetic service', environment_files: [{ template: '.env.example', instance: '.env' }],
        derives: { mcp_sources: [{ path: '.mcp.json', provenance }] } }],
    ports: { bases: { WEB_PORT: 4100 } },
    environment: {
        compose_files: ['compose.yml'],
        resettable_volumes: ['product-data'],
        seed: { argv: ['npm', 'run', 'seed'], timeout_seconds: 300 },
        install_policies: [{ toolchain: 'node', volume: 'dependencies', lockfile: 'package-lock.json', install: ['npm', 'ci'], load_probe: ['node', 'synthetic-probe.mjs'] }],
    },
}

const surfaceDeclaration = {
    name: 'consumer-guide',
    feature: 'rules',
    source: 'surfaces/consumer-guide.json',
    sources: [{ path: 'rules/consumer-guide.md', bytes: '# Consumer guide\n' }],
}

const customHarness = {
    name: 'synthetic-harness',
    capabilities: [
        {
            feature: 'rules',
            state: 'instructed',
            measured_on: '2026-09-26',
            spelling: 'config/rules.md',
            control: 'controls/rules.json',
            mechanism: { module: 'adapters/synthetic.mjs', export: 'renderRules' },
        },
        {
            feature: 'mcp',
            state: 'unavailable',
            measured_on: '2026-09-26',
            reason: 'The harness has no MCP mechanism',
        },
        ...['subagents', 'skills', 'hooks', 'permissions'].map((feature) => ({
            feature,
            state: 'unavailable',
            measured_on: '2026-09-26',
            reason: `The harness has no ${feature} mechanism`,
        })),
    ],
}

describe('consumer surface declarations', () => {
    it('accepts strict overlay sources and a complete dated custom harness matrix', () => {
        expect(SurfaceDeclaration.safeParse(surfaceDeclaration).success).toBe(true)
        expect(SurfaceOverlay.safeParse(surfaceDeclaration).success).toBe(true)
        expect(CustomHarness.safeParse(customHarness).success).toBe(true)
        const enforced = structuredClone(customHarness)
        Object.assign(enforced.capabilities[0]!, {
            state: 'enforced',
            evidence: { reference: 'evidence/rules.json', sha256: 'a'.repeat(64) },
        })
        expect(CustomHarness.safeParse(enforced).success).toBe(true)
        const parsed = CockpitConfig.parse({
            cockpit: { name: 'synthetic' },
            sibling: [{ slug: 'app', dir: 'app', mount: 'none', acquire: 'none', var: 'APP_DIR', purpose: 'Synthetic source' }],
            ports: { bases: {} },
            surfaces: { overlays: [surfaceDeclaration], harnesses: [customHarness], bundles: ['claudecode-plugin'] },
        })
        expect(parsed.surfaces).toEqual({ tools: ['claudecode', 'codexcli', 'opencode'], overlays: [surfaceDeclaration], harnesses: [customHarness], bundles: ['claudecode-plugin'], adopted: [] })
    })

    // A cloned repository's cockpit.toml is hostile input: `dir` is resolved under the siblings
    // root and each guide is joined onto it before being projected into the agent-visible tree.
    it.each(['../escape', '/etc', '..', './a', 'a/./b', 'a/../../b', 'a\\b'])('rejects sibling dir %j', (dir) => {
        const sibling = { slug: 'app', dir, mount: 'none', acquire: 'none', var: 'APP_DIR', purpose: 'Synthetic source' }
        expect(CockpitConfig.safeParse({ cockpit: { name: 'synthetic' }, sibling: [sibling], ports: { bases: {} } }).success).toBe(false)
    })

    it('accepts dir "." for a single-repository stack', () => {
        const sibling = { slug: 'app', dir: '.', mount: 'none', acquire: 'none', var: 'APP_DIR', purpose: 'Synthetic source' }
        expect(CockpitConfig.safeParse({ cockpit: { name: 'synthetic' }, sibling: [sibling], ports: { bases: {} } }).success).toBe(true)
    })

    it.each(['../../../secret', '/etc/passwd', 'docs/../../secret', 'docs\\..\\secret'])('rejects sibling guide %j', (guide) => {
        const sibling = { slug: 'app', dir: 'app', mount: 'none', acquire: 'none', var: 'APP_DIR', purpose: 'Synthetic source', guides: [guide] }
        expect(CockpitConfig.safeParse({ cockpit: { name: 'synthetic' }, sibling: [sibling], ports: { bases: {} } }).success).toBe(false)
    })

    it.each(['yaml', 'javascript', 'js', 'toml'])('rejects %s-qualified Markdown frontmatter', (language) => {
        expect(SurfaceOverlay.safeParse({
            name: 'synthetic-agent',
            feature: 'subagents',
            source: 'surfaces/synthetic-agent.json',
            sources: [{
                path: 'subagents/synthetic-agent.md',
                bytes: `---${language}\nname: synthetic-agent\n---\nSynthetic instructions.\n`,
            }],
        }).success).toBe(false)
    })

    it('rejects executable Markdown frontmatter after a byte-order mark', () => {
        expect(SurfaceOverlay.safeParse({
            name: 'synthetic-agent',
            feature: 'subagents',
            source: 'surfaces/synthetic-agent.json',
            sources: [{
                path: 'subagents/synthetic-agent.md',
                bytes: '\uFEFF---javascript\n({ name: "synthetic-agent" })\n---\nSynthetic instructions.\n',
            }],
        }).success).toBe(false)
    })

    it.each(['mcp', 'permissions'])('keeps %s in the neutral surface vocabulary but out of consumer overlays', (feature) => {
        const declaration = {
            ...surfaceDeclaration,
            feature,
            sources: [{ path: feature === 'mcp' ? 'mcp.jsonc' : 'permissions.jsonc', bytes: '{}\n' }],
        }
        expect(SurfaceDeclaration.safeParse(declaration).success).toBe(true)
        expect(SurfaceOverlay.safeParse(declaration).success).toBe(false)
        expect(CockpitConfig.safeParse({
            cockpit: { name: 'synthetic' },
            sibling: [{ slug: 'app', dir: 'app', mount: 'none', acquire: 'none', var: 'APP_DIR', purpose: 'Synthetic source' }],
            ports: { bases: {} },
            surfaces: { overlays: [declaration] },
        }).success).toBe(false)
    })

    it.each([
        ['missing date', () => { const value = structuredClone(customHarness); Reflect.deleteProperty(value.capabilities[0]!, 'measured_on'); return value }],
        ['missing mechanism', () => { const value = structuredClone(customHarness); Reflect.deleteProperty(value.capabilities[0]!, 'mechanism'); return value }],
        ['fake enforced claim', () => { const value = structuredClone(customHarness); Object.assign(value.capabilities[0]!, { state: 'enforced' }); return value }],
        ['unavailable emitted spelling', () => { const value = structuredClone(customHarness); Object.assign(value.capabilities[1]!, { spelling: 'hooks.json' }); return value }],
        ['unavailable emitted mechanism', () => { const value = structuredClone(customHarness); Object.assign(value.capabilities[1]!, { mechanism: { module: 'adapter.mjs', export: 'renderHooks' } }); return value }],
        ['missing feature cell', () => { const value = structuredClone(customHarness); value.capabilities.pop(); return value }],
        ['duplicate feature cell', () => { const value = structuredClone(customHarness); value.capabilities[1] = structuredClone(value.capabilities[2]!); return value }],
    ])('rejects a custom harness with %s', (_label, build) => {
        expect(CustomHarness.safeParse(build()).success).toBe(false)
    })

    it('rejects duplicate surface and harness identities at the config boundary', () => {
        const base = {
            cockpit: { name: 'synthetic' },
            sibling: [{ slug: 'app', dir: 'app', mount: 'none', acquire: 'none', var: 'APP_DIR', purpose: 'Synthetic source' }],
            ports: { bases: {} },
        }
        expect(CockpitConfig.safeParse({ ...base, surfaces: { overlays: [surfaceDeclaration, surfaceDeclaration] } }).success).toBe(false)
        expect(CockpitConfig.safeParse({ ...base, surfaces: { harnesses: [customHarness, customHarness] } }).success).toBe(false)
    })

    it('defaults to the measured tools and lists any other shipped tool only when asked, never none or only unguarded ones', () => {
        const base = {
            cockpit: { name: 'synthetic' },
            sibling: [{ slug: 'app', dir: 'app', mount: 'none', acquire: 'none', var: 'APP_DIR', purpose: 'Synthetic source' }],
            ports: { bases: {} },
        }
        expect(CockpitConfig.parse(base).surfaces).toEqual({ tools: ['claudecode', 'codexcli', 'opencode'], overlays: [], harnesses: [], bundles: [], adopted: [] })
        expect(CockpitConfig.parse({ ...base, surfaces: { tools: ['claudecode', 'cursor'] } }).surfaces.tools).toEqual(['claudecode', 'cursor'])
        for (const tools of [[], ['cursor'], ['cursor', 'grokcli'], ['claudecode', 'claudecode'], ['claudecode', 'unknown']]) {
            expect(CockpitConfig.safeParse({ ...base, surfaces: { tools } }).success, JSON.stringify(tools)).toBe(false)
        }
    })
})

describe('environment declarations', () => {
    it('declares one repository as an ordinary estate with no scope setting to narrow its surfaces', () => {
        expect(CockpitConfig.parse(stackConfig).sibling).toHaveLength(1)
        const scoped = { ...stackConfig, cockpit: { ...stackConfig.cockpit, scope: 'stack' } }
        expect(CockpitConfig.safeParse(scoped).success).toBe(false)
        expect(publishedCockpitValidator(scoped)).toBe(false)
    })

    it('loads a complete consumer-neutral declaration through runtime and editor schemas', () => {
        const parsed = CockpitConfig.safeParse(stackConfig)
        expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true)
        const validate = publishedCockpitValidator
        expect(validate(stackConfig), JSON.stringify(validate.errors)).toBe(true)
    })

    it('round-trips the declaration through the canonical TOML loader', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'cockpit-environment-schema-'))
        try {
            const path = join(directory, 'cockpit.toml')
            await writeFile(path, stringify(stackConfig))
            const loaded = await loadCockpitConfig(path)
            expect(loaded.kind).toBe('complete')
            if (loaded.kind === 'complete') expect(loaded.result.config.environment).toMatchObject(stackConfig.environment)
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    it.each([
        ['an environment.generated table', (config: typeof stackConfig) => { Reflect.set(config.environment, 'generated', { compose_file: 'compose.generated.yml' }) }],
        ['a sibling derives.generated row', (config: typeof stackConfig) => { Reflect.set(config.sibling[0]!.derives, 'generated', {}) }],
        ['an empty seed command', (config: typeof stackConfig) => { config.environment.seed.argv = [] }],
        ['a seed timeout past one hour', (config: typeof stackConfig) => { config.environment.seed.timeout_seconds = 3601 }],
        ['an unknown seed field', (config: typeof stackConfig) => { Reflect.set(config.environment.seed, 'cwd', 'app') }],
        ['an inferred unconfirmed provenance', (config: typeof stackConfig) => { config.sibling[0]!.derives.mcp_sources[0]!.provenance = { ...provenance, kind: 'inferred' } }],
    ])('rejects %s through runtime and editor schemas', (_name, mutate) => {
        const config = structuredClone(stackConfig)
        mutate(config)
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        const validate = publishedCockpitValidator
        expect(validate(config)).toBe(false)
    })

    it.each([
        ['resettable volume without Compose files', (config: typeof stackConfig) => { Reflect.set(config.environment, 'compose_files', []); Reflect.deleteProperty(config.environment, 'seed') }, 'environment.resettable_volumes[]', 'declared_compose_volume_key'],
        ['seed without resettable volumes', (config: typeof stackConfig) => { config.environment.resettable_volumes = [] }, 'environment.seed', 'requires_resettable_volumes'],
    ])('enforces the runtime-only %s relation without claiming editor enforcement', (_name, mutate, path, rule) => {
        const config = structuredClone(stackConfig)
        mutate(config)
        const parsed = CockpitConfig.safeParse(config)
        expect(parsed.success).toBe(false)
        if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.code === 'custom')).toBe(true)
        const schema = JSON.parse(renderCockpitSchema())
        expect(schema['x-cockpit-runtime-checks']).toContainEqual({ path, rule })
    })

    it('accepts the minimal example through runtime and editor schemas', async () => {
        const minimal = parseToml(await readFile(fileURLToPath(new URL('../../../examples/minimal/cockpit.toml', import.meta.url)), 'utf8'))
        const validate = publishedCockpitValidator
        const parsed = CockpitConfig.safeParse(minimal)
        expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true)
        expect(validate(minimal), JSON.stringify(validate.errors)).toBe(true)
    })

    it('lets a declaration omit observed_on only when this configuration file is its source', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'cockpit-provenance-'))
        try {
            const path = join(directory, 'cockpit.toml')
            const undated = (source: string) => {
                const config = structuredClone(stackConfig)
                config.sibling[0]!.derives.mcp_sources[0]!.provenance = { source, kind: 'declared', reason: 'Written in the configuration' } as typeof provenance
                return config
            }
            await writeFile(path, stringify(undated('cockpit.toml')))
            expect((await loadCockpitConfig(path)).kind).toBe('complete')
            await writeFile(path, stringify(undated('docs/runtime.md')))
            expect(await loadCockpitConfig(path)).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
                message: expect.stringContaining('sibling.0.derives.mcp_sources.0.provenance: provenance without observed_on must name this configuration file (cockpit.toml)'),
                fix: expect.stringContaining('observed_on'),
            })] })
            const measured = undated('cockpit.toml')
            measured.sibling[0]!.derives.mcp_sources[0]!.provenance.kind = 'measured'
            expect(CockpitConfig.safeParse(measured).success).toBe(false)
            expect(publishedCockpitValidator(measured)).toBe(false)
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })
})

describe('entrypoint kind ownership', () => {
    it('accepts every published kind and rejects values outside the vocabulary', () => {
        for (const kind of ENTRYPOINT_KINDS) {
            expect(EntrypointDerivative.safeParse({ name: 'web', kind, port: 'WEB', path: '/' }).success).toBe(true)
        }
        expect(EntrypointDerivative.safeParse({ name: 'web', kind: 'other', port: 'WEB', path: '/' }).success).toBe(false)
    })

    it('keeps runtime and editor declarations aligned for bounded local HTTP origins', () => {
        const base = { name: 'application', kind: 'origin', port: 'WEB_PORT', path: '/' }
        const longestHostname = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(51)}.localhost`
        const cases = [
            [{}, true],
            [{ hostname: 'app.sample.localhost' }, true],
            [{ scheme: 'https' }, true],
            [{ hostname: 'app.sample.localhost', scheme: 'http' }, true],
            [{ hostname: longestHostname, scheme: 'https' }, true],
            [{ hostname: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(52)}.localhost` }, false],
            [{ hostname: `${'a'.repeat(64)}.localhost` }, false],
            [{ hostname: 'localhost' }, false],
            [{ hostname: '127.0.0.1' }, false],
            [{ hostname: 'app.sample.test' }, false],
            [{ hostname: 'app.localhost.example.test' }, false],
            [{ hostname: 'App.sample.localhost' }, false],
            [{ hostname: 'app_sample.localhost' }, false],
            [{ hostname: '-app.localhost' }, false],
            [{ hostname: 'app-.localhost' }, false],
            [{ hostname: 'app..localhost' }, false],
            [{ hostname: 'app.localhost.' }, false],
            [{ hostname: 'app.localhost\n' }, false],
            [{ hostname: 'app.localhost:8443' }, false],
            [{ hostname: 'user@app.localhost' }, false],
            [{ hostname: '*.sample.localhost' }, false],
            [{ scheme: 'https:' }, false],
            [{ scheme: 'HTTPS' }, false],
            [{ scheme: 'file' }, false],
        ] as const
        for (const [address, accepted] of cases) {
            const declaration = { ...base, ...address }
            const config = { ...stackConfig, environment: {
                ...stackConfig.environment, entrypoint_derivatives: [declaration],
            } }
            expect(EntrypointDerivative.safeParse(declaration).success, JSON.stringify(address)).toBe(accepted)
            expect(CockpitConfig.safeParse(config).success, JSON.stringify(address)).toBe(accepted)
            expect(publishedCockpitValidator(config), JSON.stringify(publishedCockpitValidator.errors)).toBe(accepted)
        }
    })
})

describe('posture requirement declarations', () => {
    it('accepts exact posture requirement tags without inventing missing declarations', () => {
        const tags = [
            { requirement: 'browser-addressing', addressing: 'hostname' },
            { requirement: 'local-authentication', authentication: 'bypassed' },
            { requirement: 'authenticated-route', addressing: 'port', authentication: 'real' },
        ]
        expect(Environment.parse({ posture_requirements: tags }).posture_requirements).toEqual(tags)
        expect(Environment.parse({})).not.toHaveProperty('posture_requirements')
    })

    it('rejects malformed and duplicate posture requirement declarations', () => {
        for (const tags of [
            [{ requirement: 'unmarked-requirement' }],
            [{ requirement: 'invalid/identifier', addressing: 'hostname' }],
            [{ requirement: 'x'.repeat(65), addressing: 'hostname' }],
            [{ requirement: 'route', addressing: 'unknown' }],
            [{ requirement: 'route', authentication: 'unknown' }],
            [{ requirement: 'route', addressing: 'hostname', extra: true }],
            [{ requirement: 'route', addressing: 'hostname' }, { requirement: 'route', authentication: 'real' }],
            Array.from({ length: 129 }, (_, index) => ({ requirement: `route-${index}`, addressing: 'hostname' })),
        ]) expect(Environment.safeParse({ posture_requirements: tags }).success).toBe(false)
    })
})

describe('work and browser declarations', () => {
    const browser = {
        harnesses: [{ target: 'codexcli', version: '0.149.0' }],
        images: {
            runner: { reference: `synthetic.invalid/runner@sha256:${'a'.repeat(64)}`, driver_version: '1.2.3' },
            mcp: { reference: `synthetic.invalid/mcp@sha256:${'b'.repeat(64)}`, driver_version: '1.2.3' },
        },
        project: { lockfile: 'package-lock.json', sha256: 'c'.repeat(64), driver_version: '1.2.3' },
        endpoint: 'ws://localhost:3001/', max_clients: 2,
        proxy: { server_port: 3000, proxy_port: 3001, allowed_hosts: ['localhost:3001'] },
        resolver: [{ hostname: 'app.example.invalid', address: '127.0.0.1' }],
        authentication: { policy: 'per-worker', states: [
            { worker: 'first', path: '.browser/auth/first.json' },
            { worker: 'second', path: '.browser/auth/second.json' },
        ] },
        data: { mode: 'seeded', isolated: true, reaches_production: false },
        request_preapproval: true, headed: false,
        artifacts: { runner: '.browser/runner', mcp: '.browser/mcp', cli: '.browser/cli', auth: '.browser/auth', debugger: '.browser/debugger' },
    }

    // The runner these described was a service cockpit rendered into its own Compose file.
    it('refuses the rendered-runner fields through runtime and editor schemas', () => {
        const config = { ...stackConfig, environment: { ...stackConfig.environment,
            addressing: 'hostname', authentication: 'real', generated_host_paths: Object.values(browser.artifacts),
            posture_requirements: [{ requirement: 'authenticated-route', addressing: 'hostname', authentication: 'real' }],
        } }
        const accepted = { ...config, browser }
        expect(CockpitConfig.safeParse(accepted).success).toBe(true)
        for (const declaration of [
            { ...browser, resources: { memory_mb: 768, cpus: 0.5, provenance } },
            { ...browser, runner_health_measurement: { duration_seconds: 15, provenance: { ...provenance, kind: 'measured' } } },
            { ...browser, images: { ...browser.images, runner: { ...browser.images.runner, architectures: ['arm64'] } } },
        ]) {
            const candidate = { ...config, browser: declaration }
            expect(CockpitConfig.safeParse(candidate).success).toBe(false)
            expect(publishedCockpitValidator(candidate)).toBe(false)
        }
    })

    it('drives a browser signed out for a product with no sign-in, without a requirement tagged for it', () => {
        const environment = { ...stackConfig.environment,
            addressing: 'hostname', authentication: 'none', generated_host_paths: Object.values(browser.artifacts),
            posture_requirements: [{ requirement: 'local-route', addressing: 'hostname' }],
        }
        const signedOut = { ...browser, authentication: { policy: 'none', states: [] } }
        expect(CockpitConfig.safeParse({ ...stackConfig, environment, browser: signedOut }).success).toBe(true)
        expect(CockpitConfig.safeParse({ ...stackConfig, environment, browser: { ...signedOut, authentication: browser.authentication } }).success).toBe(false)
    })

    it('keeps WIP and attempt controls lower-only and each decision to agent, person or ci', () => {
        expect(Work.parse({})).toEqual({ grading: 'independent', attempt_cap: 2, wip_cap: 3, gates: {},
            verification_timeout_seconds: 1_800, evaluator_timeout_seconds: 900 })
        expect(Work.parse({ evaluators: ['opencode', 'claudecode'] })).toMatchObject({ evaluators: ['opencode', 'claudecode'] })
        for (const evaluators of [[], ['cursor'], ['claudecode', 'claudecode']]) expect(Work.safeParse({ evaluators }).success, JSON.stringify(evaluators)).toBe(false)
        for (const field of ['verification_timeout_seconds', 'evaluator_timeout_seconds']) {
            for (const value of [0, 7_201, 1.5]) expect(Work.safeParse({ [field]: value }).success, `${field}=${value}`).toBe(false)
        }
        expect(Work.parse({ wip_cap: 1 })).toMatchObject({ wip_cap: 1 })
        for (const value of [0, 4, 1.5]) expect(Work.safeParse({ wip_cap: value }).success).toBe(false)
        for (const value of [0, 3]) expect(Work.safeParse({ attempt_cap: value }).success).toBe(false)
        expect(Work.safeParse({ grading: 'vibes' }).success).toBe(false)
        expect(Work.safeParse({ gates: { accept: 'ci', signoff: 'person' } }).success).toBe(true)
        expect(Work.safeParse({ gates: { accept: 'anyone' } }).success).toBe(false)
        expect(Work.safeParse({ gates: { merge: 'agent' } }).success).toBe(false)
        expect(Autonomy.safeParse({ preset: 'agent', reset: 'ci', sync: 'person' }).success).toBe(true)
        // An MCP approval is a digest a person records, which CI cannot add to.
        expect(Autonomy.safeParse({ mcp_approve: 'ci' }).success).toBe(false)
        expect(Autonomy.safeParse({ commit: 'agent' }).success).toBe(false)
    })

    it('pins the runner to the project driver exactly and lets an MCP pre-release share its major.minor', () => {
        const drivers = (runner: string, mcp: string, project: string) => Browser.safeParse({ ...browser,
            images: { runner: { ...browser.images.runner, driver_version: runner }, mcp: { ...browser.images.mcp, driver_version: mcp } },
            project: { ...browser.project, driver_version: project } }).success
        expect(drivers('1.64.0', '1.64.0-alpha-2026-10-20', '1.64.0')).toBe(true)
        expect(drivers('1.64.0-beta.1', '1.64.0-beta.1', '1.64.0-beta.1')).toBe(true)
        expect(drivers('1.64.0', '1.65.0-alpha', '1.64.0')).toBe(false)
        expect(drivers('1.64.1', '1.64.0', '1.64.0')).toBe(false)
        for (const malformed of ['1.64', '1.64.0-', '1.64.0-alpha..1', '01.64.0', '1.64.0-01', '^1.64.0', '1.64.0+build'])
            expect(drivers('1.64.0', malformed, '1.64.0'), malformed).toBe(false)
    })

    it('selects supported browser engines and refuses TLS endpoints without TLS termination', () => {
        expect(Browser.parse(browser).engine).toBe('chromium')
        for (const engine of ['chromium', 'firefox', 'webkit']) expect(Browser.parse({ ...browser, engine }).engine).toBe(engine)
        expect(Browser.safeParse({ ...browser, engine: 'unknown' }).success).toBe(false)
        for (const [scheme, port] of [['ws', 80], ['wss', 443]] as const) {
            expect(Browser.safeParse({ ...browser, endpoint: `${scheme}://localhost:${port}/`,
                proxy: { ...browser.proxy, proxy_port: port, allowed_hosts: [`localhost:${port}`] } }).success).toBe(scheme === 'ws')
            expect(Browser.safeParse({ ...browser, endpoint: `${scheme}://other.invalid:${port}/`,
                proxy: { ...browser.proxy, proxy_port: port, allowed_hosts: [`localhost:${port}`] } }).success).toBe(false)
        }
    })

    it('refuses browser harnesses whose native transport has no measured support', () => {
        const environment = { ...stackConfig.environment,
            addressing: 'hostname', authentication: 'real', generated_host_paths: Object.values(browser.artifacts),
            posture_requirements: [{ requirement: 'authenticated-route', addressing: 'hostname', authentication: 'real' }],
        }
        for (const target of ['cursor', 'grokcli']) {
            const declaration = { ...browser, harnesses: [{ target, version: '1.2.3' }] }
            const config = { ...stackConfig, environment, browser: declaration }
            expect(Browser.safeParse(declaration).success).toBe(false)
            expect(CockpitConfig.safeParse(config).success).toBe(false)
            expect(publishedCockpitValidator(config), JSON.stringify(publishedCockpitValidator.errors)).toBe(false)
        }
        // A measured tool the cockpit does not list gets no browser wiring either.
        const measured = { ...stackConfig, environment, browser }
        expect(CockpitConfig.safeParse(measured).success).toBe(true)
        expect(CockpitConfig.safeParse({ ...measured, surfaces: { tools: ['claudecode'] } }).success).toBe(false)
    })

    it('defaults network exposure to loopback and requires a reason for declared wider rules', () => {
        expect(Browser.parse(browser).network_exposure).toBe('<loopback>')
        expect(Browser.parse({ ...browser, network_exposure: '*.example.invalid,127.0.0.1',
            network_exposure_reason: 'Declared isolated service access' }).network_exposure).toBe('*.example.invalid,127.0.0.1')
        for (const value of [
            { network_exposure: '*' },
            { network_exposure: '*', network_exposure_reason: ' ' },
            { network_exposure: '<loopback>', network_exposure_reason: 'Redundant decision' },
            { network_exposure: '<loopback>,<loopback>', network_exposure_reason: 'Duplicated rule' },
            { network_exposure: 'host.invalid/path', network_exposure_reason: 'Invalid rule' },
            { network_exposure: 'example.invalid:0', network_exposure_reason: 'Invalid zero port' },
            { network_exposure: '*.127.0.0.1', network_exposure_reason: 'Invalid wildcard address' },
        ]) expect(Browser.safeParse({ ...browser, ...value }).success).toBe(false)
    })

    it('binds explicit browser project manifests and proxy leases without accepting partial identities', () => {
        const project = { ...browser.project, manifest: 'package.json', manifest_sha256: 'd'.repeat(64) }
        expect(Browser.safeParse({ ...browser, project, proxy: { ...browser.proxy, host_variable: 'BROWSER_PORT' } }).success).toBe(true)
        expect(Browser.safeParse({ ...browser, project: { ...browser.project, manifest: 'package.json' } }).success).toBe(false)
        expect(Browser.safeParse({ ...browser, project: { ...browser.project, manifest_sha256: 'd'.repeat(64) } }).success).toBe(false)
    })

    it('rejects unsafe browser posture, artifact and authentication declarations', () => {
        expect(Browser.safeParse(browser).success).toBe(true)
        expect(Browser.safeParse({ ...browser, request_preapproval: true, data: { ...browser.data, mode: 'restored' } }).success).toBe(false)
        expect(Browser.safeParse({ ...browser, proxy: { ...browser.proxy, bind: '0.0.0.0' } }).success).toBe(false)
        expect(Browser.safeParse({ ...browser, proxy: { ...browser.proxy, bind: '0.0.0.0', wider_exposure: true } }).success).toBe(false)
        expect(Browser.safeParse({ ...browser, proxy: { ...browser.proxy, bind: '::' as const, wider_exposure: true } }).success).toBe(false)
        expect(Browser.safeParse({ ...browser, proxy: { ...browser.proxy, bind: '::1' as const } }).success).toBe(true)
        expect(Browser.safeParse({ ...browser, artifacts: { ...browser.artifacts, cli: '.browser/mcp/cli' } }).success).toBe(false)
        expect(Browser.safeParse({ ...browser, authentication: { ...browser.authentication, states: [browser.authentication.states[0], browser.authentication.states[0]] } }).success).toBe(false)
    })

    it('requires authentication states below the auth root and unique proxy authorities', () => {
        expect(Browser.safeParse({ ...browser, authentication: { policy: 'serialized', states: [
            { worker: 'shared', path: browser.artifacts.auth },
        ] } }).success).toBe(false)
        expect(Browser.safeParse({ ...browser, proxy: {
            ...browser.proxy, allowed_hosts: [browser.proxy.allowed_hosts[0], browser.proxy.allowed_hosts[0]],
        } }).success).toBe(false)
        for (const authority of ['null:3001', 'undefined:3001']) {
            expect(Browser.safeParse({ ...browser, endpoint: `ws://${authority}/`, proxy: {
                ...browser.proxy, allowed_hosts: [authority],
            } }).success, authority).toBe(false)
        }
    })

    it('accepts only closed product-owned gate and hook declarations', () => {
        const testing = { stages: [{ id: 'unit', command: ['npm', 'test'], requires_stack: false }],
            gates: [{ id: 'focused', tier: 'targeted', stages: ['unit'], changes: 'Isolated behavior' }], native_hooks: { install: 'inspect' } }
        expect(Testing.safeParse(testing).success).toBe(true)
        expect(Testing.safeParse({ ...testing, gates: [{ ...testing.gates[0], stages: ['missing'] }] }).success).toBe(false)
        expect(Testing.safeParse({ ...testing, native_hooks: { install: 'automatic' } }).success).toBe(false)
        expect(Testing.safeParse({ ...testing, native_hooks: { install: 'explicit-native' } }).success).toBe(false)
        expect(Testing.safeParse({ ...testing, native_hooks: { install: 'explicit-native' }, native_hook_policy: { path: 'hook-policy.txt', sha256: 'a'.repeat(64) } }).success).toBe(true)
        // Hooks are inspect-only unless declared otherwise, so the table may be left out, but not under a policy.
        const { native_hooks: _hooks, ...undeclared } = testing
        expect(Testing.parse(undeclared).native_hooks).toEqual({ install: 'inspect' })
        expect(Testing.safeParse({ ...undeclared, native_hook_policy: { path: 'hook-policy.txt', sha256: 'a'.repeat(64) } }).success).toBe(false)
        expect(Testing.safeParse({ ...testing, extra: true }).success).toBe(false)
        const selecting = (select: unknown) => ({ ...testing, stages: [{ ...testing.stages[0], select }] })
        expect(Testing.safeParse(selecting({ file: ['{value}'], test: ['-t', '{value}'] })).success).toBe(true)
        // A selection that never places the value would run the stage unselected under a selected verdict.
        expect(Testing.safeParse(selecting({ test: ['-t'] })).success).toBe(false)
        expect(Testing.safeParse(selecting({ suite: ['{value}'] })).success).toBe(false)
    })
})

it('rejects the superseded stale age control as an unknown key', () => {
    const result = Work.safeParse({ stale_park_days: 14 })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ code: 'unrecognized_keys', keys: ['stale_park_days'] }))
})
