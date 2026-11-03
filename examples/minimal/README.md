# Minimal cockpit

The smallest stack, for seeing one come up: one service built from `api/` by the cockpit's own
`compose.yml`, one leased port, one healthcheck. A small app with no Compose file gets a starting
one like this from `npx --no cockpit init <cockpit root> --scaffold-compose <app dir> --port <port>`.

[Install cockpit as an exact project-local dependency](../../docs/getting-started.md#install-cockpit),
then run this example in a `git init` copy. `check` validates `compose.yml` through
`docker compose config`:

```sh executable
./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run --json
./node_modules/.bin/cockpit sync --config cockpit.toml --json
./node_modules/.bin/cockpit check --config cockpit.toml --json
```

Commit the copy before running `preflight`, which otherwise exits 2 with `GIT_STATE_UNHEALTHY`:
`git add -A && git commit -m 'Minimal cockpit'`.

With Docker running, measure the runtime with a local image, then bring the stack up, hold it for
one command, put it to sleep and resume it, and remove it:

```sh human-only:runtime
docker pull node:22-alpine
./node_modules/.bin/cockpit runtime measure --config cockpit.toml --image node:22-alpine
./node_modules/.bin/cockpit up --config cockpit.toml
./node_modules/.bin/cockpit session --config cockpit.toml -- sh -c 'curl -fsS "http://127.0.0.1:$API_HOST_PORT/health"'
./node_modules/.bin/cockpit sleep --config cockpit.toml && ./node_modules/.bin/cockpit up --config cockpit.toml
./node_modules/.bin/cockpit down --config cockpit.toml
```
