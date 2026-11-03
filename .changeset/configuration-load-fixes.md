---
"@b0dea/cockpit": patch
---

Every refusal to load `cockpit.toml` now carries a fix: a missing file names `--config` and `cockpit init`, an unreadable, oversized, non-UTF-8 or unparseable file says what to repair, and a schema mismatch points at the configuration reference. `[testing].native_hooks` may be left out and defaults to `{ install = "inspect" }`, as documented; a declared `native_hook_policy` still needs `native_hooks = { install = "explicit-native" }` beside it.
