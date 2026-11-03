# Minimal cockpit

The smallest generated environment, for seeing a stack come up: one service built from `api/`,
one port, one health probe.

[Install cockpit as an exact project-local dependency](../../docs/getting-started.md#install-cockpit),
then run this example in a `git init` copy. `check` lists the decisions still open:

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

## Drive it with a browser

`cockpit.browser.toml` is the same stack with a generated browser runner: a pinned Playwright
container that the `browser` commands drive against the application's own URLs. Use it in a fresh
`git init` copy; the two configurations publish the same generated files. Besides the `[browser]`
table it needs the files in `browser/`: an MCP declaration for the `playwright` server and a
browser project that pins `@playwright/test` with an npm lockfile. Install that project on this
machine (the commands load its Playwright), create the artifact roots, then bring the stack up and
drive it:

```sh human-only:runtime
npm ci --prefix browser
mkdir -p .browser/runner .browser/mcp .browser/cli .browser/auth .browser/debugger
./node_modules/.bin/cockpit runtime measure --config cockpit.browser.toml --image node:22-alpine
./node_modules/.bin/cockpit up --config cockpit.browser.toml
./node_modules/.bin/cockpit browser drive --config cockpit.browser.toml --json
./node_modules/.bin/cockpit browser screenshot --config cockpit.browser.toml --json
./node_modules/.bin/cockpit down --config cockpit.browser.toml
```

`up` comes before `sync` here: the runner is published with its leased proxy port, so `sync`
refuses until the stack holds a lease. Each command reports one receipt per route, with the
`http://127.0.0.1:<leased port>/` URL you can open yourself. If the application is down, the
commands say that nothing answered at that URL. [Work and browser](../../docs/work-and-browser.md#declare-a-browser)
explains each requirement.
