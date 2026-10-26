import { dirname, isAbsolute, normalize } from 'node:path'
import type { Diagnostic } from './environment/contract.js'

export const mechanism = {
    id: 'executable-remedy-catalogue',
    module: 'packages/cockpit/src/fix-catalogue.ts',
    exports: ['admitDiagnosticFix'],
} as const

export interface FixContext {
    // Supplied by the command boundary from resolved configuration and its generated inventory,
    // never extracted from diagnostic prose or arbitrary result data.
    readonly resolvedConfigPath: string | null
    readonly generatedTargets: readonly string[]
}

export interface ExecutableFix {
    readonly argv: readonly ['cockpit', 'sync', '--config', string]
    readonly command: string
}

const unsafeControl = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/

function safeTarget(target: string): boolean {
    return !unsafeControl.test(target) && !target.includes('\\') && !target.includes(':')
        && target.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

export function admitDiagnosticFix(diagnostic: Diagnostic, context?: FixContext): ExecutableFix | undefined {
    if (diagnostic.severity !== 'error' || diagnostic.code !== 'GENERATED_ARTIFACT_DRIFT'
        || diagnostic.fix !== 'run cockpit sync --config <file>' || !diagnostic.target || !context) return undefined
    const path = context.resolvedConfigPath
    if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || dirname(path) === path
        || unsafeControl.test(path) || !safeTarget(diagnostic.target)
        || !context.generatedTargets.includes(diagnostic.target)) return undefined
    const argv = Object.freeze(['cockpit', 'sync', '--config', path] as const)
    // Single quoting keeps shell syntax in a config filename literal when the user pastes it.
    const command = `cockpit sync --config '${path.replaceAll("'", "'\"'\"'")}'`
    return Object.freeze({ argv, command })
}
