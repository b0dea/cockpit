# Minimal cockpit

<!-- cockpit:verified version=0.0.0 -->

The smallest generated environment: one service built from `api/`, one port, one health probe.
Run in a `git init` copy; `check` lists undecided decisions, then measure with a local image:

```sh executable
cockpit sync --config cockpit.toml --dry-run --json
cockpit sync --config cockpit.toml --json
cockpit check --config cockpit.toml --json
```

```sh human-only:runtime
cockpit runtime measure --config cockpit.toml --image node:22.23.4-alpine --write
cockpit sync --config cockpit.toml && cockpit up --config cockpit.toml
cockpit session --config cockpit.toml -- sh -c 'curl -fsS localhost:4100/health'
cockpit sleep --config cockpit.toml && cockpit up --config cockpit.toml
DOCKER_CONTEXT="$(docker context show)" cockpit down --config cockpit.toml
```
