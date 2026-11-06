# Environment lifecycle

The reference for cockpit's environment commands: what each does, what it refuses, and how to
recover. For the order to run them in, follow
[Bring the product up](getting-started.md#bring-the-product-up); every flag is in the
[CLI reference](cli-reference.md).

Add `--json` to get the result and any diagnostics as one JSON document on stdout; otherwise the
result is text and diagnostics go to stderr. Every refusal exits nonzero with a named diagnostic
code, and unknown flags are refused.

## Input limits

cockpit checks the size of configuration, registry and adoption files before parsing them, against
the limit in [`config/load.ts`](../packages/cockpit/src/config/load.ts). A file that cannot be read,
is not a regular file, is too large, or changes while cockpit reads it is refused. Make the file
smaller; raising an output or subprocess limit does not change this one.

A skipped registry row produces no `init --registry` draft, because cockpit may no longer know which
repository it applies to.

## Environment modes

`[environment]` is optional. What it declares decides which commands have anything to run.

| Declares | Mode | `sync` and `check` | Runtime commands |
|---|---|---|---|
| no `compose_files` | surfaces only | write and drift-check the harness surfaces | refuse with `ENVIRONMENT_NOT_DECLARED` |
| `environment.compose_files` | compose first | the surfaces, plus `check` reads the Compose topology | run the declared Compose files |

The runtime commands are `up`, `sleep`, `session`, `down`, `reset`, `preflight`, `logs`, `ps`,
`restart`, `rebuild`, `exec` and `runtime measure`. Every mode writes the harness
[surfaces](concepts.md#surface) and checks them for [drift](concepts.md#drift).
[`examples/docs-only`](../examples/docs-only/README.md) and
[`examples/compose-first`](../examples/compose-first/README.md) show the two modes.

- A cockpit that declares only `[environment.machine]` still gets the machine-capacity checks in
  `preflight`, so it is not refused as surfaces only.
- `doctor` reports an undeclared runtime as not declared, not as healthy, and also works from linked
  worktrees and configurations below the checkout root.
- A passing surface check verifies generated files, not running services, hook enforcement or MCP
  startup; those need separate harness checks.

**With no runtime declared,** `sync` and `check` only ask Git which checkout holds the
configuration. No repository, a `.git` entry Git rejects, or Git absent from `PATH` makes the
directory standalone, with a `GENERATED_CHECKOUT_STANDALONE` warning stating why. The generated
files stay valid, but the guard needs a Git repository it can read and holds
[guarded calls](safety-and-autonomy.md#edits-the-guard-has-not-applied) until it has one; held calls
continue without a `sync` once the repository is readable. The guard reads a repository more
strictly than `sync` and `check` do, so a repository-local `include.path` in Git's configuration
raises nothing from them, and the first sign is the guard's refusal or the same reason from
`doctor`. A declared runtime or browser still needs setup's stricter view of the checkout.

### Compose-first stacks

`environment.compose_files` lists paths relative to the cockpit root, and each must stay inside it.
Compose resolves every relative path in those files against the directory of the first listed file,
exactly as `docker compose -f <first> -f <second>` does, so `compose_files = ["shop/compose.yml"]`
runs a product repository's own file unchanged. List files from two directories only when the later
ones name no relative paths.

`check` reads your topology with `docker compose config`, without interpolation, and refuses with
`COMPOSE_TOPOLOGY_UNAVAILABLE` if Docker cannot produce it. It also checks:

| Finding | Level | Why, and the fix |
|---|---|---|
| `COMPOSE_PORT_NOT_LEASED` | fails | A host port not written as a `[ports.bases]` variable, such as `"127.0.0.1:4200:3000"`, collides across worktrees. Write `"127.0.0.1:${API_HOST_PORT}:3000"`. |
| `COMPOSE_PORT_ALL_INTERFACES` | warns | With no host interface, as in `"${API_HOST_PORT}:3000"`, Docker binds every interface and the service is reachable from the network. Name `127.0.0.1`, or `0.0.0.0` when you mean the wider exposure. |
| `COMPOSE_CONTAINER_NAME_FIXED` | fails | Docker allows one container of a name, so a second checkout's stack would fail to start. Remove `container_name` and address the service by its Compose name. |
| `COMPOSE_IMAGE_TAG_SHARED` | fails | With `build` and a fixed `image`, one checkout's build replaces the image another's stack runs. Remove `image`. |
| `COMPOSE_PROFILE_UNDEFINED` | fails | A profile in `environment.profiles` or a `profile:<name>` mount that no service declares: Compose would accept it and start nothing. |
| `COMPOSE_HEALTHCHECK_MISSING` | warns | Without a healthcheck, running is treated as ready. |
| `COMPOSE_IMAGE_UNPINNED` | warns | An image referenced by tag rather than digest. |

`doctor` reports a refusal from this check as itself, with its fix. `init` shows the port, container
name, shared image tag and healthcheck findings beside the drafted `cockpit.toml` as warnings; it
never edits a Compose file.

cockpit never edits your Compose files. `sync` writes `compose.cockpit.yml`, an override cockpit
owns that adds ownership labels to every service, the default network and every named volume that is
not `external`. Runtime commands pass it after your files only while it matches what cockpit would
generate now. A Compose `include` is refused with `GENERATED_DECLARATION_INVALID`, because Compose
reads an included file from disk, outside the verified snapshot, and cockpit could not label its
services; list the file in `environment.compose_files` instead.

Runtime commands give Compose only the leased `[ports.bases]` variables, each `[[sibling]] var` set
to that sibling's absolute directory, and cockpit's own stack and holder identities. Any other
`${VAR}` reference needs a `:-default`. Compose's automatic loading of the project `.env` file is
turned off, because a file cockpit has not checked must not change the topology it has checked. The
topology check does not read service `env_file` contents either, so service secrets never enter
cockpit's records; Compose still passes those files to the containers.

Mounts must match the declaration in both directions:

- Each `mount = "always"` sibling must be bind-mounted, whole or a directory inside it, through its
  variable (`"${WORKER_DIR}:/srv/worker"`) or a path relative to the first Compose file. Otherwise
  `check` fails with `COMPOSE_SIBLING_NOT_MOUNTED` and `up` refuses; or set `mount = "none"`.
- Each `environment.generated_host_paths` entry must reach a container: bound itself, through a
  directory inside it, or inside a bound directory. Otherwise `check` fails with
  `GENERATED_HOST_PATH_UNMOUNTED`.
- A container gets only what `cockpit.toml` declares. A bind outside those, or one that leaves its
  sibling through a symbolic link, fails `check` with `COMPOSE_BIND_UNDECLARED`, and `up` refuses
  it.

### Scaffold a Compose file

A small app with no Compose file can get a starting one, once:

```sh
npx --no cockpit init . --scaffold-compose api --port 3000 --with postgres,redis
```

`--scaffold-compose` names the app directory relative to the cockpit root and `--port` the port the
app listens on inside its container. The app builds from its Dockerfile; without one, a directory
with a `package.json` runs on `node:22-alpine` and needs `--command "npm start"` or whatever starts
it. `--with` adds `postgres` or `redis`, each on a pinned major version with a healthcheck, a named
volume and its URL in the app's environment. The command prints the `[ports.bases]` variable and
`resettable_volumes` entries to declare.

`check` then warns that the app service has no healthcheck and that the images are pinned by tag.
The file is yours from then on, and the scaffold refuses with `INIT_SCAFFOLD_COMPOSE_EXISTS` when
the cockpit root already holds any Compose file.

### Compose profiles

`environment.profiles` lists the profiles every `up` and `session` activates, and
`--profile <name>`, repeated for several, adds more for that run. A sibling declared
`mount = "profile:<name>"` is mounted, and checked as mounted, exactly while its profile is active;
the generated agent files follow `environment.profiles`.

The stack records the profiles it started with, and every later command on it activates the same
set, so `down` removes the profile services too. Adding a profile changes what the stack runs, so
`up` refuses it on a running stack with `LIFECYCLE_PROGRESS_INVALID`: run `down`, then
`up --profile <name>`. `check` judges each service's bind mounts under the default set and under the
default set plus each other profile.

## Local URLs and port families

Write each published port with an explicit loopback binding, as in
`"127.0.0.1:${API_HOST_PORT}:3000"`; use `::1` for IPv6, or `0.0.0.0` only when you intend that
exposure. cockpit does not rewrite your published interfaces.

Stack *n* publishes each `[ports.bases]` value plus *n* × `ports.step`, for up to `ports.count`
stacks (defaults: step 100, count 27). `up` leases a whole port family under one lock shared by
every cockpit your user account runs with the same canonical
[state root](troubleshooting.md#clear-cockpit-state). It skips any family holding a port another
cockpit's active lease holds, then checks that no other program is listening. An overlap costs a
candidate family, never a shared port. A retained lease keeps its family. Other user accounts and
separate state roots, including different Linux `XDG_STATE_HOME` settings, are not coordinated; only
the listener check separates them.

The listener check looks on IPv4 loopback when ports are first allocated. It does not reserve the
port, does not see a listener bound only to IPv6, and cannot stop another process binding the port
afterwards. If startup reports a bind failure, resolve the conflicting process and rerun
`cockpit up --config cockpit.toml`. The lease stays reserved until cockpit has confirmed its
cleanup, even when its holder is no longer running.

### Named local URLs

Entrypoint derivatives turn a port lease into application origins and other declared addresses. Add
an optional `hostname` and `scheme` for a named local URL:

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

`cockpit up --config cockpit.toml --json` returns `https://app.sample.localhost:<leased-port>/`.
Omitting `hostname` uses `127.0.0.1`; omitting `scheme` uses `http`. These declarations set no
environment variables in the application: configure the product's public origin and callback
settings to match the returned address.

Names must be lowercase DNS subdomains of `.localhost`, which
[RFC 6761](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3) reserves for loopback. Arbitrary
suffixes, bare `localhost`, wildcard names and embedded ports are refused. Use a distinct hostname
per project, because
[cookies are not isolated by port](https://www.rfc-editor.org/rfc/rfc6265.html#section-8.5).

Inside a container, loopback is that container's own, so a product container calling the
host-published URL needs its own `extra_hosts` mapping; service-to-service traffic normally uses
Compose service names. `browser.resolver` supplies mappings only to the browser the `browser`
commands launch, not to a remote browser, MCP server or other client.

`scheme = "https"` only declares a URL; the product's stack must serve TLS on that leased port.
cockpit does not install trust roots, change host DNS or start a shared HTTPS proxy. To set it up:

1. Provision a certificate whose subjectAltName covers the exact hostname. Port offsets do not
   change the certificate identity.
2. Keep private keys outside tracked files and build contexts, and mount only the leaf key into the
   TLS service.
3. Explicitly trust the issuer in each runtime that connects. Clients need the public CA
   certificate, never the CA signing key.
4. Rerun `cockpit up --config cockpit.toml` and open the returned URL with certificate validation
   enabled.

[Compose patterns](compose-patterns.md#serve-tls) shows a TLS service in front of the app.

## Sibling and template paths

`sync` and `check` require each declared [sibling](concepts.md#sibling-repository) directory to
exist inside the siblings root, both as written and after following links. Get missing checkouts
onto disk, for example with `cockpit setup`, before `sync`.

`doctor` and `preflight` inspect every declared environment file in every sibling and list all
failing paths, so one healthy file cannot hide another's missing instance or stale key names.
Restore the checkout or bring its instance keys in line with its template. When no sibling declares
an environment file, these checks pass.

## Serve a sibling from a worktree

Point a sibling at another checkout of its repository, usually a linked worktree, for this cockpit
checkout:

```sh
npx --no cockpit use api /path/to/api/.worktrees/feature --config cockpit.toml
npx --no cockpit use api --clear --config cockpit.toml
```

`use` accepts the root of a checkout that shares the declared checkout's object store, or whose
`origin` names the same repository as the declared checkout or its `remote`; anything else is
refused with `SIBLING_CHECKOUT_FOREIGN`. A path reaching it through a symbolic link is refused. The
choice is recorded in `.cockpit/local/sibling-checkouts`, never in `cockpit.toml`.

`up`, `logs`, the guard's allowed roots and protected instance files, `doctor`, `preflight`, work
orders and `docs check` all use the recorded checkout, and each refuses with
`SIBLING_CHECKOUT_UNAVAILABLE` once it is gone. `doctor` and `preflight` name each one
(`SIBLING_CHECKOUT_OVERRIDDEN`) and warn with `SIBLING_ENVIRONMENT_FILE_MISSING` for every declared
environment file the worktree lacks: cockpit never copies ignored files from another checkout.

A running stack keeps the checkout it mounted: run `down` and `up` after `use`. An agent may run
`use` for a checkout inside a directory it may already write; any other path is a person's call. A
worktree inside the declared checkout stays reachable through the committed grants. For one outside
it, `use` grants the tools that read a machine-local setting, and `--clear` takes that back:

- **Claude Code**: `use` adds the checkout to `permissions.additionalDirectories` in
  `.claude/settings.local.json` and removes only that entry later. It refuses a file it cannot
  parse, because Claude Code ignores such a file entirely.
- **OpenCode**: `use` writes the checkout to the machine-local grant file `sync` writes for the
  sibling.
- **Codex** has no machine-local setting for extra writable roots: start it with
  `--add-dir <checkout>`.
- **Cursor** and **Grok Build** have no measured grant, so `use` writes nothing and they may ask
  before editing.

`use` lists which tools got the grant (`agentGrants` with `--json`). Restart a running agent so it
reads the new grant. [Harness surfaces](harness-surfaces.md#sibling-projection-and-standing-cost)
records what was measured.

## Bring checkouts up to date

`cockpit pull --config cockpit.toml` fetches and fast-forwards the cockpit and every sibling
checkout, including one `use` recorded, to the upstream of its branch. It never merges, rebases,
stashes or switches branch, and runs no Git hooks, so an agent may run it without asking.

A checkout with modified tracked files, a diverged branch, a missing upstream or a failed fetch is
left as it was and reported with `PULL_SKIPPED` and the command that resolves it; a detached HEAD or
a branch tracking nothing is listed and skipped without a warning. Its Git reads only each
repository's own configuration, so a credential helper set only globally is not used, and a
repository whose attributes name a filter defined only there, such as Git LFS, is skipped rather
than checked out as placeholder files; run `git pull --ff-only` in it yourself.

## Lifecycle and ownership

`setup` gets the declared sibling checkouts onto disk and wires them up. `mount` controls how the
stack uses a checkout and `acquire` how it gets onto disk; the two are independent. Setup looks at
declared secret-file paths but never reads or copies their contents.

**Instruction pointers.** With `instruction_pointer = true`, plain
`cockpit setup --config cockpit.toml` only reports the proposed path, so an agent cannot silently
change the instructions later agents load. After a person reviews the exact block,
`cockpit setup --config cockpit.toml --write-instruction-pointers` appends that marked block, which
links to the **AGENTS.md** beside the selected `cockpit.toml`, and keeps every other byte. A missing
guide is created only by this approved write. Edited, partial or duplicate marked blocks, redirected
directories and invalid UTF-8 are refused.

**Instruction files.** An agent started inside a sibling loads only what its own tool reads: Codex
and OpenCode read **AGENTS.md**, Claude Code reads **CLAUDE.md**, as runs of each tool beside a
decoy file showed. Every tool gets the same instructions only when AGENTS.md holds them and
CLAUDE.md imports it with `@AGENTS.md`. `doctor` warns for every sibling laid out otherwise:

| Code | Layout |
|---|---|
| `SIBLING_INSTRUCTIONS_AGENTS_ONLY` | only AGENTS.md |
| `SIBLING_INSTRUCTIONS_CLAUDE_ONLY` | only CLAUDE.md |
| `SIBLING_INSTRUCTIONS_UNLINKED` | both, with no import |
| `SIBLING_INSTRUCTIONS_MISSING` | neither |
| `SIBLING_INSTRUCTIONS_TOOL_ONLY` | files such as **.cursorrules** or **GEMINI.md**, which none of those tools load |

Setup proposes the two changes that need no judgement, and makes them only when a person runs
`cockpit setup --config cockpit.toml --write-instruction-files` after reviewing them: a sibling with
only AGENTS.md gets a CLAUDE.md holding `@AGENTS.md`, and one with only CLAUDE.md has it copied byte
for byte to AGENTS.md and replaced by `@AGENTS.md`. It proposes no move when CLAUDE.md imports other
files with `@`, because only Claude Code would follow those imports from AGENTS.md. It writes only
ordinary files, never through a link, and refuses a file that changed after it was read. Merging two
diverging files, or writing a first AGENTS.md, stays a person's.

### Start or resume the stack

`up` starts the selected stack, or resumes it. It records a holder it newly adds separately from an
existing one, so if the start fails, cockpit undoes only the holder that attempt added. Before
resuming, it checks that the saved progress still matches the current lifecycle record, runtime and
port lease. If so, it rechecks the services that completed and resumes the rest; if not, it discards
that progress before touching containers left by the earlier attempt. After the first seed, missing
saved progress blocks startup. Restore that state rather than delete it: deleting it would make the
stack look like a fresh environment when it is not.

When a service `up` started does not become healthy, cockpit reports its last log lines as one
diagnostic, then stops its container and keeps it, so a restart policy cannot leave it restarting.
Failure logs are limited to that service and time window, and never follow the process that failed.
The holder and lease stay, so the next `up` resumes and `down` removes the stack.

`up` times the start, from the earliest recorded service start to the moment the last newly started
service reports healthy. Over `cold_start_seconds` it refuses with `MACHINE_COLD_START_EXCEEDED`;
the configuration refuses a budget above 3600 seconds, the longest `up` holds one start open. A
result reports `coldStart.measuredMillis`, `limitMillis` and `headroomMillis`. A partial resume
times only the services that run started, and joining a running stack reports no duration rather
than an invented one.

### Release the stack

`sleep` removes the current holder and stops the shared runtime only when no other holder remains,
so one holder cannot stop another's environment. Stopping also releases the port lease; the next
`up` may land on a different family, so read the ports and entrypoints it returns. `stackId` names
the shared runtime and `checkoutId` one checkout; two checkouts with the same stack ID are still not
interchangeable.

`session` runs `up`, keeps that holder while one foreground command runs, and runs `sleep` only
after confirming the command's process group stopped. A command that prints nothing still counts as
running. Interrupting the wrapper stops only the process group it started, then sleeps. If cockpit
cannot confirm the group stopped, it keeps the holder so you can clean up explicitly. Lifecycle
commands run inside the wrapper use the same private identity, and a second `session` wrapper is
refused. Once cleanup completes, `session` exits with the command's own status, or 128 plus the
signal number when a signal ended it. It exits 2 when cleanup fails and 130 when you cancel it.

The command gets the stack's addresses in its environment:

- each `[ports.bases]` name holds the leased port, as in `API_HOST_PORT=4210`;
- each entrypoint `up --json` returns is under `COCKPIT_ENTRYPOINT_` plus its upper-case name with
  hyphens as underscores, as in `COCKPIT_ENTRYPOINT_API_HOST_PORT=http://127.0.0.1:4210/`.

These replace a value of the same name in the calling shell, are read once at start, and do not
follow a later `down` and `up`. When the command ends, the session releases only its own hold: a
stack an earlier `up` from this checkout still holds keeps running, and the session says so with
`SESSION_STACK_RETAINED`.

A wrapper that dies without its closing `sleep`, from SIGKILL, a crash or a closed terminal, leaves
its hold behind. A session records its wrapper's process ID and start identity (on Linux the start
in clock ticks since boot from `/proc`, which a wall-clock step does not move; elsewhere the start
time `ps` reports), so the next `up`, `sleep`, `down` or `reset` from the checkout sees the process
is gone, or its ID now belongs to another process, and releases the hold. When it was the last hold,
the command's own hold takes the running stack over. A hold whose process still runs is kept, and so
is one whose start could not be read while its process ID is in use: the `CLAIM_CO_TENANT` refusal
names each holder and process ID, so you can confirm with `ps -p` that it is that session, end it
and retry. A process ID can be reused, so a hold standing on one alone may name another process.

The wrapper passes this identity to its command in `COCKPIT_SESSION_PROCESS`, so a hold that a
`sleep` and then an `up` inside the session re-add stays tied to the wrapper. `up` refuses with
`CLI_USAGE_INVALID` when the wrapper has ended or the value is malformed.

Docker sends SIGTERM and waits ten seconds before killing. A service whose PID 1 ignores SIGTERM, as
`node` does unless the program handles it, pays the whole grace at every stop: add `init: true` to
it in your Compose file, or handle SIGTERM.

### Remove the stack and its data

`down` removes only containers, networks and images carrying this stack's ownership label, and
reports and keeps anything it cannot show is this stack's. Ownership is the stack's identity, not
the configuration, so a container or network an earlier `cockpit.toml` started is removed too. An
image the stack built is removed unless it has a second tag. Volumes stay, because only `reset`
deletes data.

When one of the stack's own resources has to stay, `down` refuses with `DOWN_RESOURCES_KEPT` and
names each and the reason. It clears startup progress only after confirming the removals. It also
retires a stack that `sleep` or an ended `session` left stopped, with no need to run `up` first.
While another session holds the stack, it refuses with `CLAIM_CO_TENANT` and names that holder and
process.

`reset` first shows an exact preview of the declared volumes and generated host paths it would
delete. Plain and `--json` calls delete nothing. Interactive reset needs a person at a terminal
outside CI; the approval stays with the process that showed the preview, which checks everything
again before it acts. `down` and `reset` delete only from a local Docker daemon
([Choose the Docker daemon](#choose-the-docker-daemon)).

Name each `environment.resettable_volumes` entry by its top-level `volumes:` key in the Compose
file, not Docker's prefixed name. `sync`, `check` and every runtime command refuse a name no
declared volume has, and an `external` volume, because cockpit cannot label it. A declared volume
that does not exist yet is left out of the preview. A volume an earlier `cockpit.toml` created is
still this stack's data, and `reset` deletes it.

Every destructive action is recorded durably before it starts. If cockpit is interrupted, a detached
supervisor keeps track of that attempt; the next `sleep`, `down` or approved `reset` has it stop the
action's process group, confirms the group is gone, and retries the saved action. If the target was
already removed, cockpit checks again and marks the action complete. `DRAIN_ATTEMPT_REPAIR_REQUIRED`
means the attempt marker, supervisor identity, control socket or stop confirmation did not match;
cockpit then keeps the attempt and refuses any overlapping cleanup. Do not remove its state or
runtime resources by hand: that destroys the records it needs to repair safely.

### List and prune stacks across the machine

Deleting a worktree leaves its containers, network, volumes and lease behind with no checkout left
to run `down` from. `stacks` lists every stack this machine knows about, whichever cockpit started
it, and changes nothing:

```sh
npx --no cockpit stacks --config cockpit.toml --json
```

It attributes a resource to a stack only when all of cockpit's ownership labels are present and well
formed; nothing is attributed by its name. Each row gives the cockpit, stack, Compose project,
checkout, state record, containers, networks, volumes, port lease, last activity, and a verdict with
the reason.

A stack's checkout is proven, never guessed: Compose's label for the directory each container ran
from, or the checkouts Git records for the cockpit's main checkout. `checkout.source` says which.
The checkout is `present`, `missing`, `replaced` (the path is no longer a checkout of that cockpit)
or `unknown`. A worktree whose path does not exist while Git still registers it, or marks it locked,
is `unknown`: an unmounted drive or a checkout moved without `git worktree repair` looks exactly
like that. Once it is really gone, `git worktree prune` in its main checkout (after
`git worktree unlock` for a locked one) lets `stacks prune` remove its stack.

A stack is `orphaned` only when its checkout is proven `missing`. Every other stack is kept: one
whose checkout exists or cannot be found, one a `down` or `reset` is still draining, the current
checkout's own, and one whose state this version cannot read, because a newer version may still use
it. A state folder this version cannot read is listed; one in the colon spelling an earlier build
used is orphaned once none of its stacks is kept, and one named as current versions name their state
is kept.

`stacks prune` shows exactly what it would remove and a digest of it, and removes nothing:

```sh
npx --no cockpit stacks prune --config cockpit.toml
npx --no cockpit stacks prune --config cockpit.toml --apply
```

`--apply` observes the machine again and removes only while the plan still has the previewed digest:
each orphan's containers, networks and labelled volumes, then the state records holding its lease,
then the orphaned state folders. State is removed only while every file still holds the bytes the
preview read, under the lock `up` takes to lease ports. A failed step stops with
`STACKS_PRUNE_INCOMPLETE`, and running `--apply` again resumes. The result is reported only once a
fresh inventory no longer lists what was removed.

Removing an orphan is housekeeping, so `--apply` runs for an agent. A prune that deletes volumes
deletes data and follows the reset gate: it runs only where `[autonomy] reset` lets the caller
reset, and otherwise a person runs `stacks prune --interactive` in a terminal and types the digest.
That gate is this cockpit's own policy, so `--apply` removes only this cockpit's orphans and the
state folders an earlier build left. The preview lists every orphan, marks each with `thisCockpit`,
and warns with `STACKS_PRUNE_UNCONFIRMED` that another cockpit's are removed only by a person's
`stacks prune --interactive`, which covers the whole machine. `doctor` warns with `STACKS_ORPHANED`
when a stack of this cockpit has lost its checkout or a state record cannot be read, without asking
Docker.

### Change a running stack

A stack's identity is a digest of the Compose files and of the `cockpit.toml` declarations that
reach its containers, not of the bytes of `cockpit.toml`. Editing a sibling's `purpose`, the guards,
MCP, skills, surfaces, comments or formatting leaves a running stack alone. So do the fields the
host checks rather than the containers receive: `[environment.machine]` (including
`cold_start_seconds`), `addressing`, `authentication`, `posture_requirements`, `resettable_volumes`,
`seed` and `entrypoint_derivatives`. Those need only `sync`.

A change to a Compose file, ports, mounts or anything else the containers receive gives the stack a
new identity, and `up` refuses with `LIFECYCLE_PROGRESS_INVALID` rather than replace the running
stack in place. To apply one, for example a `[ports.bases]` edit:

1. Edit `cockpit.toml`. This can happen while the stack runs.
2. Run `cockpit sync --config cockpit.toml`. Until then, the guard holds every
   [guarded tool call](safety-and-autonomy.md#edits-the-guard-has-not-applied) except that sync, and
   `sleep` and `down` refuse because they read the Compose files `sync` publishes. An agent may run
   it where `[autonomy] sync = "agent"` and the edit does not widen what agents may do, as a
   `[ports.bases]` edit does not; otherwise a person runs it in a terminal.
3. Run `cockpit down --config cockpit.toml`. It finds the stack and its lease by the stack, not by
   the edited declaration, and refuses with `CLAIM_CO_TENANT` while another holder remains.
4. Run `cockpit up --config cockpit.toml --json` and use the newly returned ports and entrypoints.

Restoring `cockpit.toml` to the exact bytes `sync` last saw, for example with
`git restore cockpit.toml`, clears the guard's hold without a `sync`.

### When a sibling changes under a running stack

A bind mount follows a sibling's files at once, but installed dependencies usually live in an image
or volume built earlier, and the database keeps the schema it was migrated to. When `up` starts a
stack it records a digest of each mounted sibling's lockfiles and of its `rebuild_inputs`, such as a
migrations directory. Lockfiles come from the `environment.install_policies` rows for the sibling's
toolchain, or, without one, from the common lockfile names present; each finding names its source.
`doctor` and `preflight` warn with `STACK_INPUTS_CHANGED` when any of them, or the checkout serving
the sibling, changed since, and `pull` warns after moving one.

Run `down` and then `up`, rebuilding first an image that installs the dependencies. A resumed `up`
keeps the record; `down`, or a `sleep` that stops the stack, drops it. It is a warning, not a
refusal: whether a changed lockfile matters is the product's call, and `test-run` does not block on
it.

## Choose the Docker daemon

Every command uses the daemon Docker itself would select: `DOCKER_HOST` when set, otherwise the
context `DOCKER_CONTEXT` names, otherwise the active context. Four commands fix that daemon once,
before their first step, and address only it:

| Command | Why it fixes the daemon |
|---|---|
| `down`, `reset` | they delete; reading the context per step could list one daemon and delete from another if `docker context use` ran mid-command |
| `stacks` | `stacks prune` deletes, for the same reason |
| `runtime measure` | the measurement must describe the daemon `up` will use, not one selected while the probe ran |

None of them needs a prefix, so they run as printed:

```sh
npx --no cockpit down --config cockpit.toml
npx --no cockpit runtime measure --config cockpit.toml --image node:22-alpine
```

The daemon's endpoint must be an absolute `unix://` socket path. TCP, SSH and other transports are
refused, because a remote daemon could receive a deletion and its behaviour says nothing about this
machine. A `DOCKER_HOST` that is not local is refused with `CLI_USAGE_INVALID`; a context that is
not local, or whose endpoint cannot be read, with `RUNTIME_UNAVAILABLE`, naming the context and
endpoint. For `down` and `reset`, conflicting selections and a TLS override are refused too.

## Compose project name

Every Compose command passes `--project-name <cockpit.name>-<stack>`, where `<stack>` is the first
12 hex digits of the stack ID. The stack ID comes from the cockpit's main checkout and the current
checkout, so two cockpits sharing a name, or two checkouts of one cockpit, get separate projects on
one daemon. It never depends on the bytes of `cockpit.toml`.

Containers, networks and named volumes carry that name, such as `shop-cockpit-3f2b3aead733-api-1`;
your own file's `name:` is overridden. To look at the stack with Docker directly, find the project
with `docker compose ls`: `docker compose --project-name shop-cockpit-3f2b3aead733 ps`. Renaming
addresses a different stack, so [run `down` first](getting-started.md#rename-a-cockpit).

## Measure the container runtime

`up`, `session`, `down` and `reset` refuse with `RUNTIME_UNMEASURED` unless the runtime Docker
selects has been measured on this machine. `sleep` and `logs` fail while a running stack's runtime
no longer matches a measurement, for example after an engine upgrade. `preflight` and `doctor` only
report an unmeasured runtime, as an unavailable check. A measurement is a fact about one machine, so
it is never written to `cockpit.toml`.

cockpit identifies the runtime from one `docker info` reading of `OperatingSystem`, `Name` and
`OSType`:

| Runtime identity | Recognised by | Provenance |
|---|---|---|
| `docker-desktop` | `OperatingSystem` is `Docker Desktop` | vendor `docker info` output, not probed |
| `orbstack` | `OperatingSystem` is `OrbStack` | observed on an OrbStack host |
| `colima` | `Name` starts with `colima` | vendor `docker info` output, not probed |
| `rancher-desktop` | `Name` ends with `rancher-desktop` | vendor `docker info` output, not probed |
| `docker-engine` | a Linux host whose daemon reports `OSType` `linux` | vendor `docker info` output, not probed |

Any other reading, including an unrecognised VM on macOS, is never accepted; the refusal lists the
raw values so you can report them.

```sh
docker pull node:22-alpine
./node_modules/@b00dea/cockpit/bin/cockpit.mjs runtime measure --config ./cockpit.toml --image node:22-alpine
```

The probe runs in a throwaway directory: a candidate stack exercising profiles, bind mounts in both
directions, labels, health, logs, recovery and teardown, next to a deliberately broken Compose file
the runtime must reject. It uses only the local image you name and never pulls, runs only from an
installed `@b00dea/cockpit` package, and only against a [local daemon](#choose-the-docker-daemon).

Its project is `<cockpit.name>-probe-<id>`, and it removes what it creates before returning. If a
measure was killed first, the next one removes that cockpit's leftover probe resources and temporary
directory and lists them. Each probe resource carries a `dev.b0dea.cockpit.probe-owner` label naming
its process, so only resources whose process is gone are removed; anything that may belong to a
running measure is left and named. It refuses to probe when a leftover cannot be removed.

A pass records the measurement in `machine/runtime-measurements.json` under cockpit's per-user state
root, so every checkout on this machine measures once. The record is keyed by runtime identity and
daemon name and holds the engine version and the Compose version, which becomes the Compose floor.
Switching between two runtimes needs one measurement each. A failed measurement records nothing.

`up` admits the runtime only when the record has a row for the same runtime and daemon, with the
same engine version and a Compose version at or above the floor, so an engine upgrade needs a new
measurement. Recording changes no committed file, so an agent can run it before its first `up`
without waiting for a human `sync`. `doctor` names the measurement that admitted the runtime in the
`RUNTIME_UNMEASURED` check's source.

## Secret sources and environment schemas

**Where things live.** Keep each component's `.env.schema` tracked beside its application; if its
ignore rules match `.env.*`, explicitly allow `.env.schema`. The schema declares variable names,
validation and how a provider resolves each value, so review its resolver code and dependency lock
as you would product code. Put encrypted resolver expressions or external-provider references in
`env/.secrets/<cockpit-project>/<component>`, which the generated guards keep agents from changing
or staging.

Let `sync` write the generated ignore block in the cockpit's `.gitignore` before any secret material
exists, and leave it as generated: ignoring the `env/.secrets/` directory itself would defeat its
exception for `env/.secrets/.gitignore`. Create the directories with mode 0700 and no symbolic
links, and resolver files with mode 0600 through your own approved provisioning. cockpit does not
create those files or their values.

**Adopting [Varlock](https://varlock.dev).** Inspect environment filenames and declared commands
without reading plaintext values. Existing dotenv files or templates trigger an adoption decision
even without a schema; record it or the reason for deferring. `init` and `doctor` recommend adoption
with `ENV_SCHEMA_UNDECLARED` when an immediate cockpit or sibling root contains `.env`, `.env.*` or
`env.template` without `.env.schema`; discovery reads file names and types only, and does not make
Varlock a prerequisite. The shipped setup procedure explains adoption through the product's pinned
dependency and an existing declared command or script.

Use agent-mode validation for status and `run --inject vars --redact-stdout` inside that declared
command for a trusted product process, keeping resolved credentials out of the agent's environment.
Varlock refuses `--redact-stdout` on an interactive terminal, so a person in a terminal runs the
same `run` without the flag. Give both paths as absolute repeated `--path`: the component schema
root first, then its central resolver directory; the later path wins. Installation, initialization,
provider login, encryption and migration need explicit permission from whoever owns the product and
the provider. See the [Varlock CLI reference](https://varlock.dev/reference/cli/load-and-run/) and
[AI tools guide](https://varlock.dev/guides/ai-tools/).

`--redact-stdout` redacts the spawned process's output, not Varlock's own diagnostics. With that flag
set, a parse error printed the offending source line and a failing `exec()` printed its command and
stderr, all on Varlock's stderr (measured with synthetic values on Varlock 1.23.0, 2026-11-06). Keep
those diagnostics with the operator. Cockpit's schema probes read only Varlock's report, and keep key
names and status.

**Moving an existing dotenv file.** Varlock evaluates env files, including gitignored ones such as
`.env.local`, so a copied file is not inert data. In the same measurement, a bare `exec(...)` and a
`$(...)` that was bare, embedded in a bare value or inside double quotes each ran the command when
the file loaded. Only single quotes kept `$(...)` literal, and `\'` kept a single quote inside one.
A password holding `$(` can therefore run a command on the next `preflight` or `doctor`, so
single-quote every migrated value and review resolver expressions as code.

**What the probe does.** `cockpit preflight` and `cockpit doctor` look at every `.env.schema` a
sibling tracks (`git ls-files`), plus a sibling's root schema whether tracked or not and the cockpit
root's own, and load each one that is [committed](#a-schema-runs-only-once-committed). In a sibling
that is not a Git repository only the root is looked at; Git failing otherwise, or more than 64
tracked schemas, makes that sibling unavailable. On a cockpit with no runtime, `preflight` refuses,
so `doctor` reports schema status.

Each schema runs `varlock load --agent --format json-full --path <schema directory>` with
`VARLOCK_TELEMETRY_DISABLED=true`, a timeout, a 256 KiB output cap and every `_VARLOCK_*` variable
removed, adding `--path <cockpit root>/env/.secrets/<cockpit name>/<slug>[/<relative dir>]` when
that directory exists (`env/.secrets/<cockpit name>` for the cockpit root's own schema). That
directory is checked with file metadata only; a symbolic link on the way to it, or a failure other
than its absence, makes the schema unavailable. A sibling is read from the checkout `cockpit use`
serves. A linked worktree of the cockpit with no store uses its main checkout's, at the same place;
a repository laid out any other way, or Git failing, leaves the schema with no store.

Only key names and a category are kept; values and Varlock's messages are discarded. Each row below
is `ENV_SCHEMA_UNHEALTHY`, with schemas labelled `<slug> (<relative dir>)`.

| Varlock reports | Row | Named as |
| --- | --- | --- |
| The required-empty message for a key | fails | `missing required <keys>` |
| Any other key error, such as a failed resolver or a value that does not coerce | unavailable, unless another key is missing | `could not validate or resolve <keys>` |
| An error at the root of the report, such as a bad plugin | fails | `schema could not be loaded` |
| A timeout, or an exit without a readable report | unavailable | the cause |

A key that could not be resolved is not called invalid: the provider may be signed out or
unreachable. Sign in and rerun. To diagnose, a person runs
`VARLOCK_TELEMETRY_DISABLED=true varlock load --path <schema directory> --path <central directory>`,
leaving out the second path where it does not exist. `ENV_SCHEMA_OVERRIDDEN` warns without failing
the row when a key is satisfied by the shell that ran the command rather than the schema's own
sources; unset it and rerun.

### A schema runs only once committed

Loading a schema runs its resolvers, including `exec()`, with the caller's environment, and a schema
is exempt from the secret-file denial, so an edited one could otherwise run commands through an
unprompted `doctor`. Before loading, the probe asks Git in the schema's directory, with
`git status --porcelain=v1 -z` and `git ls-files -v`, whether the file is tracked and identical to
HEAD, because a commit is a guarded, visible step and an edit is not.

A schema that is edited, staged, untracked, ignored, hidden behind Git's assume-unchanged or
skip-worktree flag, a symbolic link or outside a repository is not run. Its row keeps passing, and
`ENV_SCHEMA_UNCOMMITTED` warns, naming the schema and the fix: commit it to have it validated, or
have a person review it and run the `VARLOCK_TELEMETRY_DISABLED=true varlock load` the warning
prints. While another schema fails or cannot be checked, the row reports that instead, and this
warning appears once it clears. Git failing for any other reason makes the schema unavailable, again
without running Varlock.

**The limit.** This does not cover an agent's commit that a person approves, local plugin or
`@import` files beside a schema, or declared test commands, which also run edited code. It checks
the schema alone: gitignored env files beside it and the central store load unchecked, and what
keeps agents out of those is the guard's secret-file denial. An agent
that can get a schema committed can have commands run, with your environment, by a `doctor` or
`preflight` it may run unprompted. Cockpit is not a sandbox: review schema changes as you review
code, and run `doctor` with a provider sign-in only on schemas you trust. This was reasoned from
Varlock's documented resolver behaviour plus a failing `exec()` measured with a synthetic schema.

### Varlock on PATH

The probe uses `varlock` from your `PATH`, not the product's locked copy, so a product with only a
local install sees `ENV_SCHEMA_TOOL_MISSING`, a warning rather than a failure.

Secret-manager resolvers, such as vault or 1Password, may need their own sign-in and environment.
The probe passes your environment through, never prompts because its stdin is closed, and reports a
timeout as unavailable. This was measured only with a failing synthetic resolver, not a real
provider.

Set `VARLOCK_TELEMETRY_DISABLED=true` in product-owned Varlock wrappers too. Cockpit's probes always
disable telemetry but do not modify global Varlock settings; see
[Varlock's privacy documentation](https://varlock.dev/privacy/).

Report only variable names, validation state, exit status and where each value came from. Raw
resolver output, resolved values and browser state do not belong in work-order results. Git ignore
rules, filesystem permissions, encryption and output redaction do not protect secrets from malicious
code running as the same user, and trusted product child processes receive plaintext variables. A
stronger boundary needs a separately tested sandbox and provider policy. What the guard refuses, and
which native tools it reaches, is in
[Reading secrets and instances](safety-and-autonomy.md#reading-secrets-and-instances).

### Read variable names and schemas

Native rules can refuse an agent these documentation files
([measured](safety-and-autonomy.md#reading-secrets-and-instances)), so two commands read them. Both
find the same directories as the probe, in the checkout `cockpit use` serves, run no Varlock and no
resolver, never follow a symbolic or hard link, and run without a prompt.

`npx --no cockpit env keys --config cockpit.toml` is the narrower choice when only names are needed.
For each `.env.schema`, or a directory's `.env.example`, `.env.sample` and `.env.template` where it
has none, it prints the path, whether it is a `schema` or `template` source, and each key's `name`.
A key shows `required`, `sensitive` and a bare `type` only when a decorator directly above it
declares them, or `@defaultRequired` or `@defaultSensitive` above the `# ---` divider does; a
missing field means the file states no static answer, not false. A value, default, resolver
expression, comment's text or unparsed line is never shown: `unparsed` counts those lines, which
include any key name that is not a plain identifier. A symbolic or hard link is reported by name and
warns with `ENV_KEYS_SOURCE_SKIPPED`. No source at all exits 0 and names what was looked for; a file
or sibling that could not be read exits 2 naming why, beside what could be read. Output is bounded,
and `truncated` says what was left out. Varlock also honours a decorator after a value, measured on
2026-11-05 with Varlock 1.23.0; `env keys` does not read those, so it states no default for such a
key.

`npx --no cockpit env schema --config cockpit.toml --path api:services/web/.env.schema` prints one
schema's text verbatim, including every resolver expression and comment (in human output, a control
character is shown escaped). A schema must hold no secret values: the guard treats this name as
documentation and Git already reaches a committed copy. `--path` is the `reference` `env keys`
prints: `<slug>:<relative directory>/.env.schema` in a sibling, or `.env.schema` in the cockpit
root. It refuses with `ENV_SCHEMA_READ_REFUSED` any other file name (matched exactly, including
case), a symbolic or hard link, a non-regular file, a directory the probe does not discover and an
oversized file.

To change one, write a draft with your normal tools and add `--replace-from <draft>`, with the draft
relative to the cockpit root. The same command creates a sibling component's first schema, such as
`--path api:services/web/.env.schema`, when Git tracks a regular product file directly in that
existing directory of the served checkout; a descendant, a link, an environment file or a
guard-protected file does not establish the component. It does not stage the new schema: `env keys`
and `env schema` find it after `git add`, and it runs only once committed.
[What it refuses](safety-and-autonomy.md#editing-a-schema-under-claude-code) is what stops a secret
being laundered through a draft.

## Check and sync

`check` works out what the generated files should contain now and compares that with every whole
file and shared-file region in the ownership manifest (see
[generated ownership](concepts.md#cockpit-generated-ownership)). It reports drift and never changes
an output. `sync --dry-run` lists the writes and removals, in order, without changing anything.
`sync` writes the full set as one recoverable filesystem transaction.

Team package metadata is prepared separately: a known surface conflict, an input overlap or a
refused stale-removal approval leaves it unchanged. A later I/O failure or concurrent input change
can still leave those metadata updates in place while the transaction reports its own recovery
result.

Removing a stale file needs a separate approval of the exact path, operation and current bytes the
dry run showed. Plain `sync` refuses; `sync --interactive` asks you to type the exact digest. After
approval and a final recheck, cockpit can remove an unchanged whole file, or its own region in a
shared file. When every stale path is the MCP-only file of a tool still listed, removing it only
narrows access, so `sync` applies it without that approval. Files cockpit did not write, and bytes
outside its regions, are kept. A stale path that changed or is unsafe needs manual reconciliation.

Generated content for a shared Markdown region is rejected if it contains either region delimiter,
and shared JSON updates keep the whitespace outside cockpit's property group. If cockpit cannot
confirm that writing or rollback finished, it keeps the recovery inputs and refuses to report
success.

## Bring-up order

`setup` writes `started` to the lifecycle history, and so does the first `up` on a stack with
neither lifecycle data nor history; lifecycle data without history is refused as lost. Bring-up then
checks the runtime, starts the Compose stack, waits for every service to report healthy, records
`seeded`, and only then runs `environment.seed` when it is due. A refusal keeps the progress so the
next `up` resumes. Fix the named prerequisite; never edit lifecycle state to fake `started` or
`seeded` history.

## Result words

`enforced` and `unavailable` mean what they mean for harness features
([Capability states](harness-surfaces.md#capability-states)); for the environment:

- **enforced**: cockpit refuses a declaration, file, ownership record, identity, mount or operation
  that does not match.
- **measured**: a probe produced the stated result. Repository tests run mounted candidates next to
  unmounted and incompatible controls, but those synthetic controls say nothing about your local
  runtime.
- **unavailable**: cockpit could not get or verify the required result, and it counts as not
  passing.
- **human_needed**: product or vendor behavior a maintainer still has to review; no check has
  established it.

## Demo data, test users and roles

cockpit runs the product's own seed command and records when it last succeeded. It never writes rows
or creates identities itself: the product's writers already encode its invariants, and a second
writer in cockpit would drift from them.

```toml
[environment]
compose_files = ["compose.yml"]
resettable_volumes = ["postgres-data"]
seed = { argv = ["npm", "run", "db:seed"], timeout_seconds = 300 }
```

`up` runs the seed once every service is healthy, whenever no successful seed is recorded for the
stack or one of the `resettable_volumes` was created after the last one. It runs on the host from
the cockpit directory, with the leased `[ports.bases]` variables and each `COCKPIT_ENTRYPOINT_*`
address added to the caller's environment. `up --json` reports `seed` as `ran` or `current`.

A seed that exits nonzero, or outlives `timeout_seconds`, refuses with `DATA_SEED_FAILED`: the stack
stays up, its data may be partly applied, and the next `up` runs it again, so write it to be rerun.
When Docker cannot say when the volumes were created, `up` refuses with `DATA_SEED_UNAVAILABLE`
rather than guess. `seed` requires `resettable_volumes`, because those volumes tell cockpit the data
is gone. To seed from inside the stack, see
[Compose patterns](compose-patterns.md#seed-or-restore-data).

Applying a reset wipes data, so it needs a person by default: `reset --interactive` in a terminal,
or `reset --apply` when `[autonomy] reset` allows the caller. The next `up` seeds again.

```sh human-only: resets data and requires the declared local stack
./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config cockpit.toml
./node_modules/@b00dea/cockpit/bin/cockpit.mjs reset --config cockpit.toml --json
./node_modules/@b00dea/cockpit/bin/cockpit.mjs reset --interactive --config cockpit.toml
./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config cockpit.toml
```

**Test users.** cockpit has no user model; the product's seed creates them. Give each a stable
synthetic ID such as `auth-admin`, a role, one operation it must be allowed and one it must be
denied. Stable IDs let a re-seed update the same rows, and the pair proves the roles work, not only
that a sign-in succeeded. The shipped `cockpit-setup` skill carries an on-demand reference
(`references/test-data-and-personas.md`).

**Fixture hygiene.** These rules come from seeders that broke in real use:

- Seed through the product's own writers, not raw inserts, so derived fields and constraints hold.
- A re-seed restores only the fields a fixture names. Name every field a test changes, or the next
  run fails its own precondition. Unset fields rather than writing null.
- Seed the settled state a test needs. Default column values can read as work in flight and disable
  the interface.
- Before a seed writer runs, assert that every database and service target is local. A development
  fixture is no permission to reach a shared or non-local environment.
- Resolve a sibling fixture path by probing the declared sibling root and a documented fallback;
  never embed one checkout layout as a constant.
- Clean up by ownership, never by time window.

## Declare environment postures

Declare which local requirements depend on how the product is addressed (`addressing`) and how
sign-in works locally (`authentication`):

```toml
[environment]
addressing = "hostname"
authentication = "bypassed"
posture_requirements = [
  { requirement = "local-route-resolution", addressing = "hostname" },
  { requirement = "local-session-access", authentication = "bypassed" },
]
```

A product with no local sign-in declares `authentication = "none"`; a requirement tagged with a
sign-in value then fails preflight. A plain localhost stack declares:

```toml
[environment]
addressing = "port"
authentication = "none"
posture_requirements = [{ requirement = "leased-localhost-ports", addressing = "port" }]
```

Use your actual requirement names. Each tag must match the selected value, and the selected
`addressing` value, and any `authentication` value other than `none`, must each appear in at least
one tag. Preflight refuses missing declarations, mismatched tags and selected values no tag uses.
The check validates the declared tags; deciding which requirements need tags is still a maintainer's
review.

## Health and evidence

`preflight` is the blocking gate; `doctor` reports the same checks. Neither repairs anything, runs
`sync`, seeds data or advances lifecycle progress. Before the first bring-up (`STATE_UNSEEDED`),
while the stack sleeps (`STACK_NOT_RUNNING`), and for a cockpit with no runtime
(`ENVIRONMENT_NOT_DECLARED`, `doctor` only), both still run every check that needs no running stack
and report the rest as not applicable; `preflight` never passes in those states. A check can pass,
fail, be unavailable, or not apply, and an unavailable required check never becomes a pass because
another succeeded. Host capacity and runtime health need complete results from processes cockpit
itself ran.

`doctor` exits 0 with a report whenever it can read `cockpit.toml`, whatever the verdict, and 2 when
the configuration is missing or invalid. `--json` carries the checks, declarations, override
inspection and whether the generated files are current.

What the checks compare:

- **Git remotes.** A declared sibling remote is compared with the remote selected by that checkout's
  branch upstream; cockpit does not rewrite remotes. With no upstream there is nothing to compare,
  and the result says so. A missing or diverged upstream blocks the gate. A `remote` that is a local
  path is still cloned by `setup`, but `preflight` refuses it: declare the hosted https or ssh
  remote, or remove `remote` and set `acquire = "none"`.
- **Surfaces.** Generated files must match the ownership manifest and stay within the guide line cap
  and the built-in skill caps; missing or edited ones block health. Custom outputs and plugin bundle
  copies are checked for being current, but no always-loaded cap applies. Whether each harness
  enforces the files is in the [capability matrix](capability-matrix.md).
- **Grants.** Directory grants are checked only when a sibling declares `mount = "always"`.
- **Mounts and ports.** Declared binds must match the current mounts exactly; no bind mounts passes
  as an exact empty comparison. Health on a running stack rechecks the retained lease, container
  identities, mounts and published listeners without reserving sockets. Compose reports a `::`
  publication beside each `0.0.0.0` one, and some runtimes forward only IPv4 loopback, so the `::`
  row need not listen while its `0.0.0.0` twin does; a leased port nothing publishes must stay free
  on both families.
- **Capacity.** Cold-start timing applies only to services `up` actually started. The disk floor
  compares current free space with an explicitly declared machine floor; without that declaration,
  host-floor checks do not apply.

**Logs.** `logs` reads one declared service from the selected running stack, defaulting to
`--tail 100 --since 15m`. `--tail` accepts 1 through 10000 records. A read without `--follow` has
ten seconds and reports a timeout as a failure. `--follow` collects until you interrupt it (exit 130
with the records collected), the container stops, or two hours pass. Output is limited to 1 MiB of
stdout and 64 KiB of stderr; past that, `logs` keeps the newest whole records, sets `truncated` and
warns with `LOGS_TRUNCATED`. It is returned after collection, not streamed.

### Work on one service

`ps`, `restart`, `rebuild` and `exec` act on one service of this checkout's own running stack,
started by `up` from this checkout; after `down` they refuse and name `up`.

- `ps` lists every service with its container state, health and status; a service with no container
  is `absent`.
- `restart --service <name>` restarts the container in place, without its dependents, then waits for
  it as `up` does and reports its last log lines when it does not become healthy.
- `rebuild --service <name>` builds the image, replaces the container and waits the same way, for a
  change baked into the image. It also works on a stack whose start stopped at that service, and
  records the new container so `preflight` and `logs` follow it.
- `exec --service <name> -- <command> [args...]` runs the command inside the container and exits
  with its status. It gets a terminal only when cockpit runs in one.

What the guard admits for these is in
[Cockpit commands an agent can run](safety-and-autonomy.md#cockpit-commands-an-agent-can-run).
