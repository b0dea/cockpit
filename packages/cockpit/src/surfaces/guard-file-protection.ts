// Spells the files the guard depends on as each agent tool's own write denials. The guard judges
// command text, so a program it does not understand (an inline script, a build tool) can rewrite the
// guard, its registrations or a repository's Git state; only the tool's own permission layer or
// sandbox refuses that. The native set is narrower than the guard's: the guard refuses every write
// below a `.git` segment, while a native denial covers only Git state that chooses programs Git runs,
// and only the part a tool can deny without breaking ordinary Git work. cockpit.toml is left out on
// purpose: agents edit it, and the guard judges whether an edit widens.
import { GUARD_ROOT_PROTECTIONS } from '../guards/evaluator.js'

type ProtectedPath = Readonly<{ path: string; type: 'file' | 'directory' }>

// Git runs hooks from `.git/hooks` unless `core.hooksPath` in a configuration file points elsewhere,
// and reads `config.worktree` once `extensions.worktreeConfig` is on. A submodule keeps its hooks and
// configuration under `.git/modules/<name>`. A `*` segment stands for any depth of directories, so
// these cover a linked worktree's administrative directory and nested submodules too, in the cockpit
// root and in every sibling repository.
const GIT_CONTROLS: readonly ProtectedPath[] = Object.freeze([
    { path: '.git/hooks', type: 'directory' }, { path: '.git/config', type: 'file' },
    { path: '.git/config.worktree', type: 'file' }, { path: '.git/*/config.worktree', type: 'file' },
    { path: '.git/modules/*/hooks', type: 'directory' }, { path: '.git/modules/*/config', type: 'file' },
])

// The files that tell Git where a repository lives: a linked worktree's or a submodule checkout's
// `.git` gitfile, and the `gitdir` and `commondir` files in its administrative directory. Rewriting one
// points Git at a directory whose configuration the agent wrote. Claude Code's sandbox turns a denial
// into a filesystem write denial: under it, Claude Code 2.1.319's `git worktree add` failed writing the
// new worktree's gitfile, gitdir or commondir, and every Git write failed once `.git` was denied, since
// the sandbox also denies everything below a denied path. So only OpenCode, whose denial binds its edit tool alone,
// gets these.
const GIT_LOCATORS: readonly ProtectedPath[] = Object.freeze([
    { path: '.git', type: 'file' }, { path: '.git/*/gitdir', type: 'file' }, { path: '.git/*/commondir', type: 'file' },
])

/**
 * Claude Code `Edit(...)` rules, which cover every file tool. Claude Code 2.1.319 also refused shell
 * commands whose redirect or copy destination matched one, and its sandbox writes them into its
 * filesystem write denials. A `/` rule is anchored at the project root; siblings sit outside it, where
 * only a filesystem-root `//**` rule matches the same path in every clone.
 */
export function claudeGuardFileDenials(): readonly string[] {
    return [...GUARD_ROOT_PROTECTIONS.map(({ path, type }) => type === 'directory' ? `/${path}/**` : `/${path}`),
        ...GIT_CONTROLS.map(({ path, type }) => {
            const glob = path.replaceAll('/*/', '/**/')
            return type === 'directory' ? `//**/${glob}/**` : `//**/${glob}`
        })]
}

/**
 * OpenCode `edit` permission patterns, which cover its edit, write and patch tools. OpenCode matches a
 * path relative to the Git worktree, and its `*` crosses `/`, so each path is denied as written and
 * below any prefix: a cockpit root nested in a larger repository and siblings reached through `../`.
 */
export function openCodeGuardFileDenials(): readonly string[] {
    const patterns = [...GUARD_ROOT_PROTECTIONS, ...GIT_CONTROLS, ...GIT_LOCATORS].map(({ path, type }) => type === 'directory' ? `${path}/*` : path)
    return [...new Set(patterns.flatMap(pattern => [pattern, `*/${pattern}`]))]
}
