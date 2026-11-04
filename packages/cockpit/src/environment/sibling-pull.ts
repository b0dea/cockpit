/**
 * Owns bringing one checkout up to its upstream, the way a careful person would: fetch, then
 * fast-forward the branch that is checked out, and nothing else. It never merges, rebases,
 * stashes, switches branch or touches a modified file; a checkout it cannot fast-forward cleanly
 * is left exactly as it was and reported with the reason. That is what makes it safe to run
 * unprompted: the only change it can make is one `git merge --ff-only` would make.
 */
import { formatShellCommand } from '../fix-catalogue.js'
import { parseGitBranchStatus, type GitBranchStatus } from './git-observation.js'
import type { GitRunner } from './sibling-checkouts.js'

export type PullRow =
    | Readonly<{ state: 'advanced'; path: string; branch: string; upstream: string; from: string; to: string; commits: number }>
    | Readonly<{ state: 'current'; path: string; branch: string; upstream: string; ahead: number }>
    // `blocked` when something stands in the way; a branch that follows nothing is a choice, not a problem.
    | Readonly<{ state: 'skipped'; path: string; reason: string; fix: string; blocked: boolean }>

// Hooks and an fsmonitor command are code in the checkout; a fast-forward an agent may start
// without asking must not run them.
const QUIET = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'] as const

async function branchStatus(git: GitRunner, path: string): Promise<GitBranchStatus | Readonly<{ reason: string }>> {
    const status = await git.run(path, 'pull:status', [...QUIET, 'status', '--porcelain=v2', '--branch', '--untracked-files=no'])
    if (status.kind !== 'complete') return { reason: `git status failed (${status.detail})` }
    const parsed = parseGitBranchStatus(status.stdout)
    return parsed.kind === 'complete' ? parsed : { reason: parsed.reason }
}

/**
 * The filter drivers the upstream's attributes name that the repository's own configuration does
 * not define. cockpit's Git reads no global configuration, where `git lfs install` puts its driver,
 * and a checkout through an undefined filter writes the stored pointer silently, with no error.
 */
async function unconfiguredFilters(git: GitRunner, path: string): Promise<readonly string[] | Readonly<{ reason: string }>> {
    const named = await git.run(path, 'pull:filters', [...QUIET, 'grep', '-h', '-o', '-I', '-E', 'filter=[^[:space:]]+', '@{upstream}', '--', ':(glob)**/.gitattributes'])
    // grep exits 1 when nothing matches.
    if (named.kind !== 'complete') return named.exitCode === 1 ? [] : { reason: `its attributes could not be read (${named.detail})` }
    const drivers = [...new Set(named.stdout.split('\n').map(line => line.trim().slice('filter='.length)).filter(Boolean))]
    // One call lists every filter variable; git exits 1 when there are none. Section and variable
    // names are lower-cased in the output, the driver (subsection) keeps its case.
    const configured = await git.run(path, 'pull:filter-drivers', ['config', '--get-regexp', '^filter\\.'])
    if (configured.kind !== 'complete' && configured.exitCode !== 1) return { reason: `its Git configuration could not be read (${configured.detail})` }
    const defined = new Set<string>()
    for (const line of configured.kind === 'complete' ? configured.stdout.split('\n') : []) {
        const match = /^filter\.(.+)\.(smudge|process)(?:\s|$)/.exec(line)
        if (match) defined.add(match[1]!)
    }
    return drivers.filter(driver => !defined.has(driver))
}

export async function fastForwardCheckout(git: GitRunner, path: string): Promise<PullRow> {
    const shell = (...args: string[]) => formatShellCommand(['git', '-C', path, ...args])
    const skipped = (reason: string, fix: string, blocked = true): PullRow => ({ state: 'skipped', path, reason, fix, blocked })
    const before = await branchStatus(git, path)
    if ('reason' in before) return skipped(`it is not a readable Git checkout: ${before.reason}`, `inspect it with ${shell('status')}`)
    if (before.revision === '(initial)') return skipped('it has no commits yet', `commit in it, or ignore it until it has a history`)
    if (before.branch === '(detached)') return skipped('HEAD is detached, so there is no branch to move', `check out a branch with ${shell('switch', '<branch>')} if it should follow one`, false)
    if (before.upstream === null) return skipped(`branch ${before.branch} tracks no upstream`, `set one with ${shell('branch', '--set-upstream-to', '<remote>/<branch>')} if it should follow one`, false)
    const fetched = await git.run(path, 'pull:fetch', [...QUIET, 'fetch', '--quiet', '--prune'], { timeoutMs: 120_000 })
    if (fetched.kind !== 'complete') {
        return skipped(`fetching ${before.upstream} failed (${fetched.detail})`,
            `run ${shell('fetch')} yourself to see why; cockpit fetches without the global Git configuration, so a credential helper set only there is not used`)
    }
    const after = await branchStatus(git, path)
    if ('reason' in after) return skipped(`it could not be read after fetching: ${after.reason}`, `inspect it with ${shell('status')}`)
    const upstream = after.upstream ?? before.upstream
    if (!after.adjacencyReported) return skipped(`${upstream}, which ${after.branch} tracks, no longer exists`,
        `push the branch to recreate it, or stop tracking it with ${shell('branch', '--unset-upstream')}`)
    if (after.behind === 0) return { state: 'current', path, branch: after.branch, upstream, ahead: after.ahead }
    if (after.ahead > 0) return skipped(`${after.branch} has diverged from ${upstream} (${after.behind} behind, ${after.ahead} ahead)`,
        `reconcile it by hand, for example with ${shell('rebase', upstream)}; cockpit only fast-forwards`)
    if (after.trackedDirtyCount > 0) return skipped(`${after.branch} is ${after.behind} behind ${upstream}, but ${after.trackedDirtyCount} tracked file(s) are modified`,
        `commit or stash the changes (see ${shell('status', '--short')}), then run pull again; cockpit never moves a checkout with work in it`)
    const filters = await unconfiguredFilters(git, path)
    if ('reason' in filters) return skipped(filters.reason, `inspect it with ${shell('check-attr', '-a', '--', '<path>')}`)
    if (filters.length > 0) return skipped(`it uses the Git filter ${filters.join(', ')} (Git LFS, for one), which is configured only outside the repository, `
        + 'so a fast-forward here would check out its placeholder files instead of their content', `run ${shell('pull', '--ff-only')} yourself`)
    const merged = await git.run(path, 'pull:fast-forward', [...QUIET, 'merge', '--ff-only', '--quiet', '@{upstream}'], { timeoutMs: 120_000 })
    if (merged.kind !== 'complete') return skipped(`fast-forwarding ${after.branch} to ${upstream} failed (${merged.detail})`,
        `run ${shell('merge', '--ff-only', '@{upstream}')} yourself to see what is in the way`)
    const head = await git.run(path, 'pull:head', ['rev-parse', 'HEAD'])
    return { state: 'advanced', path, branch: after.branch, upstream, from: after.revision,
        to: head.kind === 'complete' ? head.stdout : 'unknown', commits: after.behind }
}
