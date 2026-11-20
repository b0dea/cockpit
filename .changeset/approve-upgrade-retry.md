---
'@b00dea/cockpit': patch
---

Approving an upgrade under Safe Chain works, and a failed approve can be retried.

- Under Safe Chain, `npx` runs inside Safe Chain's own process, and its proxy filters every package fetch with that process's settings. The age exemption approve set on the install never reached it, so a new release failed with "no matching version". When `safe-chain` is on the search path, the agent's output now names the exemption on the person's approve command: `SAFE_CHAIN_MINIMUM_PACKAGE_AGE_EXCLUSIONS=@b00dea/cockpit npx --no cockpit approve`. An install the filter refused says so and gives that line to rerun.
- A step that fails after the person says yes stays queued, so the next `approve` retries it, and `n` drops it. An upgrade whose install finished but whose sync or commit failed is not kept, since a rerun would find it current and redo nothing; its message says what to run. A step that fails before asking is dropped, and the summary names the command that queues it again.
- `upgrade` no longer says to start a branch when you are on a new branch that has no upstream yet. It does say so on a branch in `[guards] protected_branches`, which covers a local `main` when origin names no default branch.
