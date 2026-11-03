import { snapshotJson } from './environment/contract.js'
import {
    CockpitConfig,
    type CockpitConfig as CockpitConfigValue,
    type Provenance,
} from './schema.js'

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
}

export type RegistryDerivationResult =
    | Readonly<{ kind: 'complete'; result: DerivedRegistry }>
    | Readonly<{
          kind: 'refusal'
          code: 'REGISTRY_INPUT_INVALID'
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
        return refusal('REGISTRY_INPUT_INVALID', zodMessage('registry derivation input is not a canonical cockpit configuration', parsed.error.issues))
    }
    // The derives facts leave the configuration as the MCP sources below.
    const config = { ...parsed.data, sibling: parsed.data.sibling.map(({ derives: _derives, ...sibling }) => sibling) }

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
    return freezeData({
        kind: 'complete' as const,
        result: { config, mcpSources, secretPaths },
    })
}
