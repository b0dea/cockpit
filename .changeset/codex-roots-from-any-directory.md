---
"@b0dea/cockpit": patch
---

The Codex `writable_roots` that `sync` writes for repositories beside the cockpit no longer depend on the directory you run it from. Run from inside a sibling repository, `sync` used to write a root that pointed at the wrong place, and `check` then reported `.codex/config.toml` as drifted depending on where it ran.
