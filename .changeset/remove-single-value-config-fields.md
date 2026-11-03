---
"@b00dea/cockpit": patch
---

Removed `cockpit.toml` fields that had no effect or could be written only one way. A configuration that still sets one is refused as an unknown key, so delete the line.

- `surfaces.harnesses[].features`. `capabilities` must still hold exactly one row for each surface feature.
- `sibling[].derives.mcp_sources[].format`. Each source is read as a JSON file with an `mcpServers` object, as before.
- `browser.authentication.states[].source`. Saved sign-in state should still come from seeded users, but cockpit cannot check where it came from.

`browser.data.isolated` and `browser.data.reaches_production` stay required. They are your statement about the data the browser uses, and `request_preapproval` is refused unless the data is isolated and does not reach production.
