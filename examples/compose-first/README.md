# Compose-first cockpit

For a product that already has a Compose file: this cockpit keeps its own `compose.yml` for two
tiny Node siblings instead of an `environment.generated` stack. `sync` publishes the agent
surfaces; `check` drift-checks them and validates `compose.yml` through `docker compose config`,
failing a host port not taken from `[ports.bases]` and warning on a missing healthcheck.
[Install cockpit as an exact project-local dependency](../../docs/getting-started.md#install-cockpit)
before running the example.

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
./node_modules/.bin/cockpit session --config cockpit.toml -- sh -c 'curl -fsS "http://127.0.0.1:$API_HOST_PORT/health"'
./node_modules/.bin/cockpit down --config cockpit.toml
```
