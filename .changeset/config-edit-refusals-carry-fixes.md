---
"@b00dea/cockpit": patch
---

Refusals from `sibling add`, `sibling remove` and `sync --adopt` when they cannot edit `cockpit.toml` safely now carry a fix: wait for another edit to finish and run the same command again, correct the option the message names, or make the change by hand and preview it with `sync --dry-run`. The printed `--config` path in a `sibling` fix is the one the command was given, and the JSON invocation record names it.
