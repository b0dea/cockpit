---
"@b00dea/cockpit": patch
---

An edit of `cockpit.toml` that widens what agents may do no longer holds every guarded call until a person syncs. The guard keeps judging calls under the configuration last synced, the copy it already authenticates in `.cockpit/local/guard-config`, so what was allowed before the edit is still allowed and the widened rule is not in force yet. While the edit waits, the guard refuses an agent's `cockpit sync` and `cockpit upgrade`, an edit that would change the pinned policy tables is still refused against the current text, and every refusal ends with a sentence naming the unapproved edit and the exact sync command a person runs. `check` reports the same as `GUARD_CONFIG_WIDENED`. Restoring the recorded configuration out of a widening edit is now admitted, as it is out of any other unsynced edit.
