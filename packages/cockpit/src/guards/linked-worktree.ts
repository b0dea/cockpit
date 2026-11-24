// Which main checkout a linked worktree belongs to, read from Git's own files as the hook's check reads them, so the
// guard that admits a worktree's bind and the sync that performs it agree with the check that chose the guard.
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { readBoundedFile } from '../bounded-read.js'
import { hasErrorCode } from '../environment/contract.js'

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
