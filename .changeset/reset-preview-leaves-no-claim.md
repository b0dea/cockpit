---
"@b00dea/cockpit": patch
---

A `reset` preview, or a declined `reset --interactive`, of a stack that is down no longer leaves a claim and port lease behind. The kept claim made every later `up` refuse with `EXECUTION_PRECONDITION_CHANGED` and a "rerun up" fix that repeated the refusal. `down` and `reset` now give back the claim they take on a stopped stack whenever they stop before removing anything, and an `up` refused before it starts a service now restores the port reservation it found instead of keeping its family reserved. If an earlier version already left such a claim, `up` now says to run `down` and then `up`, which clears it.
