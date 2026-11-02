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
        // Draft 4 has no propertyNames, and Zod drops a record's key schema there, so an editor
        // accepted any key the loader refuses. Every key must match one pattern property instead.
        override: ({ zodSchema, jsonSchema }) => {
            const def = zodSchema._zod.def
            if (def.type !== 'record') return
            const { type, pattern, maxLength, ...rest } = z.toJSONSchema(def.keyType, { io: 'input', target: 'draft-7' }) as JsonSchema
            delete rest.$schema
            const value = jsonSchema.additionalProperties
            if (type !== 'string' || typeof pattern !== 'string' || Object.keys(rest).length > 0 || maxLength !== undefined && typeof maxLength !== 'number'
                || value === undefined || typeof value === 'boolean') {
                throw new Error(`record key schema ${JSON.stringify({ type, pattern, maxLength, ...rest })} has no draft-04 rendering`)
            }
            const key = maxLength === undefined ? pattern : `^(?=[\\s\\S]{0,${maxLength}}$)(?:${pattern})`
            jsonSchema.patternProperties = { [key]: value }
            jsonSchema.additionalProperties = false
        },
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
        { path: 'surfaces.harnesses[].capabilities', rule: 'one_row_per_surface_feature' },
        { path: 'surfaces.harnesses[].capabilities[].spelling', rule: 'unique_when_emitted' },
        { path: 'surfaces.adopted[].path', rule: 'unique' },
        { path: 'surfaces.adopted[].source', rule: 'equals_cockpit/adopted/<path>' },
        { path: 'surfaces.adopted[].provenance.kind', rule: 'declared' },
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
        { path: 'environment.posture_requirements[].requirement', rule: 'unique' },
        { path: 'browser.artifacts', rule: 'exact_environment.generated_host_paths_coverage' },
        { path: 'browser', rule: 'matches_environment_addressing_authentication_and_client_cap' },
        { path: 'browser.images', rule: 'runner_driver_equals_project_driver_and_mcp_driver_shares_major_minor' },
        { path: 'testing.gates[].stages[]', rule: 'references_declared_testing_stage' },
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
        { path: 'environment.generated.data', rule: 'declared_default_mode_fixtures_for_seeded_and_restore_for_restored' },
        { path: 'environment.generated.decisions.entries[]', rule: 'declared_subject_with_undecided_subjects_rendered' },
        { path: 'environment.generated', rule: 'undated_declared_provenance_names_the_configuration_file' },
    ]
    ;(schema['x-cockpit-runtime-checks'] as unknown[]).push(...generatedChecks)
    ;(schema['x-cockpit-editor-limitations'] as unknown[]).push(...generatedChecks)

    // Found by shape, so every table that embeds a provenance carries the rule, wherever it sits.
    const requireProvenanceEvidence = (node: JsonSchema): void => {
        const fields = node.properties as Record<string, JsonSchema> | undefined
        if (fields?.observed_on && fields.kind && fields.source) {
            node.anyOf = [
                { properties: { kind: { enum: ['declared'] } } },
                { properties: { kind: { enum: ['measured'] } }, required: ['observed_on'] },
                { properties: { kind: { enum: ['inferred'] }, confirmed: { enum: [true] } }, required: ['confirmed', 'observed_on'] },
            ]
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) for (const entry of value) {
                if (entry !== null && typeof entry === 'object') requireProvenanceEvidence(entry as JsonSchema)
            }
            else if (value !== null && typeof value === 'object') requireProvenanceEvidence(value as JsonSchema)
        }
    }

    const refineGeneratedSchema = (node: JsonSchema): void => {
        const fields = node.properties as Record<string, JsonSchema> | undefined
        if (fields?.location && fields.argv) {
            node.oneOf = [
                { properties: { location: { enum: ['host'] } }, not: { required: ['service'] } },
                { properties: { location: { enum: ['in-stack'] } }, required: ['service'] },
            ]
        }
        if (fields?.image && fields.build && fields.command) {
            // allOf, because the role rule below owns this node's oneOf.
            node.allOf = [{ oneOf: [
                { required: ['image'], not: { required: ['build'] } },
                { required: ['build'], not: { required: ['image'] } },
            ] }]
        }
        if (fields?.posture && fields.endpoints) {
            fields.nonempty_variables.uniqueItems = true
            node.allOf = [
                { anyOf: [{ properties: { posture: { not: { enum: ['vendor-sandbox'] } } } }, { required: ['expiry'] }] },
                { anyOf: [{ properties: { posture: { not: { enum: ['stubbed'] } } } }, { required: ['stub'] }] },
            ]
        }
        if (fields?.purpose && fields.install_policy) {
            node.oneOf = [
                { properties: { purpose: { enum: ['dependencies'] } }, required: ['install_policy'] },
                { properties: { purpose: { enum: ['product-data'] } }, not: { required: ['install_policy'] } },
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

    requireProvenanceEvidence(schema)

    return `${JSON.stringify(schema, null, 2)}\n`
}
