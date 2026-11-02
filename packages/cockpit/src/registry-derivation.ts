import { snapshotJson } from './environment/contract.js'
import {
    CockpitConfig,
    type CockpitConfig as CockpitConfigValue,
    type Provenance,
} from './schema.js'

export const mechanism = {
    id: 'registry-derivation',
    module: 'packages/cockpit/src/registry-derivation.ts',
    exports: ['deriveRegistry'],
} as const

export interface RegistryMcpSource {
    readonly slug: string
    readonly siblingDir: string
    readonly path: string
    readonly provenance: Provenance
}

export interface RegistrySecretPath {
    readonly slug: string
    readonly siblingDir: string
    readonly path: string
    readonly kind: 'instance'
}

export interface RegistryOrigin {
    readonly slug: string
    readonly provenance: Provenance
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
        ? readonly DeepReadonly<Item>[]
        : T extends object
            ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
            : T

export interface DerivedRegistry {
    readonly config: DeepReadonly<CockpitConfigValue>
    readonly mcpSources: readonly RegistryMcpSource[]
    readonly secretPaths: readonly RegistrySecretPath[]
    readonly origins: readonly RegistryOrigin[]
}

export type RegistryDerivationResult =
    | Readonly<{ kind: 'complete'; result: DerivedRegistry }>
    | Readonly<{
          kind: 'refusal'
          code:
              | 'REGISTRY_INPUT_INVALID'
              | 'REGISTRY_GENERATED_BASELINE_MISSING'
              | 'REGISTRY_EFFECTIVE_CONFIG_INVALID'
          message: string
      }>

function refusal(code: Extract<RegistryDerivationResult, { kind: 'refusal' }>['code'], message: string): RegistryDerivationResult {
    return Object.freeze({ kind: 'refusal', code, message })
}

function freezeData<T>(value: T): DeepReadonly<T> {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freezeData(child)
        Object.freeze(value)
    }
    return value as DeepReadonly<T>
}

function zodMessage(prefix: string, issues: readonly { readonly path: PropertyKey[]; readonly message: string }[]): string {
    const issue = issues[0]
    if (!issue) return prefix
    const path = issue.path.length === 0 ? 'configuration' : issue.path.map(String).join('.')
    return `${prefix} at ${path}: ${issue.message}`
}

export function deriveRegistry(input: unknown): RegistryDerivationResult {
    const snapshot = snapshotJson(input)
    if (snapshot === undefined) {
        return refusal('REGISTRY_INPUT_INVALID', 'registry derivation input is not bounded own data')
    }
    const parsed = CockpitConfig.safeParse(snapshot)
    if (!parsed.success) {
        const missingBaseline = parsed.error.issues.some((issue) => (
            issue.code === 'custom' && issue.params?.cockpitCode === 'REGISTRY_GENERATED_BASELINE_MISSING'
        ))
        return refusal(
            missingBaseline ? 'REGISTRY_GENERATED_BASELINE_MISSING' : 'REGISTRY_INPUT_INVALID',
            missingBaseline
                ? 'row-generated data requires a global generated environment baseline'
                : zodMessage('registry derivation input is not a canonical cockpit configuration', parsed.error.issues),
        )
    }

    const rows = parsed.data.sibling.map((sibling) => ({ sibling, generated: sibling.derives?.generated }))
    const generatedRows = rows.filter((row): row is typeof row & { generated: NonNullable<typeof row.generated> } => row.generated !== undefined)
    const services = generatedRows.map(({ sibling, generated }) => ({
        ...generated.service,
        id: sibling.slug,
        sibling: sibling.slug,
        profiles: sibling.mount === 'always' ? [] : [sibling.mount.slice('profile:'.length)],
        mounts: [
            { kind: 'bind' as const, source: '.', target: generated.checkout_mount.target, source_type: 'directory' as const },
            ...generated.additional_mounts,
        ],
    }))
    const rowVolumes = generatedRows.flatMap(({ generated }) => generated.volumes ?? [])
    const rowDecisions = generatedRows.flatMap(({ generated }) => generated.decisions)
    const rowPolicies = generatedRows.flatMap(({ generated }) => generated.install_policies ?? [])
    const rowEntrypoints = generatedRows.flatMap(({ generated }) => generated.entrypoints)
    const rowPorts = Object.fromEntries(generatedRows.flatMap(({ generated }) => Object.entries(generated.port_defaults)))
    const siblings = parsed.data.sibling.map(({ derives: _derives, ...sibling }) => sibling)
    const baseline = parsed.data.environment.generated
    const effectiveCandidate = {
        ...parsed.data,
        sibling: siblings,
        ports: { ...parsed.data.ports, bases: { ...parsed.data.ports.bases, ...rowPorts } },
        environment: {
            ...parsed.data.environment,
            entrypoint_derivatives: [...parsed.data.environment.entrypoint_derivatives, ...rowEntrypoints],
            install_policies: [...parsed.data.environment.install_policies, ...rowPolicies],
            ...(baseline ? {
                generated: {
                    ...baseline,
                    services: [...baseline.services, ...services],
                    volumes: [...baseline.volumes, ...rowVolumes],
                    decisions: {
                        ...baseline.decisions,
                        entries: [...baseline.decisions.entries, ...rowDecisions],
                    },
                },
            } : {}),
        },
    }
    const effective = CockpitConfig.safeParse(effectiveCandidate)
    if (!effective.success) {
        return refusal(
            'REGISTRY_EFFECTIVE_CONFIG_INVALID',
            zodMessage('normalized registry derivation violates the effective cockpit configuration', effective.error.issues),
        )
    }

    const mcpSources = parsed.data.sibling.flatMap((sibling) => (sibling.derives?.mcp_sources ?? []).map((source) => ({
        slug: sibling.slug,
        siblingDir: sibling.dir,
        path: source.path,
        provenance: source.provenance,
    })))
    const secretPaths = parsed.data.sibling.flatMap((sibling) => (sibling.environment_files ?? []).map((file) => ({
        slug: sibling.slug,
        siblingDir: sibling.dir,
        path: file.instance,
        kind: 'instance' as const,
    })))
    const origins = generatedRows.map(({ sibling, generated }) => ({ slug: sibling.slug, provenance: generated.provenance }))

    return freezeData({
        kind: 'complete' as const,
        result: { config: effective.data, mcpSources, secretPaths, origins },
    })
}
