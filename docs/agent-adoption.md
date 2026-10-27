# Agent adoption guide

<!-- cockpit:verified version=0.0.0 -->

This guide is for an AI coding agent that a human has asked to "set up cockpit for our project",
and for the human watching it. It maps each starting situation to the exact non-interactive
commands, says what counts as done at every step, and links the page that owns each detail.
People can follow it too; the [getting started guide](getting-started.md) is the same journey
written for a terminal.

## Safety contract

cockpit exists so that an agent's environment holds no guesses. A clean-looking configuration
with invented values in it is the failure it is built to prevent, so the agent works under five
rules for the whole adoption:

1. **Ask the human first** before any of these, and wait for a yes:
   - writing into a product repository (a Dockerfile, Compose file, `.env.schema` or anything
     else inside a sibling checkout);
   - creating a Git remote or a hosted repository;
   - any destructive command (`down`, `reset`, `sync --interactive` removals, deleting files);
   - `cockpit sync --adopt`, which moves the team's own agent settings;
   - accepting an `init` digest (`--accept-preview`, `--accept-defaults`).
2. **Show the exact preview** before you ask: the `sync --dry-run` listing, the `init` preview
   with its `previewSha256`, the answers file, or the defaults digest the run printed. Consent
   binds to those bytes; a digest copied from anywhere but the latest pending run is refused.
3. **Never invent a configuration value.** A port, image, command, health check, purpose or name
   comes from a file you read or from the human. When you cannot find it, leave it as a named gap
   and ask.
4. **Inferred values carry provenance and need confirmation.** Whatever you derive, and whatever
   `init` proposes under `provenance.kind = "inferred"`, is shown to the human with the file it
   came from. It becomes an answer only on their word.
5. **Ask for every non-local host.** The `guards` answer lists the database and live vendor API
   hosts of production, staging and shared environments; propose the variable names `init` found
   in env templates, never read their values, and take each host from the human.

These are instructions, not enforcement: no harness blocks an agent that ignores them. The guard
cockpit installs later blocks some commands; see [Safety and autonomy](safety-and-autonomy.md).

## Read a cockpit result

Pass `--json` to every command except `session`. Each prints one JSON document on stdout with
`result`, `diagnostics` (each with a `severity` and a `code`) and `invocation.exitCode`. A
refusal exits nonzero and names its diagnostic; look the code up in
[Troubleshooting](troubleshooting.md). Read the flags from `cockpit <command> --help` or the
[CLI reference](cli-reference.md) rather than from memory.

`init` is the exception to "exit 0 means done": a run that stops at a question also exits 0.
Read `result.stage`, `result.question` and `result.nextCommand` to know where it stopped.

## Install cockpit

Done when `cockpit --help` lists the commands.

cockpit is installed from source today. Follow [Install cockpit](getting-started.md#install-cockpit)
for the current commands and supported Node versions. Installing writes nothing into the product,
but it does clone a repository and put a command on the PATH, so tell the human what you are about
to run.

Your harness target is the tool you are running in: `claudecode` for Claude Code, `codexcli` for
Codex CLI, `opencode` for OpenCode. Every `init` command below needs it. If your tool isn't one of
the built-ins, cockpit's AGENTS.md still gives it the instructions; guards and permissions are not
enforced there. The [capability matrix](capability-matrix.md) records what each built-in enforces.

## Choose your situation

Start from what is on disk, not from what the human called it. Look before asking.

| On disk | Go to |
|---|---|
| Nothing yet: an empty directory, a product not started | [Empty directory](#empty-directory) |
| You are inside an existing product repository | [Inside a product repository](#inside-a-product-repository) |
| One repository of documents, decisions or notes, with nothing to run | [Docs or decisions only](#docs-or-decisions-only) |
| One repository with a service that runs | [One or several repositories](#one-or-several-repositories) |
| Several repositories side by side | [One or several repositories](#one-or-several-repositories) |
| Repositories scattered across the disk | [Scattered repositories](#scattered-repositories) |
| A Compose file that already starts the product | [Existing Compose file](#existing-compose-file) |
| A service that has only ever run in CI, staging or a cluster | [No local setup](#no-local-setup) |
| Committed `.claude/settings.json`, `.codex/config.toml` or `.codex/hooks.json` | [Existing agent settings](#existing-agent-settings) |
| A cockpit already exists and a repository joins it | [Add a repository](#add-a-repository) |
| A cockpit already exists and a repository leaves it | [Remove a repository](#remove-a-repository) |
| A sibling has a `.env.schema` (Varlock) | [Varlock-managed environment](#varlock-managed-environment) |

Several can apply at once: a multi-repository product can also have committed agent settings and
one service with no local setup. Handle the bootstrap case first, then the others.

The cockpit checkout is the directory that holds `cockpit.toml` and the generated files. It is a
folder of its own beside the product repositories;
[Where the cockpit lives](concepts.md#where-the-cockpit-lives) says why and covers the exceptions.
If it is not yet a Git repository, ask the human before running `git init` there: the generated
files are meant to be committed.

### Empty directory

Done when `cockpit check --config cockpit.toml --json` exits 0 and every repository the human
named is declared.

With no repository under the root, `init` observes nothing runnable and builds a surfaces-only
cockpit. Its first sibling is the cockpit root itself: the schema needs one sibling, and the root
is where the product's notes and decisions live until its repositories exist.

1. **Preview** from the directory that will hold the cockpit:

   ```sh
   cockpit init "$(pwd)" --target claudecode --json
   ```

   `result.interview.outstanding` lists `sibling`, `ports.bases`, `guards` and
   `configuration.defaults`. Under `sibling`, `inferred` proposes the root row: the directory name
   as `slug`, `dir = "."`, `mount = "none"` and `acquire = "none"`. It has no `purpose`.
2. **Write the answers file** with the purpose and the non-local hosts from the human. For a
   product not yet started there are usually no hosts, and an explicit empty answer is recorded
   as a decision. In a directory named `orders`:

   ```toml
   [[sibling]]
   slug = "orders"
   dir = "."
   mount = "none"
   acquire = "none"
   var = "ORDERS_DIR"
   purpose = "Product notes and decisions"

   [ports]
   bases = {}

   [guards]
   hosted_db_hosts = []
   vendor_endpoint_hosts = []
   ```

   `mount = "none"` because the agent already works in the root: mounting it, or projecting its
   guides, would point the cockpit's own files at themselves.
3. **Accept the preview and the answers, then the defaults**, exactly as in steps 3 and 4 of
   [One or several repositories](#one-or-several-repositories). The run ends at
   `environment-verified` and reports `ENVIRONMENT_NOT_DECLARED` as information.
4. **Add each repository** the product will have. `--purpose` is required and comes from the
   human:

   ```sh
   cockpit sibling add api --config cockpit.toml --create --purpose "HTTP API for orders" --json
   ```

   `--create` runs `git init` on an empty or missing directory and never creates a hosted
   repository. `result.publish.command` is the `gh repo create` command to hand to the human, and
   `result.publish.recordRemote` is the `sibling add <slug> --remote <url>` call that records the
   result. Then preview, publish and check:

   ```sh
   cockpit sync --config cockpit.toml --dry-run --json
   cockpit sync --config cockpit.toml --json
   cockpit check --config cockpit.toml --json
   ```

### Inside a product repository

Done when the human has chosen the cockpit root and `init` reports `environment-verified`
from that root, or has stopped at a named gap you have reported.

A Git checkout with a package manifest at its root is a product repository. Run in it, the
`--json` preview carries `result.cockpitRoot` before anything else: the question, both options
with the exact paths each writes, and `recommended = "dedicated"`. Relay it to the human with
both trade-offs; [Where the cockpit lives](concepts.md#where-the-cockpit-lives) states them. Never
answer it yourself: the choice decides which directory `init` writes into, so `--accept-preview`
and `--accept-defaults` refuse with `INIT_COCKPIT_ROOT_REQUIRED` until the answers file has it.

```toml
cockpit.root = "dedicated"   # or "in-repo"
```

An option with `unavailable` set cannot be taken here, for example a repository directory name
that is not a valid sibling slug; it says why and what to do instead.

With `"dedicated"`, the next run creates the folder listed in that option's `creates`, and every later
step runs there with the repository as its first sibling (`dir` is the repository's name,
`siblings_root = ".."`). Keep running the same command from the product repository with the same
answers file, not from the new folder, which `init` would treat as a fresh empty cockpit;
`result.root` shows the cockpit root, and the `sync`, `check` and `sibling add`
commands that follow take `--config <result.root>/cockpit.toml`. With `"in-repo"`, `init`
proposes the repository as its own first sibling (`dir = "."`) and continues as in
[Empty directory](#empty-directory) steps 2 and 3. It observes manifests only in directories
below the root, so an in-repo cockpit declares no runtime until you add
`environment.compose_files` or `[environment.generated]` by hand.

### Docs or decisions only

Done when `cockpit check --config cockpit.toml --json` exits 0 and `cockpit up` refuses with
`ENVIRONMENT_NOT_DECLARED`.

A repository with no package manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`,
`Gemfile`) has nothing runnable. Run `init` from the repository itself and follow
[Empty directory](#empty-directory) steps 1 to 3: the documents repository is the cockpit root
and its own first sibling. [Environment modes](environment.md#environment-modes) explains what
surfaces-only publishes. The runtime commands refuse with `ENVIRONMENT_NOT_DECLARED`, which is the
expected result, not a failure to fix.

### One or several repositories

Done when `init` reports `environment-verified`, or has stopped at a named gap you have reported.

Run from the directory that holds the repositories. Each step stops for the human.

1. **Preview.** It writes nothing:

   ```sh
   cockpit init "$(pwd)" --target claudecode --json
   ```

   Read `result.previewSha256` and `result.interview.outstanding`: every field `init` will ask,
   in order, each with a `why` and the values it could propose. This is a trimmed real preview
   for three repositories:

   <!-- cockpit:capture date=2026-10-27 version=0.0.0 -->
   ```console
   $ cockpit init "$(pwd)" --target claudecode --json
   {"result":{"stage":"surface-previewed","previewSha256":"5f16c475...","nextCommand":"confirm selected bootstrap preview",
    "interview":{"outstanding":[
     {"field":"sibling","why":"the source does not establish schema-shaped sibling declarations","inferred":[]},
     {"field":"estate.runnable","why":"resolve the exact current runnable gaps: worker.runnable from worker/go.mod", ...},
     {"field":"ports.bases", ...,"inferred":[{"target":"api.container_ports","value":[3000],
       "provenance":{"kind":"inferred","source":"api/Dockerfile","reason":"the final stage of the Dockerfile EXPOSEs these container ports"}}]},
     ...
     {"field":"configuration.defaults", ...}]}}, ...}
   ```

2. **Write the answers file.** One TOML key per outstanding field, from what you read and what
   the human told you. The field table and an example are in
   [Bootstrap without a terminal](getting-started.md#bootstrap-without-a-terminal). Show the
   human the whole file, every inferred value with its source, and the `previewSha256`.
3. **Accept the preview and the answers** once the human agrees:

   ```sh
   cockpit init "$(pwd)" --target claudecode --accept-preview <previewSha256> --answers ./answers.toml --json
   ```

   The run stops at the first field still unanswered, or at `configuration.defaults`. There,
   `result.question.expectedSha256` is the defaults digest, and the `DOCUMENT_DEFAULT` and
   `DOCUMENT_INFERRED` diagnostics list every value the human has not stated.
4. **Accept the defaults** after the human has read that list:

   ```sh
   cockpit init "$(pwd)" --target claudecode --accept-preview <previewSha256> --answers ./answers.toml --accept-defaults <expectedSha256> --json
   ```

   This writes `cockpit.toml`, syncs, checks and runs `preflight`. Where a runtime is declared,
   `preflight` needs a measured runtime ([Measure the runtime](#measure-the-runtime)); until then
   the run stops there and resumes when you rerun the same command.

Rerunning with the same answers file resumes. A changed value for a recorded answer is refused
with `INIT_ANSWER_CONFLICT`: drop that key to keep the recorded answer, or tell the human there is
no command to reset it. One repository gets the same cockpit as several: instructions, guards
and settings.

### Scattered repositories

Done when every repository is declared and `cockpit setup --config cockpit.toml --json` exits 0.

Moving checkouts is the human's call. Either they put the repositories side by side under one
directory and you follow [One or several repositories](#one-or-several-repositories), or you
start a cockpit and point it at each checkout where it is:

```sh
cockpit sibling add billing --config cockpit.toml --from ~/code/billing --purpose "Billing worker" --json
cockpit setup --config cockpit.toml --json
```

`--from` reads the checkout's `origin` remote and records it with `acquire = "auto"`, so `setup`
clones a fresh copy into the cockpit. It never moves, changes or deletes the original, and it
refuses a checkout with no `origin`. `--from` needs an existing `cockpit.toml`, so start from
[Empty directory](#empty-directory) or from `init` over the repositories that are already together.

### Existing Compose file

Done when `cockpit check --config cockpit.toml --json` exits 0 with no `COMPOSE_PORT_NOT_LEASED`.

Keep the product's Compose file and let cockpit run it. In the answers file, answer
`environment.generated` with the file instead of a generated stack; `init` proposes it under
`inferred` when it finds one:

```toml
[environment]
install_policies = []
compose_files = ["compose.yml"]
```

`check` reads the topology with `docker compose config`. Every published host port must come from
a `[ports.bases]` variable, and a service without a healthcheck warns. The rules are in
[Environment modes](environment.md#environment-modes) and a working layout is
[examples/compose-first](../examples/compose-first/README.md). Changing the Compose file is a
product change: ask first.

`init` then asks `environment.machine`: the floor the product needs from the container runtime
(`runtime_memory_mb`, `runtime_cpus`, `free_disk_mb`, `cold_start_seconds`). These are product
requirements and `init` proposes none of them, so ask the human rather than picking numbers, and
answer under `[environment.machine]` in the answers file.

### No local setup

Done when the human has confirmed every inferred value and the stack reports healthy, or you have
named what stopped it.

Follow **Create a local setup** in the shipped procedure,
[packages/cockpit/surfaces/skills/procedures/onboarding.md](../packages/cockpit/surfaces/skills/procedures/onboarding.md#create-a-local-setup).
It derives each value from the repository's manifests, CI workflows and deployment files, records
it as inferred with its source, and keeps every unknown a named gap. The `init` preview already
proposes several of these: a Dockerfile's `EXPOSE` and `CMD`, `.env.example` variable names, and
the `services:` of GitHub workflows.

### Existing agent settings

Done when `cockpit check --config cockpit.toml --json` exits 0 and the adopted copy sits under
`cockpit/adopted/`.

A plain `sync` refuses to overwrite a committed `.claude/settings.json`, `.codex/config.toml` or
`.codex/hooks.json` with `SURFACE_STATE_CONFLICT`, and names the command that keeps it. Show the
human the file and ask, then adopt it:

```sh
cockpit sync --config cockpit.toml --adopt .claude/settings.json --json
cockpit check --config cockpit.toml --json
```

Repeat `--adopt` once per file. OpenCode needs no adoption. What is merged, and which settings are
refused with `SURFACE_ADOPTION_REFUSED`, is in
[Adopt existing agent settings](adoption.md#adopt-existing-agent-settings).

### Add a repository

Done when `cockpit check --config cockpit.toml --json` exits 0 after the sync.

Pick the `sibling add` form by where the repository is: already under the siblings root (no
flag), not yet existing (`--create`), elsewhere on disk (`--from`) or only a remote (`--remote`).
The forms are in [Add or remove a repository](getting-started.md#add-or-remove-a-repository).
Then:

```sh
cockpit sync --config cockpit.toml --dry-run --json
cockpit sync --config cockpit.toml --json
cockpit check --config cockpit.toml --json
```

### Remove a repository

Done when the sibling is gone from `cockpit.toml` and `check` exits 0.

```sh
cockpit sibling remove api --config cockpit.toml --json
```

`remove` refuses and lists every reference while anything still uses the sibling. It never deletes
the checkout; `result.flaggedForReview` names generated files to look at. Run the sync sequence
from [Add a repository](#add-a-repository). If `sync` would remove a stale generated file it
refuses, and the removal is approved by the human in a terminal with `cockpit sync --interactive`.

### Varlock-managed environment

Done when `preflight` reports no `ENV_SCHEMA_UNHEALTHY` row.

`preflight` and `doctor` check every sibling with a `.env.schema` through Varlock and report key
names and validity only, never values. Follow **Secret handling** in the
[shipped procedure](../packages/cockpit/surfaces/skills/procedures/onboarding.md#secret-handling)
and [Secret sources and environment schemas](environment.md#secret-sources-and-environment-schemas).
`varlock init`, provider login, encryption and moving secrets are the human's actions; preview
them and do not run them.

## Measure the runtime

Done when `cockpit.toml` holds an `[[environment.runtime_measurements]]` row for this machine.

Before the first `up`, measure the local container runtime and record it:

```sh
cockpit runtime measure --config cockpit.toml --image <local-image> --write --json
```

Name an image already on the machine; the probe never pulls. cockpit recognises Docker Desktop,
OrbStack, Colima, Rancher Desktop and Linux Docker Engine, and so far only OrbStack has been
observed; the others are recognised from vendor `docker info` output. The probe runs only from an
installed `@b0dea/cockpit` package, not from a linked source checkout. The table and the rules are
in [Measure the container runtime](environment.md#measure-the-container-runtime).

## Daily loop

Done when the agent command has exited and `session` has released the stack.

```sh
cockpit session --config cockpit.toml -- claude
```

`session` starts or resumes the stack, keeps it while the agent command after `--` runs, and
releases it afterwards. `cockpit sleep --config cockpit.toml --json` releases this checkout's hold
and stops the stack only when no other checkout holds it. `cockpit down --config cockpit.toml --json`
removes this checkout's runtime; it is destructive, so ask first. Details are in
[Run an agent inside the environment](getting-started.md#run-an-agent-inside-the-environment)
and [Environment lifecycle](environment.md#lifecycle-and-ownership).

## Upgrade loop

Done when `cockpit check --config cockpit.toml --json` exits 0 on the new version.

Install the new cockpit version the same way it was installed, then:

```sh
cockpit check --config cockpit.toml --json
cockpit sync --config cockpit.toml --dry-run --json
cockpit sync --config cockpit.toml --json
```

`check` shows what the new version renders differently; the dry run lists the writes for the
human to read before `sync`. The guard trusts only the cockpit, Node and `cockpit.toml` it was
generated for, so after an upgrade, a Node switch or an edit to `cockpit.toml` it holds every agent
tool call, `cockpit sync` run through the agent included, until a human regenerates. That is
deliberate: guard policy comes from `cockpit.toml`, and an agent able to apply its own edit could
loosen its guard. The refusal names what changed and the command to run. The upgrade sequence is:

1. Update the dependency, for example `npm update @b0dea/cockpit`.
2. In a terminal, outside the agent, run `cockpit sync --config cockpit.toml`.
3. Review and commit the regenerated files.

Each clone keeps its own machine-local guard identity in `.cockpit/local/`, which Git ignores, so
teammates run step 2 after pulling and commit nothing extra. To inspect a release before
installing it, see [Review an upgrade](harness-surfaces.md#review-an-upgrade).
