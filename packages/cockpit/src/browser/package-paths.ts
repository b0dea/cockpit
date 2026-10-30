import { isAbsolute, relative, sep } from 'node:path'

export const mechanism = {
    id: 'browser-package-paths',
    module: 'packages/cockpit/src/browser/package-paths.ts',
    exports: ['isPackageDescendant'],
} as const

// Lexical confinement complements the caller's canonical filesystem and byte-identity checks.
export function isPackageDescendant(root: string, candidate: string): boolean {
    const offset = relative(root, candidate)
    return candidate.startsWith(`${root}${sep}`) && offset.length > 0 && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
}
