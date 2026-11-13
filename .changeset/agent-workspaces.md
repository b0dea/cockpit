---
"@b00dea/cockpit": patch
---

The guard no longer blocks an agent tool's own files, with no configuration:

- Claude Code, Codex and OpenCode read and write their own data (Claude Code's auto memory, plans, transcripts and spilled tool output, Codex's memory notes and sessions, OpenCode's tool output), the session's scratchpad and private temp files, file by file. Each location comes from the hook payload and the tool's environment.
- The tools' settings, instructions, hooks, skills, plugins and anything they load into later sessions stay refused to writes, their logins to reads and writes, and an entry the guard does not know asks. Claude Code memory and transcripts are written only for this cockpit's own checkouts, and a subagent writes only its own memory.
- Links, extractions, executable modes, `.env*` names and guard paths stay refused there as anywhere outside the roots.
- Documented: Claude Code started in a subdirectory of the cockpit does not load its hook, so the guard does not run for that session.
