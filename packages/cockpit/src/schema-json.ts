import { z } from 'zod'

import { CockpitConfig, LOCAL_ENDPOINT_URL_PATTERN, OPERATOR_GATE_RISK_PATTERN, STRUCTURED_INPUT_ENTRY_LIMIT } from './schema.js'

export const mechanism = {
    id: 'schema-generation',
    module: 'packages/cockpit/src/schema-json.ts',
    exports: ['renderCockpitSchema'],
} as const

type JsonSchema = Record<string, unknown>

export function renderCockpitSchema(): string {
    const schema = z.toJSONSchema(CockpitConfig, {
        io: 'input',
        target: 'draft-04',
    }) as JsonSchema
    const properties = schema.properties as Record<string, JsonSchema>
    const sibling = properties.sibling.items as JsonSchema
    const environment = properties.environment as JsonSchema
    const environmentProperties = environment.properties as Record<string, JsonSchema>
    const browser = properties.browser as JsonSchema
    const browserProperties = browser.properties as Record<string, JsonSchema>
    const testing = properties.testing as JsonSchema
    schema.allOf = [{ anyOf: [
        { not: { required: ['browser'], properties: { browser: { required: ['resources'] } } } },
        { required: ['environment'], properties: { environment: { required: ['generated'] } } },
    ] }]

    const postureRequirement = environmentProperties.posture_requirements.items as JsonSchema
    postureRequirement.anyOf = [{ required: ['addressing'] }, { required: ['authentication'] }]

    for (const field of ['resettable_volumes', 'generated_host_paths', 'compose_files']) {
        environmentProperties[field].uniqueItems = true
    }
    ;(browserProperties.harnesses as JsonSchema).uniqueItems = true
    const browserProxy = browserProperties.proxy as JsonSchema
    const browserProxyProperties = browserProxy.properties as Record<string, JsonSchema>
    browserProxyProperties.allowed_hosts.uniqueItems = true
    browser.allOf = [
        { anyOf: [{ not: { required: ['resources'] } }, { required: ['endpoint'] }] },
        {
            anyOf: [
                { properties: { request_preapproval: { enum: [false] } } },
                { properties: { data: { required: ['mode', 'isolated', 'reaches_production'], properties: {
                    mode: { enum: ['empty', 'seeded'] }, isolated: { enum: [true] }, reaches_production: { enum: [false] },
                } } } },
            ],
        },
    ]
    testing.oneOf = [
        { properties: { native_hooks: { properties: { install: { enum: ['inspect'] } } } }, not: { required: ['native_hook_policy'] } },
        { properties: { native_hooks: { properties: { install: { enum: ['explicit-native'] } }, required: ['install'] } }, required: ['native_hook_policy'] },
    ]

    sibling.allOf = [
        {
            oneOf: [
                {
                    properties: { acquire: { enum: ['none'] } },
                    not: { required: ['remote'] },
                },
                {
                    properties: { acquire: { enum: ['auto', 'manual'] } },
                    required: ['remote'],
                },
            ],
        },
        {
            anyOf: [
                {
                    properties: { mount: { enum: ['host'] } },
                    required: ['host_reason'],
                },
                {
                    properties: { mount: { not: { enum: ['host'] } } },
                },
            ],
        },
        {
            not: {
                required: ['mount', 'derives'],
                properties: {
                    mount: { enum: ['none', 'host'] },
                    derives: { required: ['generated'] },
                },
            },
        },
        {
            anyOf: [
                {
                    properties: { gate: { enum: ['operator'] } },
                    required: ['gate'],
                },
                {
                    not: {
                        anyOf: [
                            { properties: { mount: { enum: ['host'] } } },
                            { properties: { purpose: { pattern: OPERATOR_GATE_RISK_PATTERN } } },
                        ],
                    },
                },
            ],
        },
    ]
    schema['x-cockpit-runtime-checks'] = [
        { path: 'sibling[].slug', rule: 'unique' },
        { path: 'sibling[].dir', rule: 'unique' },
        { path: 'sibling[].var', rule: 'unique' },
        { path: 'sibling[].environment_files[].instance', rule: 'unique' },
        { path: 'environment.resettable_volumes[]', rule: 'unique' },
        { path: 'environment.generated_host_paths[]', rule: 'unique' },
        { path: 'environment.compose_files[]', rule: 'unique' },
        { path: 'environment.entrypoint_derivatives[].name', rule: 'unique' },
        { path: 'environment.install_policies[].volume', rule: 'unique' },
        { path: 'environment.install_policies[].toolchain+lockfile', rule: 'unique' },
        { path: 'environment.runtime_measurements[].runtime', rule: 'unique' },
        { path: 'environment.posture_requirements[].requirement', rule: 'unique' },
        { path: 'environment.entrypoint_derivatives[].port', rule: 'declared_in_ports.bases' },
        { path: 'browser.artifacts', rule: 'exact_environment.generated_host_paths_coverage' },
        { path: 'browser', rule: 'matches_environment_addressing_authentication_and_client_cap' },
        { path: 'testing.gates[].stages[]', rule: 'references_declared_testing_stage' },
        { path: 'sibling[].environment_files[]', rule: 'template_and_instance_differ' },
        { path: 'sibling[].derives.generated', rule: 'row_owned_relations_and_exact_port_defaults' },
        { path: 'sibling[].derives.mcp_sources[].path', rule: 'unique_within_sibling' },
        { path: 'sibling[].derives', rule: 'global_baseline_and_cross_row_identity_disjointness' },
        {
            path: 'ports',
            rule: 'count_times_base_count_within_shared_input_budget',
            limit: STRUCTURED_INPUT_ENTRY_LIMIT,
        },
        { path: 'surfaces.overlays[].name', rule: 'unique' },
        { path: 'surfaces.overlays[].sources[].path', rule: 'unique' },
        { path: 'surfaces.overlays[].sources', rule: 'feature_namespace_and_complete_skill_definitions' },
        { path: 'surfaces.overlays[].sources[].bytes', rule: 'utf8_byte_length_at_most_65536' },
        { path: 'surfaces.overlays[].replaces.name', rule: 'matches_declaration_name' },
        { path: 'surfaces.harnesses[].name', rule: 'unique' },
        { path: 'surfaces.harnesses[].features', rule: 'exact_capability_feature_set' },
        { path: 'surfaces.harnesses[].capabilities[].spelling', rule: 'unique_when_emitted' },
    ]
    schema['x-cockpit-editor-limitations'] = [
        { path: 'sibling[].environment_files[].instance', rule: 'unique' },
        { path: 'sibling[].environment_files[]', rule: 'template_and_instance_differ' },
        { path: 'sibling[].derives.generated', rule: 'row_owned_relations_and_exact_port_defaults' },
        { path: 'sibling[].derives.mcp_sources[].path', rule: 'unique_within_sibling' },
        { path: 'sibling[].derives', rule: 'global_baseline_and_cross_row_identity_disjointness' },
        { path: 'environment.entrypoint_derivatives[].name', rule: 'unique' },
        { path: 'environment.entrypoint_derivatives[].port', rule: 'declared_in_ports.bases' },
        { path: 'environment.install_policies[].volume', rule: 'unique' },
        { path: 'environment.install_policies[].toolchain+lockfile', rule: 'unique' },
        { path: 'environment.runtime_measurements[].runtime', rule: 'unique' },
        { path: 'environment.posture_requirements[].requirement', rule: 'unique' },
        { path: 'browser.artifacts', rule: 'exact_environment.generated_host_paths_coverage' },
        { path: 'browser', rule: 'matches_environment_addressing_authentication_and_client_cap' },
        { path: 'testing.gates[].stages[]', rule: 'references_declared_testing_stage' },
        { path: 'surfaces.overlays[].name', rule: 'unique' },
        { path: 'surfaces.overlays[].sources[].path', rule: 'unique' },
        { path: 'surfaces.overlays[].sources', rule: 'feature_namespace_and_complete_skill_definitions' },
        { path: 'surfaces.overlays[].sources[].bytes', rule: 'utf8_byte_length_at_most_65536' },
        { path: 'surfaces.overlays[].replaces.name', rule: 'matches_declaration_name' },
        { path: 'surfaces.harnesses[].name', rule: 'unique' },
        { path: 'surfaces.harnesses[].features', rule: 'exact_capability_feature_set' },
        { path: 'surfaces.harnesses[].capabilities[].spelling', rule: 'unique_when_emitted' },
    ]

    // Editors cannot enforce cross-row identities or arithmetic; the loader owns these checks.
    const generatedChecks = [
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
        { path: 'environment.generated.decisions.entries[]', rule: 'exact_rendered_choice_and_vendor_coverage' },
    ]
    ;(schema['x-cockpit-runtime-checks'] as unknown[]).push(...generatedChecks)
    ;(schema['x-cockpit-editor-limitations'] as unknown[]).push(...generatedChecks)

    const refineGeneratedSchema = (node: JsonSchema): void => {
        const fields = node.properties as Record<string, JsonSchema> | undefined
        if (fields?.location && fields.argv) {
            node.oneOf = [
                { properties: { location: { enum: ['host'] } }, not: { required: ['service'] } },
                { properties: { location: { enum: ['in-stack'] } }, required: ['service'] },
            ]
        }
        if (fields?.observed_on && fields.kind && fields.source) {
            node.anyOf = [
                { properties: { kind: { enum: ['declared', 'measured'] } } },
                { properties: { kind: { enum: ['inferred'] }, confirmed: { enum: [true] } }, required: ['confirmed'] },
            ]
        }
        if (fields?.posture && fields.endpoints) {
            fields.nonempty_variables.uniqueItems = true
            node.allOf = [
                { anyOf: [{ properties: { posture: { not: { enum: ['vendor-sandbox'] } } } }, { required: ['expiry'] }] },
                { anyOf: [{ properties: { posture: { not: { enum: ['stubbed'] } } } }, { required: ['stub'] }] },
            ]
        }
        if (fields?.purpose && fields.install_policy && fields.target) {
            node.oneOf = [
                { properties: { purpose: { enum: ['dependencies'] } }, required: ['install_policy'] },
                { properties: { purpose: { enum: ['product-data'] } }, not: { required: ['install_policy'] } },
            ]
        }
        if (fields?.role && fields.one_shot_failure) {
            node.oneOf = [
                { properties: { role: { enum: ['one-shot'] } }, required: ['one_shot_failure'] },
                { properties: { role: { enum: ['service'] } }, not: { required: ['one_shot_failure'] } },
            ]
        }
        if (fields?.kind && fields.source && fields.target && fields.source_type) {
            node.oneOf = [
                { properties: { kind: { enum: ['volume'] }, source: { not: { enum: ['.'] } } }, not: { required: ['source_type'] } },
                { properties: { kind: { enum: ['bind'] } }, required: ['source_type'] },
                { properties: { kind: { enum: ['environment-file'] }, source_type: { enum: ['file'] } }, required: ['source_type'] },
            ]
        }
        if (fields?.sink && fields.runtime_service) fields.sink.pattern = LOCAL_ENDPOINT_URL_PATTERN
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) for (const entry of value) {
                if (entry !== null && typeof entry === 'object') refineGeneratedSchema(entry as JsonSchema)
            }
            else if (value !== null && typeof value === 'object') refineGeneratedSchema(value as JsonSchema)
        }
    }
    refineGeneratedSchema(environmentProperties.generated)
    refineGeneratedSchema(browserProperties.resources)
    const siblingProperties = sibling.properties as Record<string, JsonSchema>
    siblingProperties.derives.anyOf = [
        { required: ['generated'] },
        { required: ['mcp_sources'], properties: { mcp_sources: { minItems: 1 } } },
    ]
    refineGeneratedSchema(siblingProperties.derives)

    return `${JSON.stringify(schema, null, 2)}\n`
}
