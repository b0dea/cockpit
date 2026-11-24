---
'@b00dea/cockpit': patch
---

An agent can now bind the guard of a new linked worktree itself, instead of asking a person to install and sync there. A worktree kept beside its main checkout, not only one inside it, is judged by that main checkout until it is bound, so the agent's `cd` and `pwd` work there too. The refusal there prints one command, `cockpit sync --bind-worktree`, run from the worktree root through the main checkout's own Node and cockpit by absolute path; the guard admits nothing else, an install included. The new `--bind-worktree` flag writes no tracked file. It binds the worktree's guard to that same cockpit only when the worktree's configuration, adopted settings copies and every other tracked input and generated file hold the main checkout's bytes, and each sibling resolves to the same directory or to the same place inside each checkout; otherwise it refuses with `GUARD_WORKTREE_BIND_REFUSED` and a person syncs the worktree. After the bind, install the worktree's dependencies as usual, under its own guard.

The same bind repairs a linked worktree whose guard went stale, as after rebasing onto a main checkout that upgraded cockpit or an install that replaced the cockpit it ran: the worktree's guard names the bind and admits it, instead of holding every call until a person syncs. A worktree whose recorded Node or cockpit handler is gone is judged by its main checkout, so the bind can run there too. The main checkout's own upgrade, and any other hold, stays a person's sync.

Recoveries that hand a person several commands now print them as one line joined with `&&`, starting with `cd` to the cockpit root where one is needed, so a terminal's paste guard no longer flags them.
