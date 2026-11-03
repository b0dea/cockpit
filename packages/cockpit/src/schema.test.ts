import { describe, expect, it } from 'vitest'

import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'
import { Browser, EntrypointDerivative, Environment, GeneratedService, InstallPolicy, Sibling, Testing, Workorders } from './schema.js'
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
const operation = { location: 'in-stack', service: 'app', cwd: '.', argv: ['node', 'synthetic-operation.mjs'], timeout_seconds: 30, provenance }
const structuralDecisions = [
    ['service-app', 'service', 'app'],
    ['volume-dependencies', 'volume', 'dependencies'],
    ['volume-product-data', 'volume', 'product-data'],
    ['data-default', 'data-default', 'seeded'],
    ['data-mode-empty', 'data-mode', 'empty'],
    ['data-mode-seeded', 'data-mode', 'seeded'],
    ['data-mode-restored', 'data-mode', 'restored'],
    ['restore-policy', 'restore', 'policy'],
    ['mount-dependencies', 'mount', 'app:volume:dependencies:/app/node_modules'],
    ['mount-product-data', 'mount', 'app:volume:product-data:/app/data'],
    ['mount-source', 'mount', 'app:bind:.:/app/source'],
    ['port-web', 'port', 'app:web'],
].map(([id, subject, subject_id]) => ({ id, subject, subject_id, decided_on: '2026-09-26', decision: `Synthetic ${subject}`, rejected: ['Undeclared structure'], reason: 'Reproducible environment', provenance }))
const generatedConfig = {
    cockpit: { name: 'synthetic' },
    sibling: [{ slug: 'app', dir: 'app', mount: 'always', acquire: 'none', var: 'APP_DIR', toolchain: 'node', purpose: 'Synthetic service', environment_files: [{ template: '.env.example', instance: '.env' }] }],
    ports: { bases: { WEB_PORT: 4100 } },
    environment: {
        resettable_volumes: ['product-data'],
        install_policies: [{ toolchain: 'node', volume: 'dependencies', lockfile: 'package-lock.json', install: ['npm', 'ci'], load_probe: ['node', 'synthetic-probe.mjs'] }],
        generated: {
            compose_file: 'compose.generated.yml',
            services: [{
                id: 'app', sibling: 'app', role: 'service', profiles: [], command: ['node', 'server.mjs'],
                image: { reference: `example.invalid/synthetic@sha256:${'a'.repeat(64)}`, reason: 'Stable synthetic runtime', architectures: ['amd64', 'arm64'], manifest_probe: operation, provenance },
                ports: [{ name: 'web', host_variable: 'WEB_PORT', internal: 3000, host_ip: '127.0.0.1' }],
                mounts: [{ kind: 'volume', source: 'dependencies', target: '/app/node_modules' }, { kind: 'volume', source: 'product-data', target: '/app/data' }, { kind: 'bind', source: '.', target: '/app/source', source_type: 'directory' }],
                dependencies: [],
                health: { property: 'Synthetic route resolves', probe: operation, tool_probe: operation, interval_seconds: 5, timeout_seconds: 3, retries: 3, start_period_seconds: 20, measurement: { duration_seconds: 15, provenance } },
                toolchain_pins: [{ path: '.node-version', pinned: '22.0.0', observed: '22.0.0', provenance }],
                provenance,
            }],
            volumes: [{ id: 'dependencies', purpose: 'dependencies', install_policy: 'dependencies', provenance }, { id: 'product-data', purpose: 'product-data', provenance }],
            data: {
                volume: 'product-data',
                default_mode: 'seeded',
                modes: ['empty', 'seeded', 'restored'].map((mode) => ({ mode, operations: (mode === 'empty' ? ['schema'] : mode === 'seeded' ? ['schema', 'sweep', 'fixtures'] : ['schema', 'restore', 'rewrite']).map((kind, index, kinds) => ({ id: kind, kind, operation, prerequisites: [], after: kinds.slice(0, index), fresh_volume_only: mode === 'restored', provenance })), probes: [operation], provenance })),
                fixtures: { persona_source: 'fixtures/personas.json', persona_outputs: [{ path: 'fixtures/personas.generated.ts', format: 'typescript', reason: 'Synthetic importer cannot read JSON' }], volume_tag: 'synthetic-volume', pagination_warning: 'Default fixtures do not cover large lists', volume_operations: [operation], volume_probes: [operation], provenance },
                restore: { rewrites: [{ category: 'object-store', operation, reason: 'Use local synthetic storage' }], untouched: ['identities', 'third-party-ids', 'personal-data', 'timer-state'], provenance },
            },
            vendors: ['bypassed', 'stubbed', 'substituted', 'vendor-sandbox', 'record-replay', 'absent-and-gated'].map((posture, index) => ({
                id: posture, posture, reason: 'Synthetic vendor posture', provenance,
                endpoints: [{ variable: `SYNTHETIC_ENDPOINT_${index}`, sink: 'http://app:3000/sink', runtime_service: 'app', supplier: { sibling: 'app', template: '.env.example' } }],
                loader_probe: operation, route_probe: operation, egress_probe: operation,
                placeholder: `cockpit:absent:${posture}`,
                callback_reachability: { reachable: false, alternative: 'Synthetic local replay', reason: 'Synthetic sender cannot reach this stack' },
                ...(posture === 'vendor-sandbox' ? { expiry: { expires_on: '2027-01-01', reason: 'Synthetic trial expiry', probe: operation } } : {}),
                ...(posture === 'stubbed' ? {
                    stub: { rejection_probe: operation, outage_probe: operation },
                    callback: { enable: operation, timestamp_source: operation, fresh_window_seconds: 60, fixture: { path: 'fixtures/callback.raw', sha256: 'b'.repeat(64) }, sign: operation, dispatch: operation, tamper_probe: operation },
                    tls: { generate_at_start: operation, append_trust_probe: operation, hostname_probe: operation },
                } : {}),
            })),
            decisions: { entries: [...structuralDecisions, ...['bypassed', 'stubbed', 'substituted', 'vendor-sandbox', 'record-replay', 'absent-and-gated'].map((posture) => ({ id: posture, subject: 'vendor', subject_id: posture, decided_on: '2026-09-26', decision: posture, rejected: ['Undeclared live endpoint'], reason: 'Explicit local behavior', provenance }))] },
        },
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

describe('generated environment declarations', () => {
    it('declares one repository as an ordinary estate with no scope setting to narrow its surfaces', () => {
        expect(CockpitConfig.parse(generatedConfig).sibling).toHaveLength(1)
        const scoped = { ...generatedConfig, cockpit: { ...generatedConfig.cockpit, scope: 'stack' } }
        expect(CockpitConfig.safeParse(scoped).success).toBe(false)
        expect(publishedCockpitValidator(scoped)).toBe(false)
    })

    it('loads a complete consumer-neutral declaration through runtime and editor schemas', () => {
        const parsed = CockpitConfig.safeParse(generatedConfig)
        expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true)
        const validate = publishedCockpitValidator
        expect(validate(generatedConfig), JSON.stringify(validate.errors)).toBe(true)
    })

    it('round-trips the declaration through the canonical TOML loader', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'cockpit-generated-schema-'))
        try {
            const path = join(directory, 'cockpit.toml')
            await writeFile(path, stringify(generatedConfig))
            const loaded = await loadCockpitConfig(path)
            expect(loaded.kind).toBe('complete')
            if (loaded.kind === 'complete') expect(loaded.result.config.environment.generated).toEqual(generatedConfig.environment.generated)
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    it.each([
        ['floating image', (config: typeof generatedConfig) => { config.environment.generated.services[0].image.reference = 'example.invalid/synthetic:latest' }],
        ['unbounded command', (config: typeof generatedConfig) => { config.environment.generated.services[0].command = Array(257).fill('argument') }],
        ['path traversal', (config: typeof generatedConfig) => { config.environment.generated.compose_file = '../compose.yml' }],
        ['missing posture reason', (config: typeof generatedConfig) => { config.environment.generated.vendors[0].reason = '' }],
        ['invalid measurement date', (config: typeof generatedConfig) => { config.environment.generated.services[0].health.measurement.provenance.observed_on = '2026-99-99' }],
        ['whitespace reason', (config: typeof generatedConfig) => { config.environment.generated.vendors[0].reason = '   ' }],
        ['undeclared posture', (config: typeof generatedConfig) => { config.environment.generated.vendors[0].posture = 'invented' }],
        ['missing expiry', (config: typeof generatedConfig) => { Reflect.deleteProperty(config.environment.generated.vendors[3], 'expiry') }],
        ['missing stub controls', (config: typeof generatedConfig) => { Reflect.deleteProperty(config.environment.generated.vendors[1], 'stub') }],
        ['host operation with service', (config: typeof generatedConfig) => { config.environment.generated.services[0].health.probe.location = 'host' }],
        ['inferred unconfirmed provenance', (config: typeof generatedConfig) => { config.environment.generated.services[0].provenance.kind = 'inferred' }],
        ['open-ended decision subject', (config: typeof generatedConfig) => { config.environment.generated.decisions.entries[0].subject = 'structure' }],
        ['uppercase endpoint URL spelling', (config: typeof generatedConfig) => { config.environment.generated.vendors[0].endpoints[0].sink = 'HTTP://APP:3000/sink' }],
    ])('rejects %s through runtime and editor schemas', (_name, mutate) => {
        const config = structuredClone(generatedConfig)
        mutate(config)
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        const validate = publishedCockpitValidator
        expect(validate(config)).toBe(false)
    })

    it.each([
        ['duplicate identities', (config: typeof generatedConfig) => { config.environment.generated.services.push({ ...config.environment.generated.services[0], command: ['node', 'other.mjs'] }) }],
        ['undeclared service', (config: typeof generatedConfig) => { config.environment.generated.services[0].health.probe.service = 'missing' }],
        ['undeclared sibling', (config: typeof generatedConfig) => { config.environment.generated.services[0].sibling = 'missing' }],
        ['undeclared lease', (config: typeof generatedConfig) => { config.environment.generated.services[0].ports[0].host_variable = 'MISSING_PORT' }],
        ['undeclared policy', (config: typeof generatedConfig) => { Reflect.set(config.environment.generated.volumes[0], 'install_policy', 'missing') }],
        ['undeclared resettable volume', (config: typeof generatedConfig) => { Reflect.set(config.environment, 'resettable_volumes', ['product-dta']) }],
        ['too-short measured start', (config: typeof generatedConfig) => { config.environment.generated.services[0].health.start_period_seconds = 1 }],
        ['nonlocal sink', (config: typeof generatedConfig) => { config.environment.generated.vendors[0].endpoints[0].sink = 'https://vendor.invalid/' }],
        ['forward operation reference', (config: typeof generatedConfig) => { config.environment.generated.data.modes[1].operations[0].after = ['fixtures'] }],
        ['dependency policy mismatch', (config: typeof generatedConfig) => {
            config.environment.install_policies.push({ ...config.environment.install_policies[0], volume: 'other-dependencies', lockfile: 'other-lock.json' })
            config.environment.generated.volumes[0].install_policy = 'other-dependencies'
        }],
        ['dependency volume mounted at two targets', (config: typeof generatedConfig) => {
            const mounts = config.environment.generated.services[0].mounts
            mounts.push({ ...mounts[0]!, target: '/different/dependencies' })
        }],
        ['unmounted dependency volume', (config: typeof generatedConfig) => {
            config.environment.generated.services[0].mounts.splice(0, 1)
            config.environment.generated.decisions.entries.splice(8, 1)
        }],
        ['undeclared endpoint supplier sibling', (config: typeof generatedConfig) => { config.environment.generated.vendors[0].endpoints[0].supplier.sibling = 'missing' }],
        ['undeclared endpoint supplier template', (config: typeof generatedConfig) => { config.environment.generated.vendors[0].endpoints[0].supplier.template = 'missing.env' }],
        ['duplicate endpoint variable', (config: typeof generatedConfig) => { config.environment.generated.vendors[1].endpoints[0].variable = config.environment.generated.vendors[0].endpoints[0].variable }],
        ['duplicate published lease in one service', (config: typeof generatedConfig) => {
            config.environment.generated.services[0].ports.push({ name: 'admin', host_variable: 'WEB_PORT', internal: 3001, host_ip: '127.0.0.1' })
            config.environment.generated.decisions.entries.push({ ...config.environment.generated.decisions.entries[11], id: 'port-admin', subject_id: 'app:admin' })
        }],
        ['duplicate published lease across services', (config: typeof generatedConfig) => {
            config.sibling.push({ ...config.sibling[0], slug: 'worker', dir: 'worker', var: 'WORKER_DIR' })
            const worker = { ...structuredClone(config.environment.generated.services[0]), id: 'worker', sibling: 'worker', dependencies: [], ports: [{ name: 'worker', host_variable: 'WEB_PORT', internal: 3001, host_ip: '127.0.0.1' }] }
            worker.health.probe.service = 'worker'
            worker.health.tool_probe.service = 'worker'
            config.environment.generated.services.push(worker)
            const decision = config.environment.generated.decisions.entries[0]
            config.environment.generated.decisions.entries.push(
                { ...decision, id: 'service-worker', subject: 'service', subject_id: 'worker' },
                ...worker.mounts.map((mount, index) => ({ ...decision, id: `worker-mount-${index}`, subject: 'mount', subject_id: `worker:${mount.kind}:${mount.source}:${mount.target}` })),
                { ...decision, id: 'worker-port', subject: 'port', subject_id: 'worker:worker' },
            )
        }],
        ['changed data-default decision', (config: typeof generatedConfig) => { config.environment.generated.data.default_mode = 'restored' }],
        ['seeded mode without fixtures', (config: typeof generatedConfig) => { Reflect.deleteProperty(config.environment.generated.data, 'fixtures') }],
        ['restored mode without restore', (config: typeof generatedConfig) => { Reflect.deleteProperty(config.environment.generated.data, 'restore') }],
        ['restore without a restored mode', (config: typeof generatedConfig) => {
            config.environment.generated.data.modes.pop()
            config.environment.generated.decisions.entries = config.environment.generated.decisions.entries.filter(({ subject_id }) => subject_id !== 'restored')
        }],
        ['default mode outside the declared modes', (config: typeof generatedConfig) => {
            config.environment.generated.data.modes = config.environment.generated.data.modes.filter(({ mode }) => mode === 'empty')
            Reflect.deleteProperty(config.environment.generated.data, 'restore')
            config.environment.generated.decisions.entries = config.environment.generated.decisions.entries.filter(({ subject }) => !['data-mode', 'restore'].includes(subject))
        }],
    ])('enforces the runtime-only %s relation without claiming editor enforcement', (_name, mutate) => {
        const config = structuredClone(generatedConfig)
        mutate(config)
        const parsed = CockpitConfig.safeParse(config)
        expect(parsed.success).toBe(false)
        if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.code === 'custom')).toBe(true)
        const schema = JSON.parse(renderCockpitSchema())
        expect(schema['x-cockpit-editor-limitations']).toContainEqual({ path: 'environment.generated', rule: 'declared_sibling_service_volume_policy_mount_port_references' })
    })

    it('accepts the minimal example and requires exactly one of image or build in runtime and editor schemas', async () => {
        const minimal = parseToml(await readFile(fileURLToPath(new URL('../../../examples/minimal/cockpit.toml', import.meta.url)), 'utf8'))
        const validate = publishedCockpitValidator
        const parsed = CockpitConfig.safeParse(minimal)
        expect(parsed.success, parsed.success ? '' : parsed.error.message).toBe(true)
        expect(validate(minimal), JSON.stringify(validate.errors)).toBe(true)
        const service = (config: typeof minimal) => (config as { environment: { generated: { services: Record<string, unknown>[] } } }).environment.generated.services[0]!
        const both = structuredClone(minimal)
        service(both).image = generatedConfig.environment.generated.services[0]!.image
        const neither = structuredClone(minimal)
        Reflect.deleteProperty(service(neither), 'build')
        const escaped = structuredClone(minimal)
        service(escaped).build = { context: '../outside' }
        for (const config of [both, neither, escaped]) {
            expect(CockpitConfig.safeParse(config).success).toBe(false)
            expect(validate(config)).toBe(false)
        }
    })

    it('lets a declaration omit observed_on only when this configuration file is its source', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'cockpit-provenance-'))
        try {
            const path = join(directory, 'cockpit.toml')
            const undated = (source: string) => {
                const config = structuredClone(generatedConfig)
                config.environment.generated.services[0]!.provenance = { source, kind: 'declared', reason: 'Written in the configuration' } as typeof provenance
                return config
            }
            await writeFile(path, stringify(undated('cockpit.toml')))
            expect((await loadCockpitConfig(path)).kind).toBe('complete')
            await writeFile(path, stringify(undated('docs/runtime.md')))
            expect(await loadCockpitConfig(path)).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
                message: expect.stringContaining('environment.generated.services.0.provenance: provenance without observed_on must name this configuration file (cockpit.toml)'),
                fix: expect.stringContaining('observed_on'),
            })] })
            const measured = undated('cockpit.toml')
            measured.environment.generated.services[0]!.provenance.kind = 'measured'
            expect(CockpitConfig.safeParse(measured).success).toBe(false)
            expect(publishedCockpitValidator(measured)).toBe(false)
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    it.each([
        ['zero port', 'http://app:0/sink', true],
        ['maximum port', 'http://app:65535/sink', true],
        ['out-of-range port', 'http://app:65536/sink', false],
        ['five-digit out-of-range port', 'http://app:99999/sink', false],
    ])('keeps runtime and editor endpoint parity at the %s boundary', (_name, sink, accepted) => {
        const config = structuredClone(generatedConfig)
        config.environment.generated.vendors[0].endpoints[0].sink = sink
        const validate = publishedCockpitValidator

        expect(CockpitConfig.safeParse(config).success).toBe(accepted)
        expect(validate(config), JSON.stringify(validate.errors)).toBe(accepted)
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
            const config = { ...generatedConfig, environment: {
                ...generatedConfig.environment, entrypoint_derivatives: [declaration],
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

    it('accepts only effective browser resource ceilings with confirmed provenance in both schemas', () => {
        const resources = { memory_mb: 768, cpus: 0.5, provenance }
        const validate = publishedCockpitValidator
        const config = { ...generatedConfig, environment: { ...generatedConfig.environment,
            addressing: 'hostname', authentication: 'real', generated_host_paths: Object.values(browser.artifacts),
            posture_requirements: [{ requirement: 'authenticated-route', addressing: 'hostname', authentication: 'real' }],
        } }
        const check = (declaration: unknown, accepted: boolean) => {
            const candidate = { ...config, browser: declaration }
            expect(CockpitConfig.safeParse(candidate).success).toBe(accepted)
            expect(validate(candidate), JSON.stringify(validate.errors)).toBe(accepted)
        }
        check({ ...browser, resources }, true)
        check({ ...browser, resources: { ...resources, cpus: 0.01, memory_mb: 6 } }, true)
        const local = { ...browser, resources }
        Reflect.deleteProperty(local, 'endpoint')
        check(local, false)
        const overlay = { ...config, environment: { ...config.environment }, browser: { ...browser, resources } }
        Reflect.deleteProperty(overlay.environment, 'generated')
        expect(CockpitConfig.safeParse(overlay).success).toBe(false)
        expect(validate(overlay), JSON.stringify(validate.errors)).toBe(false)
        for (const invalid of [
            { ...resources, cpus: Number.MIN_VALUE },
            { ...resources, cpus: Number.MAX_VALUE },
            { ...resources, memory_mb: 5 },
            { ...resources, provenance: { ...provenance, kind: 'inferred' } },
        ]) check({ ...browser, resources: invalid }, false)
        check({ ...browser, resources: { ...resources, provenance: { ...provenance, kind: 'inferred', confirmed: true } } }, true)
    })

    it('drives a browser signed out for a product with no sign-in, without a requirement tagged for it', () => {
        const environment = { ...generatedConfig.environment,
            addressing: 'hostname', authentication: 'none', generated_host_paths: Object.values(browser.artifacts),
            posture_requirements: [{ requirement: 'local-route', addressing: 'hostname' }],
        }
        const signedOut = { ...browser, authentication: { policy: 'none', states: [] },
            resources: { memory_mb: 768, cpus: 0.5, provenance } }
        expect(CockpitConfig.safeParse({ ...generatedConfig, environment, browser: signedOut }).success).toBe(true)
        expect(CockpitConfig.safeParse({ ...generatedConfig, environment, browser: { ...signedOut, authentication: browser.authentication } }).success).toBe(false)
    })

    it('keeps WIP and attempt controls lower-only', () => {
        expect(Workorders.parse({})).toEqual({ attempt_cap: 2, wip_cap: 3,
            verification_timeout_seconds: 1_800, evaluator_timeout_seconds: 900 })
        expect(Workorders.parse({ evaluators: ['opencode', 'claudecode'] })).toMatchObject({ evaluators: ['opencode', 'claudecode'] })
        for (const evaluators of [[], ['cursor'], ['claudecode', 'claudecode']]) expect(Workorders.safeParse({ evaluators }).success, JSON.stringify(evaluators)).toBe(false)
        for (const field of ['verification_timeout_seconds', 'evaluator_timeout_seconds']) {
            for (const value of [0, 7_201, 1.5]) expect(Workorders.safeParse({ [field]: value }).success, `${field}=${value}`).toBe(false)
        }
        expect(Workorders.parse({ wip_cap: 1 })).toMatchObject({ wip_cap: 1 })
        for (const value of [0, 4, 1.5]) expect(Workorders.safeParse({ wip_cap: value }).success).toBe(false)
        // The programme cap has one legal value, so it is policy rather than configuration.
        expect(Workorders.safeParse({ programme_wip_cap: 1 }).success).toBe(false)
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
        const environment = { ...generatedConfig.environment,
            addressing: 'hostname', authentication: 'real', generated_host_paths: Object.values(browser.artifacts),
            posture_requirements: [{ requirement: 'authenticated-route', addressing: 'hostname', authentication: 'real' }],
        }
        const resources = { memory_mb: 768, cpus: 0.5, provenance }
        for (const target of ['cursor', 'grokcli']) {
            const declaration = { ...browser, harnesses: [{ target, version: '1.2.3' }], resources }
            const config = { ...generatedConfig, environment, browser: declaration }
            expect(Browser.safeParse(declaration).success).toBe(false)
            expect(CockpitConfig.safeParse(config).success).toBe(false)
            expect(publishedCockpitValidator(config), JSON.stringify(publishedCockpitValidator.errors)).toBe(false)
        }
        // A measured tool the cockpit does not list gets no browser wiring either.
        const measured = { ...generatedConfig, environment, browser: { ...browser, resources } }
        expect(CockpitConfig.safeParse(measured).success).toBe(true)
        expect(CockpitConfig.safeParse({ ...measured, surfaces: { tools: ['claudecode'] } }).success).toBe(false)
    })

    it('retains explicit runner architectures and measured health provenance', () => {
        const input = { ...browser, images: { ...browser.images, runner: { ...browser.images.runner, architectures: ['arm64'] } },
            runner_health_measurement: { duration_seconds: 15, provenance: { ...provenance, kind: 'measured' } } }
        expect(Browser.parse(input)).toMatchObject({ images: { runner: { architectures: ['arm64'] } },
            runner_health_measurement: input.runner_health_measurement })
        expect(Browser.safeParse({ ...input, images: { ...input.images, runner: { ...input.images.runner, architectures: ['arm64', 'arm64'] } } }).success).toBe(false)
        expect(Browser.safeParse({ ...input, runner_health_measurement: { duration_seconds: 0, provenance } }).success).toBe(false)
        expect(Browser.safeParse({ ...input, runner_health_measurement: { duration_seconds: 15,
            provenance: { ...provenance, kind: 'inferred', confirmed: false } } }).success).toBe(false)
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
        const service = generatedConfig.environment.generated.services[0]!
        const { host_ip: _hostIp, ...unboundPort } = service.ports[0]!
        expect(GeneratedService.parse({ ...service, ports: [unboundPort] }).ports[0]?.host_ip).toBe('127.0.0.1')
        for (const host_ip of ['127.0.0.1', '::1', '0.0.0.0', '::']) expect(GeneratedService.safeParse({ ...service,
            ports: [{ ...service.ports[0], host_ip }] }).success).toBe(true)
        expect(GeneratedService.safeParse({ ...service, ports: [{ ...service.ports[0], host_ip: 'host.invalid' }] }).success).toBe(false)
        expect(GeneratedService.safeParse({ ...service, host_aliases: [
            { hostname: 'app.example.invalid', address: '127.0.0.1' },
            { hostname: 'api.example.invalid', address: '::1' },
        ] }).success).toBe(true)
        for (const host_aliases of [
            [{ hostname: 'app.example.invalid', address: 'not-an-address' }],
            [{ hostname: '../app.invalid', address: '127.0.0.1' }],
            [{ hostname: 'app.example.invalid', address: '127.0.0.1' }, { hostname: 'app.example.invalid', address: '::1' }],
        ]) expect(GeneratedService.safeParse({ ...service, host_aliases }).success).toBe(false)
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

function vendorClientPolicyConfig() {
    const config = structuredClone(generatedConfig)
    return { ...config, environment: { ...config.environment, generated: { ...config.environment.generated,
        vendors: config.environment.generated.vendors.map((vendor, index) => ({ ...vendor,
            nonempty_variables: [`SYNTHETIC_TOKEN_${index}`],
            egress_guard: { flag: `ALLOW_SYNTHETIC_BACKEND_${index}`, enabled_value: '1', local_service: 'app' },
        })),
    } } }
}

describe('vendor client policy declarations', () => {
    it('accepts explicit vendor client policy through runtime and editor schemas', () => {
        const config = vendorClientPolicyConfig()
        expect(CockpitConfig.safeParse(config).success).toBe(true)
        const validate = publishedCockpitValidator
        expect(validate(config), JSON.stringify(validate.errors)).toBe(true)
    })

    it('rejects malformed vendor client policy through runtime and editor schemas', () => {
        for (const policy of [
            { nonempty_variables: [] },
            { nonempty_variables: ['invalid-variable'] },
            { nonempty_variables: ['TOKEN', 'TOKEN'] },
            { egress_guard: { flag: 'invalid-variable', enabled_value: '1', local_service: 'app' } },
            { egress_guard: { flag: 'ALLOW_SYNTHETIC', enabled_value: '', local_service: 'app' } },
            { egress_guard: { flag: 'ALLOW_SYNTHETIC', enabled_value: 'not a token', local_service: 'app' } },
            { egress_guard: { flag: 'ALLOW_SYNTHETIC', enabled_value: '1', local_service: 'app', extra: true } },
        ]) {
            const config = vendorClientPolicyConfig()
            Object.assign(config.environment.generated.vendors[0], policy)
            expect(CockpitConfig.safeParse(config).success).toBe(false)
            const validate = publishedCockpitValidator
            expect(validate(config)).toBe(false)
        }
    })

    it('rejects vendor client policy aliases across every variable role', () => {
        const changes: Array<(config: ReturnType<typeof vendorClientPolicyConfig>) => void> = [
            (config) => { config.environment.generated.vendors[1].nonempty_variables = [...config.environment.generated.vendors[0].nonempty_variables] },
            (config) => { config.environment.generated.vendors[1].egress_guard.flag = config.environment.generated.vendors[0].egress_guard.flag },
            (config) => { config.environment.generated.vendors[1].egress_guard.flag = config.environment.generated.vendors[0].nonempty_variables[0] },
            (config) => { config.environment.generated.vendors[0].nonempty_variables = [config.environment.generated.vendors[1].endpoints[0].variable] },
            (config) => { config.environment.generated.vendors[0].egress_guard.flag = config.environment.generated.vendors[1].endpoints[0].variable },
        ]
        for (const change of changes) {
            const config = vendorClientPolicyConfig()
            change(config)
            expect(CockpitConfig.safeParse(config).success).toBe(false)
        }
    })

    it('rejects vendor client policy that names an undeclared egress backend', () => {
        const config = vendorClientPolicyConfig()
        config.environment.generated.vendors[0].egress_guard.local_service = 'undeclared-backend'
        expect(CockpitConfig.safeParse(config).success).toBe(false)
    })
})

it('rejects the superseded stale age control as an unknown key', () => {
    const result = Workorders.safeParse({ stale_park_days: 14 })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ code: 'unrecognized_keys', keys: ['stale_park_days'] }))
})
