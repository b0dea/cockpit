---
"@b00dea/cockpit": patch
---

An edit of `cockpit.toml` that does not widen what agents may do no longer holds every guarded call except `cockpit sync` and `cockpit check` until it is synced. Such an edit grants nothing the last sync did not, so the guard now judges calls under it straight away, and a restriction it adds, such as a new `[[guards.deny]]` rule, is in force at once. The policy pin still applies, and restoring the exact configuration last synced is still admitted. `check` still reports the edit as `GUARD_CONFIG_UNSYNCED` until you run `sync`, which regenerates the files the edit changes. An edit the guard cannot build a policy from still holds every guarded call.
