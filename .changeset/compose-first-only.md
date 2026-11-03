---
"@b00dea/cockpit": patch
---

cockpit runs your own Compose files and no longer generates one.

- `[environment.generated]` and `sibling[].derives.generated` are gone, and with them the generated services, dependency volumes and installs, vendor stubs and their TLS probes, the `empty`, `seeded` and `restored` data modes, restore rewrites, persona outputs and `docs/cockpit/environment-decisions.md`. So are the rendered browser runner and its fields: `browser.resources`, `browser.runner_health_measurement` and `browser.images.runner.architectures` are unknown keys. A `cockpit.toml` that still sets one is refused; declare `environment.compose_files` and keep the stack in plain Compose. The new Compose patterns guide shows a vendor stub, a TLS front end and a data restore.
- `environment.seed = { argv = [...], timeout_seconds = N }`, beside `environment.resettable_volumes`, is the command `up` runs once the stack is healthy, and again whenever one of those volumes is newer than the last successful seed, such as after `reset`. A seed that fails refuses with `DATA_SEED_FAILED`, leaves the stack up, and runs again on the next `up`. Editing it leaves a running stack alone.
- `npx --no cockpit init <cockpit root> --scaffold-compose <app dir> --port <port>` writes a starting `compose.yml` for a small app once, with an optional `--with postgres,redis`, and never replaces an existing Compose file.
- A compose-first `up` now refuses with `MACHINE_MEMORY_BELOW_FLOOR`, `MACHINE_CPU_BELOW_FLOOR` or `MACHINE_DISK_BELOW_FLOOR` before starting anything on a machine below the declared `[environment.machine]` floor. Only a generated stack used to be held to it.
- `examples/synthetic` is gone; the tutorial walks through `examples/compose-first`, and `examples/minimal` runs its own `compose.yml`.
