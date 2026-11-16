---
"@b00dea/cockpit": patch
---

`sleep`, `down` and `reset` finish what an interrupted run left when you run them again.

**Changed:** each takes a lock on the stack, stops it, reads what Docker reports now, removes this stack's resources by id, and reads Docker again to confirm they are gone. If one is interrupted, run the same command again: it removes only what is still there. A lock left by a killed command is taken over by the next one. While one runs, another refuses with `STATE_LOCKED` and `up` refuses to lease the stack's ports. A state lock left by a command killed while taking or releasing it is now taken over by the next command, as one left by a killed holder already was, and a lock no longer stays quarantined until a person removes it. A stack's lifecycle progress, whether it has come up, and when its seed last succeeded now live in one record; `setup` no longer writes lifecycle state. A stack started by an earlier cockpit reads as not yet up, so `preflight` treats it as before its first bring-up until the next `up`, which runs the seed once more. An approved `reset` refuses with `RESET_CONFIRMATION_MISMATCH` when the stack changed after its preview; run it again to approve the current targets.

**Removed:** the detached supervisor that tracked a removal in progress, and the refusal that asked for an interrupted attempt to be repaired by hand. A removal still running when cockpit was killed is no longer stopped by the next run. `stacks --json` no longer reports `state.draining`.
