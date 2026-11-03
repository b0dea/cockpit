---
"@b00dea/cockpit": patch
---

`SURFACE_STATE_CONFLICT` on a hand-edited generated file (a skill, `.claude/settings.json`, the text between cockpit's markers in `AGENTS.md`, or the OpenCode root group) carries its own fix: move the edit into `cockpit.toml` or a surface overlay, and ask the person who owns the cockpit before discarding it. A file cockpit has no record of writing gets a fix that asks the person before it is moved or deleted, and a team's own harness settings file names the `sync --adopt` command in the fix rather than in the message.
