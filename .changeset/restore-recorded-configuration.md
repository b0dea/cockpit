---
"@b00dea/cockpit": patch
---

Let an agent undo an edit the guard admitted and `sync` then refused, such as a tool restriction naming an undeclared server. The `GUARD_CONFIG_UNSYNCED` hold now admits one edit of `cockpit.toml` that leaves it byte-identical to the configuration the guards were generated from, and says so. Anything else stays held for `sync`, and an edit that widens stays held for a person.
