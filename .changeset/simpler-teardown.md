---
"@b00dea/cockpit": patch
---

`sleep`, `down` and `reset` finish what an interrupted run left when you run them again.

**Changed:** each takes a lock on the stack, stops it, reads what Docker reports now, removes this stack's resources by id, and reads Docker again to confirm they are gone. If one is interrupted, run the same command again: it removes only what is still there. A lock left by a killed command is taken over by the next one. While one runs, another refuses with `STATE_LOCKED` and `up` refuses to lease the stack's ports. An approved `reset` refuses with `RESET_CONFIRMATION_MISMATCH` when the stack changed after its preview; run it again to approve the current targets.

**Removed:** the detached supervisor that tracked a removal in progress, and the refusal that asked for an interrupted attempt to be repaired by hand. A removal still running when cockpit was killed is no longer stopped by the next run. `stacks --json` no longer reports `state.draining`.
