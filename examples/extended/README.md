# Extended cockpit

For a team that keeps its own tooling beside cockpit: a custom `compose.yml` service, a `Makefile`
and `scripts/verify.mjs` stay team-owned, while cockpit publishes the shared agent surfaces, an
overlay skill and a pre-write hook. The guard allows the exact local verification target and denies
commands aimed at a shared environment, and repeated `sync` leaves the team's files alone.
[Install cockpit as an exact project-local dependency](../../docs/getting-started.md#install-cockpit)
before running the example.

<!-- cockpit:verified version=0.0.0 -->

```sh executable
./node_modules/.bin/cockpit sync --config cockpit.toml --json
make verify
./node_modules/.bin/cockpit sync --config cockpit.toml --json
```
