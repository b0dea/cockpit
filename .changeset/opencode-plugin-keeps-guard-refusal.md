---
"@b00dea/cockpit": patch
---

The generated OpenCode plugin keeps the guard's refusal and its reason when the guard exits before reading the whole tool call, such as when the guard script is missing. Before, the closed pipe surfaced as `cockpit restriction guard failed: spawnSync /bin/bash EPIPE` instead of the recovery message; the call was refused either way. A guard that exits 0 without reading the whole call still refuses it. Run `sync` to regenerate the plugin.
