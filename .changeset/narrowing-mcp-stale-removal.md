---
"@b00dea/cockpit": patch
---

Apply an MCP tool restriction under `stale_delete = "person"` or `"ci"`. Restricting a server stales `.cursor/mcp.json`, and the refused removal left every other tool unrestricted too. `sync` now removes an unchanged MCP-only file of a tool still listed without that approval, and `check` says so. A hand-edited file stays a conflict, and any other stale path still needs the approval.
