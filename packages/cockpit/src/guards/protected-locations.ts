// Owns the machine facts behind three guard protections: the directories holding the code the
// running guard loads, the command search path directories inside the allowed roots, and the
// identity of every file in the root secrets directory. It reads the filesystem and decides
// nothing; the guard application filters these facts into the policy and the evaluator turns them
// into hard denials.
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'

import { foldGuardSpelling, GUARD_PROTECTED_LOCATION_LIMIT, GUARD_SECRET_FILE_LIMIT, guardIdentity } from './evaluator.js'

export const mechanism = {
    id: 'guard-protected-locations', module: 'packages/cockpit/src/guards/protected-locations.ts',
    exports: ['guardInstalledDirectories', 'guardSearchDirectories', 'guardSecretFiles'],
} as const

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

/** The directory Node loads a bare specifier from: the nearest `node_modules/<name>` above `from`. */
function installedPackage(from: string, name: string): string {
    for (let directory = from; ; directory = dirname(directory)) {
        const candidate = join(directory, 'node_modules', name)
        try {
            if (lstatSync(candidate)) return candidate
        } catch (error) {
            if (!missing(error)) throw error
        }
        if (dirname(directory) === directory) throw new Error(`guard dependency ${name} is not installed above ${from}`)
    }
}

/**
 * The running cockpit package and every package it loads, each under the spelling it was found by
 * and its real path, plus the consumer's `node_modules` spelling of the package when that is a link
 * to it. The guard authenticates only its entry point, so all of these are controls.
 */
export function guardInstalledDirectories(packageRoot: string, consumerRoot: string): readonly string[] {
    const found = new Set<string>()
    const visited = new Set<string>()
    const pending = [packageRoot]
    const { name } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name: string }
    const linked = join(consumerRoot, 'node_modules', name)
    try {
        if (realpathSync(linked) === realpathSync(packageRoot)) pending.push(linked)
    } catch (error) {
        if (!missing(error)) throw error
    }
    while (pending.length) {
        const spelled = pending.pop()!
        const real = realpathSync(spelled)
        found.add(spelled).add(real)
        if (visited.has(real)) continue
        visited.add(real)
        if (found.size > GUARD_PROTECTED_LOCATION_LIMIT) throw new Error(`guard package closure exceeds ${GUARD_PROTECTED_LOCATION_LIMIT} directories`)
        const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
        for (const name of Object.keys(manifest.dependencies ?? {})) pending.push(installedPackage(real, name))
    }
    return [...found].sort()
}

/**
 * Absolute search path entries, and their real paths, that lie inside an allowed root. A relative
 * entry resolves against whatever directory a command runs in, so it names no fixed location.
 */
export function guardSearchDirectories(searchPath: string, allowedRoots: readonly string[]): readonly string[] {
    const inside = (path: string) => allowedRoots.some((root) => path === root || path.startsWith(`${root}/`))
    const found = new Set<string>()
    for (const entry of searchPath.split(':')) {
        if (!entry.startsWith('/')) continue
        const spelled = posix.normalize(entry).replace(/(?<=.)\/+$/, '')
        const candidates = [spelled]
        try { candidates.push(realpathSync(spelled)) } catch (error) { if (!missing(error)) throw error }
        for (const candidate of candidates) if (inside(candidate)) found.add(candidate)
    }
    if (found.size > GUARD_PROTECTED_LOCATION_LIMIT) throw new Error(`guard search path exceeds ${GUARD_PROTECTED_LOCATION_LIMIT} directories inside the allowed roots`)
    return [...found].sort()
}

/**
 * Identities of every file in each case-folded spelling of `env/.secrets` below `root`, and whether
 * any has a second hard link; `identities` is null once more than the bound of entries was seen,
 * which leaves every read unproven rather than silently uncovered.
 */
export function guardSecretFiles(root: string): { readonly identities: readonly string[] | null; readonly linked: boolean } {
    const directories = (parent: string, name: string) => {
        let entries: string[]
        try { entries = readdirSync(parent) } catch (error) { if (missing(error)) return []; throw error }
        return entries.filter((entry) => foldGuardSpelling(entry) === name).map((entry) => join(parent, entry))
            .filter((path) => { const status = lstatSync(path); return status.isDirectory() && !status.isSymbolicLink() })
    }
    const pending = directories(root, 'env').flatMap((env) => directories(env, '.secrets'))
    const identities: string[] = []
    let linked = false
    let seen = 0
    while (pending.length) {
        const directory = pending.pop()!
        for (const entry of readdirSync(directory)) {
            if (++seen > GUARD_SECRET_FILE_LIMIT) return { identities: null, linked: true }
            const path = join(directory, entry)
            const status = lstatSync(path)
            if (status.isDirectory()) pending.push(path)
            else if (status.isFile()) {
                identities.push(guardIdentity(status))
                if (status.nlink > 1) linked = true
            }
        }
    }
    return { identities: identities.sort(), linked }
}
