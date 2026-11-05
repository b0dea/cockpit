---
'@b00dea/cockpit': patch
---

Bind surfaces-only `sync`, `check` and `doctor` to one checkout identity in linked worktrees and nested configuration directories, and keep publication working where only setup needs to be strict. A plain `git status` no longer refuses `sync` or `check`, and a repository-local include is accepted. A `.git` entry Git rejects, or Git missing from `PATH`, publishes as standalone with a `GENERATED_CHECKOUT_STANDALONE` warning that says the guard needs a readable repository and holds guarded calls until it has one. A checkout observation interrupted by Git activity retries, then says so, instead of reporting unsupported configuration origins or an invalid worktree inventory.
