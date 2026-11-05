---
'@b00dea/cockpit': patch
---

Add `[mcp.allowed_tools]`, exact allowlists per MCP server. Codex receives `enabled_tools`; Claude Code receives an authenticated guard scoped to the restricted server namespaces, which denies unlisted tools and leaves listed tools to Claude Code's own permission prompts. Harnesses with no restriction mechanism omit a restricted server and report `MCP_TRANSPORT_UNAVAILABLE`.

MCP tool input is bounded at 1 MiB, separately from the smaller shell and edit limit. Browser rebinding keeps restrictions, and the browser skill names only allowed tools. A restricted server whose native namespace overlaps another server's is refused.

A dotted name works under Claude Code, which calls `read.record` by the name `read_record`. It cannot tell those two apart, so a listed `read_record` also admits a server tool named `read.record`; Codex matches the raw name. Tool restrictions do not filter MCP resources or prompts and do not make an unsafe allowed dispatcher safe. A name, a token scope or `readOnlyHint` is not an enforcement boundary.
