---
"@b0dea/cockpit": patch
---

Removed `cockpit.toml` fields that had no effect or could be written only one way. A configuration that still sets one is refused as an unknown key, so delete the line.

- `environment.generated.volumes[].target`. A dependency volume's target is the target of the service mounts that use it, and those mounts must still share one target.
- `environment.generated.vendors[].stub.validates`. The stub's `rejection_probe` and `outage_probe` are what get checked.
- `surfaces.harnesses[].features`. `capabilities` must still hold exactly one row for each surface feature.
- `environment.generated.decisions.path`. The decision log is always written to `docs/cockpit/environment-decisions.md`.
- `reviewer` on `environment.generated.decisions.entries[]` and `sibling[].derives.generated.decisions[]`. The decision log no longer prints a `Reviewer` line.
- `sibling[].derives.mcp_sources[].format`. Each source is read as a JSON file with an `mcpServers` object, as before.
- `sibling[].derives.generated.checkout_mount.source_type`. The checkout is always mounted as a directory.
- `browser.authentication.states[].source`. Saved sign-in state should still come from seeded users, but cockpit cannot check where it came from.

`browser.data.isolated` and `browser.data.reaches_production` stay required. They are your statement about the data the browser uses, and `request_preapproval` is refused unless the data is isolated and does not reach production.
