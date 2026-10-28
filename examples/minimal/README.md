# Minimal cockpit

<!-- cockpit:verified version=0.0.0 -->

The smallest generated environment: one service built from `api/`, one port, one health probe.
[Install cockpit as an exact project-local dependency](../../docs/getting-started.md#install-cockpit),
then run this example in a `git init` copy. `check` lists undecided decisions; afterwards, measure
with a local image:

```sh executable
./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run --json
./node_modules/.bin/cockpit sync --config cockpit.toml --json
./node_modules/.bin/cockpit check --config cockpit.toml --json
```

```sh human-only:runtime
docker pull node:22-alpine
./node_modules/.bin/cockpit runtime measure --config cockpit.toml --image node:22-alpine --write
./node_modules/.bin/cockpit sync --config cockpit.toml && ./node_modules/.bin/cockpit up --config cockpit.toml
./node_modules/.bin/cockpit session --config cockpit.toml -- sh -c 'curl -fsS localhost:4100/health'
./node_modules/.bin/cockpit sleep --config cockpit.toml && ./node_modules/.bin/cockpit up --config cockpit.toml
DOCKER_CONTEXT="$(docker context show)" ./node_modules/.bin/cockpit down --config cockpit.toml
```
