import * as nativePaths from 'node:path'

export const mechanism = {
    id: 'browser-package-paths',
    module: 'packages/cockpit/src/browser/package-paths.ts',
    exports: ['isPackageDescendant'],
} as const

// Lexical confinement complements the caller's canonical filesystem and byte-identity checks.
export function isPackageDescendant(root: string, candidate: string,
    paths: Pick<typeof nativePaths, 'relative' | 'isAbsolute' | 'sep'> = nativePaths): boolean {
    const offset = paths.relative(root, candidate)
    return candidate.startsWith(`${root}${paths.sep}`) && offset.length > 0 && offset !== '..' && !offset.startsWith(`..${paths.sep}`) && !paths.isAbsolute(offset)
}
