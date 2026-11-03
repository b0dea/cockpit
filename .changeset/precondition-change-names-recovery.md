---
"@b00dea/cockpit": patch
---

`EXECUTION_PRECONDITION_CHANGED` from `up` and `session` now carries a fix. When `cockpit.toml` or the running stack changes while `up` runs, the refusal says to run `down` and then `up` again.
