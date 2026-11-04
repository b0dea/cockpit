---
"@b00dea/cockpit": patch
---

`cockpit use <slug> <checkout>` serves a sibling from another checkout of its repository, such as a
linked worktree, for this cockpit checkout only; `use <slug> --clear` goes back to the declared one.
The stack's mounts, `logs`, the guard's allowed roots and protected instance files, `doctor` and
`preflight` all follow it, a checkout of a different repository is refused, and a worktree missing a
declared environment file is reported, never filled in. `cockpit pull` fetches and fast-forwards the
cockpit and every sibling to its upstream, skipping and reporting any checkout with modified files, a
diverged branch or a failed fetch; agents may run it. `up` now records each mounted sibling's
lockfiles and the new `rebuild_inputs` paths, and `doctor`, `preflight` and `pull` warn with
`STACK_INPUTS_CHANGED` when they change under a running stack.
