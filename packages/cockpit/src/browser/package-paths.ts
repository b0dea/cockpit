import { isAbsolute, relative, sep } from 'node:path'

// Lexical confinement complements the caller's canonical filesystem and byte-identity checks.
export function isPackageDescendant(root: string, candidate: string): boolean {
    const offset = relative(root, candidate)
    return candidate.startsWith(`${root}${sep}`) && offset.length > 0 && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
}
