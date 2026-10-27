# Minimal cockpit

<!-- cockpit:verified version=0.0.0 -->

The smallest generated environment: one service built from `api/`, one port, one health probe.
Every field it omits takes a documented default, and nothing is invented to satisfy the schema.

```sh executable
cockpit sync --config cockpit.toml --dry-run --json
cockpit sync --config cockpit.toml --json
cockpit check --config cockpit.toml --json
```

`check` reports the decisions this stack has not recorded yet; the generated
`docs/cockpit/environment-decisions.md` lists them as undecided.
