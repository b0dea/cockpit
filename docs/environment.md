# Environment lifecycle

<!-- cockpit:verified version=0.0.0 -->

This page is the reference for cockpit's environment commands: what each one does, what it
refuses, and how to recover when it refuses. It is for people running cockpit on a product and for
agents working inside it. For the order to run the commands in, follow
[Bring the product up](getting-started.md#bring-the-product-up); every flag is in the
[CLI reference](cli-reference.md), and `cockpit <command> --help` prints a command's usage.

## Output and exit codes

Add `--json` to get the result and any diagnostics as one JSON document on stdout. Without
`--json`, cockpit prints the result as readable text and diagnostics to stderr. Every refusal exits
nonzero with a named diagnostic code, and unknown flags are refused. `logs` defaults to
`--tail 100 --since 15m`.

## Input limits

cockpit checks the size of configuration, registry and adoption files before parsing them, against
the limit defined in [`config/load.ts`](../packages/cockpit/src/config/load.ts). A file that cannot
be read, is not a regular file, is too large, or changes while cockpit reads it is refused with a
diagnostic. Make the file smaller; raising an output or subprocess limit does not change this one.

`document` can print a visibly incomplete draft when a registry fact is missing; in its JSON result
that gap is `null`. A skipped registry row produces nothing, because cockpit may no longer know
which repository it applies to. `registry-resolve` prints shell data you can `source` only when its
input passed validation.

## Environment modes

`[environment]` is optional. What it declares decides which commands have anything to run.

| Declares | Mode | `sync` and `check` | Runtime commands |
|---|---|---|---|
| neither `compose_files` nor `generated` | surfaces only | write and drift-check the harness surfaces | refuse with `ENVIRONMENT_NOT_DECLARED` |
| `environment.compose_files` | compose first | the surfaces, plus `check` reads the Compose topology | run the declared Compose files |
| `[environment.generated]` | generated | the surfaces and the generated stack | run the generated Compose file |

If both are declared, `generated` wins. The runtime commands are `up`, `sleep`, `session`, `down`,
`reset`, `preflight`, `logs` and `runtime measure`. Every mode writes the harness
[surfaces](concepts.md#surface) (instructions, skills, guards, permissions, evaluator and work
orders) and checks them for [drift](concepts.md#drift). A cockpit that declares only
`[environment.machine]` still gets the machine-capacity checks in `preflight`, so it is not refused
as surfaces only. `doctor` reports an undeclared runtime as not declared, not as healthy, and its
`declarations` result lists resource ceilings, data modes and vendor guards as not declared unless
the stack is generated. [`examples/docs-only`](../examples/docs-only/README.md) and
[`examples/compose-first`](../examples/compose-first/README.md) show the first two modes.

### Compose-first stacks

`environment.compose_files` lists paths relative to the cockpit root, and each must stay inside it.
Compose resolves every relative path in those files, such as `build: ./api` or `"./api:/app"`,
against the directory of the first listed file, exactly as `docker compose -f <first> -f <second>`
does. So `compose_files = ["shop/compose.yml"]` runs a product repository's own file with its `./`
paths meaning what they mean in that repository. Every command passes that directory to Compose as
`--project-directory`, because Compose reads verified snapshots of the files and could not
otherwise tell where they came from. List files from two directories only when the later ones name
no relative paths, since theirs resolve against the first file's directory too.

`check` reads your Compose topology with `docker compose config`, without interpolation, and refuses
with `COMPOSE_TOPOLOGY_UNAVAILABLE` if Docker cannot produce it. It also checks:

- a published host port not written as a `[ports.bases]` variable, such as `"127.0.0.1:4200:3000"`,
  fails with `COMPOSE_PORT_NOT_LEASED`, because the same number collides across worktrees and
  parallel stacks; write `"127.0.0.1:${API_HOST_PORT}:3000"` instead;
- a service with no Compose healthcheck warns with `COMPOSE_HEALTHCHECK_MISSING`, because running
  is then treated as ready;
- an image referenced by tag rather than digest warns with `COMPOSE_IMAGE_UNPINNED`.

cockpit never edits your Compose files. To run the stack, `sync` writes `compose.cockpit.yml`, an
override that belongs to cockpit and adds its ownership labels to every service, the default
network and every named volume that is not `external`. Volumes also get a generation label, so
`reset` can account for each `resettable_volumes` entry. `check` drift-checks the override, and
runtime commands pass it after your declared files only while it matches what cockpit would
generate now. A Compose `include` is refused with `GENERATED_DECLARATION_INVALID`, because Compose
reads an included file from disk, outside the verified snapshot, and cockpit could not label the
services it brings in; list the file in `environment.compose_files` instead.

Runtime commands give Compose only these variables: the leased `[ports.bases]` variables, each
`[[sibling]] var` set to that sibling's absolute directory, and cockpit's own stack and holder
identities. Any other `${VAR}` reference needs a `:-default`. Every Compose command that
interpolates the checked configuration turns off Compose's automatic loading of the project `.env`
file, because a file cockpit has not checked must not change the topology it has checked. The
topology check does not read service `env_file` contents either, so service secrets never enter
cockpit's records; Compose still passes those files to the containers when the stack runs.

Mounts must match the declaration in both directions:

- Each sibling declared with `mount = "always"` must be bind-mounted, whole or a directory inside
  it. Otherwise `check` fails with `COMPOSE_SIBLING_NOT_MOUNTED` and `up` refuses to start the
  stack. Mount it through its variable, as in `"${WORKER_DIR}:/srv/worker"` or
  `"${WORKER_DIR}/src:/app"`, through a path relative to the first Compose file's directory, as in
  `"./worker:/srv/worker"` from a `compose.yml` in the cockpit root, or set `mount = "none"` on the
  row.
- A container gets only what `cockpit.toml` declares. A bind outside every `mount = "always"`
  sibling and every `environment.generated_host_paths` entry, or one that leaves its sibling
  through a symbolic link, fails `check` with `COMPOSE_BIND_UNDECLARED`, and `up` refuses it.

## Local URLs and port families

Generated service ports bind to `127.0.0.1` by default, so starting a local stack does not expose
it to the network. Set a port's `host_ip` to `::1` for IPv6 loopback, or to `0.0.0.0` or `::` only
when you intend that wider exposure; cockpit keeps what you set. In compose-first mode, write the
same explicit loopback binding in your own Compose file, as in `"127.0.0.1:${API_HOST_PORT}:3000"`;
cockpit does not rewrite your published interfaces.

Stack *n* publishes each `[ports.bases]` value plus *n* × `ports.step`, for up to `ports.count`
stacks (defaults: step 100, count 27). `up` leases a whole port family under one lock shared by
every cockpit run by your user account with the same canonical
[state root](troubleshooting.md#clear-cockpit-state). It skips any family holding a port that
another cockpit's active lease holds, then checks that no other program is listening on
the ports it picked. Cockpits with similar bases therefore never get the same ports, even before
either stack starts listening; an overlap costs a candidate family, never a shared port. Each
cockpit's stack count applies only to its own stacks. A retained lease keeps its original family
and blocks any conflicting reservation. Other user accounts and separate state roots, including different Linux `XDG_STATE_HOME`
settings, are not coordinated; only the listener check separates them.

The listener check looks for a listener on each port on IPv4 loopback when ports are first
allocated. It does not reserve the port, does not see a listener bound only to IPv6, and cannot
stop another process binding the port afterwards. If startup reports a bind failure, find the
conflicting process, resolve it, and rerun `cockpit up --config cockpit.toml`. The lease stays
reserved until cockpit has confirmed its cleanup, even when its holder is no longer running. To
change a stack's ports, see [Change a running stack](#change-a-running-stack).

### Named local URLs

Entrypoint derivatives turn a port lease into application origins, callback URLs and other
declared addresses. Add an optional `hostname` and `scheme` to use a named local URL:

```toml
[ports.bases]
APP_HOST_PORT = 8443

[[environment.entrypoint_derivatives]]
name = "application"
kind = "origin"
port = "APP_HOST_PORT"
path = "/"
hostname = "app.sample.localhost"
scheme = "https"
```

Run `cockpit up --config cockpit.toml --json` and use the entrypoint it returns; the example
produces `https://app.sample.localhost:<leased-port>/`. The port comes from the selected port
family, including any nonzero offset, and a retained lease derives it the same way. Omitting
`hostname` uses `127.0.0.1`; omitting `scheme` uses `http`. Automatic numeric entrypoints keep their
plain HTTP loopback URLs. These declarations set no environment variables in the application:
configure the product's public origin and callback settings to match the returned address.

Names must be lowercase DNS subdomains of `.localhost`, with ordinary letter, digit and hyphen
labels. Arbitrary suffixes, bare `localhost`, wildcard names and embedded ports are refused.
[RFC 6761](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3) reserves `.localhost` for
loopback; an arbitrary name such as `local.app.sample` has no such guarantee. Use a distinct
hostname for each project, because
[cookies are not isolated by port](https://www.rfc-editor.org/rfc/rfc6265.html#section-8.5).

Host clients use the host resolver, and conforming resolvers map `.localhost` names to host
loopback. Inside a container, loopback is that container's own, so a product container that calls
the host-published URL needs its own `extra_hosts` mapping to the right host gateway;
service-to-service traffic normally uses Compose service names and container ports instead.
`browser.resolver` supplies mappings only to the browser runtime declared in cockpit, not to an
unrelated remote browser, MCP server or other client: put the mapping where that client's network
process runs. Browser operations then use that runtime's own networking and DNS, as described in
[Work and browser](work-and-browser.md#browser-evidence).

`scheme = "https"` only declares a URL; the product's Compose stack must serve TLS on that leased
port. cockpit does not install trust roots, change host DNS or start a shared HTTPS proxy. To set
it up:

1. Provision a certificate whose subjectAltName covers the exact hostname. Port offsets do not
   change the certificate identity.
2. Keep private keys outside tracked files and build contexts, and mount only the leaf key into
   the TLS service.
3. Explicitly trust the issuer in each runtime that connects. Clients need the public CA
   certificate, never the CA signing key.
4. Rerun `cockpit up --config cockpit.toml` and open the returned URL with certificate validation
   enabled.

## Sibling and template paths

`sync` and `check` require each declared [sibling](concepts.md#sibling-repository) directory to
exist inside the siblings root, both as written and after following filesystem links. An absolute
sibling path is accepted only inside that root. Get missing checkouts onto disk, for example with
`cockpit setup`, before generating their environment.

`doctor` and `preflight` inspect every declared environment file in every sibling, and each check
lists all its failing paths, so one healthy file cannot hide another file's missing instance or
stale key names. Restore the named checkout or bring its instance keys in line with its template,
then rerun `cockpit doctor --config cockpit.toml`. When no sibling declares an environment file,
the instance-presence and key-freshness checks pass: there is nothing to seed or compare.

For generated services, `build.context`, bind and environment-file mount sources, and
`toolchain_pins.path` are relative to the declared sibling checkout; `.` means the checkout itself.
A dedicated cockpit can build and mount a sibling that sits beside its own folder; the generated
Compose file records that relative path. Declare the sibling under `cockpit.siblings_root`, then
run `cockpit sync` and `cockpit check` before starting the stack. Reading inputs from a sibling
does not let cockpit write outside the cockpit: browser-runner inputs, `generated_host_paths` and
generated output destinations stay relative to the cockpit folder.

Before Compose builds or starts a generated service, cockpit checks each declared bind source,
environment-file mount, build context and Dockerfile, starting from the checkout it belongs to:

- no part of the path may be a symbolic link;
- bind sources must have their declared type, and build contexts must be directories;
- Dockerfiles must be regular files inside the context; an omitted Dockerfile means `Dockerfile`
  in that context.

This stops a link or a wrong-type input from reaching Docker before readiness probes could explain
the failure. It does not read environment-file values. Toolchain pins are checked in the sibling
even when the service has no bind mount, but only diagnostics report them; they do not affect the
build.

Browser-runner inputs are checked after their generated files are written. Create the directory
named by `browser.artifacts.runner` before the first `cockpit up`; for example, if the declaration
uses `.browser/runner`, run `mkdir -p .browser/runner` from the cockpit checkout. cockpit refuses
missing or linked inputs rather than let Docker create host directories; restore the reported input
as an ordinary file or directory, then rerun `cockpit up --config cockpit.toml`. These checks look
at the declared paths when cockpit checks them; they do not inspect a build context's contents
recursively or lock the filesystem against later changes.

Generated vendor templates must be inside the cockpit checkout. External sibling checkouts remain
valid for mounted surfaces, but a vendor template outside the checkout is refused, and cockpit never
substitutes a similarly named directory inside its own checkout. The
[adoption guide](adoption.md#adopt-in-layers) gives the order for generated templates.

## Lifecycle and ownership

`setup` gets the declared sibling checkouts onto disk and wires them up. `mount` controls how the
stack uses a checkout; `acquire` controls how it gets onto disk; the two are independent. Setup
looks at declared secret-file paths but never reads or copies their contents.

A sibling with `instruction_pointer = true` asks setup to connect the product's own **AGENTS.md**
to the cockpit guide. Plain `cockpit setup --config cockpit.toml` only reports the proposed path, so
an agent cannot silently change the instructions later agents load. After a person reviews the
exact block, `cockpit setup --config cockpit.toml --write-instruction-pointers` appends that marked
block and keeps every other byte. A missing guide is created only by this approved write; edited,
partial or duplicate marked blocks are refused so a person can reconcile them. Setup also refuses
redirected directories and invalid UTF-8 rather than replace the product's bytes.

### Start or resume the stack

`up` starts the selected stack, or resumes it. It records a holder it newly adds separately from an
existing one, so if the start fails, cockpit undoes only what that attempt added. Before resuming,
cockpit checks that the saved progress still matches the current lifecycle record, runtime and port
lease. If it does, cockpit rechecks the services that already completed and resumes the rest; if
anything changed, it discards that progress before touching containers left by the earlier
attempt. After the first seed, missing saved progress blocks startup. Restore that state rather
than delete it: deleting it would make the stack look like a fresh environment when it is not.

When a service that `up` started does not become healthy, cockpit reports that service's last log
lines as one diagnostic, then stops its container and keeps it, so a restart policy cannot leave it
restarting. Failure logs are limited to that service and time window, and never follow the process
that failed. The holder and lease stay, so the next `up` resumes and `down` removes the stack.

When `up` starts services, it times the start, from the earliest recorded service start to the
moment the last newly started service reports healthy. If that exceeds `cold_start_seconds`, `up`
refuses with `MACHINE_COLD_START_EXCEEDED`. A successful result reports `coldStart.measuredMillis`,
`limitMillis` and `headroomMillis`. A partial resume times only the services that run started.
Joining a stack that is already running, or that another holder started, reports no duration
rather than an invented one.

### Release the stack

`sleep` removes the current holder. It stops the shared runtime only when no other holder remains,
so one holder cannot stop another's environment. `stackId` names the shared runtime and
`checkoutId` names one checkout; two checkouts with the same stack ID are still not
interchangeable.

`session` runs `up`, keeps that holder while one foreground command runs, and runs `sleep` only
after confirming that the command's process group has stopped. A command that prints nothing still
counts as running. Interrupting the wrapper stops only the process group it started, then sleeps.
If cockpit cannot confirm that the process group stopped, it keeps the holder so you can clean up
explicitly. Ordinary cockpit lifecycle commands run inside the wrapper use the same private session
identity, and a second `cockpit session` wrapper is refused. Once cleanup completes, `session`
exits with the command's own status, or 128 plus the signal number (and names the signal) when a
signal ended it. It exits 2 when cleanup fails and 130 when you cancel it.

The command `session` runs gets the stack's addresses in its environment, so an agent started under
it can reach the stack without rerunning `up --json`:

- each `[ports.bases]` name holds the port leased for this stack, the same value the Compose files
  read, as in `API_HOST_PORT=4210`;
- each entrypoint `up --json` returns is under `COCKPIT_ENTRYPOINT_` followed by its name in upper
  case with hyphens as underscores, as in
  `COCKPIT_ENTRYPOINT_API_HOST_PORT=http://127.0.0.1:4210/`.

The lease is the truth for the stack, so these replace a value of the same name already set in the
calling shell. They are read once when the command starts and do not follow a later `down` and
`up`. When the command ends, the session releases only its own hold: a stack that an earlier `up`
from this checkout still holds keeps running, and the session says so with
`SESSION_STACK_RETAINED`; `sleep` releases that hold.

Each `sleep` and `down` stops containers with a stop grace: Docker sends SIGTERM and waits ten
seconds before killing. A service whose PID 1 ignores SIGTERM, as `node` does unless the program
handles it, pays the whole grace at every stop. Generated services already run under `init: true`;
in your own Compose file, add `init: true` to such a service or handle SIGTERM in the program.

### Remove the stack and its data

`down` removes only what cockpit's runtime, checkout and ownership records show it owns: it lists
only containers, networks and images that carry this stack's ownership label, and reports and
keeps anything it cannot show is this stack's. Ownership is the stack's identity, not the
configuration, so a container or network that an earlier `cockpit.toml` started is removed too. An
image the stack built carries the same label and is removed, unless it also has a second tag.
Volumes stay, because only `reset` deletes data.

When one of the stack's own resources has to stay, such as a network another container is still
attached to or an image tagged under a second name, `down` refuses with `DOWN_RESOURCES_KEPT` and
names each resource and the reason, rather than reporting a stack removed that is still there. It
clears startup progress only after confirming the removals, which lets the next `up` use a new
generated identity. `down` also retires a stack that `sleep` or an ended `session` left stopped:
with no holder left, it claims the stack for this checkout without starting anything and removes
it, so you do not have to run `up` first. While another session still holds the stack, `down`
refuses with `CLAIM_CO_TENANT`; end that `cockpit session` or run `cockpit sleep` from it, then
retry.

`reset` first shows an exact preview of the declared volumes and generated host paths it would
delete. Plain and `--json` reset calls delete nothing. Interactive reset needs a person at a
terminal outside CI; the approval stays with the process that showed the preview, which checks
everything again before it acts. `down` and `reset` delete only from a local Docker daemon, which
they fix once per run; see [Choose the Docker daemon](#choose-the-docker-daemon).

Name each `environment.resettable_volumes` entry by its key in the Compose file: the
`[[environment.generated.volumes]]` `id` in a generated stack, or the top-level `volumes:` key in a
compose-first one. Docker's volume name carries a per-checkout project prefix, so it is not
accepted. A name that no declared volume has fails configuration validation in a generated stack.
In a compose-first stack, `sync`, `check` and every runtime command, `down` included, refuse it,
and an `external` volume too, because cockpit cannot label it. A declared volume that does not exist yet is left out of the
preview. A volume that an earlier `cockpit.toml` created is still this stack's data, and `reset`
deletes it with the rest.

Every destructive action is recorded durably before it starts. If cockpit itself is interrupted, a
detached supervisor process keeps track of that exact attempt. The next `sleep`, `down` or approved
`reset` asks the supervisor to stop the action's process group, confirms the group is gone, marks
the attempt as failed, and retries the saved action. If the target was already removed, cockpit
checks again that it is gone and that the remaining targets are unchanged, then marks the action
complete without repeating it. `DRAIN_ATTEMPT_REPAIR_REQUIRED` means the attempt marker, supervisor
identity, control socket or stop confirmation did not match; cockpit then keeps the attempt and
refuses any overlapping cleanup. Do not remove its state or runtime resources by hand: that
destroys the records cockpit needs to repair it safely.

### Change a running stack

A stack's identity, carried in its ownership labels and saved progress, is a digest of the
declarations that reach its containers, not of the bytes of `cockpit.toml`. Editing a sibling's
`purpose`, the guards, MCP, surfaces, comments or formatting leaves a running stack alone, and the
next `up` resumes it. `sleep` and `reset` keep the previous generated identity so the stack can
resume.

A change to services, ports, mounts, images or anything else the containers receive gives the
stack a new identity, and `up` refuses with `LIFECYCLE_PROGRESS_INVALID` rather than replace the
running stack in place. To apply such a change, for example a `[ports.bases]` edit:

1. Edit `cockpit.toml`. This can happen while the stack runs.
2. Have a person run `cockpit sync --config cockpit.toml` in a terminal. Until then, the agent
   guard holds every tool call, because the configuration no longer matches what it was generated
   for, and `sleep` and `down` refuse because they read the Compose files `sync` publishes.
3. Run `cockpit down --config cockpit.toml`. It finds the stack and its port lease by the stack,
   not by the edited declaration, and removes the containers still running the old declaration.
   While another holder, such as a running `cockpit session`, still holds the stack, it refuses
   with `CLAIM_CO_TENANT`.
4. Run `cockpit up --config cockpit.toml --json` and use the newly returned ports and entrypoints.

Restoring `cockpit.toml` to the exact bytes `sync` last saw, for example with
`git restore cockpit.toml`, clears the guard's hold without a `sync`: the guard compares the file's
content, not which file holds it.

## Choose the Docker daemon

Every command uses the daemon Docker itself would select: a `DOCKER_HOST` when set, otherwise the
context `DOCKER_CONTEXT` names, otherwise the active context `docker context show` reports. Three
commands fix that daemon once, before their first step, and address only it:

| Command | Why it fixes the daemon |
|---|---|
| `down`, `reset` | they delete; reading the context per step could list one daemon and delete from another if `docker context use` ran mid-command |
| `runtime measure` | the measurement must describe the daemon `up` will use, not one selected while the probe ran |

None of them needs a prefix, so they run as printed:

```sh
npx --no cockpit down --config cockpit.toml
npx --no cockpit runtime measure --config cockpit.toml --image node:22-alpine
```

However the daemon was chosen, its endpoint must be an absolute `unix://` socket path. TCP, SSH and
other transports are refused, because a remote daemon could receive a deletion and its behaviour
says nothing about this machine. A `DOCKER_HOST` that is not local is refused with
`CLI_USAGE_INVALID`; a named or active context that is not local, or whose endpoint cannot be read,
is refused with `RUNTIME_UNAVAILABLE`, naming the context and its endpoint. For `down` and `reset`,
conflicting selections are refused, and so is a TLS override. Socket paths keep literal spaces and
punctuation, and cockpit uses the exact spelling when it binds the context and runs discovery or
deletion.

## Compose project name

Every command that runs Docker Compose passes `--project-name <cockpit.name>-<stack>`, in both
compose-first and generated mode, where `<stack>` is the first 12 hex digits of the stack ID. The
stack ID comes from the cockpit's main checkout and the current checkout, so two cockpits that share
a `cockpit.name`, or two checkouts of one cockpit, get separate projects on one Docker daemon
instead of replacing each other's containers. It never depends on the bytes of `cockpit.toml`, so
editing the file keeps the same project.

Containers, networks and named volumes carry that name: a cockpit named `shop-cockpit` runs
containers such as `shop-cockpit-3f2b3aead733-api-1` and a volume
`shop-cockpit-3f2b3aead733_dependencies`. The generated Compose file has no `name:` field, because
it is committed and shared by every checkout; in compose-first mode your own file's `name:` is
overridden. To look at the stack with Docker directly, find the project with `docker compose ls`
and name it: `docker compose --project-name shop-cockpit-3f2b3aead733 ps`. Renaming `cockpit.name`
addresses a different project and stack, so run `down` before renaming, as
[Rename a cockpit](getting-started.md#rename-a-cockpit) describes.

## Measure the container runtime

`up`, `session`, `down` and `reset` refuse with `RUNTIME_UNMEASURED` unless the container runtime
Docker selects has been measured on this machine. `sleep` and `logs` act on a running stack and
fail while its runtime no longer matches a measurement, for example after an engine upgrade.
`preflight` and `doctor` only report an unmeasured runtime, as an unavailable check. A measurement
is a fact about one machine, not something the team declares: teammates run different runtimes and
versions, so it is never written to `cockpit.toml`.

cockpit identifies the runtime from one `docker info` reading of `OperatingSystem`, `Name` and
`OSType`:

| Runtime identity | Recognised by | Provenance |
|---|---|---|
| `docker-desktop` | `OperatingSystem` is `Docker Desktop` | vendor `docker info` output, not probed |
| `orbstack` | `OperatingSystem` is `OrbStack` | observed on an OrbStack host |
| `colima` | `Name` starts with `colima` | vendor `docker info` output, not probed |
| `rancher-desktop` | `Name` ends with `rancher-desktop` | vendor `docker info` output, not probed |
| `docker-engine` | a Linux host whose daemon reports `OSType` `linux` | vendor `docker info` output, not probed |

Any other reading, including an unrecognised VM on macOS, is not identified and never accepted; the
refusal lists the raw `docker info` values so you can report them.

Measure the runtime on this machine:

```sh
docker pull node:22-alpine
./node_modules/.bin/cockpit runtime measure --config ./cockpit.toml --image node:22-alpine
```

The command runs a probe in a throwaway directory: a candidate stack that exercises profiles, bind
mounts in both directions, labels, health, logs, recovery and teardown, next to a deliberately
broken Compose file that the runtime must reject. It uses only the local image you name and never
pulls. Its Compose project is `<cockpit.name>-probe-<id>`, so anything it leaves on a shared daemon
names the cockpit that ran it, and the probe removes it before returning. The probe runs only from
an installed `@b0dea/cockpit` package and only against a daemon that passes the
[local endpoint rules](#choose-the-docker-daemon).

If the candidate passes and the broken file is rejected, the command records the measurement in
`.cockpit/local/runtime-measurements.json` beside `cockpit.toml`, a directory Git ignores. The
record is keyed by the runtime identity and the daemon name `docker info` reports, and holds the
engine version and the Compose version the probe saw, which becomes the Compose floor. Measuring
again replaces the row for the same runtime and daemon and keeps the others, so switching between
two runtimes needs one measurement each. A failed measurement records nothing.

`up` admits the runtime only when this machine's record has a row for the same runtime and daemon,
with the same engine version and a Compose version at or above the floor, so an engine upgrade
needs a new measurement. Recording a measurement changes no committed file, so an agent can run it
before its first `up` without waiting for a human `sync`. `doctor` names the measurement that
admitted the runtime in the `RUNTIME_UNMEASURED` check's source.

## Secret sources and environment schemas

Keep each product component's `.env.schema` tracked beside its application. If its ignore rules
match `.env.*`, explicitly allow `.env.schema` and confirm that Git tracks it before adoption. The
schema declares variable names, validation and how a provider resolves each value; review its
resolver code and dependency lock as you would product code.

For generated environments, `sync` writes cockpit's own `env/.secrets/.gitignore`, which ignores
everything below it, before any secret material exists. Put encrypted resolver expressions or
external-provider references in `env/.secrets/<cockpit-project>/<component>`. If an ignore file
that cockpit did not write already exists there, reconcile it first. Existing secret directories
must not be symbolic links and must have mode 0700. cockpit leaves files it did not create alone
and does not create their values: create resolver files with mode 0600 through your own approved
provisioning process.

The shared onboarding procedure explains how to adopt Varlock, optionally, through the product's
pinned dependency and an existing declared command or script. Use agent-mode validation for status
and `run --inject vars --redact-stdout` for a trusted product process, and keep resolved
credentials out of the agent's environment. Give both paths as absolute paths with repeated
`--path`: the component schema root first, then its central resolver directory in the cockpit; the
later path wins. Installation, initialization, provider login, encryption and migration need
explicit permission from whoever owns the product and the provider. Current commands and
limitations are in the [Varlock CLI reference](https://varlock.dev/reference/cli/load-and-run/) and
[AI tools guide](https://varlock.dev/guides/ai-tools/).

`cockpit preflight` and `cockpit doctor` check every sibling that contains a `.env.schema` and skip
the rest. Each runs `varlock load --agent --format json-full --path <sibling>` from your `PATH`
with the command's timeout and a 256 KiB output cap, and keeps only key names and a validity
category; values and Varlock's messages are discarded. `ENV_SCHEMA_UNHEALTHY` fails the row and
names the sibling and its keys, or reports the row as unavailable when Varlock times out, exits
without a readable report, or a provider cannot resolve a value; run `varlock load` in that sibling
to see why. `ENV_SCHEMA_TOOL_MISSING` is a warning, not a failure, when Varlock is not installed
(<https://varlock.dev>).

Report only variable names, validation state, exit status and where each value came from. Raw
resolver output, resolved values and browser state do not belong in work-order results. Generated
guards refuse changes and staging under secrets directories, including staging a parent directory
of the central store; whether a harness can natively block reads of these files has not been
tested. Git ignore rules, filesystem permissions, encryption and output redaction do not protect
secrets from malicious code running as the same user, and trusted product child processes receive
plaintext variables. A stronger boundary needs a separately tested sandbox and provider policy.

## Generated environment

`[environment.generated]` is where a product declares its stack content: services, images,
volumes, mounts, data operations, vendor modes, probes and generated destination paths. cockpit
supplies the rendering and writing; the declaration supplies what differs between products. The
outputs are the declared environment paths plus the configured harness surfaces; the repository's
synthetic example shows a Compose file, a generated copy of a secrets template,
<!-- cockpit:ref consumer=docs/cockpit/environment-decisions.md --> `docs/cockpit/environment-decisions.md`, and generated persona files.

### Check and sync

`check` works out what the generated files should contain now and compares that with every whole
file, symlink target and shared-file region listed in the ownership manifest (see
[generated ownership](concepts.md#cockpit-generated-ownership)). It reports drift and never changes
an output. `sync --dry-run` does the same preparation and lists the writes and removals, in order,
without changing anything. `sync` writes the full set as one recoverable filesystem transaction.

Team package metadata is prepared separately: a known surface conflict, an input overlap or a
refused stale-removal approval leaves it unchanged; resolve the reported conflict, then run
`cockpit sync --config cockpit.toml` again. Metadata is replaced only after these checks pass, but
a later I/O failure or concurrent input change can still leave those metadata updates in place
while the generated-file transaction reports its own recovery result.

Removing a stale file needs a separate approval of the exact path, operation and current bytes that
the dry run showed. Plain `sync` refuses to apply it; `sync --interactive` shows the request and
asks you to type its exact digest. After approval and a final recheck, cockpit can remove an
unchanged whole file or symlink, or its own region in a shared file. Files cockpit did not write,
and bytes outside its regions, are kept. A stale path that changed or is unsafe needs manual
reconciliation before you retry.

Generated content for a shared Markdown region is rejected before writing if it contains either
region delimiter, and shared JSON updates keep the whitespace outside cockpit's property group. The
transaction plans its helper steps before staging and keeps time in reserve to roll back if forward
work reaches its deadline. If cockpit cannot confirm that writing or rollback finished, it keeps the
recovery inputs and refuses to report success.

Capability states, overlay rules, MCP approval, sibling guide links, the skill contract, `selftest`
and `upgrade` for the generated harness surfaces are in [Harness surfaces](harness-surfaces.md);
see [Review an upgrade](harness-surfaces.md#review-an-upgrade) before changing the installed
version.

### Services and dependencies

Each generated service runs under `init: true`, so its command gets signals forwarded and exits
promptly on stop. A pinned-image service with exactly one bind mount of its checkout
(`source = "."`) runs from that mount's target, because the image knows nothing about the checkout
and a relative command such as `node server.js` would otherwise run from `/`. A built service keeps
the `WORKDIR` its Dockerfile declares. The generated file names no Compose project; see
[Compose project name](#compose-project-name).

Generated services can declare `resources.memory_mb`, `resources.cpus` and
`resources.provenance`, applied as `mem_limit` and `cpus` on the generated Compose service. To
limit the generated browser runner, use `browser.resources` with the same fields, together with
`environment.generated` and a declared `browser.endpoint`. Minimum values are in the
[configuration reference](configuration-reference.md). Choose ceilings from what the product
actually needs and what the laptop can spare; cockpit does not invent limits. Environment decisions
report the declared ceilings, or that none are declared. The machine floor stays a separate minimum
capacity check.

Before using a running generated stack, cockpit checks that it matches the stack ID, configuration
and source digests, generation, Compose project and Compose files. For installed dependencies it
also checks the sibling checkout and lockfile, the install policy, the physical volume and where it
is mounted, the container image, architecture and ABI, the install record, the load-probe record
and the stamp file. Each sibling has its own dependency cache identity, even when two lockfiles
contain the same bytes. That identity includes the physical volume: a new generated volume gets a
fresh install, a new load probe on the same mount, and its own stamp. If compatibility changes
within the same volume, cockpit refuses rather than overwrite the stamp, because a stamp alone does
not show that the current runtime can load the installed dependencies.
`DEPENDENCY_RUNTIME_STALE`, `DEPENDENCY_RUNTIME_UNMOUNTED` and `DEPENDENCY_RUNTIME_INCOMPATIBLE`
say which of these checks failed; `DEPENDENCY_RUNTIME_UNAVAILABLE` means cockpit could not get a
current result.

### Data, vendors and decisions

A stack without `environment.generated.data` has no data step, and `up` completes the data stage
without applying anything. Otherwise `up` applies the declared default mode;
[Demo data, test users and roles](#demo-data-test-users-and-roles) covers how to declare it. cockpit
records the exact IDs of the operations it applied, attempted and did not apply. An intention, an
earlier success, or a current read-only probe that failed or could not be verified does not count
as completion. In-stack data operations and their read-only probes use the identities and leased
ports of the current stack, so Compose cannot pick a different stack or fall back to default ports.
Host data operations run with an empty process environment. Run
`./node_modules/.bin/cockpit up --config ./cockpit.toml` to apply the declared mode, then
`./node_modules/.bin/cockpit doctor --config ./cockpit.toml` to run its current probes.

Each vendor declaration selects a `posture` such as `stubbed`. It pins every endpoint variable to
its supplier template and to its runtime service and local sink, and declares the probes that
apply: route, loader, shadow, expiry, TLS, callback, stub and egress. A nonempty placeholder value
stays inert. An egress flag is passed only to its guarded process and is never written into
generated files. A generated host-port variable must also be safe to put in the host process
environment: names that control a loader, interpreter, shell, module path or container runtime are
refused even when their leased values are numbers.

<!-- cockpit:ref consumer=docs/cockpit/environment-decisions.md --> `docs/cockpit/environment-decisions.md` is a generated file that cockpit owns whole. It lists every service, volume, data default and mode,
restore policy, mount, port and vendor. A subject with a dated entry shows that decision; a subject
without one is listed as **undecided**, with the source it inherits from, and `check` reports it as
`GENERATED_DECISIONS_UNDECIDED`, an information diagnostic rather than a failure. Duplicate,
future-dated, stale or sensitive entries stop the inspection. Covering every subject does not show
that a business decision is right; that review stays `human_needed`.

### Bring-up order

Bring-up starts from the lifecycle history: `setup` writes `started`, and so does the first `up` on
a stack that has neither lifecycle data nor history, so you do not have to run `setup` first.
Lifecycle data without history is refused as lost history. Bring-up then completes, in order, the
generated-runtime check, dependencies, data and vendors, and only after that records `seeded`. A
refusal keeps the exact applied, attempted and not-applied progress so the run can be replayed.
Fix the named prerequisite or failed check; never edit lifecycle state to fake `started` or
`seeded` history.

### Result words

Environment results use four words with exact meanings. `enforced` and `unavailable` mean what they
mean for harness features (see [Capability states](harness-surfaces.md#capability-states)); for the
environment:

- **enforced**: cockpit refuses a declaration, file, ownership record, identity, mount, endpoint
  pin or operation that does not match.
- **measured**: a probe produced the stated result. Repository tests run mounted candidates next to
  unmounted and incompatible controls, but those synthetic controls say nothing about your local
  runtime.
- **unavailable**: cockpit could not get or verify the required result, and it counts as not
  passing. The native dependency probe stays unavailable until you supply a canonical generated
  configuration, a checkout, and a pinned image known to be incompatible, as the broken control.
- **human_needed**: product or vendor behavior a maintainer still has to review; no check has
  established it.

## Demo data, test users and roles

This section is for whoever makes the local stack start with useful data and signed-in test users.
cockpit runs the product's own seed, sweep and restore commands in a declared order and records
what was applied. It never writes rows or creates identities itself: the product's writers already
encode its invariants, and a second writer in cockpit would drift from them.

**What to declare.** Under `[environment.generated.data]`, list the modes the stack supports, from
`empty`, `seeded` and `restored`, and pick the `default_mode` that `cockpit up` applies. Each mode
is an ordered list of operations. A `seeded` mode needs `fixtures`, which name a product-owned
[persona](concepts.md#persona) source; cockpit renders that source into typed persona outputs (JSON
or TypeScript) for tests. A `restored` mode needs `restore`.
[`examples/synthetic/cockpit.toml`](../examples/synthetic/cockpit.toml) declares all three modes.

Run the declared flow in this order. Replace the two `*-gate-id` placeholders with IDs from
`[testing.gates]`; those gates call the product's own state-minting and authorization setup.

```sh human-only: resets data, creates provider state, and requires the declared local stack
./node_modules/.bin/cockpit check --config cockpit.toml --json
./node_modules/.bin/cockpit up --config cockpit.toml
./node_modules/.bin/cockpit reset --config cockpit.toml --json
./node_modules/.bin/cockpit reset --interactive --config cockpit.toml
./node_modules/.bin/cockpit up --config cockpit.toml
./node_modules/.bin/cockpit test-run --config cockpit.toml --gate auth-state-gate-id
./node_modules/.bin/cockpit test-run --config cockpit.toml --gate authorization-gate-id
./node_modules/.bin/cockpit check --config cockpit.toml --json
```

The first `up` applies the default data mode. Reset previews exactly which data and auth files it
will remove; only the interactive command applies that preview. The second `up` reseeds, the first
product gate mints one signed-in state per persona, and the second proves both an allowed and a
denied operation. Running only part of a gate is PARTIAL, never a pass of the whole gate.

**Personas.** Give each test user a stable synthetic ID such as `auth-admin` or `auth-member`, its
role and permissions, and one operation it must be allowed and one it must be denied. Stable IDs let
a re-seed update the same rows instead of duplicating them. The allowed and denied pair is what
proves the roles work, not only that a sign-in succeeded.

**Fixture hygiene.** These rules come from seeders that broke in real use:

- Seed through the product's own writers, not raw inserts, so derived fields and constraints hold.
- A re-seed restores only the fields a fixture names. Name every field a test changes, or the next
  run fails its own precondition. Unset fields rather than writing null.
- Seed the settled state a test needs. Default column values can read as work in flight and
  disable the interface.
- Every mode keeps the schema's indexes and constraints (`constraints_and_indexes = true` is
  required), so an empty stack still rejects the rows production would reject.
- Print every restore gap before applying the restore. A silent omission looks like a complete local
  copy even though the missing table or object can change product behavior.
- Before a seed writer runs, assert that every database and service target is local. A development
  fixture is no permission to reach a shared or non-local environment.
- Resolve a sibling fixture path by probing the declared sibling root and a documented fallback;
  never embed one checkout layout as a constant.
- Adopt only provider objects that carry the synthetic namespace's ownership marker. Refuse any
  other, naming the account, and never rewrite the roles of an identity people share.
- A local stack receives no webhooks from an identity provider, so link the provider's ID to the
  product row explicitly.
- Prove a seeded credential by using it once. A placeholder passes every read-only check.
- Clean up by ownership, never by time window.

**Signed-in browser state.** Mint one state file per persona, one at a time, under the declared
auth root (directory mode 0700, files 0600). Warm the application first, and wait for the
provider's session to exist before saving the state. Mint again after any reseed or reset, because
a reused session goes stale and fails in ways that look like product bugs. Name the files so that
the reset patterns match them, and replay each wipe pattern against a synthetic fixture before
relying on it; a file outside those patterns survives a reset.

The shipped `cockpit-setup` skill carries an on-demand reference for this
(`references/test-data-and-personas.md`), which `cockpit-browser` also loads before signed-in
testing. It keeps stable synthetic persona IDs and the product's own rows separate from what the
identity provider owns, and asks for both an allowed and a denied authorization check. Its Clerk
recipe, a separate reference read only when the lockfile shows Clerk, uses the product's current
supported Clerk and Playwright APIs. It does not make cockpit an identity provider, does not create
provider identities without explicit permission, and does not treat an existing state file as
proof of a live Clerk login. Provider writes and cleanup stay limited to an approved development
instance and the exact operation that was approved.

| Symptom | Likely cause |
| --- | --- |
| Redirect loop or a wall of 401s across parallel workers | One provider session shared by several workers; mint per worker or run serially |
| Bounced back to sign-in after a reseed | Stale state file; mint again |
| Sign-in times out on the first run only | Cold application; warm it before minting |
| Signed in but lands on a "no role" page | The role exists in the product database but not as a provider membership, or the reverse |

## Declare environment postures

Declare which local requirements depend on how the product is addressed (`addressing`) and how
sign-in works locally (`authentication`). For example:

```toml
[environment]
addressing = "hostname"
authentication = "bypassed"
posture_requirements = [
  { requirement = "local-route-resolution", addressing = "hostname" },
  { requirement = "local-session-access", authentication = "bypassed" },
]
```

A product with no local sign-in declares `authentication = "none"`; no requirement needs a tag for
it, and a requirement tagged with a sign-in value fails preflight. A plain localhost stack reached
through leased ports declares:

```toml
[environment]
addressing = "port"
authentication = "none"
posture_requirements = [{ requirement = "leased-localhost-ports", addressing = "port" }]
```

Use your actual requirement names. Each tag must match the selected value, and the selected
`addressing` value, and any `authentication` value other than `none`, must each appear in at least
one tag. Preflight refuses missing declarations, mismatched tags and selected values that no tag
uses. Draft configurations may leave these fields out, but then cannot pass that gate. The check
validates the declared tags; deciding which requirements need tags is still a maintainer's review.

## Health and evidence

`preflight` is the blocking gate; `doctor` reports the same checks without repairing anything or
changing the baseline. Ordinary checks require a steady lifecycle stage. A check can pass, fail, be
unavailable, or not apply to the declared setup, and an unavailable required check never becomes a
pass because another check succeeded. Host capacity, dependency installation and runtime health
need complete results from processes cockpit itself ran; when those results are missing, the
result does not pass.

`preflight` and `doctor` read current results without changing anything; `doctor` also previews
generated surfaces to list overrides. They never run `sync`, install dependencies, seed or restore
data, contact vendors to repair anything, or advance lifecycle progress. Only bring-up runs those
steps, as [Bring-up order](#bring-up-order) describes. Generated, dependency, data and vendor
checks each return their own results.

What the checks compare:

- **Git remotes.** A declared sibling remote is compared with the remote selected by that
  checkout's branch upstream; cockpit does not rewrite Git remotes. A checkout with no upstream has
  nothing to compare, and the result says so. Once an upstream is selected, it must be available
  and match; a missing or diverged upstream blocks the gate.
- **Surfaces.** Generated files must match the ownership manifest and stay within the guide line
  cap and the built-in harness skill caps. Custom outputs and plugin bundle copies are checked for
  being current, but no harness-side cap on their always-loaded size applies to them. Whether each
  harness enforces the files is recorded in the [capability matrix](capability-matrix.md). Missing
  or edited generated files block health: run `cockpit sync --config cockpit.toml`, then retry.
- **Grants and registries.** Directory grants and registry authentication are checked only when the
  current declarations select grants or registry probes.
- **Mounts and ports.** A runtime with no bind mounts passes as an exact empty mount comparison;
  declared binds must match the current mounts exactly. Health on a running stack rechecks the
  retained lease, current container identities, mounts and published listeners without reserving
  sockets. Compose reports a `::` publication beside each `0.0.0.0` one, and some runtimes forward
  only IPv4 loopback, so the `::` row is not required to listen while its `0.0.0.0` twin does; a
  leased port that nothing publishes must stay free on both address families.
- **Capacity.** Cold-start timing applies only to services that `up` actually started; read-only
  health checks do not invent a new duration. The machine disk floor compares current free space
  with an explicitly declared machine floor, independently of generated file sizes; without that
  declaration, host-floor checks do not apply.

`logs` reads one declared service from the selected running stack. `--tail` accepts 1 through 10000
records, and `--since` limits the time range. Records keep their stream and restart details. In the
CLI, interrupting `--follow` returns exit 130 with the records collected before the process group
stopped; programmatic callers must supply an abort signal. Collection is limited in time and output
size; the CLI allows ten seconds for it and reports a timeout as a failure. Output is returned after
collection, including structured records in JSON mode, rather than streamed.

`baseline-record` is experimental. It is the only command that writes an environment baseline, and
it requires you to confirm one exact pair of snapshot and runtime-check results; `preflight`,
`doctor` and `logs` cannot write or advance the baseline. `--interactive`, its only recording mode,
shows the selected stack, the result hashes, the version and the observation time, then asks for
approval in a terminal; it does not work in CI or JSON mode. After approval, the same process
rechecks the runtime and source and writes that pair once; a later run cannot reuse the approval.

## Respond to diagnostic codes

Human output always includes the diagnostic's severity, code and message, followed by its target
and fix when present; JSON output carries the same diagnostic object. The code identifies the
family; it does not make a destructive action safe by itself. After a repair, rerun
`doctor --config <file> --json`, or `preflight --config <file> --json` when the environment must
pass the blocking gate.

### Configuration and setup input

For `CONFIG_NOT_FOUND`, `CONFIG_UNREADABLE`, `CONFIG_ENCODING_INVALID`, `CONFIG_PARSE_INVALID`,
or `CONFIG_SCHEMA_INVALID`, open the named configuration path and fix its encoding, TOML or schema
error. For `CONFIG_CHANGED_DURING_EXECUTION`, stop concurrent edits and retry from a configuration
you have inspected.

`SETUP_CONFIG_REQUIRED`, `SETUP_OPTION_DUPLICATE`, and `SETUP_POSITIONAL_UNSUPPORTED` mean the CLI
input is invalid. Pass exactly one `--config <file>` flag. For `SETUP_PATH_OUTSIDE_ROOT`,
`SETUP_PATH_SYMLINK`, `SETUP_PATH_TYPE_INVALID`, or `SETUP_PARENT_MISSING`, fix the declared
sibling path or its parent. For `SETUP_REMOTE_MISMATCH`, fix the declaration or the existing
remote. For `SETUP_MANUAL_MISSING`, do the declared manual acquisition first.
`SETUP_NONE_ABSENT`, `SETUP_NONE_DIRECTORY`, and `SETUP_NONE_REPOSITORY` mean a checkout declared
with no acquisition is not already present in the required form. `SETUP_POSTCHECK_FAILED` means
the acquired checkout does not match the setup plan; inspect it before retrying.

### State, lifecycle, and execution

For `STATE_ROOT_UNAVAILABLE`, inspect the target path and restore a canonical, writable state path
that is not a symbolic link and is owned by the current user. Existing path components must not be
writable by group or other users; fix their ownership and permissions instead of loosening them.
`STATE_FORMAT_UNSUPPORTED` and `STATE_RECORD_MALFORMED` mean cockpit cannot read a state record;
do not edit it by hand, [clear that cockpit's state](troubleshooting.md#clear-cockpit-state)
instead. As a warning, `STATE_RECORD_MALFORMED` names another cockpit's state that was skipped.
`STATE_LOCKED` means a state write is in progress or cockpit could not verify who holds the lock;
inspect the named holder. `STATE_DURABILITY_INDETERMINATE` means cockpit could not confirm that a
state write reached disk, so do not assume it was saved.

`EXECUTION_PRECONDITION_CHANGED` means an inspected input changed before execution; inspect the
new input and retry. `EXECUTION_SPAWN_FAILED`, `EXECUTION_STAGING_FAILED`,
`EXECUTION_STAGING_CLEANUP_FAILED`, `EXECUTION_TIMEOUT`, `EXECUTION_STDOUT_LIMIT`,
`EXECUTION_STDERR_LIMIT`, `EXECUTION_STEP_FAILED`, and `EXECUTION_ABORTED` name the step that
failed. Use the diagnostic's target and stderr excerpt to fix the named executable, staging path,
timeout, output volume or command. When a generated service build or launcher fails, the
diagnostic includes the last nonempty stderr line only if it is valid text without control
characters and any sensitive values in it can be redacted; otherwise cockpit shows the generic
remedy. Fix the named image error, then rerun `cockpit up`. `EXECUTION_TERMINATION_UNCONFIRMED`
means cockpit sent termination signals but could not confirm that the process group exited.
cockpit keeps its staging directory, does not record the run as finished, and starts no follow-up
cleanup while the process may still be running. Inspect the named process and what owns it,
confirm that it has stopped, then follow the recovery procedure for that state before removing
the kept staging directory. `EXECUTION_COMPENSATION_TIMEOUT` and
`EXECUTION_COMPENSATION_STEP_FAILED` mean the cleanup also failed; check what owns the resources
before running another lifecycle command. `LIFECYCLE_EVIDENCE_INVALID` and
`LIFECYCLE_PROGRESS_INVALID` mean cockpit's lifecycle records or saved progress must be recovered
before you retry.

### Ports, claims, and dependency installation

For `PORT_FAMILY_COLLISION`, find out what owns the listener, then stop your conflicting listener
or change the declared port family. `PORT_FAMILY_OUT_OF_RANGE` needs a valid declared port family;
`PORT_LEASE_EXHAUSTED` needs you to release a lease you have confirmed is stale, or to choose
another valid family. `PORT_LISTENER_EVIDENCE_INVALID` means cockpit could not verify what it saw
listening. `PORT_LOCAL_VALUE_CORRECTED` reports that cockpit corrected a local value; review it
before publishing external configuration. `PORT_EXTERNAL_REGISTRATION_GAP` means a person still has
to register the address with the external service.

`CLAIM_CO_TENANT` means another live holder shares the stack and must not be displaced.
`CLAIM_LIVENESS_UNKNOWN` means cockpit could not tell whether a holder is still alive. For
`CLAIM_STATE_UNHEALTHY`, check who holds the claim and whether it is alive; never remove a claim
only because it is old. For `DRAIN_ATTEMPT_REPAIR_REQUIRED`, follow the recovery described under
[Remove the stack and its data](#remove-the-stack-and-its-data).

For `INSTALL_LOCK_HELD`, wait for the running installer. `INSTALL_LOCK_INVALID`,
`INSTALL_STALE_PATH`, and `INSTALL_LOAD_PROBE_FAILED` mean you must inspect the reported install
path and who owns it before repairing it. `INSTALL_LOCKFILE_CHANGED` means the dependency input
changed and must be read again. For `INSTALL_POLICY_OBSERVATION_UNAVAILABLE`,
`INSTALL_POLICY_OBSERVATION_INVALID`, `INSTALL_POLICY_MISSING`, or `INSTALL_POLICY_AMBIGUOUS`,
make the dependency policy readable and unambiguous before running setup.
`INSTALL_STATE_UNHEALTHY` means the installed result does not satisfy that policy.

### Environment files and runtime

For `TEMPLATE_NOT_FOUND`, `TEMPLATE_NOT_TRACKED`, `TEMPLATE_IGNORED`, or
`TEMPLATE_PATH_OUTSIDE_ROOT`, fix the declared template and keep it tracked inside its sibling
root. For `ENVIRONMENT_FILE_NOT_FOUND`, `ENVIRONMENT_FILE_UNREADABLE`,
`ENVIRONMENT_FILE_TOO_LARGE`, or `ENVIRONMENT_FILE_MALFORMED`, repair the reported generated
environment file. `INSTANCE_NOT_IGNORED` means the generated instance path must be ignored before
cockpit writes it. `ENVIRONMENT_SEED_PRECONDITION_CHANGED` means you must rerun the command so
cockpit inspects again; `ENVIRONMENT_SEED_FAILED` means you must fix the named seed action.
`ENVIRONMENT_KEYS_STALE` means the generated environment keys no longer match the declared inputs.

`RUNTIME_UNAVAILABLE` and `RUNTIME_PROBE_TIMEOUT` mean cockpit could not confirm a healthy local
stack. Start or repair the declared runtime, then run the probe again. `RUNTIME_UNMEASURED` means
cockpit could not verify the probe's inputs or artifacts or they were over their size limits, did
not recognise the runtime, found no measurement of it on this machine, found one taken with a
different engine version, or saw a Compose version below that measurement's floor. The message
names the detected runtime, its `docker info` values and the measurements this machine holds.
Restore safe local artifacts whose digests match, then record a measurement as described in
[Measure the container runtime](#measure-the-container-runtime).
`RUNTIME_COMPOSE_REMOTE` means a Compose file was outside the declared root, referred to a remote
file, could not be parsed safely, or contained a remote or unsupported build, include or extends
source. Replace it with a local Compose file inside the root whose digest matches, with supported
local build contexts. `RUNNING_CHECKOUT_MISMATCH` means the running stack belongs to a different
checkout; switch to that checkout instead of reusing its runtime. `ENVIRONMENT_NOT_DECLARED` means
the configuration declares no runtime; add `environment.compose_files` or `[environment.generated]`
as described in [Environment modes](#environment-modes).

### Reset, reclaim, and baselines

`RESET_CONFIRMATION_REQUIRED` means a person must approve the exact preview interactively.
`RESET_CONFIRMATION_MISMATCH` means the preview changed and must be reviewed again.
`RESET_CO_TENANT` means another holder shares the stack, so reset stays blocked.
`RECLAIM_LABEL_ESCAPE` and `RECLAIM_ACCOUNTING_MISMATCH` mean the resources cockpit would remove go
beyond, or contradict, its ownership records; stop and inspect the reported labels and accounting.
`DOWN_RESOURCES_KEPT` means `down` removed everything it could but some of the stack's own
resources are still in use; release each one as its reason says, then run `down` again.

`EVIDENCE_BASELINE_MISSING` means no baseline has been recorded. `EVIDENCE_UNAVAILABLE` means the
current snapshot or runtime results are incomplete. Get the runtime healthy, review the exact
snapshot, and run interactive `baseline-record`; `doctor` and `preflight` cannot record a baseline.

### Preflight observations

`CONFIG_STALE`, `SIBLING_MISSING`, `GIT_STATE_UNHEALTHY`, `CHECKOUT_ADJACENCY_UNHEALTHY`, and
`GIT_COMPARISON_REMOTE_MISMATCH` mean the configuration or a checkout has drifted. Inspect the
reported path and result, and restore the declared checkout or upstream remote yourself; cockpit
does not rewrite Git state. `GIT_STATE_UNHEALTHY` covers the cockpit repository itself: preflight
passes only when it has a commit and no modified or untracked file outside `.gitignore`, because
the gate vouches for the cockpit as committed, not for local edits. A repository with no commits
yet, such as one `init` has just created, fails this one row with "has no commits yet"; the row's
fix names the `git -C <cockpit root> status --short` review and the `git add -A` and `git commit`
that make the first commit. `GUIDE_CAP_EXCEEDED` means you must shrink the selected guide set.
`SKILL_BUDGET_UNAVAILABLE` and `HARNESS_SURFACE_UNAVAILABLE` mean cockpit could not read the
declared agent inputs; make them readable.

For `MACHINE_MEMORY_BELOW_FLOOR`, `MACHINE_CPU_BELOW_FLOOR`,
`MACHINE_DISK_BELOW_FLOOR`, or `MACHINE_COLD_START_EXCEEDED`, make the host capacity or startup
time meet its declared floor or limit, or deliberately change the declaration.
`DIRECTORY_GRANTS_UNAVAILABLE` means you must restore the declared grants.
`MOUNT_POSTURE_UNAVAILABLE` and `MOUNT_MATERIALIZATION_UNAVAILABLE` mean cockpit could not confirm
the mounts; fix them so they can be checked. `REGISTRY_AUTH_UNAVAILABLE` means the registry
authentication probe did not succeed; fix the registry credentials and rerun. `STATE_UNSEEDED`
means the declared initial seed has not run; do not erase history to make the stack look new.
Resource ceilings for generated services are described under
[Services and dependencies](#services-and-dependencies).

### Generated, dependency, data, and vendor evidence

For generated declaration or input failures (`GENERATED_DECLARATION_MISSING`,
`GENERATED_DECLARATION_INVALID`, `GENERATED_INPUT_INVALID`, `GENERATED_TEMPLATE_INVALID`,
`GENERATED_COMPOSE_INVALID`, `GENERATED_PERSONA_INVALID`,
`GENERATED_PERSONA_SOURCE_UNAVAILABLE`, and `GENERATED_EXECUTABLE_UNAVAILABLE`), fix the declared
generated environment, the persona source or the resolved local executable. Run
`cockpit check --config <file>` before writing the intended files.

For generated ownership and path failures (`GENERATED_OWNERSHIP_MISSING`,
`GENERATED_OWNERSHIP_INVALID`, `GENERATED_OWNERSHIP_DRIFT`, `GENERATED_PATH_DUPLICATE`,
`GENERATED_PATH_UNSAFE`, `GENERATED_PATH_UNOWNED`, `GENERATED_STALE_ARTIFACT`, and
`GENERATED_STALE_ARTIFACT_DRIFT`), inspect the named path and the previous ownership manifest.
Keep changed bytes; do not delete them, and do not add them to the manifest by hand as generated
output. `GENERATED_STALE_APPROVAL_REQUIRED` means the dry run found a stale removal but the apply
has no separate approval for that exact request; review every removal, then run
`sync --interactive` from a terminal outside CI. `GENERATED_STALE_APPROVAL_INVALID` means cockpit
could not build the request safely. Neither result means you may delete files by hand. Ownership
metadata cannot claim the configuration or cockpit's source inputs, including other paths to the
same file. Restore trusted ownership metadata before retrying an input-overlap refusal.

For file or write failures (`GENERATED_ARTIFACT_MISSING`, `GENERATED_ARTIFACT_DRIFT`,
`GENERATED_SOURCE_CHANGED`, `GENERATED_PUBLICATION_FAILED`, `GENERATED_COMPENSATION_FAILED`,
`GENERATED_RENDER_UNAUTHENTICATED`, `GENERATED_INSPECTION_INVALID`, and
`GENERATED_ENVIRONMENT_UNAVAILABLE`), use `check` to see the current drift. Run `sync` only after
reviewing the declaration and its sources. A write or rollback failure keeps the named recovery
inputs; inspect them before retrying. See the full
[`GENERATED_ARTIFACT_DRIFT` recovery steps](troubleshooting.md#generated_artifact_drift).

For decision-log failures (`GENERATED_DECISION_COVERAGE`, `GENERATED_DECISION_DUPLICATE`,
`GENERATED_DECISION_FUTURE`, `GENERATED_DECISION_STALE`, and
`GENERATED_DECISION_SENSITIVE`), fix the declaration and regenerate. Never put credentials or
machine-local paths in it. Whether a decision is right stays `human_needed` after the structural
checks pass.

For dependency-runtime failures (`DEPENDENCY_RUNTIME_UNAVAILABLE`, `DEPENDENCY_RUNTIME_STALE`,
`DEPENDENCY_RUNTIME_UNMOUNTED`, and `DEPENDENCY_RUNTIME_INCOMPATIBLE`),
`INSTALL_STATE_UNHEALTHY`, or a related `EXECUTION_*` failure, restore the exact current container
and image, the physical volume mount, a supported architecture and ABI, and a load probe on the
same mount. Health commands stay read-only and never install dependencies.

`DATA_MODE_UNAVAILABLE`, `EXECUTION_PRECONDITION_CHANGED`, and `EXECUTION_STEP_FAILED` mean the
selected declared data mode must finish, including any restore reservation, before the current
read-only mode and fixture-volume probes run again. Use the recorded applied, attempted and
not-applied IDs; do not assume a step ran because the plan lists it.

For vendor failures (`EXTERNAL_DEPENDENCY_DECLARATION_INVALID`,
`EXTERNAL_DEPENDENCY_TEMPLATE_MISMATCH`, `EXTERNAL_DEPENDENCY_SHADOW_UNAVAILABLE`,
`EXTERNAL_DEPENDENCY_EXPIRED`, `EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE`,
`EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE`, and `EXTERNAL_DEPENDENCIES_UNAVAILABLE`), fix the named
declaration, template pin, shadow or service check, then rerun every declared verifier against the
current stack. Expired, missing, product-owned or untested results stay non-passing.

Surface, sibling link, MCP, skill, selftest, restriction and upgrade diagnostics, with their
remedies, are in [Harness surface failures](troubleshooting.md#harness-surface-failures).

## Where the decisions live

Contributors looking for the source module behind each step should start at
[Architecture](architecture.md#runtime-behavior) and the
[environment code map](../AGENTS.md#environment-code-map).
