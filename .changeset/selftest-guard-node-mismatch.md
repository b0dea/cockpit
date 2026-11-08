---
"@b00dea/cockpit": patch
---

`selftest` no longer asks you to approve a run whose Claude Code guard probe cannot run. `sync` records the Node it ran under and the guard hook keeps running that Node, so when `selftest` ran under a different `node` (a Node version manager in another shell, say), the probe was refused only after every approval, as an unnamed changed input. `selftest` now compares the installed guard identity first and refuses with `SELFTEST_GUARD_IDENTITY_MISMATCH`, naming both Nodes and the two ways forward: run selftest with the recorded Node, or run `sync` under the current one and then selftest. When the Node at the recorded path was upgraded in place, it says so and gives the one remedy that works: run `sync`.

When a reviewed input does change during a run, the message now names it and its path: the approved executable, a probe control, the guard identity, the configuration recorded for the guard, `cockpit.toml`, the Node or cockpit module the guard runs, or the generated Bash guard, or says the step's dispatch window closed.
