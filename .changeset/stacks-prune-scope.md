---
"@b00dea/cockpit": patch
---

`stacks prune --apply` now removes only the running cockpit's orphaned stacks, plus the state folders an earlier build left. Before, it covered every cockpit on the machine while checking only the running cockpit's `[autonomy] reset`, so an agent could delete the volumes of a cockpit that requires a person. Another cockpit's orphans are still listed in the preview, marked `thisCockpit: false` with a `STACKS_PRUNE_UNCONFIRMED` warning, and a person removes them with `stacks prune --interactive`.

A worktree whose path is missing while Git still registers it, or marks it locked, is no longer taken for gone: its checkout is `unknown` and its stack is kept, since an unmounted drive or share, or a checkout moved without `git worktree repair`, looks the same. Run `git worktree prune` (after `git worktree unlock` for a locked worktree) once the checkout is really gone, and the next prune removes its stack.
