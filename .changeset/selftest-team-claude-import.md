---
"@b00dea/cockpit": patch
---

`selftest` now measures Claude Code instruction loading when your own `CLAUDE.md` is exactly `@AGENTS.md`. cockpit leaves such a file in place, and the probe used to fail that cell with a "run sync" remedy that changed nothing. The probe now loads the guide through your file as `sync` read it. A `CLAUDE.md` holding anything beside its `@AGENTS.md` import is recorded as `native_protocol_unsupported` with the reason; to have it measured, move the other content out so the file is exactly the import, then run `sync`. In a cockpit that keeps its own `CLAUDE.md` this way, the probe-specification file goes stale once after the upgrade; write a fresh one as `selftest` asks.
