---
"@b00dea/cockpit": patch
---

An agent can now apply its own `cockpit.toml` edit when the edit does not widen what agents may do.
After any edit the guard still holds every tool call, but it compares the edit with the configuration
the guards were generated from: when the edit only rewords a sibling's purpose, moves a port, adds a
derived route, an agent tool or an operator gate, or removes a Compose file, profile or resettable
volume, the guard admits `cockpit sync` and `cockpit check` from the agent (where `[autonomy] sync =
"agent"`) and reports `GUARD_CONFIG_UNSYNCED`. Any other edit keeps the person-only hold, whose
message now names each field that widens: any change to `[guards]`, `[work]`, `[autonomy]`, `[mcp]`,
`[testing]` or `[browser]`, a new sibling, a sibling's changed directory, guides or environment files,
a command field, and a field the classification has no rule for. `check` reports the same
classification, `GUARD_CONFIG_WIDENED` as an error and `GUARD_CONFIG_UNSYNCED` as a warning. Sync
keeps the configuration it generated the guards from in `.cockpit/local/guard-config`. An agent may
now run `cockpit tool add`; `tool remove`, `sibling add` and `sibling remove` stay a person's.
