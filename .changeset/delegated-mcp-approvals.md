---
"@b00dea/cockpit": patch
---

Stop holding an agent's `[mcp.approved]` edit for a person while `mcp_approve = "agent"` in both the recorded and new configuration, which the edit pin already admits. A change of `mcp_approve` itself and removing a tool allowlist stay held.
