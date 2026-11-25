---
"@b00dea/cockpit": patch
---

A session that starts in the main checkout and works in a linked worktree beside it is no longer refused there as working outside the cockpit. Each call made in the worktree is judged by the worktree's own guard, as if the session had started there; a worktree nobody has synced still admits only `cd`, `pwd` and the command that binds its guard. A checkout of another repository stays refused.

A Write, Edit or NotebookEdit larger than 64 KiB is no longer refused for its size. The guard judges such a call by its path, up to the 1 MiB it reads, and asks before a skill, command or agent file it could not read. Shell commands keep their 64 KiB limit.
