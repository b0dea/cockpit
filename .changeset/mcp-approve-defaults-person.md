---
"@b00dea/cockpit": patch
---

`[autonomy] mcp_approve` now defaults to `person`. Under `agent`, `sync` enabled every server a sibling's `derives.mcp_sources` file declared, and that file is one an agent can write, so an agent could have a harness start any command outside the guard. A declared server now stays disabled with `MCP_NOT_APPROVED` until a person records its digest in `[mcp.approved]`, and the guard refuses an agent's edit of `[mcp]` by default. Setting `mcp_approve = "agent"` remains possible; the configuration reference, the safety guide and the block `cockpit init` writes say it lets an agent start processes outside the guard.
