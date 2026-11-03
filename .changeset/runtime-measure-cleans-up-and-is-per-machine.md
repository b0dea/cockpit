---
"@b00dea/cockpit": patch
---

`runtime measure` now cleans up after itself and is recorded once per machine.

- A measure killed mid-probe left probe containers, a network, a volume and a temporary directory behind. The next `runtime measure` removes this cockpit's own leftovers (matched by label, Compose project and a dead owner), lists what it removed, leaves anything a live measure may own, and refuses to probe when a leftover cannot be removed.
- Measurements are stored under the per-user state root instead of beside `cockpit.toml`, so every git worktree of a cockpit reuses them. A different runtime, daemon or engine version still matches no row and still needs its own measurement. Existing `.cockpit/local/runtime-measurements.json` records are not read; measure once more.
