export const mechanism = {
    id: 'resolved-registry-shell-rendering',
    module: 'packages/cockpit/src/registry-resolve/render-shell.ts',
    exports: ['renderResolvedRegistryShell'],
} as const

export interface ResolvedRegistryShellModel {
    formatVersion: string
    cockpitSourceRevision: string
    registrySha256: string
    dialect: 'lane' | 'tier'
    siblingsRoot: string
    rows: readonly string[]
    paths: readonly string[]
    variables: readonly { name: string; defaultPath: string }[]
    adoption: readonly { layer: string; state: string }[]
}

function quote(value: string): string {
    if (/\0|\r|\n|\$\(|\$\{|`/.test(value)) {
        throw new Error('REGISTRY_ARTIFACT_UNSAFE: value contains executable or multiline shell syntax')
    }
    return `'${value.replaceAll("'", `'"'"'`)}'`
}

function array(name: string, values: readonly string[]): string[] {
    return [`${name}=(`, ...values.map((value) => `  ${quote(value)}`), ')']
}

export function renderResolvedRegistryShell(model: ResolvedRegistryShellModel): string {
    if (
        model.siblingsRoot.includes('|') ||
        model.variables.some(({ defaultPath }) => defaultPath.includes('|')) ||
        model.paths.some((path) => path.split('|').length !== 3) ||
        model.rows.some((row) => row.split('|').length !== (model.dialect === 'lane' ? 6 : 7)) ||
        model.adoption.some(({ layer, state }) => layer.includes('|') || state.includes('|'))
    ) {
        throw new Error('REGISTRY_ARTIFACT_UNSAFE: a field contains the shell record delimiter')
    }
    for (const variable of model.variables) {
        if (!/^[A-Z][A-Z0-9_]*_DIR$/.test(variable.name)) {
            throw new Error('REGISTRY_VARIABLE_INVALID: expected a namespaced sibling directory variable')
        }
    }

    return [
        `COCKPIT_REGISTRY_FORMAT=${quote(model.formatVersion)}`,
        `COCKPIT_SOURCE_REVISION=${quote(model.cockpitSourceRevision)}`,
        `COCKPIT_REGISTRY_SHA256=${quote(model.registrySha256)}`,
        `COCKPIT_REGISTRY_DIALECT=${quote(model.dialect)}`,
        `COCKPIT_SIBLINGS_ROOT=${quote(model.siblingsRoot)}`,
        ...array('COCKPIT_REGISTRY_ROWS', model.rows),
        ...array('COCKPIT_SIBLING_PATHS', model.paths),
        ...array(
            'COCKPIT_SIBLING_VARIABLES',
            model.variables.map((variable) => `${variable.name}|${variable.defaultPath}`),
        ),
        ...array(
            'COCKPIT_ADOPTION_STATES',
            model.adoption.map(({ layer, state }) => `${layer}|${state}`),
        ),
        ...model.variables.map(({ name, defaultPath }) => `export ${name}=${quote(defaultPath)}`),
        '',
    ].join('\n')
}
