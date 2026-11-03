import { z } from 'zod'

import { CockpitConfig, OPERATOR_GATE_RISK_PATTERN, STRUCTURED_INPUT_ENTRY_LIMIT } from './schema.js'

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
    const postureRequirement = environmentProperties.posture_requirements.items as JsonSchema
    postureRequirement.anyOf = [{ required: ['addressing'] }, { required: ['authentication'] }]

    for (const field of ['resettable_volumes', 'generated_host_paths', 'compose_files']) {
        environmentProperties[field].uniqueItems = true
    }
    ;(browserProperties.harnesses as JsonSchema).uniqueItems = true
    const browserProxy = browserProperties.proxy as JsonSchema
    const browserProxyProperties = browserProxy.properties as Record<string, JsonSchema>
    browserProxyProperties.allowed_hosts.uniqueItems = true
    browser.anyOf = [
        { properties: { request_preapproval: { enum: [false] } } },
        { properties: { data: { required: ['mode', 'isolated', 'reaches_production'], properties: {
            mode: { enum: ['empty', 'seeded'] }, isolated: { enum: [true] }, reaches_production: { enum: [false] },
        } } } },
    ]
    testing.oneOf = [
        { properties: { native_hooks: { properties: { install: { enum: ['inspect'] } } } }, not: { required: ['native_hook_policy'] } },
        { properties: { native_hooks: { properties: { install: { enum: ['explicit-native'] } }, required: ['install'] } }, required: ['native_hooks', 'native_hook_policy'] },
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
        { path: 'sibling[].derives.mcp_sources[].path', rule: 'unique_within_sibling' },
        { path: 'environment.seed', rule: 'requires_resettable_volumes' },
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
        { path: 'sibling[].derives.mcp_sources[].path', rule: 'unique_within_sibling' },
        { path: 'environment.seed', rule: 'requires_resettable_volumes' },
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

    requireProvenanceEvidence(schema)

    return `${JSON.stringify(schema, null, 2)}\n`
}
