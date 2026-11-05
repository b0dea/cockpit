# Environment lifecycle

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

A skipped registry row produces no `init --registry` draft, because cockpit may no longer know
which repository it applies to. `registry-resolve` prints shell data you can `source` only when its
input passed validation.

## Environment modes

`[environment]` is optional. What it declares decides which commands have anything to run.

| Declares | Mode | `sync` and `check` | Runtime commands |
|---|---|---|---|
| no `compose_files` | surfaces only | write and drift-check the harness surfaces | refuse with `ENVIRONMENT_NOT_DECLARED` |
| `environment.compose_files` | compose first | the surfaces, plus `check` reads the Compose topology | run the declared Compose files |

The runtime commands are `up`, `sleep`, `session`, `down`,
`reset`, `preflight`, `logs`, `ps`, `restart`, `rebuild`, `exec` and `runtime measure`. Every mode writes the harness
[surfaces](concepts.md#surface) (instructions, skills, guards, permissions, evaluator and work
orders) and checks them for [drift](concepts.md#drift). A cockpit that declares only
`[environment.machine]` still gets the machine-capacity checks in `preflight`, so it is not refused
as surfaces only. `doctor` reports an undeclared runtime as not declared, not as healthy, and its
`declarations` result says whether the runtime, the reset volumes and the seed command are
declared. This also works from linked Git worktrees and configurations below the checkout root:
`doctor` binds generated-surface checks to that checkout's identity without requiring a runtime.
A passing surface check verifies generated files, not running services, hook enforcement or MCP
startup. Hook enforcement and successful MCP startup require separate harness checks.
With no runtime declared, `sync` and `check` only ask Git which checkout holds the configuration, and
Git activity in that checkout does not disturb them. No repository, a `.git` entry Git rejects, or Git
being absent from `PATH`, makes the directory standalone with a `GENERATED_CHECKOUT_STANDALONE`
warning stating why. The generated files stay valid, but the guard needs a Git repository it can read
and holds [guarded calls](safety-and-autonomy.md#edits-the-guard-has-not-applied) until it has one;
its refusal states the reason, and held calls continue without a `sync` once the repository is
readable. The guard reads a repository more strictly than `sync` and `check` do, so a
repository-local `include.path` in Git's configuration raises nothing from them, and the first sign
is the guard's refusal or the same reason from `doctor`. A declared runtime or browser still needs
setup's stricter view of the checkout, because stack identity and repository writes depend on it.
[`examples/docs-only`](../examples/docs-only/README.md) and
[`examples/compose-first`](../examples/compose-first/README.md) show the two modes. Vendor stubs,
TLS, seeding and restoring data are plain Compose; [Compose patterns](compose-patterns.md) shows
each.

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
- a published port with no host interface, such as `"${API_HOST_PORT}:3000"`, warns with
  `COMPOSE_PORT_ALL_INTERFACES`, because Docker then binds every interface and the service is
  reachable from the network; write `"127.0.0.1:${API_HOST_PORT}:3000"`, or name `0.0.0.0` when you
  mean the wider exposure;
- a service that sets `container_name` fails with `COMPOSE_CONTAINER_NAME_FIXED`, because Docker allows
  one container of a name and the second checkout's stack would fail to start; remove it and address
  the service by its Compose service name, or with `docker compose exec <service>`;
- a service with `build` and a fixed `image` fails with `COMPOSE_IMAGE_TAG_SHARED`, because every
  checkout builds to the same tag and one checkout's build replaces the image another's stack runs;
  remove `image`, so Compose names the build after the stack's own project;
- a profile in `environment.profiles` or a `profile:<name>` mount that no service declares fails
  with `COMPOSE_PROFILE_UNDEFINED`, because Compose accepts an unknown profile and starts nothing
  for it;
- a service with no Compose healthcheck warns with `COMPOSE_HEALTHCHECK_MISSING`, because running
  is then treated as ready;
- an image referenced by tag rather than digest warns with `COMPOSE_IMAGE_UNPINNED`.

`doctor` reports a refusal from this check as itself, with its fix, not as the surface evidence it makes
unavailable. `init` shows the port, container name, shared image tag and healthcheck findings beside the drafted `cockpit.toml`, as
warnings carrying the same fix; it never edits a Compose file, so apply the edit before or right after
accepting.

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
- Each `environment.generated_host_paths` entry must reach a container: bound itself, through a
  directory inside it, or inside a bound directory such as a sibling mounted whole. Otherwise
  `check` fails with `GENERATED_HOST_PATH_UNMOUNTED`.
- A container gets only what `cockpit.toml` declares. A bind outside every `mount = "always"`
  sibling and every `environment.generated_host_paths` entry, or one that leaves its sibling
  through a symbolic link, fails `check` with `COMPOSE_BIND_UNDECLARED`, and `up` refuses it.

### Scaffold a Compose file

A small app with no Compose file can get a starting one, once:

```sh
npx --no cockpit init . --scaffold-compose api --port 3000 --with postgres,redis
```

`--scaffold-compose` names the app directory relative to the cockpit root (`.` for the root
itself) and `--port` the port the app listens on inside its container. The app builds from its
Dockerfile; without one, a directory with a `package.json` runs on `node:22-alpine` and needs
`--command "npm start"` or whatever starts it. `--with` adds a database or cache from a fixed list,
`postgres` and `redis`, each on a pinned major version with a healthcheck, a named volume and its
URL in the app's environment. The written `compose.yml` publishes the app on
`127.0.0.1:${API_HOST_PORT:-3000}` and bind-mounts the app directory, and the command prints the
`[ports.bases]` variable and `resettable_volumes` entries to declare. `check` then warns that the
app service has no healthcheck and that the images are pinned by tag; add a healthcheck and pin
each image by digest when you can. The file is yours from then
on: cockpit runs it as written and never rewrites it, and the scaffold refuses with
`INIT_SCAFFOLD_COMPOSE_EXISTS` when the cockpit root already holds any Compose file.

### Compose profiles

A service with `profiles: [workers]` in the Compose file runs only while that profile is active.
`environment.profiles` lists the profiles every `up` and `session` activates, and
`up --profile <name>` or `session --profile <name>`, repeated for several, adds more for that run.
A sibling declared `mount = "profile:<name>"` is mounted, and checked as mounted, exactly while its
profile is active; the generated agent files follow `environment.profiles`. A profile no service
declares is refused with `COMPOSE_PROFILE_UNDEFINED`, by `check` for the declared ones and by `up`
for the requested ones.

The stack records the profiles it started with, and every later command on it, `down`, `sleep`,
`logs`, `preflight`, `ps` and the service verbs included, activates the same set, so `down` removes
the profile services too. A plain `up` or `session` joins the running stack with its recorded set.
Adding a profile changes what the stack runs, so `up` refuses it on a running stack with
`LIFECYCLE_PROGRESS_INVALID`, as it refuses any change to what the stack was started from: run
`down`, then `up --profile <name>`. `check` judges each service's bind mounts under the default
set and under the default set plus each other profile, so a bind that only one profile set would
refuse still fails `check`.

## Local URLs and port families

Write each published port with an explicit loopback binding in your Compose file, as in
`"127.0.0.1:${API_HOST_PORT}:3000"`, so starting a local stack does not expose it to the network;
use `::1` for IPv6 loopback, or `0.0.0.0` only when you intend that wider exposure. cockpit does not
rewrite your published interfaces.

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
`browser.resolver` supplies mappings only to the browser the `browser` commands launch, not to an
unrelated remote browser, MCP server or other client: put the mapping where that client's network
process runs. Browser operations then use that browser's own networking and DNS, as described in
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

[Compose patterns](compose-patterns.md#serve-tls) shows a TLS service in front of the app.

## Sibling and template paths

`sync` and `check` require each declared [sibling](concepts.md#sibling-repository) directory to
exist inside the siblings root, both as written and after following filesystem links. An absolute
sibling path is accepted only inside that root. Get missing checkouts onto disk, for example with
`cockpit setup`, before running `sync`.

`doctor` and `preflight` inspect every declared environment file in every sibling, and each check
lists all its failing paths, so one healthy file cannot hide another file's missing instance or
stale key names. Restore the named checkout or bring its instance keys in line with its template,
then rerun `cockpit doctor --config cockpit.toml`. When no sibling declares an environment file,
the instance-presence and key-freshness checks pass: there is nothing to seed or compare.

## Serve a sibling from a worktree

The stack mounts each sibling's declared checkout. When you work on a branch in another checkout of
that repository, usually a linked worktree, point the sibling at it for this cockpit checkout:

```sh
npx --no cockpit use api /path/to/api/.worktrees/feature --config cockpit.toml
npx --no cockpit use api --clear --config cockpit.toml
```

`use` accepts the root of a checkout that shares the declared checkout's object store, or whose
`origin` names the same repository as the declared checkout or its `remote`; anything else is
refused with `SIBLING_CHECKOUT_FOREIGN`. Name the checkout's own directory: a path that reaches it
through a symbolic link is refused. The choice is recorded in `.cockpit/local/sibling-checkouts`,
never in `cockpit.toml`, so it applies to this checkout of the cockpit alone. `up`, `logs`, the guard's
allowed roots and protected instance files, `doctor` and `preflight`, work orders (checks, grades,
test gates and test-weakening detection) and `docs check` all use the recorded checkout, and each
refuses with `SIBLING_CHECKOUT_UNAVAILABLE` once that checkout is gone. `doctor` and `preflight`
name each one (`SIBLING_CHECKOUT_OVERRIDDEN`) and warn with
`SIBLING_ENVIRONMENT_FILE_MISSING` for every declared environment file the worktree lacks: a fresh
worktree has none of the ignored ones, and cockpit never copies them from another checkout.

A running stack keeps the checkout it mounted: run `down` and `up` after `use`. An agent may run
`use` for a checkout inside a directory it may already write; any other path is a person's call. The
directory grants `sync` writes for each agent tool are committed and name the declared checkout, so a
worktree kept inside it stays reachable without a prompt. For a checkout outside it, `use` grants
the tools that read a machine-local setting, and `use --clear` takes that grant back:

- **Claude Code**: `use` adds the checkout to `permissions.additionalDirectories` in
  `.claude/settings.local.json`, keeping everything else in the file, and removes only the entry it
  added. It refuses a file it cannot parse rather than rewrite it, because Claude Code ignores such
  a file entirely.
- **OpenCode**: `use` writes the checkout to the machine-local grant file `sync` writes for the
  sibling, and `sync` keeps it there.
- **Codex** has no machine-local setting for extra writable roots, so its sandbox still reaches only
  the declared checkout: start Codex with `--add-dir <checkout>`.
- **Cursor** and **Grok Build** have no measured machine-local grant, so `use` writes nothing for
  them and they may ask before editing the checkout.

`use` lists in its output which tools got the grant, and `--json` reports them as `agentGrants`.
Restart an agent session that is already running so it reads the new grant.
[Harness surfaces](harness-surfaces.md#sibling-projection-and-standing-cost) records what was measured.

## Bring checkouts up to date

`cockpit pull --config cockpit.toml` fetches and fast-forwards the cockpit and every sibling
checkout, including one `use` recorded, to the upstream of the branch each has checked out. It
never merges, rebases, stashes or switches branch, and it runs no Git hooks. A checkout with
modified tracked files, a branch that has diverged from its upstream, an upstream that is gone or a
failed fetch is left exactly as it was and reported with `PULL_SKIPPED` and the command that
resolves it; a detached HEAD or a branch that tracks nothing is listed and skipped without a
warning. Like `setup`, its Git reads only each repository's own configuration, so a credential
helper set only in your global Git configuration is not used, and a repository whose attributes name
a filter defined only there, such as Git LFS, is skipped rather than checked out as placeholder
files; run `git pull --ff-only` in it yourself. Because it can only fast-forward, an
agent may run it without asking.

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

An agent started inside a sibling loads only the instruction files its own tool reads: Codex and
OpenCode read **AGENTS.md**, while Claude Code reads **CLAUDE.md**, as runs of each tool beside a
decoy file showed. Every tool gets the same
instructions only when AGENTS.md holds them and CLAUDE.md imports it with a line reading
`@AGENTS.md`. `doctor` warns for every sibling laid out otherwise:
`SIBLING_INSTRUCTIONS_AGENTS_ONLY`, `SIBLING_INSTRUCTIONS_CLAUDE_ONLY`,
`SIBLING_INSTRUCTIONS_UNLINKED` (both files, no import), `SIBLING_INSTRUCTIONS_MISSING` (neither),
and `SIBLING_INSTRUCTIONS_TOOL_ONLY` for files such as **.cursorrules** or **GEMINI.md** that none of
those tools load. Setup proposes the two changes that need no judgement, and makes them only when
a person runs `cockpit setup --config cockpit.toml --write-instruction-files` after reviewing them:
a sibling with only AGENTS.md gets a CLAUDE.md holding `@AGENTS.md`, and a sibling with only
CLAUDE.md has it copied byte for byte to AGENTS.md and replaced by `@AGENTS.md`. Setup proposes no
move when CLAUDE.md imports other files with `@`, because only Claude Code would follow those
imports from AGENTS.md. It writes only ordinary files, never through a link, and refuses when a
file changed after it was read. Merging two diverging files, or writing a first AGENTS.md, needs a
person's judgement and stays with them.

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
refuses with `MACHINE_COLD_START_EXCEEDED`. Each service start may run for the whole declared
budget, and the configuration refuses a budget above 3600 seconds, the longest `up` holds one
start open. A successful result reports `coldStart.measuredMillis`,
`limitMillis` and `headroomMillis`. A partial resume times only the services that run started.
Joining a stack that is already running, or that another holder started, reports no duration
rather than an invented one.

### Release the stack

`sleep` removes the current holder. It stops the shared runtime only when no other holder remains,
so one holder cannot stop another's environment. Stopping the runtime also releases the stack's port
lease, so a stopped stack does not use up one of the `ports.count` families other checkouts need;
the next `up` leases afresh and may land on a different family, so read the ports and entrypoints
it returns instead of reusing the earlier ones. `stackId` names the shared runtime and
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

A session records its wrapper's process ID and start identity with its hold: on Linux the start in
clock ticks since boot from `/proc`, which a wall-clock step (NTP, a resumed VM) does not move, and
elsewhere the start time `ps` reports. A wrapper that dies without its closing `sleep`, from
SIGKILL, a crash or a closed terminal, leaves that hold behind; the next `up`, `sleep`, `down` or
`reset` from the checkout sees that the process is gone, or that its process ID now belongs to a
process with another start, and releases it. When it was the last hold, the command's own hold
takes the running stack over, so `sleep` stops it and `down` removes it. A hold whose process is
still running is kept, and so is one whose start could not be read while its process ID is in use:
the `CLAIM_CO_TENANT` refusal names each such holder and its process ID, so you can end that
command, for example with `kill <pid>`, and retry.

The wrapper passes its process ID and start identity to its command in `COCKPIT_SESSION_PROCESS`, so
a hold that a `sleep` and then an `up` inside the session drop and re-add is still tied to the
wrapper, and is released the same way once the wrapper is gone. `up` reads that process's start
again before recording it, and refuses with `CLI_USAGE_INVALID` when the wrapper has ended or the
value is malformed.

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
handles it, pays the whole grace at every stop. Add `init: true` to such a service in your Compose
file, or handle SIGTERM in the program.

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
clears startup progress only after confirming the removals, which lets the next `up` start
afresh. `down` also retires a stack that `sleep` or an ended `session` left stopped:
with no holder left, it claims the stack for this checkout without starting anything and removes
it, so you do not have to run `up` first. While another session still holds the stack, `down`
refuses with `CLAIM_CO_TENANT` and names that session's holder and process; end that
`cockpit session`, then retry.

`reset` first shows an exact preview of the declared volumes and generated host paths it would
delete. Plain and `--json` reset calls delete nothing. Interactive reset needs a person at a
terminal outside CI; the approval stays with the process that showed the preview, which checks
everything again before it acts. `down` and `reset` delete only from a local Docker daemon, which
they fix once per run; see [Choose the Docker daemon](#choose-the-docker-daemon).

Name each `environment.resettable_volumes` entry by its top-level `volumes:` key in the Compose
file. Docker's volume name carries a per-checkout project prefix, so it is not accepted. `sync`,
`check` and every runtime command, `down` included, refuse a name that no declared volume has, and
an `external` volume too, because cockpit cannot label it. A declared volume that does not exist yet is left out of the
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

### List and prune stacks across the machine

Each checkout gets its own stack, port lease and state, so deleting a worktree leaves its containers,
network, volumes and lease behind with no checkout left to run `down` from. `stacks` lists every
stack this machine knows about, whichever cockpit and checkout started it, and changes nothing:

```sh
npx --no cockpit stacks --config cockpit.toml --json
```

It reads cockpit's state root and the containers, networks and volumes on the local Docker daemon
that carry cockpit's ownership labels, and attributes a resource to a stack only when all of them
are present and well formed; nothing is attributed by its name. Each row gives the cockpit, the stack,
its Compose project, its checkout, the state record and whether this version can read it, running
and stopped containers, networks, volumes, the port lease it still holds, its last recorded
activity, and a verdict with the reason.

A stack's checkout is proven, never guessed. Compose labels each container with the directory it
ran from, and the ancestor whose checkout identity derives the stack's own identity is its
checkout; or the cockpit's main checkout is known and none of the checkouts Git records for it
derives the stack. `checkout.source` says which. The checkout is `present`, `missing`, `replaced`
(the path exists but is no longer a checkout of that cockpit) or `unknown`. A worktree whose path
does not exist while Git still registers it, or marks it locked, is `unknown`, not `missing`: a
drive or share that is not mounted, or a checkout moved without `git worktree repair`, looks exactly
like that. Once such a checkout is really gone, `git worktree prune` in its main checkout (after
`git worktree unlock` for a locked one) lets `stacks prune` remove its stack.

A stack is `orphaned` only when its checkout is proven `missing`. Every other stack is kept: one
whose checkout exists or cannot be found, one that a `down` or `reset` is still draining, the
current checkout's own, and one whose state this cockpit version cannot read, because a newer
version may still use it for a checkout that exists. A state folder this version cannot read is
listed with the stacks; one in the colon spelling an earlier build used is orphaned once none of its
stacks is kept, and one named as current versions name their state is kept for a version that reads
it.

`stacks prune` shows exactly what it would remove and a digest of it, and removes nothing:

```sh
npx --no cockpit stacks prune --config cockpit.toml
npx --no cockpit stacks prune --config cockpit.toml --apply
```

`--apply` observes the machine again and removes only while the plan still has the previewed digest:
each orphan's containers, then its networks and labelled volumes, then the state records that hold
its port lease, then the orphaned state folders. State is removed only while every file still holds
the bytes the preview read, under the lock `up` takes to lease ports. A step that fails stops the
prune with `STACKS_PRUNE_INCOMPLETE`; what it had not removed stays listed, and running `--apply`
again resumes. The result is reported only once a fresh inventory no longer lists what was removed.

Removing an orphan is housekeeping, so `--apply` runs for an agent. A prune that deletes volumes
deletes data, and follows the reset gate: it runs only where `[autonomy] reset` lets the caller
reset, and otherwise a person runs `stacks prune --interactive` in a terminal and types the
preview's digest. That gate is the running cockpit's own policy and says nothing for another
cockpit's, so `--apply` removes only this cockpit's orphans and the state folders an earlier build
left. The preview still lists every orphan, marks each with `thisCockpit`, and warns with
`STACKS_PRUNE_UNCONFIRMED` that another cockpit's are removed only by a person's
`stacks prune --interactive`, which covers the whole machine. `doctor` warns with `STACKS_ORPHANED` when a stack of this cockpit has lost its
checkout or a state record cannot be read, without asking Docker; `stacks` gives the full picture.

### Change a running stack

A stack's identity, carried in its ownership labels and saved progress, is a digest of the Compose
files and of the `cockpit.toml` declarations that reach its containers, not of the bytes of
`cockpit.toml`. Editing a sibling's
`purpose`, the guards, MCP, surfaces, comments or formatting leaves a running stack alone, and the
next `up` resumes it. So do the fields the host checks rather than the containers receive:
`[environment.machine]` (including `cold_start_seconds`), `addressing`, `authentication`,
`posture_requirements`, `resettable_volumes`, `seed` and `entrypoint_derivatives`.

A change to a Compose file, or to ports, mounts or anything else in `cockpit.toml` the containers
receive, gives the stack a new identity, and `up` refuses with `LIFECYCLE_PROGRESS_INVALID` rather than replace the
running stack in place. To apply such a change, for example a `[ports.bases]` edit:

1. Edit `cockpit.toml`. This can happen while the stack runs.
2. Run `cockpit sync --config cockpit.toml`. Until then, the agent guard holds every
   [guarded tool call](safety-and-autonomy.md#edits-the-guard-has-not-applied) except that sync, because the configuration no longer matches what it was generated for, and
   `sleep` and `down` refuse because they read the Compose files `sync` publishes. An agent may run
   it where `[autonomy] sync = "agent"` and the edit does not
   [widen what agents may do](safety-and-autonomy.md#edits-the-guard-has-not-applied), as a
   `[ports.bases]` edit does not; otherwise a person runs it in a terminal.
3. Run `cockpit down --config cockpit.toml`. It finds the stack and its port lease by the stack,
   not by the edited declaration, and removes the containers still running the old declaration.
   While another holder, such as a running `cockpit session`, still holds the stack, it refuses
   with `CLAIM_CO_TENANT`.
4. Run `cockpit up --config cockpit.toml --json` and use the newly returned ports and entrypoints.

Restoring `cockpit.toml` to the exact bytes `sync` last saw, for example with
`git restore cockpit.toml`, clears the guard's hold without a `sync`: the guard compares the file's
content, not which file holds it.

### When a sibling changes under a running stack

A bind mount follows a sibling's files at once, but installed dependencies usually live in an image
or volume built earlier and the database keeps the schema it was migrated to. When `up` starts a
stack it records a digest of each mounted sibling's lockfiles and of its `rebuild_inputs`, such as
a migrations directory. Lockfiles come from the `environment.install_policies` rows for the
sibling's toolchain, or, without one, from the common lockfile names present in the checkout; each
finding names which source it came from. `doctor` and `preflight` warn with `STACK_INPUTS_CHANGED`
when any of them, or the checkout serving the sibling, changed since, and `pull` warns after
moving one. Run `down` and then `up` so every service starts on the current files; rebuild an image
that installs the dependencies before `up`. A resumed `up` keeps the record, because resuming
restarts nothing; `down`, or a `sleep` that stops the stack, drops it.

It is a warning, not a refusal: whether a changed lockfile matters is the product's call, and
`test-run` does not block on it.

## Choose the Docker daemon

Every command uses the daemon Docker itself would select: a `DOCKER_HOST` when set, otherwise the
context `DOCKER_CONTEXT` names, otherwise the active context `docker context show` reports. Four
commands fix that daemon once, before their first step, and address only it:

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

However the daemon was chosen, its endpoint must be an absolute `unix://` socket path. TCP, SSH and
other transports are refused, because a remote daemon could receive a deletion and its behaviour
says nothing about this machine. A `DOCKER_HOST` that is not local is refused with
`CLI_USAGE_INVALID`; a named or active context that is not local, or whose endpoint cannot be read,
is refused with `RUNTIME_UNAVAILABLE`, naming the context and its endpoint. For `down` and `reset`,
conflicting selections are refused, and so is a TLS override. Socket paths keep literal spaces and
punctuation, and cockpit uses the exact spelling when it binds the context and runs discovery or
deletion.

## Compose project name

Every command that runs Docker Compose passes `--project-name <cockpit.name>-<stack>`, where `<stack>` is the first 12 hex digits of the stack ID. The
stack ID comes from the cockpit's main checkout and the current checkout, so two cockpits that share
a `cockpit.name`, or two checkouts of one cockpit, get separate projects on one Docker daemon
instead of replacing each other's containers. It never depends on the bytes of `cockpit.toml`, so
editing the file keeps the same project.

Containers, networks and named volumes carry that name: a cockpit named `shop-cockpit` runs
containers such as `shop-cockpit-3f2b3aead733-api-1` and a volume
`shop-cockpit-3f2b3aead733_postgres-data`. Your own file's `name:` is overridden. To look at the stack with Docker directly, find the project with `docker compose ls`
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
names the cockpit that ran it, and the probe removes it before returning. If a measure was killed
before it could, the next `runtime measure` first removes that cockpit's own probe containers,
network and volume and the stale `cockpit-runtime-measure-*` temporary directory, and lists what it
removed. Each probe resource carries a `dev.b0dea.cockpit.probe-owner` label naming the measure
process that created it, so a measure running from another worktree or terminal, with its own
temporary directory, is still recognised: only resources whose process is gone are removed, and
anything that may belong to a measure still running is left and named. It refuses to probe when a
leftover cannot be removed, naming it. The probe runs only from
an installed `@b00dea/cockpit` package and only against a daemon that passes the
[local endpoint rules](#choose-the-docker-daemon).

If the candidate passes and the broken file is rejected, the command records the measurement in
`machine/runtime-measurements.json` under cockpit's per-user state root (the same root the stack
state lives in), so every checkout and git worktree on this machine reads it and measures once. The
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

Put encrypted resolver expressions or external-provider references in
`env/.secrets/<cockpit-project>/<component>`, which the generated guards keep agents from changing
or staging. Let `sync` write the generated ignore block in the cockpit's `.gitignore` before any secret material
exists, because that block covers the contents of every `.secrets` directory at any depth, and leave
it as generated: ignoring the `env/.secrets/` directory itself would defeat its exception for
`env/.secrets/.gitignore`. Create the directories with mode 0700 and no symbolic links, and create resolver files with mode
0600 through your own approved provisioning process. cockpit does not create those files or their
values.

During adoption, inspect environment filenames and declared commands without reading plaintext
values. Existing dotenv files or templates trigger a Varlock adoption decision even without a
schema; record adoption or the reason for deferring it. `init` and `doctor` recommend adoption with
`ENV_SCHEMA_UNDECLARED` when an immediate cockpit or sibling root contains `.env`, `.env.*` or
`env.template` without `.env.schema`. Discovery reads file names and types only; it does not open
values, search nested directories, run providers or make Varlock a prerequisite. Existing schemas
are validated separately. The shipped setup procedure explains how
to adopt Varlock through the product's
pinned dependency and an existing declared command or script. Use agent-mode validation for status
and `run --inject vars --redact-stdout` inside that declared command for a trusted product process,
and keep resolved credentials out of the agent's environment. Varlock refuses `--redact-stdout` on an
interactive terminal, so a person in a terminal runs the same `run` without the flag. Give both paths as absolute paths with repeated
`--path`: the component schema root first, then its central resolver directory in the cockpit; the
later path wins. Installation, initialization, provider login, encryption and migration need
explicit permission from whoever owns the product and the provider. Current commands and
limitations are in the [Varlock CLI reference](https://varlock.dev/reference/cli/load-and-run/) and
[AI tools guide](https://varlock.dev/guides/ai-tools/).

`cockpit preflight` and `cockpit doctor` look at every `.env.schema` a sibling tracks, asking Git with
`git ls-files`, plus a sibling's root schema whether tracked or not and the cockpit root's own, and
load each one that is [committed](#a-schema-runs-only-once-committed). In a sibling that is not a Git
repository only the root is looked at; Git failing for another reason, or more than 64 tracked
schemas, makes that sibling unavailable. On a cockpit that declares no runtime
`preflight` refuses, so `doctor` is what reports schema status there. Each schema runs
`varlock load --agent --format json-full --path <schema directory>` with
`VARLOCK_TELEMETRY_DISABLED=true`, the command's timeout, a 256 KiB output cap and every `_VARLOCK_*`
variable removed, adding `--path <cockpit root>/env/.secrets/<cockpit name>/<slug>[/<relative dir>]`
when that directory exists; the cockpit root's own schema uses `env/.secrets/<cockpit name>` itself.
That directory is checked with file metadata only and nothing inside it is read, and a symbolic link
on the way to it, or a failure other than its absence, makes the schema unavailable. A sibling is
read from the checkout `cockpit use` serves. The store is gitignored, so a linked worktree of the
cockpit that has none uses its main checkout's, at the same place below the working tree. Git names
the main checkout; a repository laid out any other way, or Git failing, leaves the schema with no store.

Only key names and a category are kept; values and Varlock's messages are discarded.

| Varlock reports | Row | Named as |
| --- | --- | --- |
| The required-empty message for a key | fails | `missing required <keys>` |
| Any other key error, such as a failed resolver or a value that does not coerce | unavailable, unless another key is missing | `could not validate or resolve <keys>` |
| An error at the root of the report, such as a bad plugin | fails | `schema could not be loaded` |
| A timeout, or an exit without a readable report | unavailable | the cause |

Each is `ENV_SCHEMA_UNHEALTHY`, and schemas are labelled `<slug> (<relative dir>)`. A provider's error
messages cannot be enumerated, so a key that could not be resolved is not called invalid: the provider
may be signed out or unreachable. Sign in to it and rerun. To diagnose, a person runs
`VARLOCK_TELEMETRY_DISABLED=true varlock load --path <schema directory> --path <central directory>`,
leaving out the second path where that directory does not exist. `ENV_SCHEMA_OVERRIDDEN` warns without
failing the row when Varlock reports a key as satisfied by the shell that ran the command rather than
by the schema's own sources; unset it and rerun to check those sources.

### A schema runs only once committed

Loading a schema runs its resolvers, including `exec()`, with the caller's environment, and a schema
is exempt from the secret-file denial, so an edited one could otherwise run commands through an
unprompted `doctor`. Before loading, the probe asks Git in the schema's directory, with
`git status --porcelain=v1 -z` and `git ls-files -v`, whether the file is tracked and identical to
HEAD, because a commit is a guarded, visible step and an edit is not. Only then does Varlock run.

A schema that is edited, staged, untracked, ignored, hidden behind Git's assume-unchanged or
skip-worktree flag, a symbolic link or outside a repository is not run. Its row keeps passing, and
`ENV_SCHEMA_UNCOMMITTED` warns, naming the schema and the fix: commit it to have it validated, or
have a person review it and run the `VARLOCK_TELEMETRY_DISABLED=true varlock load` the warning prints
with both paths. Git failing for any other reason makes the schema unavailable, again without running
Varlock. An edited schema is therefore not validated until it is committed.

This does not cover an agent's commit that a person approves, local plugin or `@import` files beside a
schema, or declared test commands, which also run edited code. Cockpit is not a sandbox.

### Varlock on PATH

The probe uses `varlock` from your `PATH`, not the product's locked copy, so a product with only a
local install sees `ENV_SCHEMA_TOOL_MISSING`, a warning rather than a failure
(<https://varlock.dev>).

Secret-manager resolvers, such as vault or 1Password, may need their own sign-in and environment. The
probe passes your environment through, never prompts because its stdin is closed, and reports a
timeout as unavailable. This was measured only with a failing synthetic resolver, not a real provider.

The probe has an execution limit. `varlock load` runs the schema's resolvers, including an `exec()`
command, and the guard exempts a schema from secret-file denial as documentation, so an agent that
can edit a schema can have commands run, with your environment, by a `doctor` or `preflight` it may
run unprompted. Declared testing commands also run code an agent edited, and cockpit is not a
sandbox. Review schema changes as you review code, and run `doctor` with a provider sign-in only on
schemas you trust. This was reasoned from Varlock's documented resolver behaviour plus a failing
`exec()` measured with a synthetic schema.

Set `VARLOCK_TELEMETRY_DISABLED=true` in product-owned Varlock wrappers too. Cockpit's probes
always disable Varlock telemetry; they do not modify global Varlock settings. See
[Varlock's privacy documentation](https://varlock.dev/privacy/) for the opt-out contract.

Report only variable names, validation state, exit status and where each value came from. Raw
resolver output, resolved values and browser state do not belong in work-order results. Generated
guards refuse changes and staging under secrets directories, including staging a parent directory
of the central store; whether a harness can natively block reads of these files has not been
tested. Git ignore rules, filesystem permissions, encryption and output redaction do not protect
secrets from malicious code running as the same user, and trusted product child processes receive
plaintext variables. A stronger boundary needs a separately tested sandbox and provider policy.

### Read variable names and schemas

Native rules can refuse an agent these documentation files
([measured](safety-and-autonomy.md#reading-secrets-and-instances)), so two commands read them. Both
find the same directories as the probe, in the checkout `cockpit use` serves, run no Varlock and no
resolver, never follow a symbolic or hard link, and an agent runs them without a prompt.

`npx --no cockpit env keys --config cockpit.toml` is the narrower choice when only names are needed;
add `--json` for a machine-readable answer. For each `.env.schema`, or a directory's
`.env.example`, `.env.sample` and `.env.template` where it has none, it prints the path, whether it is a
`schema` or `template` source and each key's `name`. A key shows `required`, `sensitive` and a bare
`type` only when a decorator on the lines directly above it declares them, or `@defaultRequired` or
`@defaultSensitive` above the `# ---` divider does; a missing field means the file states no static
answer, not false. A value, default, resolver expression, comment's text or unparsed line is never
shown: `unparsed` counts those lines, which include any key name that is not a plain identifier. A
symbolic or hard link is reported by name and warns with `ENV_KEYS_SOURCE_SKIPPED`. No source at all exits 0
and names what was looked for; a file or sibling that could not be read exits 2 naming why, beside what
could be read. Output is bounded, and `truncated` says what was left out. Varlock also honours a
decorator after a value, measured on 2026-11-05 with Varlock 1.23.0; `env keys` does not read those, so
it states no default for such a key.

`npx --no cockpit env schema --config cockpit.toml --path api:services/web/.env.schema` prints one
schema's text verbatim, which includes every resolver expression and comment
(in human output, a control character is shown escaped; `--json` carries the exact text). A schema must
hold no secret values: the guard treats this name as documentation and Git already reaches a committed
copy. `--path` is the `reference` that `env keys` prints for a schema source:
`<slug>:<relative directory>/.env.schema` in a sibling, or `.env.schema` in the cockpit root. It refuses
with `ENV_SCHEMA_READ_REFUSED`, naming the fix, any other file name (matched exactly, including case), a
symbolic or hard link, a non-regular file, a directory the probe does not discover and an oversized
file.

To change one, write a draft with your normal tools and add `--replace-from <draft>` to that command,
with the draft relative to the cockpit root.
[What it refuses](safety-and-autonomy.md#editing-a-schema-under-claude-code) is what stops a secret
being laundered through a draft. The result is
[not validated until it is committed](#a-schema-runs-only-once-committed).

## Check and sync

`check` works out what the generated files should contain now and compares that with every whole
file and shared-file region listed in the ownership manifest (see
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
unchanged whole file, or its own region in a shared file. When every stale path is the MCP-only file
of a tool still listed, its servers are no longer written, so removing it only narrows access and
`sync` applies it without that approval. Files cockpit did not write,
and bytes outside its regions, are kept. A stale path that changed or is unsafe needs manual
reconciliation before you retry.

Generated content for a shared Markdown region is rejected before writing if it contains either
region delimiter, and shared JSON updates keep the whitespace outside cockpit's property group. The
transaction plans its helper steps before staging and keeps time in reserve to roll back if forward
work reaches its deadline. If cockpit cannot confirm that writing or rollback finished, it keeps the
recovery inputs and refuses to report success.

Capability states, overlay rules, MCP approval, sibling guide copies, the skill contract and
`selftest` for the generated harness surfaces are in [Harness surfaces](harness-surfaces.md);
see [Upgrade cockpit](harness-surfaces.md#upgrade-cockpit) before changing the installed version.

## Bring-up order

Bring-up starts from the lifecycle history: `setup` writes `started`, and so does the first `up` on
a stack that has neither lifecycle data nor history, so you do not have to run `setup` first.
Lifecycle data without history is refused as lost history. Bring-up then checks the runtime,
starts the Compose stack, waits for every service to report healthy, records `seeded` in the
lifecycle history, and only then runs `environment.seed` when it is due. A refusal keeps the
progress so the next `up` resumes. Fix the named prerequisite or failed check; never edit
lifecycle state to fake `started` or `seeded` history.

## Result words

Environment results use four words with exact meanings. `enforced` and `unavailable` mean what they
mean for harness features (see [Capability states](harness-surfaces.md#capability-states)); for the
environment:

- **enforced**: cockpit refuses a declaration, file, ownership record, identity, mount or
  operation that does not match.
- **measured**: a probe produced the stated result. Repository tests run mounted candidates next to
  unmounted and incompatible controls, but those synthetic controls say nothing about your local
  runtime.
- **unavailable**: cockpit could not get or verify the required result, and it counts as not
  passing.
- **human_needed**: product or vendor behavior a maintainer still has to review; no check has
  established it.

## Demo data, test users and roles

This section is for whoever makes the local stack start with useful data and test users.
cockpit runs the product's own seed command and records when it last succeeded. It never writes
rows or creates identities itself: the product's writers already encode its invariants, and a
second writer in cockpit would drift from them.

**What to declare.** Name the Compose volumes that hold the data, and the command that fills them:

```toml
[environment]
compose_files = ["compose.yml"]
resettable_volumes = ["postgres-data"]
seed = { argv = ["npm", "run", "db:seed"], timeout_seconds = 300 }
```

`up` runs the seed once every service is healthy, whenever no successful seed is recorded for the
stack or one of the `resettable_volumes` was created after the last one: the first `up`, the `up`
after `reset`, and the `up` after anything else removed the volume. The command runs on the host
from the cockpit directory, with the leased `[ports.bases]` variables and each
`COCKPIT_ENTRYPOINT_*` address added to the caller's environment, so it reaches the stack as a
person's shell would. `up --json` reports `seed` as `ran` or `current`. A seed that exits nonzero,
or runs longer than `timeout_seconds`, refuses with `DATA_SEED_FAILED`: the stack stays up, its data
may be partly applied, and the next `up` runs the seed again, so write it to be rerun. When Docker
cannot say when the volumes were created, `up` refuses with `DATA_SEED_UNAVAILABLE` rather than
guess. `seed` requires `resettable_volumes`, because those volumes are what tells cockpit the data
is gone. To seed from inside the stack instead, see
[Compose patterns](compose-patterns.md#seed-or-restore-data).

Preview a reset with `cockpit reset`, which lists exactly which volumes and host paths it will remove.
Applying it wipes data, so it needs a person by default: `reset --interactive` in a terminal, or
`reset --apply` when `[autonomy] reset` allows the caller. The next `up` seeds again, because the
volume `reset` recreated is newer than the last seed.

```sh human-only: resets data and requires the declared local stack
./node_modules/.bin/cockpit up --config cockpit.toml
./node_modules/.bin/cockpit reset --config cockpit.toml --json
./node_modules/.bin/cockpit reset --interactive --config cockpit.toml
./node_modules/.bin/cockpit up --config cockpit.toml
```

**Test users.** cockpit has no user model; the product's seed creates them. Give each test user a
stable synthetic ID such as `auth-admin` or `auth-member`, a role, one operation it must be allowed
and one it must be denied. Stable IDs let a re-seed update the same rows, and the allowed and denied
pair proves the roles work, not only that a sign-in succeeded. The shipped `cockpit-setup` skill
carries an on-demand reference (`references/test-data-and-personas.md`) that keeps these identities
separate from what an identity provider owns.

**Fixture hygiene.** These rules come from seeders that broke in real use:

- Seed through the product's own writers, not raw inserts, so derived fields and constraints hold.
- A re-seed restores only the fields a fixture names. Name every field a test changes, or the next
  run fails its own precondition. Unset fields rather than writing null.
- Seed the settled state a test needs. Default column values can read as work in flight and
  disable the interface.
- Before a seed writer runs, assert that every database and service target is local. A development
  fixture is no permission to reach a shared or non-local environment.
- Resolve a sibling fixture path by probing the declared sibling root and a documented fallback;
  never embed one checkout layout as a constant.
- Clean up by ownership, never by time window.

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

`preflight` is the blocking gate; `doctor` reports the same checks without repairing anything.
Before the first bring-up (`STATE_UNSEEDED`), while the stack sleeps
(`STACK_NOT_RUNNING`), and for a cockpit that declares no runtime (`ENVIRONMENT_NOT_DECLARED`,
`doctor` only), both still run every check that needs no running stack, such as Git state, sibling
presence, the machine floor and the runtime measurement, and report the checks that need running
services as not applicable; `preflight` never passes in those states. A check can pass, fail, be
unavailable, or not apply to the declared setup, and an unavailable required check never becomes a
pass because another check succeeded. Host capacity and runtime health need complete results from processes cockpit itself ran; when those results are missing, the
result does not pass.

`preflight` and `doctor` read current results without changing anything; `doctor` also previews
generated surfaces to list overrides. They never run `sync`, seed data or advance lifecycle
progress. Only bring-up runs those steps, as [Bring-up order](#bring-up-order) describes.

`doctor` exits 0 with a report whenever it can read `cockpit.toml`, whatever the verdict, and exits
2 when the configuration is missing or invalid. Its human output is one line per area followed by
the diagnostics; `--json` carries the checks, declarations, override inspection and whether the
generated files are current. `check --json` shows the generated-file detail.

What the checks compare:

- **Git remotes.** A declared sibling remote is compared with the remote selected by that
  checkout's branch upstream; cockpit does not rewrite Git remotes. A checkout with no upstream has
  nothing to compare, and the result says so. Once an upstream is selected, it must be available
  and match; a missing or diverged upstream blocks the gate. Only an https or ssh `remote` has a
  repository identity to compare. A `remote` that is a local path (not a URL or `host:path`) is
  still cloned by `setup`, resolved against the siblings root, but `preflight` refuses it with a
  reason: declare the hosted https or ssh remote, or remove `remote` and set `acquire = "none"`.
  `init` never proposes a local-path remote.
- **Surfaces.** Generated files must match the ownership manifest and stay within the guide line
  cap and the built-in harness skill caps. Custom outputs and plugin bundle copies are checked for
  being current, but no harness-side cap on their always-loaded size applies to them. Whether each
  harness enforces the files is recorded in the [capability matrix](capability-matrix.md). Missing
  or edited generated files block health: run `cockpit sync --config cockpit.toml`, then retry.
- **Grants.** Directory grants are checked only when a sibling declares `mount = "always"`.
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
records, and `--since` limits the time range. Records keep their stream and restart details. A read
without `--follow` has ten seconds and reports a timeout as a failure. `--follow` collects until you
interrupt it, the container stops, or two hours pass; interrupting it in the CLI returns exit 130
with the records collected before the process group stopped, and programmatic callers must supply an
abort signal. Output is limited to 1 MiB of the container's stdout and 64 KiB of its stderr. Past
that, `logs` keeps the newest whole records that fit, sets `truncated` to `true` in the JSON result
and warns with `LOGS_TRUNCATED`; lower `--tail` to stay under it. Output is returned after
collection, including structured records in JSON mode, rather than streamed.

### Work on one service

`ps`, `restart`, `rebuild` and `exec` act on one service of this checkout's own running stack, with
its Compose project, files and profiles, so neither a person nor an agent names the derived project.
The stack must have been started by `up` from this checkout; after `down` they refuse and name `up`.

- `ps` lists every service of the stack with its container state, health and status; a service
  with no container is `absent`.
- `restart --service <name>` restarts the container in place, without its dependents, then waits
  for it as `up` does and reports its last log lines when it does not become healthy.
- `rebuild --service <name>` builds the service's image, replaces its container and waits the same
  way; use it when a change is baked into the image. It also works on a stack whose start stopped at
  that service, and it records the new container so `preflight` and `logs` follow it.
- `exec --service <name> -- <command> [args...]` runs the command inside the service's container
  and exits with the command's own status, as `session` does. It gets a terminal only when cockpit
  runs in one.

The guard admits these verbs as it admits `up`. The command after `exec --` runs in the container,
whose files the guard cannot see, so it is never proven read-only: the name-based denials still apply
(`exec --service web -- cat .env` is refused like `cat .env`), and it runs without asking only when a
`[guards] allow` rule or a declared build or test command admits it
([Cockpit and project commands](safety-and-autonomy.md#cockpit-and-project-commands)). `reset` stays
gated by `[autonomy]`.

## Where the decisions live

Contributors looking for the source module behind each step should start at
[Architecture](architecture.md#runtime-behavior) and the
[environment code map](../AGENTS.md#environment-code-map).
