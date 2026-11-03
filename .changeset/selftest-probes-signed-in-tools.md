---
"@b00dea/cockpit": patch
---

`cockpit selftest` probes now reach a signed-in tool's sign-in.

- Each probe inherits `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE` and `TZ` and nothing else. Before, it ran with an empty environment, so Claude Code, Codex and OpenCode answered "not logged in" and every cell came back `human_needed` with `authentication_required`.
- Tokens and every other variable still stay out of the probe, so a tool signed in only through an environment variable still reports `authentication_required`.
