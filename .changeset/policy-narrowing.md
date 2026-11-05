---
'@b00dea/cockpit': patch
---

Let agents apply proven reductions in authority without a person: revoking an unchanged MCP approval, removing a command grant, adding a denial, and adding or narrowing a tool restriction. New or changed approvals, expanded command access, gate authority and removing a restriction stay with a person. While `mcp_approve = "agent"`, an agent's `[mcp.approved]` edit is no longer held, and removing a tool restriction still is.

An MCP restriction now applies under `stale_delete = "person"` or `"ci"`: `sync` removes an unchanged MCP-only file of a listed tool without that approval, while a hand-edited file stays a conflict. An agent can undo an edit `sync` refused: the `GUARD_CONFIG_UNSYNCED` hold admits one edit that restores the recorded configuration byte for byte, however the edited file fails to load. An edit that widens stays held for a person. Hold messages now name what a hold stops, which is shell commands, file edits and writes, and restricted MCP tools under Claude Code.
