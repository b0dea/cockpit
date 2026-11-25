// Which main checkout a linked worktree belongs to, read from Git's own files as the hook's check reads them, so the
// guard that admits a worktree's bind and the sync that performs it agree with the check that chose the guard.
import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { readBoundedFile } from '../bounded-read.js'
import { hasErrorCode } from '../environment/contract.js'
import { lstatIfPresentSync } from '../environment/presence.js'
import { GUARD_LOCAL_PATHS, parseGuardLocalIdentity, type GuardHandlerIdentity } from './local-identity.js'

/**
 * The canonical main checkout of the linked worktree at `worktree`, or undefined when its `.git` file, the worktree's
 * Git directory or the shared `.git` directory do not name one. Git's record in the worktree's Git directory must name
 * the worktree back, so a `.git` file written by hand cannot borrow another checkout's record.
 */
export function linkedWorktreeMainCheckout(worktree: string): string | undefined {
    const firstLine = (path: string) => {
        const read = readBoundedFile(path, 4096)
        return read.kind === 'complete' ? read.bytes.toString('utf8').split('\n')[0] : undefined
    }
    try {
        const pointer = firstLine(join(worktree, '.git'))
        if (!pointer?.startsWith('gitdir: ') || pointer === 'gitdir: ') return undefined
        const gitDirectory = realpathSync(resolve(worktree, pointer.slice('gitdir: '.length)))
        const back = firstLine(join(gitDirectory, 'gitdir'))
        if (!back || basename(back) !== '.git' || realpathSync(dirname(resolve(gitDirectory, back))) !== realpathSync(worktree)) return undefined
        const common = firstLine(join(gitDirectory, 'commondir'))
        if (!common) return undefined
        const shared = realpathSync(resolve(gitDirectory, common))
        return basename(shared) === '.git' && dirname(gitDirectory) === join(shared, 'worktrees') ? dirname(shared) : undefined
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR', 'EACCES')) return undefined
        throw error
    }
}

/**
 * The checkout holding the canonical `path`: the nearest directory at or above it with a `.git` entry, and the main
 * checkout of its repository. That is the checkout itself when the entry is a directory, and for a `.git` file the main
 * checkout `linkedWorktreeMainCheckout` verifies; undefined when there is no entry, or a `.git` file names none.
 */
export function checkoutOf(path: string): Readonly<{ top: string; main: string }> | undefined {
    for (let directory = path; ; directory = dirname(directory)) {
        const entry = lstatIfPresentSync(join(directory, '.git'))
        if (entry?.isDirectory()) return { top: directory, main: directory }
        if (entry) {
            const main = entry.isFile() ? linkedWorktreeMainCheckout(directory) : undefined
            return main === undefined ? undefined : { top: directory, main }
        }
        if (directory === dirname(directory)) return undefined
    }
}

/**
 * The guard identity the main checkout of the linked worktree at `worktree` recorded for itself, or undefined when
 * `worktree` is no linked worktree or its main checkout has none.
 */
export function mainCheckoutGuardIdentity(worktree: string): GuardHandlerIdentity | undefined {
    const main = linkedWorktreeMainCheckout(worktree)
    if (main === undefined || main === worktree) return undefined
    let read
    try { read = readBoundedFile(join(main, GUARD_LOCAL_PATHS.identity), 65_536) }
    catch (error) { if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR')) return undefined; throw error }
    const identity = read.kind === 'complete' ? parseGuardLocalIdentity(read.bytes.toString('utf8')) : undefined
    return identity?.root === main ? identity : undefined
}

/** The command, as argv, that binds the guard of the worktree at `root` through the Node and cockpit package the main checkout's `identity` names. */
export function worktreeBindArgv(root: string, identity: GuardHandlerIdentity): readonly string[] {
    // The launcher of the package the guard's own handler belongs to; the handler path is canonical already.
    return [identity.node, join(dirname(dirname(identity.module)), 'bin/cockpit.mjs'), 'sync', '--config', join(root, relative(identity.root, identity.configPath)), '--bind-worktree']
}
