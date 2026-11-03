# Configuration essentials

This page is for people writing or reviewing their first `cockpit.toml`. It covers the tables a
typical cockpit sets, the ones `init` asks about and the bundled examples declare, each with a
minimal snippet and a link to its full entry in the generated
[configuration reference](configuration-reference.md). Everything else is optional and listed by
area at the end.

## `[cockpit]`

The cockpit's name and where the product's repositories live. The name scopes the cockpit's
Compose projects, state and generated files, so renaming it later means bringing the stack down
and syncing again. `siblings_root` is relative to the cockpit directory and defaults to `..`.
Full entry: [`[cockpit]`](configuration-reference.md#cockpit).

```toml
[cockpit]
name = "shop"
siblings_root = ".."
```

## `[[sibling]]`

One table per product repository. `mount` says how the stack uses the checkout: `always`
bind-mounts it, `profile:<name>` mounts it only under that Compose profile, `none` leaves it read
but never mounted, and `host` runs it outside the stack for the reason given in `host_reason`.
`acquire` says how it reaches disk: `auto` clones `remote` during `setup`, `manual` expects a
person to clone it, and `none` never clones it, so it must already be there. The two are
[independent](architecture.md#two-axes-mount-and-acquire). `var` carries the checkout's path and
`toolchain` picks the install policy. `cockpit sibling add` writes these tables for you. Full
entries: [`[[sibling]]`](configuration-reference.md#sibling) and
[`[[sibling.environment_files]]`](configuration-reference.md#siblingenvironment_files).

```toml
[[sibling]]
slug = "api"
dir = "api"
mount = "always"
acquire = "auto"
remote = "git@example.com:team/api.git"
var = "API_DIR"
toolchain = "node"
purpose = "HTTP API for orders"

[[sibling.environment_files]]
template = ".env.example"   # tracked in the sibling
instance = ".env"           # created from it by setup
```

## `[ports]`

The base host port of every published port, by variable name. Each parallel stack publishes the
bases plus a multiple of `step`, as
[Local URLs and port families](environment.md#local-urls-and-port-families) explains. An empty
`[ports.bases]` table records that nothing is published. Full entry:
[`[ports]`](configuration-reference.md#ports).

```toml
[ports.bases]
API_HOST_PORT = 4100
```

## `[environment]`: posture and machine floor

How the product is reached and signed in to locally, and the least the container runtime must
offer. `preflight` refuses a runtime until the posture is declared, and runtime commands refuse to
start on a machine below the floor;
[Declare environment postures](environment.md#declare-environment-postures) covers the tags. Full
entries: [`[environment]`](configuration-reference.md#environment),
[`[[environment.posture_requirements]]`](configuration-reference.md#environmentposture_requirements)
and [`[environment.machine]`](configuration-reference.md#environmentmachine).

```toml
[environment]
addressing = "port"
authentication = "none"
posture_requirements = [{ requirement = "leased-localhost-ports", addressing = "port" }]

[environment.machine]
runtime_memory_mb = 512
runtime_cpus = 1
free_disk_mb = 1024
cold_start_seconds = 60
```

## The stack: `compose_files`

A product that runs as a stack lists its Compose files under `[environment]`, and cockpit runs them
as written ([Compose-first stacks](environment.md#compose-first-stacks)). A small app with no
Compose file gets a starting one from `cockpit init --scaffold-compose`
([Scaffold a Compose file](environment.md#scaffold-a-compose-file)). `resettable_volumes` names the
Compose volumes `reset` may delete, and `seed` the command `up` runs to fill them
([Demo data, test users and roles](environment.md#demo-data-test-users-and-roles)). Full entry:
[`[environment]`](configuration-reference.md#environment).

```toml
[environment]
compose_files = ["compose.yml"]
resettable_volumes = ["postgres-data"]
seed = { argv = ["npm", "run", "db:seed"], timeout_seconds = 300 }
```

## `[[environment.install_policies]]`

The project build and test commands for one toolchain, selected by the lockfile a sibling
checkout holds. `setup` needs exactly one matching row for each sibling whose `toolchain` is not
`none`, and the guard allows the declared `build` and `test` argument vectors in that checkout.
Full entry: the [`install_policies` shape](configuration-reference.md#install_policies-shape).

```toml
[[environment.install_policies]]
toolchain = "node"
lockfile = "package-lock.json"
build = ["npm", "run", "build"]
test = ["npm", "test"]
```

## `[testing]`

The product's test commands as stages, grouped into a targeted gate agents run while iterating and
a full gate they run before handing back shared changes. A stage command is an argument list run
without a shell; [Choose the proving test tier](work-and-browser.md#choose-the-proving-test-tier)
explains the tiers. Full entries: [`[testing]`](configuration-reference.md#testing),
[`[[testing.stages]]`](configuration-reference.md#testingstages) and
[`[[testing.gates]]`](configuration-reference.md#testinggates).

```toml
[testing]
stages = [
  { id = "changed", command = ["npx", "vitest", "run", "--changed", "origin/main"], requires_stack = false },
  { id = "all", command = ["npx", "vitest", "run"], requires_stack = false },
]
gates = [
  { id = "changed", tier = "targeted", stages = ["changed"], changes = "Isolated behaviour" },
  { id = "all", tier = "full", stages = ["all"], changes = "Shared or cross-project behaviour" },
]
```

## `[guards]`

The database and live vendor API hosts of every non-local environment; the guard denies agent
commands that reach them ([Safety and autonomy](safety-and-autonomy.md)). Empty lists record that
none exists. Full entry: [`[guards]`](configuration-reference.md#guards).

```toml
[guards]
hosted_db_hosts = ["db.prod.example.com"]
vendor_endpoint_hosts = ["api.payments.example.com"]
```

## `unconfirmed`

`init` lists each answer no person stated in `unconfirmed`, at the top of the file, and `doctor`
warns until a person confirms each value and deletes its entry. Full entry:
[Top-level keys](configuration-reference.md#top-level-keys).

## Everything else

Each optional area links to its tables in the reference and to the guide that explains it. The
reference also lists the [defaults](configuration-reference.md#defaults) and the
[checks beyond the schema](configuration-reference.md#checks-beyond-the-schema).

| Area | Tables | Guide |
|---|---|---|
| Vendor stubs, TLS, restores | your Compose files | [Compose patterns](compose-patterns.md) |
| Browser checks | [`[browser]`](configuration-reference.md#browser) | [Browser evidence](work-and-browser.md#browser-evidence) |
| Work orders | [`[work]`](configuration-reference.md#work) | [Work and browser workflows](work-and-browser.md) |
| Who decides | [`[autonomy]`](configuration-reference.md#autonomy) | [Who decides](safety-and-autonomy.md#who-decides) |
| Guard rules | [`[[guards.allow]]`](configuration-reference.md#guardsallow), the `deny` row of [`[guards]`](configuration-reference.md#guards) | [Safety and autonomy](safety-and-autonomy.md) |
| MCP approvals | [`[mcp]`](configuration-reference.md#mcp) | [MCP servers and restrictions](harness-surfaces.md#mcp-servers-and-restrictions) |
| Surface overlays | [`[[surfaces.overlays]]`](configuration-reference.md#surfacesoverlays) | [Ownership and extension](harness-surfaces.md#ownership-and-extension) |
| Custom harnesses | [`[[surfaces.harnesses]]`](configuration-reference.md#surfacesharnesses) | [Custom harnesses](harness-surfaces.md#custom-harnesses) |
