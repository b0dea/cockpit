# Compose-first cockpit

<!-- cockpit:verified version=0.0.0 -->

A cockpit that keeps its own `compose.yml` for two tiny node siblings, with no `environment.generated`.
`sync` publishes the agent surfaces, and `check` drift-checks them and reads `compose.yml` through
`docker compose config`: a host port not taken from `[ports.bases]` fails, a missing healthcheck warns.

```sh executable
cockpit sync --config cockpit.toml --json
cockpit check --config cockpit.toml --json
```

`sync` also publishes `compose.cockpit.yml`, which labels the services so runtime commands own them.
Measure the runtime with a local image, then run the stack:

```sh human-only:runtime
cockpit runtime measure --config cockpit.toml --image node:22.23.4-alpine --write
cockpit sync --config cockpit.toml && cockpit up --config cockpit.toml
cockpit session --config cockpit.toml -- sh -c 'curl -fsS localhost:4200/health'
DOCKER_CONTEXT="$(docker context show)" cockpit down --config cockpit.toml
```
