---
"@b00dea/cockpit": patch
---

The guard lets agents read declared templates and search code, and protects the MCP wrapper scripts.

- A sibling's declared environment `template` (such as `.env.example`) is readable. Undeclared `.env*` files still need approval, and declared instances are still denied.
- A recursive search (`rg`, `grep -r`, OpenCode's grep) over a sibling or the cockpit root is allowed when no declared instance or `env/.secrets` exists below it. When one does, the reason names it so the agent can search a narrower path; Codex and OpenCode used to deny every such search with a generic reason.
- Writing, removing or replacing a generated MCP wrapper script under `.cockpit/mcp/` is a hard denial, like the other guard controls.
