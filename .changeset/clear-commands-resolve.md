---
"@b00dea/cockpit": patch
---

Stop `doctor` claiming that no tool can start an installed MCP command when its own `PATH` holds a relative entry. `MCP_COMMAND_UNRESOLVED` now names the entry and its class, says it was excluded from observation, says whether the absolute entries hold the command, and asks for the `PATH` to be fixed rather than the declaration re-approved.
