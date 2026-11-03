---
"@b00dea/cockpit": patch
---

The published `cockpit.schema.json` now holds `[mcp.approved]` server names, `[ports.bases]` names and generated `port_defaults` names to the same key patterns the loader enforces, so an editor flags a key `check` would refuse.
