# Compose-first cockpit

<!-- cockpit:verified version=0.0.0 -->

A cockpit that keeps its own `compose.yml` for two tiny node siblings, with no `environment.generated`.
`sync` publishes the agent surfaces, and `check` drift-checks them and reads `compose.yml` through
`docker compose config`: a host port not taken from `[ports.bases]` fails, a missing healthcheck warns.

```sh executable
cockpit sync --config cockpit.toml --json
cockpit check --config cockpit.toml --json
```
