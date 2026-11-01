# Compose-first cockpit

A cockpit that keeps its own `compose.yml` for two tiny node siblings, with no `environment.generated`.
`sync` publishes the agent surfaces, and `check` drift-checks them and reads `compose.yml` through
`docker compose config`: a host port not taken from `[ports.bases]` fails, a missing healthcheck warns.
[Install cockpit as an exact project-local dependency](../../docs/getting-started.md#install-cockpit)
before running the example.

<!-- cockpit:verified version=0.0.0 -->

```sh executable
./node_modules/.bin/cockpit sync --config cockpit.toml --json
./node_modules/.bin/cockpit check --config cockpit.toml --json
```

`sync` also publishes `compose.cockpit.yml`, which labels the services so runtime commands own them.
Measure the runtime with a local image, then run the stack:

```sh human-only:runtime
docker pull node:22-alpine
./node_modules/.bin/cockpit runtime measure --config cockpit.toml --image node:22-alpine
./node_modules/.bin/cockpit up --config cockpit.toml
./node_modules/.bin/cockpit session --config cockpit.toml -- sh -c 'curl -fsS localhost:4200/health'
./node_modules/.bin/cockpit down --config cockpit.toml
```
