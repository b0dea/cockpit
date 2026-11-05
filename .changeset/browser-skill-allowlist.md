---
"@b00dea/cockpit": patch
---

Stop the browser skill naming `browser_navigate` when `[mcp.allowed_tools]` does not list it. The skill now names the tools the allowlist permits, or says the MCP transport cannot be used under an empty list.
