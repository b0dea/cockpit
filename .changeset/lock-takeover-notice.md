---
"@b00dea/cockpit": patch
---

Every command now says when it took over a state lock left by a killed command. Only `up`, `sleep`, `session`, `down` and `reset` reported `STATE_LOCK_RECLAIMED` before; `init`, `stacks prune`, the claims and ports commands, `test-run`, and the work and browser commands took the lock over silently. They now name the old holder's process and command and point to `doctor`, as the lifecycle commands do.
