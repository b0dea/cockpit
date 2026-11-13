---
"@b00dea/cockpit": patch
---

**Security:** 0.1.15 and earlier let an agent rewrite the guard through Git, for example `git checkout -b <new> <rev>` or `git pull --ff-only` onto a crafted commit. Upgrading closes these:

- Git checkouts, resets, restores, stashes, merges and new worktrees are judged against the files on disk, not HEAD.
- A Git write the guard can't fully resolve asks, as do Git plumbing that crafts objects or moves refs, `bisect`, submodule updates and every `git pull` in a cockpit holding the guard.
- The hook runs the guard script only when it matches the fingerprint sync records below `~/.cockpit/guards`. A guard changed by any route holds every call until a person runs sync, and `doctor` reports the mismatch.
- A background job that loops, writes files or runs a Git write asks; Claude Code's Monitor tool now reaches the guard.

**Agent workspaces:** agent tools use their own files with no guard configuration.

- Claude Code writes its auto memory and plans for this cockpit and its session scratchpad; Codex writes its memory notes. Agents read back this cockpit's Claude Code projects and the session's own files.
- What the tool writes itself is read-only to agents, a subagent's user-level memory asks, and reading anything else in a tool's home (settings, history, other projects and sessions) asks. Logins stay refused.
- Temp directories are not agent workspaces: other tools keep scratch files inside the checkout or under a write path a person adds.

**Sessions started below the root:**

- A Claude Code session started in a cockpit subdirectory is guarded: sync repeats the registration in the root's `.claude/settings.local.json` (and the repository top's, for a cockpit below it). `doctor` warns when it is missing or when any settings file sets `disableAllHooks`.
- The hook stops its search for the guard at the nearest `.git`, so a worktree kept inside the checkout runs its own guard.
- Agents can't write an agent tool's settings, hooks, MCP configuration, plugins or tools at any depth, by any writer, Git and archive extraction included. `git init`, `clone`, `submodule add` and `gh repo clone` inside the cockpit ask, and `doctor` reports nested repositories and unguarded worktrees.
- A skill, command or agent file asks when it registers hooks or MCP servers, runs shell (`` !` `` or a `` ```! `` block) or grants the shell in `allowed-tools`.

**After upgrading:** run sync; Codex asks a person to trust its hook again.
