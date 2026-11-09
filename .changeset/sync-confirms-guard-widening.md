---
"@b00dea/cockpit": patch
---

`sync` now refuses to apply an edit of `cockpit.toml` that widens what agents may do (the change `check` reports as `GUARD_CONFIG_WIDENED`) until a person confirms it. Before, the guard refused an agent's sync only where it could prove the command started cockpit, so an agent could apply its own widening through a package script such as `npm run cockpit:sync`, a package manager's `exec`, or `node` with flags, even under `[autonomy] sync = "person"`. Sync without `--interactive` now writes nothing and reports `GUARD_CONFIG_WIDENED` with the widened fields; a person runs `cockpit sync --config cockpit.toml --interactive` in a terminal, reads the change and types the digest it shows, the same confirmation as a policy weakening. A first sync, and a sync of an edit that does not widen, need no confirmation.
