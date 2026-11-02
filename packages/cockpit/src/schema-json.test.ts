import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { compileDraft04Schema, draft04Validator } from '../test-support/draft04-validator.js'
import {
    AddressingPosture,
    AuthPosture,
    CockpitConfig,
    EnvironmentFile,
    GeneratedHostPath,
    MachineFloor,
    Mount,
    ResettableVolumeId,
    InstallPolicy,
    type Sibling,
} from './schema.js'
import { renderCockpitSchema } from './schema-json.js'

const publishedCockpitValidator = compileDraft04Schema(JSON.parse(renderCockpitSchema()))

describe('project command scalar schema parity', () => {
    it('enforces every string format emitted by the published schema', () => {
        const ajv = draft04Validator()
        const cases = [
            ['date', ['2024-02-29', '2023-02-28'], ['2023-02-29', '2026-99-99']],
            ['uri', ['https://example.invalid/%20?x=y#part', 'urn:isbn:978'], [
                'not a URI', ' https://example.invalid/', 'https://example.invalid/\n',
                'https://example.invalid/%zz', 'https://exämple.invalid/',
            ]],
            ['ipv4', ['192.0.2.1'], ['999.999.999.999', '192.0.2.01']],
            ['ipv6', ['2001:db8::1'], ['not-an-ip-address', '2001:db8:::1']],
        ] as const
        const emittedFormats = new Set<string>()
        const visit = (value: unknown) => {
            if (Array.isArray(value)) return value.forEach(visit)
            if (!value || typeof value !== 'object') return
            for (const [key, nested] of Object.entries(value)) {
                if (key === 'format' && typeof nested === 'string') emittedFormats.add(nested)
                else visit(nested)
            }
        }
        visit(JSON.parse(renderCockpitSchema()))
        expect([...emittedFormats].sort()).toEqual(cases.map(([format]) => format).sort())
        for (const [format, accepted, rejected] of cases) {
            const validate = ajv.compile({ type: 'string', format })
            for (const valid of accepted) expect(validate(valid), `${format}: ${valid}`).toBe(true)
            for (const invalid of rejected) expect(validate(invalid), `${format}: ${invalid}`).toBe(false)
        }
    })

    it('uses the same scalar pattern through runtime, emitted draft-04 and checked-in draft-04 schemas', () => {
        const schemas = [JSON.parse(renderCockpitSchema()), JSON.parse(readFileSync(new URL('../cockpit.schema.json', import.meta.url), 'utf8'))]
        const validators = schemas.map(schema => compileDraft04Schema(schema.properties.environment.properties.install_policies.items))
        const base = { toolchain: 'node', volume: 'dependencies', lockfile: 'package-lock.json', install: ['npm', 'ci'], load_probe: ['node', '--version'] }
        const cases: Array<[string[], boolean]> = [
            [['a'.repeat(127)], true], [['a'.repeat(128)], true], [['a'.repeat(129)], false],
            [['😀'.repeat(127)], true], [['😀'.repeat(128)], true], [['😀'.repeat(129)], false],
            [Array(32).fill('x'), true], [Array(33).fill('x'), false], [[], false], [[''], false],
            [['\ud800'], false], [['\udfff'], false], [['a\x00'], false], [['a\x1f'], false],
            [['a\x7f'], false], [['a\x80'], false], [['a\x9f'], false],
        ]
        for (const field of ['build', 'test']) for (const [argv, expected] of cases) {
            const policy = { ...base, [field]: argv }
            expect(InstallPolicy.safeParse(policy).success, JSON.stringify(policy)).toBe(expected)
            for (const validate of validators) expect(validate(policy), JSON.stringify({ policy, errors: validate.errors })).toBe(expected)
        }
        const emitted = schemas[0].properties.environment.properties.install_policies.items.properties
        expect(emitted.build.items.pattern).toBe(emitted.test.items.pattern)
        expect(schemas[1].properties.environment.properties.install_policies.items.properties.build).toEqual(emitted.build)
    })
})

type JsonObject = Record<string, unknown>
const allSurfaceFeatures = ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'] as const

function unavailableCapabilities() {
    return allSurfaceFeatures.map((feature) => ({
        feature, state: 'unavailable' as const, measured_on: '2026-09-26', reason: `No ${feature} mechanism`,
    }))
}

const generatedRuntimeChecks = [
    { path: 'environment.generated', rule: 'unique_declaration_identities' },
    { path: 'environment.generated', rule: 'declared_sibling_service_volume_policy_mount_port_references' },
    { path: 'environment.generated.services[].ports[].host_variable', rule: 'globally_unique' },
    { path: 'environment.generated.data.modes[].operations[].after', rule: 'earlier_declared_operations' },
    { path: 'environment.generated.services[].health', rule: 'start_period_at_least_measured_duration' },
    { path: 'environment.generated.vendors[].endpoints[]', rule: 'exact_declared_local_sink_and_template_supplier' },
    { path: 'environment.generated.vendors[].endpoints[].variable', rule: 'globally_unique' },
    { path: 'environment.generated.vendors[]', rule: 'globally_unique_endpoint_nonempty_and_egress_variables' },
    { path: 'environment.generated.vendors[].egress_guard.local_service', rule: 'declared_service' },
    { path: 'environment.generated.services[]', rule: 'acyclic_dependencies_and_same_image_health_probes' },
    { path: 'environment.generated.data', rule: 'product_data_volume_and_mode_operations' },
    { path: 'environment.generated.data', rule: 'declared_default_mode_fixtures_for_seeded_and_restore_for_restored' },
    { path: 'environment.generated.decisions.entries[]', rule: 'declared_subject_with_undecided_subjects_rendered' },
    { path: 'environment.generated', rule: 'undated_declared_provenance_names_the_configuration_file' },
]

const rowDerivationRuntimeChecks = [
    { path: 'sibling[].derives.generated', rule: 'row_owned_relations_and_exact_port_defaults' },
    { path: 'sibling[].derives.mcp_sources[].path', rule: 'unique_within_sibling' },
    { path: 'sibling[].derives', rule: 'global_baseline_and_cross_row_identity_disjointness' },
]

const surfaceRuntimeChecks = [
    { path: 'surfaces.overlays[].name', rule: 'unique' },
    { path: 'surfaces.overlays[].sources[].path', rule: 'unique' },
        { path: 'surfaces.overlays[].sources', rule: 'feature_namespace_and_complete_skill_definitions' },
    { path: 'surfaces.overlays[].sources[].bytes', rule: 'utf8_byte_length_at_most_65536' },
    { path: 'surfaces.overlays[].replaces.name', rule: 'matches_declaration_name' },
    { path: 'surfaces.harnesses[].name', rule: 'unique' },
    { path: 'surfaces.harnesses[].capabilities', rule: 'one_row_per_surface_feature' },
    { path: 'surfaces.harnesses[].capabilities[].spelling', rule: 'unique_when_emitted' },
    { path: 'surfaces.adopted[].path', rule: 'unique' },
    { path: 'surfaces.adopted[].source', rule: 'equals_cockpit/adopted/<path>' },
    { path: 'surfaces.adopted[].provenance.kind', rule: 'declared' },
]

// @ts-expect-error arbitrary strings are not valid sibling mount modes
const invalidSiblingMount: Sibling['mount'] = 'banana'
// @ts-expect-error the config-level sibling type preserves the same mount contract
const invalidConfigMount: CockpitConfig['sibling'][number]['mount'] = 'banana'
void invalidSiblingMount
void invalidConfigMount

function object(value: unknown): JsonObject {
    expect(value).toBeTypeOf('object')
    expect(value).not.toBeNull()
    return value as JsonObject
}

describe('the published cockpit schema', () => {
    const validConfig = {
        cockpit: { name: 'example' },
        sibling: [
            {
                slug: 'service',
                dir: 'service',
                remote: 'https://example.invalid/service.git',
                mount: 'always',
                acquire: 'auto',
                var: 'SERVICE_DIR',
                purpose: 'Runs the product service',
            },
        ],
        ports: { bases: { WEB_PORT: 3000 } },
    }

    function editorAccepts(config: unknown): boolean {
        return publishedCockpitValidator(config) as boolean
    }

    it('keeps both host declarations identical at hostname, label and row boundaries in runtime and published schemas', () => {
        const exact = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`
        const emitted = JSON.parse(renderCockpitSchema())
        const checkedIn = JSON.parse(readFileSync(new URL('../cockpit.schema.json', import.meta.url), 'utf8'))
        const validators = [emitted, checkedIn].map((schema) => compileDraft04Schema(schema))
        const fields = emitted.properties.guards.properties
        // The two lists share one contract and differ only in what each is for.
        const contract = ({ description: _description, ...rest }: Record<string, unknown>) => rest
        expect(contract(fields.vendor_endpoint_hosts)).toEqual(contract(fields.hosted_db_hosts))
        for (const field of ['hosted_db_hosts', 'vendor_endpoint_hosts']) {
            for (const [hosts, accepted] of [
                [[], true], [[exact, `*.other.test`], true], [[`*.${exact}`], true],
                [Array.from({ length: 128 }, (_, index) => `host-${index}.example.test`), true],
                [Array.from({ length: 129 }, (_, index) => `host-${index}.example.test`), false],
                ...[`${exact}a`, `*.${exact}a`, `${'a'.repeat(64)}.test`, 'DB.test', 'db..test', 'https://db.test', 'user@db.test', 'db.test:443', 'db.test/path', 'db.test?q=1', 'db.test#x', 'db.test\n', '*.*.db.test'].map((host) => [[host], false]),
            ] as Array<[string[], boolean]>) {
                const config = { ...validConfig, guards: { [field]: hosts } }
                expect(CockpitConfig.safeParse(config).success, `${field}: ${hosts}`).toBe(accepted)
                for (const validate of validators) expect(validate(config), `${field}: ${hosts}`).toBe(accepted)
            }
        }
    })

    it('publishes the same bounded guard-rule contract as the runtime schema', () => {
        const schemas = [JSON.parse(renderCockpitSchema()), JSON.parse(readFileSync(new URL('../cockpit.schema.json', import.meta.url), 'utf8'))]
        const validators = schemas.map(schema => compileDraft04Schema(schema))
        for (const [guards, accepted] of [
            [{ allow: [{ argv: ['make', 'verify'], reason: 'Repository verification is safe.', cwd: '.' }],
                deny: [{ contains: ['--environment', 'shared'], reason: 'Shared environments require an operator.', fix: 'Use local.' }] }, true],
            [{ allow: [{ argv: [], reason: 'Empty.' }] }, false],
            [{ deny: [{ prefix: ['make'], contains: ['release'], reason: 'Ambiguous.' }] }, false],
            [{ allow: [{ argv: ['make'], reason: 'Escapes.', cwd: '../outside' }] }, false],
        ] as Array<[Record<string, unknown>, boolean]>) {
            const config = { ...validConfig, guards }
            expect(CockpitConfig.safeParse(config).success, JSON.stringify(guards)).toBe(accepted)
            for (const validate of validators) expect(validate(config), JSON.stringify(guards)).toBe(accepted)
        }
    })

    it('publishes the consumer surface shapes and names loader-only matrix relations', () => {
        const config = {
            ...structuredClone(validConfig),
            surfaces: {
                overlays: [{
                    name: 'consumer-guide', feature: 'rules', source: 'surfaces/consumer-guide.json',
                    sources: [{ path: 'rules/consumer-guide.md', bytes: '# Consumer guide\n' }],
                }],
                harnesses: [{
                    name: 'synthetic-harness', capabilities: [{
                        feature: 'rules', state: 'instructed', measured_on: '2026-09-26',
                        spelling: 'config/rules.md', control: 'controls/rules.json',
                        mechanism: { module: 'adapters/synthetic.mjs', export: 'renderRules' },
                    }, ...unavailableCapabilities().slice(1)],
                }],
            },
        }
        expect(CockpitConfig.safeParse(config).success).toBe(true)
        expect(editorAccepts(config)).toBe(true)

        const schema = JSON.parse(renderCockpitSchema())
        for (const metadata of ['x-cockpit-runtime-checks', 'x-cockpit-editor-limitations']) {
            expect(schema[metadata]).toContainEqual({ path: 'surfaces.overlays[].name', rule: 'unique' })
            expect(schema[metadata]).toContainEqual({
                path: 'surfaces.harnesses[].capabilities', rule: 'one_row_per_surface_feature',
            })
        }
    })

    it.each(['claudecode', 'codexcli', 'opencode'])('rejects shipped custom harness identity %s in runtime and editor schemas', (name) => {
        const config = { ...structuredClone(validConfig), surfaces: { harnesses: [{
            name, capabilities: unavailableCapabilities(),
        }] } }
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(false)
    })

    it('names the runtime-only source namespace relation for editors', () => {
        const config = { ...structuredClone(validConfig), surfaces: { overlays: [{
            name: 'mixed', feature: 'rules', source: 'surfaces/mixed.json',
            sources: [{ path: 'skills/mixed/SKILL.md', bytes: 'Mixed source' }],
        }] } }
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(true)
        const schema = JSON.parse(renderCockpitSchema())
        for (const metadata of ['x-cockpit-runtime-checks', 'x-cockpit-editor-limitations']) {
            expect(schema[metadata]).toContainEqual({
                path: 'surfaces.overlays[].sources', rule: 'feature_namespace_and_complete_skill_definitions',
            })
        }
    })

    it('keeps unavailable custom harness cells structurally free of emitted controls', () => {
        const config = {
            ...structuredClone(validConfig),
            surfaces: { harnesses: [{
                name: 'synthetic-harness', capabilities: unavailableCapabilities().map(
                    (capability) => capability.feature === 'hooks' ? { ...capability, spelling: 'hooks.json' } : capability,
                ),
            }] },
        }
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(false)
    })

    const capabilityBase = { feature: 'rules', measured_on: '2026-09-26' } as const
    const mechanism = { module: 'adapters/synthetic.mjs', export: 'renderRules' }
    const evidence = { reference: 'evidence/rules.json', sha256: 'a'.repeat(64) }
    const emitted = { spelling: 'config/rules.md', control: 'controls/rules.json', mechanism }
    const validCapabilities = {
        enforced: { ...capabilityBase, ...emitted, state: 'enforced', evidence },
        instructed: { ...capabilityBase, ...emitted, state: 'instructed' },
        unavailable: { ...capabilityBase, state: 'unavailable', reason: 'No rules mechanism' },
    } as const

    function configWithRulesCapability(capability: JsonObject) {
        return { ...structuredClone(validConfig), surfaces: { harnesses: [{
            name: 'synthetic-harness', capabilities: [capability, ...unavailableCapabilities().slice(1)],
        }] } }
    }

    it.each(Object.entries(validCapabilities))(
        'accepts a valid %s custom harness capability in runtime and editor schemas',
        (_state, capability) => {
            const config = configWithRulesCapability(capability)
            expect(CockpitConfig.safeParse(config).success).toBe(true)
            expect(editorAccepts(config)).toBe(true)
        },
    )

    it.each([
        ['enforced missing evidence', { ...validCapabilities.enforced, evidence: undefined }],
        ['enforced missing spelling', { ...validCapabilities.enforced, spelling: undefined }],
        ['enforced missing control', { ...validCapabilities.enforced, control: undefined }],
        ['enforced missing mechanism', { ...validCapabilities.enforced, mechanism: undefined }],
        ['enforced with reason', { ...validCapabilities.enforced, reason: 'Not unavailable' }],
        ['instructed missing spelling', { ...validCapabilities.instructed, spelling: undefined }],
        ['instructed missing control', { ...validCapabilities.instructed, control: undefined }],
        ['instructed missing mechanism', { ...validCapabilities.instructed, mechanism: undefined }],
        ['instructed with evidence', { ...validCapabilities.instructed, evidence }],
        ['instructed with reason', { ...validCapabilities.instructed, reason: 'Not unavailable' }],
        ['unavailable missing reason', { ...validCapabilities.unavailable, reason: undefined }],
        ['unavailable with spelling', { ...validCapabilities.unavailable, spelling: emitted.spelling }],
        ['unavailable with control', { ...validCapabilities.unavailable, control: emitted.control }],
        ['unavailable with mechanism', { ...validCapabilities.unavailable, mechanism }],
        ['unavailable with evidence', { ...validCapabilities.unavailable, evidence }],
    ])('rejects %s in runtime and editor schemas', (_label, capability) => {
        const config = configWithRulesCapability(capability)
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(false)
    })

    it.each(['mcp', 'permissions'])('rejects raw %s overlays in runtime and editor schemas', (feature) => {
        const config = { ...structuredClone(validConfig), surfaces: { overlays: [{
            name: 'raw-control', feature, source: 'surfaces/raw-control.json',
            sources: [{ path: feature === 'mcp' ? 'mcp.jsonc' : 'permissions.jsonc', bytes: '{}\n' }],
        }] } }
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(false)
    })

    it('rejects an empty sibling derivation in runtime and editor schemas', () => {
        const config = structuredClone(validConfig) as typeof validConfig & { sibling: Array<(typeof validConfig.sibling)[number] & { derives?: object }> }
        config.sibling[0].derives = {}
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(false)
    })

    it('declares the runtime-only port candidate-member structural budget', () => {
        const config = {
            ...structuredClone(validConfig),
            ports: {
                step: 100,
                count: 65,
                bases: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`PORT_${index}`, 1_000 + index])),
            },
        }
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(true)

        const schema = JSON.parse(renderCockpitSchema())
        expect(schema['x-cockpit-runtime-checks']).toContainEqual({
            path: 'ports', rule: 'count_times_base_count_within_shared_input_budget', limit: 4_096,
        })
    })

    it('keeps addressing, authentication, mount, and acquisition independent', () => {
        expect(AddressingPosture.options).toEqual(['hostname', 'port'])
        expect(AuthPosture.options).toEqual(['real', 'bypassed', 'none'])

        for (const addressing of AddressingPosture.options) {
            for (const authentication of AuthPosture.options) {
                for (const mount of ['always', 'none'] as const) {
                    for (const acquire of ['auto', 'manual'] as const) {
                        const config = { ...structuredClone(validConfig), environment: { addressing, authentication } }
                        Object.assign(config.sibling[0], { mount, acquire })
                        expect(CockpitConfig.safeParse(config).success).toBe(true)
                    }
                }
            }
        }
    })

    it('validates posture requirement structure in both runtime and editor schemas', () => {
        const config = { ...structuredClone(validConfig), environment: {
            addressing: 'hostname', authentication: 'real',
            posture_requirements: [{ requirement: 'local-route', addressing: 'hostname', authentication: 'real' }],
        } }
        expect(CockpitConfig.safeParse(config).success).toBe(true)
        expect(editorAccepts(config)).toBe(true)
        for (const tag of [
            { requirement: 'unmarked-route' },
            { requirement: 'invalid/identifier', addressing: 'hostname' },
            { requirement: 'x'.repeat(65), authentication: 'real' },
            { requirement: 'local-route', addressing: 'unknown' },
            { requirement: 'local-route', authentication: 'unknown' },
            { requirement: 'local-route', addressing: 'hostname', extra: true },
        ]) {
            const invalid = { ...config, environment: { ...config.environment, posture_requirements: [tag] } }
            expect(CockpitConfig.safeParse(invalid).success).toBe(false)
            expect(editorAccepts(invalid)).toBe(false)
        }
    })

    it('rejects an explicitly empty posture requirement catalog in both schemas', () => {
        const config = { ...structuredClone(validConfig), environment: { posture_requirements: [] } }
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(false)
    })

    it('reports posture requirement identifier uniqueness as a runtime editor limitation', () => {
        const config = { ...structuredClone(validConfig), environment: { posture_requirements: [
            { requirement: 'local-route', addressing: 'hostname' },
            { requirement: 'local-route', authentication: 'real' },
        ] } }
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(true)
        expect(JSON.parse(renderCockpitSchema())['x-cockpit-editor-limitations']).toContainEqual({
            path: 'environment.posture_requirements[].requirement', rule: 'unique',
        })
    })

    it('validates strict environment declarations', () => {
        expect(EnvironmentFile.safeParse({ template: '.env.example', instance: '.env' }).success).toBe(true)
        expect(ResettableVolumeId.safeParse('api-session-data').success).toBe(true)
        expect(GeneratedHostPath.safeParse('.cockpit/generated/session').success).toBe(true)
        expect(MachineFloor.safeParse({
            runtime_memory_mb: 4096,
            runtime_cpus: 2,
            free_disk_mb: 8192,
            cold_start_seconds: 300,
        }).success).toBe(true)
    })

    it.each([
        ['environment path traversal', () => EnvironmentFile.safeParse({ template: '../.env.example', instance: '.env' })],
        ['generated path traversal', () => GeneratedHostPath.safeParse('generated/../../outside')],
        ['empty reset volume', () => ResettableVolumeId.safeParse('')],
        ['zero machine memory', () => MachineFloor.safeParse({
            runtime_memory_mb: 0,
            runtime_cpus: 2,
            free_disk_mb: 8192,
            cold_start_seconds: 300,
        })],
        // `up` cannot hold a start open longer than this; a larger budget was once silently cut.
        ['a cold start budget beyond one hour', () => MachineFloor.safeParse({
            runtime_memory_mb: 4096,
            runtime_cpus: 2,
            free_disk_mb: 8192,
            cold_start_seconds: 3_601,
        })],
    ])('rejects %s',(_label, parse) => {
        expect(parse().success).toBe(false)
    })

    it.each([
        ['environment template traversal', { environment_files: [{ template: '../.env.example', instance: '.env' }] }],
        ['environment pair with an unknown field', {
            environment_files: [{ template: '.env.example', instance: '.env', expected_keys: ['SECRET'] }],
        }],
    ])('rejects %s through runtime and editor schemas', (_label, siblingPatch) => {
        const config = structuredClone(validConfig)
        Object.assign(config.sibling[0], siblingPatch)

        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(false)
    })

    it.each([
        ['remote compose file', { compose_files: ['https://example.invalid/compose.yml'] }],
        ['remote compose shorthand', { compose_files: ['git+ssh:compose.yml'] }],
        ['SCP-style remote compose file', { compose_files: ['git@example.invalid:compose.yml'] }],
        ['control character in compose path', { compose_files: ['compose\n.yml'] }],
        ['dot segment in entrypoint path', {
            entrypoint_derivatives: [{ name: 'web', kind: 'origin', port: 'WEB_PORT', path: '/../admin' }],
        }],
        ['encoded dot segment in entrypoint path', {
            entrypoint_derivatives: [{ name: 'web', kind: 'origin', port: 'WEB_PORT', path: '/%2e%2e/admin' }],
        }],
        ['mixed encoded dot segment in entrypoint path', {
            entrypoint_derivatives: [{ name: 'web', kind: 'origin', port: 'WEB_PORT', path: '/.%2E/admin' }],
        }],
        ['backslash in entrypoint path', {
            entrypoint_derivatives: [{ name: 'web', kind: 'origin', port: 'WEB_PORT', path: '/api\\next' }],
        }],
        ['control character in entrypoint path', {
            entrypoint_derivatives: [{ name: 'web', kind: 'origin', port: 'WEB_PORT', path: '/api\nnext' }],
        }],
        ['query in path-only entrypoint field', {
            entrypoint_derivatives: [{ name: 'web', kind: 'origin', port: 'WEB_PORT', path: '/api?next=/' }],
        }],
        ['empty install command', {
            install_policies: [{
                toolchain: 'node',
                volume: 'node-modules',
                lockfile: 'package-lock.json',
                install: [],
                load_probe: ['node', '--version'],
            }],
        }],
        ['incomplete machine floor', { machine: { runtime_memory_mb: 4096 } }],
        ['machine floor with an unknown field', {
            machine: {
                runtime_memory_mb: 4096,
                runtime_cpus: 2,
                free_disk_mb: 8192,
                cold_start_seconds: 300,
                swap_mb: 1024,
            },
        }],
        // A runtime measurement is a fact about one machine and lives in its ignored local state.
        ['a runtime measurement, which is not team configuration', {
            runtime_measurements: [{
                runtime: 'docker-desktop',
                compose_floor: '2.20.0',
                measured_on: '2026-09-07',
                candidate: 'passed',
                broken_control: 'rejected',
                status: 'supported',
            }],
        }],
    ])('rejects %s through runtime and editor schemas', (_label, environment) => {
        const config = { ...structuredClone(validConfig), environment }

        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(false)
    })

    it('accepts empty environment target lists without inventing machine measurements', () => {
        const parsed = CockpitConfig.parse({ ...structuredClone(validConfig), environment: {} })

        expect(parsed.environment).toEqual({
            resettable_volumes: [],
            generated_host_paths: [],
            compose_files: [],
            entrypoint_derivatives: [],
            install_policies: [],
        })
        expect(editorAccepts({ ...structuredClone(validConfig), environment: {} })).toBe(true)
    })

    it.each([
        ['resettable_volumes', ['session-data', 'session-data']],
        ['generated_host_paths', ['generated/session', 'generated/session']],
        ['compose_files', ['compose.yml', 'compose.yml']],
    ])('rejects duplicate %s identities through runtime and editor schemas', (field, values) => {
        const config = { ...structuredClone(validConfig), environment: { [field]: values } }

        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(false)
    })

    it.each([
        ['entrypoint derivative name', {
            entrypoint_derivatives: [
                { name: 'web', kind: 'origin', port: 'WEB_PORT', path: '/' },
                { name: 'web', kind: 'callback_url', port: 'WEB_PORT', path: '/callback' },
            ],
        }],
        ['install policy volume', {
            install_policies: [
                { toolchain: 'node', volume: 'node-modules', lockfile: 'a.lock', install: ['install-a'], load_probe: ['probe-a'] },
                { toolchain: 'node', volume: 'node-modules', lockfile: 'b.lock', install: ['install-b'], load_probe: ['probe-b'] },
            ],
        }],
    ])('rejects duplicate %s declarations at runtime', (_label, environment) => {
        expect(CockpitConfig.safeParse({ ...structuredClone(validConfig), environment }).success).toBe(false)
    })

    it('requires a non-none toolchain and rejects duplicate toolchain-lockfile selectors', () => {
        const valid = {
            toolchain: 'node',
            volume: 'node-modules',
            lockfile: 'package-lock.json',
            install: ['npm', 'ci'],
            load_probe: ['node', '--version'],
        }

        expect(InstallPolicy.safeParse(valid).success).toBe(true)
        expect(InstallPolicy.safeParse({ ...valid, toolchain: 'none' }).success).toBe(false)
        const { toolchain: _toolchain, ...missingToolchain } = valid
        expect(InstallPolicy.safeParse(missingToolchain).success).toBe(false)

        const environment = {
            install_policies: [
                valid,
                { ...valid, volume: 'other-node-modules', install: ['npm', 'install'] },
            ],
        }
        const config = { ...structuredClone(validConfig), environment }
        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(true)
    })

    it('rejects duplicate environment instance paths at runtime', () => {
        const config = structuredClone(validConfig)
        Object.assign(config.sibling[0], {
            environment_files: [
                { template: '.env.example', instance: '.env' },
                { template: '.env.local.example', instance: '.env' },
            ],
        })

        expect(CockpitConfig.safeParse(config).success).toBe(false)
    })

    it('rejects entrypoint derivatives that have no leased port source', () => {
        const config = {
            ...structuredClone(validConfig),
            environment: {
                entrypoint_derivatives: [{ name: 'web', kind: 'origin', port: 'TYPO_PORT', path: '/' }],
            },
        }

        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(editorAccepts(config)).toBe(true)
    })

    it('renders deterministic Draft 4 input-schema bytes with one final newline', () => {
        const first = renderCockpitSchema()
        const second = renderCockpitSchema()

        expect(first).toBe(second)
        expect(first.endsWith('\n')).toBe(true)
        expect(first.endsWith('\n\n')).toBe(false)
        expect(JSON.parse(first)).toMatchObject({
            $schema: 'http://json-schema.org/draft-04/schema#',
        })
    })

    it('preserves both mount branches and rejects a near-miss profile prefix', () => {
        const schema = object(JSON.parse(renderCockpitSchema()))
        const sibling = object(object(object(schema.properties).sibling).items)
        const mount = object(object(sibling.properties).mount)

        expect(mount.anyOf).toEqual([
            { type: 'string', enum: ['always', 'host', 'none'] },
            { type: 'string', pattern: '^profile:[a-z0-9-]+$' },
        ])
        expect(Mount.safeParse('prof1le:web').success).toBe(false)
    })

    it('publishes addressing and authentication as separate cockpit postures', () => {
        const schema = object(JSON.parse(renderCockpitSchema()))
        const properties = object(schema.properties)
        const environmentProperties = object(object(properties.environment).properties)
        const siblingProperties = object(object(object(properties.sibling).items).properties)

        expect(environmentProperties.addressing).toMatchObject({ enum: ['hostname', 'port'] })
        expect(environmentProperties.authentication).toMatchObject({ enum: ['real', 'bypassed', 'none'] })
        expect(siblingProperties).not.toHaveProperty('addressing')
        expect(siblingProperties).not.toHaveProperty('authentication')
    })

    it('publishes the exact non-none install-policy toolchain contract', () => {
        const schema = object(JSON.parse(renderCockpitSchema()))
        const environment = object(object(schema.properties).environment)
        const policies = object(object(environment.properties).install_policies)
        const policy = object(policies.items)

        expect(object(object(policy.properties).toolchain).enum).toEqual([
            'node', 'python', 'ruby', 'go', 'rust', 'dotnet',
        ])
        expect(policy.required).toEqual(['toolchain', 'volume', 'lockfile', 'install', 'load_probe'])
    })

    it('publishes the exact risky-lane implication instead of an advisory gate field', () => {
        const schema = object(JSON.parse(renderCockpitSchema()))
        const sibling = object(object(object(schema.properties).sibling).items)

        expect((sibling.allOf as unknown[])[3]).toEqual({
            anyOf: [
                {
                    properties: { gate: { enum: ['operator'] } },
                    required: ['gate'],
                },
                {
                    not: {
                        anyOf: [
                            { properties: { mount: { enum: ['host'] } } },
                            {
                                properties: {
                                    purpose: {
                                        pattern: '\\b(?:[lL][iI][vV][eE]|[pP][rR][oO][dD][uU][cC][tT][iI][oO][nN]|[hH][aA][rR][dD][wW][aA][rR][eE]|[sS][iI][mM][uU][lL][aA][tT][oO][rR])\\b',
                                    },
                                },
                            },
                        ],
                    },
                },
            ],
        })
    })

    it('does not require fields that Zod supplies while parsing author input', () => {
        const schema = object(JSON.parse(renderCockpitSchema()))
        const properties = object(schema.properties)
        const cockpit = object(properties.cockpit)
        const sibling = object(object(properties.sibling).items)
        const ports = object(properties.ports)

        expect(schema.required).toEqual(['cockpit', 'sibling', 'ports'])
        expect(cockpit.required).toEqual(['name'])
        expect(sibling.required).toEqual(['slug', 'dir', 'mount', 'acquire', 'var', 'purpose'])
        expect(ports.required).toEqual(['bases'])
    })

    it.each([
        ['root', (config: JsonObject) => config],
        ['cockpit', (config: JsonObject) => object(config.cockpit)],
        ['sibling', (config: JsonObject) => object((config.sibling as unknown[])[0])],
        ['ports', (config: JsonObject) => object(config.ports)],
        ['guards', (config: JsonObject) => object(config.guards)],
        ['mcp', (config: JsonObject) => object(config.mcp)],
        ['workorders', (config: JsonObject) => object(config.workorders)],
        ['browser', (config: JsonObject) => object(config.browser)],
        ['testing', (config: JsonObject) => object(config.testing)],
        ['environment', (config: JsonObject) => object(config.environment)],
    ])('rejects unknown keys at the %s config boundary', (_name, select) => {
        const config = structuredClone({
            ...validConfig,
            guards: {},
            mcp: {},
            workorders: {},
            browser: {
                harnesses: [{ target: 'codexcli', version: '0.149.0' }],
                images: { runner: { reference: `synthetic.invalid/runner@sha256:${'a'.repeat(64)}`, driver_version: '1.2.3' }, mcp: { reference: `synthetic.invalid/mcp@sha256:${'b'.repeat(64)}`, driver_version: '1.2.3' } },
                project: { lockfile: 'package-lock.json', sha256: 'c'.repeat(64), driver_version: '1.2.3' }, max_clients: 1,
                proxy: { server_port: 3000, proxy_port: 3001, allowed_hosts: ['localhost:3001'] }, resolver: [],
                authentication: { policy: 'none', states: [] }, data: { mode: 'empty', isolated: true, reaches_production: false },
                artifacts: { runner: '.browser/runner', mcp: '.browser/mcp', cli: '.browser/cli', auth: '.browser/auth', debugger: '.browser/debugger' },
            },
            testing: { stages: [{ id: 'unit', command: ['npm', 'test'], requires_stack: false }], gates: [{ id: 'focused', tier: 'targeted', stages: ['unit'], changes: 'Isolated behavior' }], native_hooks: { install: 'inspect' } },
            environment: {},
        }) as JsonObject
        select(config).unexpected = true

        expect(CockpitConfig.safeParse(config).success).toBe(false)
    })

    it('declares closed config objects and holds every record key to the loader\'s key pattern', () => {
        const schema = object(JSON.parse(renderCockpitSchema()))
        const properties = object(schema.properties)
        const sibling = object(object(properties.sibling).items)
        const siblingProperties = object(sibling.properties)
        const environment = object(properties.environment)
        const environmentProperties = object(environment.properties)

        for (const closed of [
            schema,
            object(properties.cockpit),
            sibling,
            object(properties.ports),
            object(properties.guards),
            object(properties.mcp),
            object(properties.workorders),
            object(properties.browser),
            object(properties.testing),
            environment,
            object(environmentProperties.machine),
            object(object(siblingProperties.environment_files).items),
            object(object(environmentProperties.entrypoint_derivatives).items),
            object(object(environmentProperties.install_policies).items),
        ]) {
            expect(closed.additionalProperties).toBe(false)
        }

        // Draft 4 has no propertyNames, so each record carries its key pattern as its only pattern property.
        const validators = [schema, JSON.parse(readFileSync(new URL('../cockpit.schema.json', import.meta.url), 'utf8'))].map(compileDraft04Schema)
        const digest = 'a'.repeat(64)
        for (const [config, accepted] of [
            [validConfig, true],
            [{ ...validConfig, ports: { bases: { web_port: 3000 } } }, false],
            [{ ...validConfig, mcp: { approved: { 'notes-server': digest } } }, true],
            [{ ...validConfig, mcp: { approved: { [`n${'a'.repeat(127)}`]: digest } } }, true],
            [{ ...validConfig, mcp: { approved: { [`n${'a'.repeat(128)}`]: digest } } }, false],
            [{ ...validConfig, mcp: { approved: { '-notes': digest } } }, false],
            [{ ...validConfig, mcp: { approved: { 'notes server': digest } } }, false],
        ] as Array<[Record<string, unknown>, boolean]>) {
            expect(CockpitConfig.safeParse(config).success, JSON.stringify(config.mcp ?? config.ports)).toBe(accepted)
            for (const validate of validators) expect(validate(config), JSON.stringify(config.mcp ?? config.ports)).toBe(accepted)
        }
    })

    it('publishes bounded work, browser, testing and hook contracts with runtime-only relations named', () => {
        const schema = object(JSON.parse(renderCockpitSchema()))
        const properties = object(schema.properties)
        const workorders = object(object(properties.workorders).properties)
        const browserProperties = object(object(properties.browser).properties)
        const testingProperties = object(object(properties.testing).properties)

        expect(workorders.wip_cap).toMatchObject({ type: 'integer', minimum: 1, maximum: 3, default: 3 })
        expect(object(browserProperties.artifacts).additionalProperties).toBe(false)
        expect(object(testingProperties.native_hooks).additionalProperties).toBe(false)
        expect(schema['x-cockpit-runtime-checks']).toContainEqual({ path: 'browser.artifacts', rule: 'exact_environment.generated_host_paths_coverage' })
        expect(schema['x-cockpit-editor-limitations']).toContainEqual({ path: 'testing.gates[].stages[]', rule: 'references_declared_testing_stage' })
    })

    it('rejects duplicate browser authorities and policy without an explicit native install discriminator', () => {
        const schema = object(JSON.parse(renderCockpitSchema()))
        const properties = object(schema.properties)
        const browserProperties = object(object(properties.browser).properties)
        const proxyProperties = object(object(browserProperties.proxy).properties)
        expect(object(proxyProperties.allowed_hosts).uniqueItems).toBe(true)

        const validate = compileDraft04Schema(object(properties.testing))
        const testing = {
            stages: [{ id: 'unit', command: ['npm', 'test'], requires_stack: false }],
            gates: [{ id: 'focused', tier: 'targeted', stages: ['unit'], changes: 'Isolated behavior' }],
            native_hooks: {},
            native_hook_policy: { path: 'hook-policy.txt', sha256: 'a'.repeat(64) },
        }
        expect(validate(testing), JSON.stringify(validate.errors)).toBe(false)
    })

    it.each([
        ['acquire none with a remote', { remote: 'https://example.invalid/service.git', acquire: 'none' }],
        ['auto acquisition without a remote', { remote: undefined, acquire: 'auto' }],
        ['manual acquisition without a remote', { remote: undefined, acquire: 'manual' }],
        ['host mount without a reason', { mount: 'host', host_reason: undefined }],
    ])('rejects %s through both runtime and editor schemas', (_name, siblingPatch) => {
        const config = structuredClone(validConfig)
        Object.assign(config.sibling[0], siblingPatch)
        const schema = JSON.parse(renderCockpitSchema())
        const validate = compileDraft04Schema(schema)

        expect(CockpitConfig.safeParse(config).success).toBe(false)
        expect(validate(config), JSON.stringify(validate.errors)).toBe(false)
    })

    it.each([
        ['host mount', { mount: 'host', host_reason: 'requires a host display' }],
        ['live purpose', { purpose: 'Connects to a live service' }],
        ['production purpose', { purpose: 'PRODUCTION maintenance runner' }],
        ['hardware purpose', { purpose: 'Controls local hardware' }],
        ['simulator purpose', { purpose: 'Starts the simulator' }],
    ])('requires the operator gate for a %s in both runtime and editor schemas', (_name, siblingPatch) => {
        const schema = JSON.parse(renderCockpitSchema())
        const validate = compileDraft04Schema(schema)
        const missingGate = structuredClone(validConfig)
        Object.assign(missingGate.sibling[0], siblingPatch)
        const invalidGate = structuredClone(missingGate) as typeof missingGate & {
            sibling: Array<(typeof missingGate.sibling)[number] & { gate?: string }>
        }
        invalidGate.sibling[0].gate = 'automatic'
        const operatorGated = structuredClone(missingGate) as typeof missingGate & {
            sibling: Array<(typeof missingGate.sibling)[number] & { gate?: string }>
        }
        operatorGated.sibling[0].gate = 'operator'

        expect(CockpitConfig.safeParse(missingGate).success).toBe(false)
        expect(validate(missingGate), JSON.stringify(validate.errors)).toBe(false)
        expect(CockpitConfig.safeParse(invalidGate).success).toBe(false)
        expect(validate(invalidGate), JSON.stringify(validate.errors)).toBe(false)
        expect(CockpitConfig.safeParse(operatorGated).success).toBe(true)
        expect(validate(operatorGated), JSON.stringify(validate.errors)).toBe(true)
    })

    it.each(['slug', 'dir', 'var'] as const)(
        'declares the runtime-only sibling %s uniqueness constraint',
        (field) => {
            const config = structuredClone(validConfig)
            config.sibling.push({
                ...config.sibling[0],
                slug: 'worker',
                dir: 'worker',
                var: 'WORKER_DIR',
                [field]: config.sibling[0][field],
            })
            const schema = object(JSON.parse(renderCockpitSchema()))

            expect(CockpitConfig.safeParse(config).success).toBe(false)
            expect(schema['x-cockpit-runtime-checks']).toEqual([
                { path: 'sibling[].slug', rule: 'unique' },
                { path: 'sibling[].dir', rule: 'unique' },
                { path: 'sibling[].var', rule: 'unique' },
                { path: 'sibling[].environment_files[].instance', rule: 'unique' },
                { path: 'environment.resettable_volumes[]', rule: 'unique' },
                { path: 'environment.resettable_volumes[]', rule: 'declared_compose_volume_key' },
                { path: 'environment.generated_host_paths[]', rule: 'unique' },
                { path: 'environment.compose_files[]', rule: 'unique' },
                { path: 'environment.entrypoint_derivatives[].name', rule: 'unique' },
                { path: 'environment.install_policies[].volume', rule: 'unique' },
                { path: 'environment.install_policies[].toolchain+lockfile', rule: 'unique' },
                { path: 'environment.posture_requirements[].requirement', rule: 'unique' },
                { path: 'environment.entrypoint_derivatives[].port', rule: 'declared_in_ports.bases' },
                { path: 'browser.artifacts', rule: 'exact_environment.generated_host_paths_coverage' },
                { path: 'browser', rule: 'matches_environment_addressing_authentication_and_client_cap' },
                { path: 'browser.images', rule: 'runner_driver_equals_project_driver_and_mcp_driver_shares_major_minor' },
                { path: 'testing.gates[].stages[]', rule: 'references_declared_testing_stage' },
                { path: 'sibling[].environment_files[]', rule: 'template_and_instance_differ' },
                ...rowDerivationRuntimeChecks,
                {
                    path: 'ports',
                    rule: 'count_times_base_count_within_shared_input_budget',
                    limit: 4_096,
                },
                ...surfaceRuntimeChecks,
                ...generatedRuntimeChecks,
            ])
            expect(schema['x-cockpit-editor-limitations']).toEqual([
                { path: 'sibling[].environment_files[].instance', rule: 'unique' },
                { path: 'sibling[].environment_files[]', rule: 'template_and_instance_differ' },
                ...rowDerivationRuntimeChecks,
                { path: 'environment.entrypoint_derivatives[].name', rule: 'unique' },
                { path: 'environment.entrypoint_derivatives[].port', rule: 'declared_in_ports.bases' },
                { path: 'environment.install_policies[].volume', rule: 'unique' },
                { path: 'environment.install_policies[].toolchain+lockfile', rule: 'unique' },
                { path: 'environment.posture_requirements[].requirement', rule: 'unique' },
                { path: 'browser.artifacts', rule: 'exact_environment.generated_host_paths_coverage' },
                { path: 'browser', rule: 'matches_environment_addressing_authentication_and_client_cap' },
                { path: 'browser.images', rule: 'runner_driver_equals_project_driver_and_mcp_driver_shares_major_minor' },
                { path: 'testing.gates[].stages[]', rule: 'references_declared_testing_stage' },
                ...surfaceRuntimeChecks,
                ...generatedRuntimeChecks,
            ])
        },
    )

    it('byte-matches the committed package artifact', () => {
        const artifact = readFileSync(new URL('../cockpit.schema.json', import.meta.url), 'utf8')

        expect(artifact).toBe(renderCockpitSchema())
    })

    it('keeps attempt bounds and removed age control identical in runtime and editor schemas', () => {
        const validate = publishedCockpitValidator
        for (const attempt_cap of [1, 2]) {
            const config = { ...validConfig, workorders: { attempt_cap } }
            expect(CockpitConfig.safeParse(config).success).toBe(true)
            expect(validate(config), JSON.stringify(validate.errors)).toBe(true)
        }
        for (const workorders of [{ attempt_cap: 3 }, { attempt_cap: 0 }, { attempt_cap: 1.5 }, { stale_park_days: 14 }]) {
            const config = { ...validConfig, workorders }
            expect(CockpitConfig.safeParse(config).success).toBe(false)
            expect(validate(config), JSON.stringify(validate.errors)).toBe(false)
        }
    })

    it('requires provenance evidence on every provenance table the editor schema publishes', () => {
        const withoutRule: string[] = []
        const seen: string[] = []
        const walk = (node: unknown, path: string): void => {
            if (node === null || typeof node !== 'object') return
            const table = node as Record<string, unknown>
            const fields = table.properties as Record<string, unknown> | undefined
            if (fields?.observed_on && fields.kind && fields.source) {
                seen.push(path)
                if (!Array.isArray(table.anyOf)) withoutRule.push(path)
            }
            for (const [key, value] of Object.entries(table)) walk(value, `${path}.${key}`)
        }
        walk(JSON.parse(renderCockpitSchema()), '#')

        expect(seen.some((path) => path.includes('runner_health_measurement'))).toBe(true)
        expect(seen.some((path) => path.includes('adopted'))).toBe(true)
        expect(withoutRule).toEqual([])
    })

    it('describes every field so editors and the reference can say what it does', () => {
        const undescribed: string[] = []
        const walk = (node: unknown, path: string): void => {
            if (node === null || typeof node !== 'object') return
            const table = node as Record<string, unknown>
            for (const [name, field] of Object.entries((table.properties ?? {}) as Record<string, unknown>)) {
                const description = (field as { description?: unknown }).description
                if (typeof description !== 'string' || description.length === 0) undescribed.push(`${path}.${name}`)
            }
            // anyOf, oneOf, allOf and not restate fields as conditions, not as declarations.
            for (const [key, value] of Object.entries(table)) if (!['anyOf', 'oneOf', 'allOf', 'not'].includes(key)) walk(value, `${path}.${key}`)
        }
        walk(JSON.parse(renderCockpitSchema()), '#')

        expect([...new Set(undescribed)]).toEqual([])
    })

})
