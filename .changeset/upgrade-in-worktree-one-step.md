---
"@b00dea/cockpit": patch
---

Upgrading cockpit in a linked worktree now takes one person step: approve's sync binds the worktree's guard, a later `sync --bind-worktree` answers `Nothing to bind`, and sync says when it bound the guard instead of only "Nothing to sync". When package.json pins a different cockpit than the one running, the message now says to run that checkout's own cockpit from its directory instead of installing the running version, and a refused bind names the approve waiting in the worktree. A worktree bound to its main checkout's cockpit that installs another release is now reported as needing a sync, even when the two releases' entry files match.
