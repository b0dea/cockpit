# Configuration essentials

<!-- cockpit:verified version=0.0.0 -->

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

## The stack: a Compose file or a generated one

Choose one. A product that already has a Compose file lists it as `compose_files = ["compose.yml"]`
under `[environment]`, and Compose keeps owning the stack
([Compose-first stacks](environment.md#compose-first-stacks)). Otherwise cockpit generates the
Compose file from declared services ([Generated environment](environment.md#generated-environment)):
each names its sibling, a pinned image or a build, its command, ports and a health probe. Full
entries: [`[environment.generated]`](configuration-reference.md#environmentgenerated),
[`[[environment.generated.services]]`](configuration-reference.md#environmentgeneratedservices) and
the [`health` shape](configuration-reference.md#health-shape).

```toml
[environment.generated]
compose_file = "compose.generated.yml"

[[environment.generated.services]]
id = "api"
sibling = "api"
build = { context = "." }
command = ["node", "server.mjs"]
ports = [{ name = "http", host_variable = "API_HOST_PORT", internal = 3000 }]

[environment.generated.services.health]
property = "GET /health returns 200"
probe = { location = "in-stack", service = "api", cwd = ".", argv = ["node", "probe.mjs"], timeout_seconds = 10 }
interval_seconds = 5
timeout_seconds = 3
retries = 4
start_period_seconds = 20
```

## `[[environment.install_policies]]`

How dependencies are installed for one toolchain: the volume they live in, the lockfile, the
install command and a probe that proves they load. Full entry: the
[`install_policies` shape](configuration-reference.md#install_policies-shape).

```toml
[[environment.install_policies]]
toolchain = "node"
volume = "dependencies"
lockfile = "package-lock.json"
install = ["npm", "ci"]
load_probe = ["node", "probe.mjs", "load"]
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
native_hooks = { install = "inspect" }
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
| Demo data | [`[environment.generated.data]`](configuration-reference.md#environmentgenerateddata) | [Data, vendors and decisions](environment.md#data-vendors-and-decisions) |
| Vendors | [`[[environment.generated.vendors]]`](configuration-reference.md#environmentgeneratedvendors) | [Data, vendors and decisions](environment.md#data-vendors-and-decisions) |
| Decisions | [`[environment.generated.decisions]`](configuration-reference.md#environmentgenerateddecisions) | [Where the decisions live](environment.md#where-the-decisions-live) |
| Browser checks | [`[browser]`](configuration-reference.md#browser) | [Browser evidence](work-and-browser.md#browser-evidence) |
| Work orders | [`[workorders]`](configuration-reference.md#workorders) | [Work and browser workflows](work-and-browser.md) |
| Guard rules | [`[[guards.allow]]`](configuration-reference.md#guardsallow), the `deny` row of [`[guards]`](configuration-reference.md#guards) | [Safety and autonomy](safety-and-autonomy.md) |
| MCP approvals | [`[mcp]`](configuration-reference.md#mcp) | [MCP servers and restrictions](harness-surfaces.md#mcp-servers-and-restrictions) |
| Surface overlays | [`[[surfaces.overlays]]`](configuration-reference.md#surfacesoverlays) | [Ownership and extension](harness-surfaces.md#ownership-and-extension) |
| Custom harnesses | [`[[surfaces.harnesses]]`](configuration-reference.md#surfacesharnesses) | [Custom harnesses](harness-surfaces.md#custom-harnesses) |
