# Extended cockpit

<!-- cockpit:verified version=0.0.0 -->

This example keeps a custom `compose.yml` service and product-specific verification beside cockpit:
`Makefile` and `scripts/verify.mjs` remain consumer-owned, while cockpit publishes the shared agent
surfaces, an overlay skill and a pre-write hook.
The guard declaration permits the exact local verification target and denies commands aimed at a
shared environment. Repeated `sync` preserves every build-beside file. [Install cockpit as an exact
project-local dependency](../../docs/getting-started.md#install-cockpit) before running the example.

```sh executable
./node_modules/.bin/cockpit sync --config cockpit.toml --json
make verify
./node_modules/.bin/cockpit sync --config cockpit.toml --json
```
