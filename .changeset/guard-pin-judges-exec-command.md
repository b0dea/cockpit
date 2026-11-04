---
"@b00dea/cockpit": patch
---

The guard's pin on `[work]`, `[work.gates]` and `[autonomy]` now judges the command after `cockpit exec --service <s> --` as a command of its own, as it already did for `cockpit session`. Before, a container command that named `cockpit.toml` after its own `--config` was taken for cockpit's `--config` operand and let through. Because the command runs in the container, no read-only spelling excuses it from the pin either.
