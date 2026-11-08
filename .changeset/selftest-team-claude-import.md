---
"@b00dea/cockpit": patch
---

`selftest` now measures Claude Code instruction loading in every cockpit, whatever its `cockpit.name`, and when your own `CLAUDE.md` already imports `AGENTS.md`. The check that the generated `CLAUDE.md` imports `AGENTS.md` accepted only one cockpit name, and a team `CLAUDE.md` that cockpit leaves in place was not found at all, so the cell failed with a "run sync" remedy that changed nothing. The probe now loads the guide through your file as `sync` read it, notes beside the `@AGENTS.md` line included. A `CLAUDE.md` or `AGENTS.md` that imports further files with `@`, or an `AGENTS.md` holding an HTML comment of your own, is recorded `native_protocol_unsupported` with what to change to make the cell measurable.
