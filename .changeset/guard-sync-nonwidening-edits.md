---
"@b00dea/cockpit": patch
---

An agent can now apply its own `cockpit.toml` edit when the edit does not widen what agents may do.
After any edit the guard still holds every tool call, but it compares the edit with the configuration
the guards were generated from: when the edit only rewords a purpose or guides, adds a sibling inside
the siblings root, a derived route, a test stage or gate, a deny rule or an agent tool, moves a port,
or narrows a rule or decision, the guard admits `cockpit sync` and `cockpit check` from the agent
(where `[autonomy] sync = "agent"`) and reports `GUARD_CONFIG_UNSYNCED`. Any other edit, including
one to a field the classification has no rule for, keeps the person-only hold, whose message now
names each field that widens. `check` reports the same classification, `GUARD_CONFIG_WIDENED` as an
error and `GUARD_CONFIG_UNSYNCED` as a warning. Sync keeps the configuration it generated the guards
from in `.cockpit/local/guard-config`.
