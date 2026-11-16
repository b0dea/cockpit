---
"@b00dea/cockpit": patch
---

`test-run` now saves each stage's output under `.cockpit/local/` and, when a stage fails, prints the file's path and the last 40 lines (also in `--json`), so a failure no longer needs the test command run again by hand. Stages with `requires_stack = false` now get the leased port variables when this checkout holds a stack, so their tests no longer fall back to base ports that may belong to another checkout's stack.
