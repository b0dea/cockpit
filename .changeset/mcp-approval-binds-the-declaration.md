---
"@b00dea/cockpit": patch
---

An MCP approval now binds the reviewed declaration, not only the server name, and the generated wrapper starts in the right directory under any shell setup.

- `[mcp.approved]` maps each server name to the sha256 of its command, arguments, working directory and environment names. A sibling's declaration file is agent-writable, so approving the name alone let a rewritten command start after the next human `sync`. A server whose declaration changed is now generated disabled, and `MCP_NOT_APPROVED` reports the digest to approve once it has been reviewed.
- The MCP wrapper no longer honours `CDPATH`, which could start the server in another directory and print that path into the JSON-RPC stream, and it resolves a sibling outside the cockpit from the real cockpit directory when the agent was started through a symbolic link.

Upgrade: delete `approved = [...]` under `[mcp]`, run `cockpit sync`, review each server it reports as `MCP_NOT_APPROVED`, then add `name = "<sha256>"` under `[mcp.approved]` for each one to enable and run `cockpit sync` again.
