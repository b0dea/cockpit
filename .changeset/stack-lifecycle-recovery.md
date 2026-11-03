---
"@b00dea/cockpit": patch
---

Running stacks recover from the states that used to wedge them.

- A `cockpit session` killed without its closing `sleep` no longer holds the stack forever: the session records its process ID and start time, and the next `up`, `sleep`, `down` or `reset` releases a hold whose process is gone. `CLAIM_CO_TENANT` names each remaining holder and its process.
- `cold_start_seconds` is honoured up to 3600 seconds instead of being cut to five minutes; a larger value is refused by the configuration.
- Editing the machine floor, postures, `resettable_volumes` or entrypoint derivatives no longer forces a `down`, and a second `up` after the first reports `unchanged` instead of a fresh start.
- A declaration change on a fully started compose-first stack makes `up` refuse with `LIFECYCLE_PROGRESS_INVALID` instead of recreating its healthy containers.
- Plain `reset` prints its preview, and the recovery messages for a killed service and an ended session say what to run.
