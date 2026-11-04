---
"@b00dea/cockpit": patch
---

Add `cockpit stacks`, which lists every stack on this machine with its checkout, state, containers,
volumes, port lease and last activity, and `cockpit stacks prune`, which previews and, with `--apply`,
removes the stacks whose checkout is gone, such as a deleted worktree's, together with their
containers, networks, labelled volumes, port lease and state. A checkout is proven from Compose's
working-directory label or from the checkouts Git records for the cockpit, never from names; a stack
whose checkout exists is never touched. State this version cannot read is listed and kept, except
state folders in the spelling an earlier build used, which are pruned once none of their stacks is
kept. A prune that deletes volumes follows `[autonomy] reset`; otherwise a person approves it with
`--interactive`. `doctor` now warns with `STACKS_ORPHANED`, and its warning
about unreadable state folders names `stacks prune` instead of a manual `rm -rf`.
