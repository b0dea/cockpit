// Spells the files the guard depends on as each agent tool's own write denials. The guard judges
// command text, so a program it does not understand (an inline script, a build tool) can rewrite the
// guard, its registrations or a repository's Git hooks; only the tool's own permission layer or
// sandbox refuses that. The protected set is the guard's own: every control it authenticates, plus
// each repository's `.git/hooks` and `.git/config`, which choose programs Git runs outside any agent
// tool. cockpit.toml is left out on purpose: agents edit it, and the guard judges whether an edit widens.
import { GUARD_ROOT_PROTECTIONS } from '../guards/evaluator.js'

// Git runs hooks from `.git/hooks` unless `core.hooksPath` in `.git/config` points elsewhere, so both
// are protected in the cockpit root and in every sibling repository.
const GIT_CONTROLS = Object.freeze([{ path: '.git/hooks', type: 'directory' as const }, { path: '.git/config', type: 'file' as const }])

/**
 * Claude Code `Edit(...)` rules, which cover every file tool. Claude Code 2.1.319 also refused shell
 * commands whose redirect or copy destination matched one, and its sandbox writes them into its
 * filesystem write denials. A `/` rule is anchored at the project root; siblings sit outside it, where
 * only a filesystem-root `//**` rule matches the same path in every clone.
 */
export function claudeGuardFileDenials(): readonly string[] {
    return [...GUARD_ROOT_PROTECTIONS.map(({ path, type }) => type === 'directory' ? `/${path}/**` : `/${path}`),
        ...GIT_CONTROLS.map(({ path, type }) => type === 'directory' ? `//**/${path}/**` : `//**/${path}`)]
}

/**
 * OpenCode `edit` permission patterns, which cover its edit, write and patch tools. OpenCode matches a
 * path relative to the Git worktree, and its `*` crosses `/`, so each path is denied as written and
 * below any prefix: a cockpit root nested in a larger repository and siblings reached through `../`.
 */
export function openCodeGuardFileDenials(): readonly string[] {
    const patterns = [...GUARD_ROOT_PROTECTIONS, ...GIT_CONTROLS].map(({ path, type }) => type === 'directory' ? `${path}/*` : path)
    return [...new Set(patterns.flatMap(pattern => [pattern, `*/${pattern}`]))]
}
