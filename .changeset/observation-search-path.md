---
'@b00dea/cockpit': patch
---

Run read-only observations through bounded absolute `PATH` entries. Empty, dot and parent-relative entries are excluded for `sync`, `check`, `doctor`, `preflight` and `docs check`, so a poisoned working directory never runs and a package manager's relative entry no longer stops them. Guards, sessions, evaluators and MCP startup keep their exact `PATH` authority, a noncanonical absolute entry still refuses and nothing is normalized. `MCP_COMMAND_UNRESOLVED` names the excluded entry and asks for `PATH` to be fixed rather than the declaration re-approved. Git child processes in these observations no longer run a configured fsmonitor.
