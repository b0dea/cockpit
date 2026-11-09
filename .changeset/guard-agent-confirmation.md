---
"@b00dea/cockpit": patch
---

`cockpit sync --interactive` refuses to take a confirmation inside an agent tool's session, where Claude Code sets `CLAUDECODE`, Codex `CODEX_THREAD_ID` and OpenCode `OPENCODE`: a pseudo-terminal an agent opens passes the terminal check, so a widening or weakening is confirmed only in a person's own terminal. The guard asks before a command removes one of those variables (`unset`, `env -u`, an empty prefix assignment) or the whole environment (`env -i`).
