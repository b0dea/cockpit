---
'@b00dea/cockpit': patch
---

Allow a dotted MCP tool under Claude Code: `allowed_tools = ["read.record"]` now matches the `read_record` name Claude Code uses, where the guard denied every call before. The harness surfaces guide records that Claude Code cannot tell those two names apart, while Codex can.
