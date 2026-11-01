# Agent adoption guide

<!-- cockpit:verified version=0.0.0 -->

This guide is for an AI coding agent that a human has asked to "set up cockpit for our project",
and for the human watching it. It maps each starting situation to the exact non-interactive
commands, says what counts as done at every step, and links the page with each detail.
People can follow it too; the [getting started guide](getting-started.md) is the same journey
written for a terminal.

## Safety contract

cockpit exists so that an agent's environment holds no guesses. A clean-looking configuration
with invented values in it is the failure it is built to prevent, so the agent works under six
rules for the whole adoption:

1. **Ask the human first** before any of these, and wait for a yes:
   - writing into a product repository (a Dockerfile, Compose file, `.env.schema` or anything
     else inside a sibling checkout);
   - creating a Git remote or a hosted repository;
   - any destructive command (`down`, `reset`, `sync --interactive` removals, deleting files);
   - `cockpit sync --adopt`, which moves the team's own agent settings;
   - accepting an `init` digest (`--accept-preview`, `--accept-defaults`);
   - committing in the cockpit repository, unless the human asked you to commit.
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
6. **Defaults never reach into a product repository, and are labelled.** "Use sensible defaults"
   or "don't ask me" covers `init` answers only. Writing an **AGENTS.md** pointer, a Compose
   file, a `package.json` or anything else inside a product repository still needs the human's
   explicit yes to that exact change. Every answer you choose yourself goes in the answers file's
   `[provenance]` table as `"agent-default"` ([Mark the answers you chose](#mark-the-answers-you-chose)),
   and your final report lists every default you chose with its field and value.

These are instructions, not enforcement: no harness blocks an agent that ignores them. The guard
cockpit installs later blocks some commands; see [Safety and autonomy](safety-and-autonomy.md).

## Read a cockpit result

Pass `--json` to every command except `session`. Each prints one JSON document on stdout with
`result`, `diagnostics` (each with a `severity` and a `code`) and `invocation.exitCode`. A
refusal exits nonzero and names its diagnostic; look the code up in
[Troubleshooting](troubleshooting.md). Read the flags from `cockpit <command> --help` or the
[CLI reference](cli-reference.md) rather than from memory.

`init` is the exception to "exit 0 means done": a run that stops at a question also exits 0.
Read `result.stage`, `result.question`, `result.cockpitRoot` and `result.interview.outstanding`
to identify the pending decision.

## Install cockpit

Done when `cockpit --help` lists the commands.

Follow [Install cockpit](getting-started.md#install-cockpit) for the project-local dependency,
source-package fallback and supported Node releases. For an existing product, cockpit is installed
in a dedicated cockpit directory beside the product repositories, not in a product repository: the
product stays untouched unless the human agrees to a change in it. That directory does not exist
yet: run the first `init` from inside the product repository with the temporary executable from
[Bootstrap an existing product](getting-started.md#bootstrap-an-existing-product), and follow
[Inside a product repository](#inside-a-product-repository); `init` creates the directory. Show
the human which directory will receive the dependency and lockfile before installing. Installing a local dependency does not
put its binary on a normal terminal's PATH. Run every `./node_modules/.bin/cockpit` command below
from the cockpit directory.

For a directory without a product manifest, first follow
[Bootstrap without a project manifest](getting-started.md#bootstrap-without-a-project-manifest).
Use its exact temporary installed executable for `init`; adding an installation manifest to the
root first would make it look like a product repository. After init creates the cockpit manifest,
install locally and run from the cockpit root through `./node_modules/.bin/cockpit`. During
bootstrap, replace that prefix in the following `init` examples with the temporary installed
executable's path. If the selected executable is absent, repair the install before continuing.
A command runner that downloads a missing package would bypass the project's reviewed version.

Every `init` command needs your harness's target identifier. The
[capability matrix](capability-matrix.md) names built-in targets and separates generated surfaces
from native enforcement that has been confirmed. For example, Codex uses `codexcli`; substitute
your tool's target in the examples. Claude Code, Codex CLI and OpenCode are the primary targets:
cockpit installs its guard hook for them; see the capability matrix for what each one is measured
to enforce. Cursor and Grok Build files are `generated` (nobody has verified those tools load
them), and cockpit installs no guard for them. For an instructions-only tool, follow
[Capability states](harness-surfaces.md#capability-states); generation alone does not establish
guard or permission enforcement.

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
   ./node_modules/.bin/cockpit init "$(pwd)" --target claudecode --json
   ```

   `result.interview.outstanding` lists `cockpit.name`, `sibling`, `ports.bases`, `guards` and
   `configuration.defaults`. `cockpit.name` proposes the directory name. Under `sibling`, `inferred` proposes the root row: the directory name
   as `slug`, `dir = "."`, `mount = "none"` and `acquire = "none"`. It has no `purpose`.
2. **Write the answers file** with the purpose and the non-local hosts from the human. For a
   product not yet started there are usually no hosts, and an explicit empty answer is recorded
   as a decision. In a directory named `orders`:

   ```toml
   [cockpit]
   name = "orders"

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

   `mount = "none"` is the honest initial answer because this directory has no runtime to mount.
   If the root later becomes runnable and the generated stack must bind-mount it, change the row to
   `mount = "always"`, then run `cockpit sync --config cockpit.toml` and
   `cockpit check --config cockpit.toml`. The root `AGENTS.md` and `CLAUDE.md` are already native
   harness inputs, so sync does not project them back into themselves; other declared guide paths
   still project normally.
3. **Accept the preview and the answers, then the defaults**, exactly as in steps 3 and 4 of
   [One or several repositories](#one-or-several-repositories). The run ends at
   `environment-verified` and reports `ENVIRONMENT_NOT_DECLARED` as information.
4. **Add each repository** the product will have. `--purpose` is required and comes from the
   human:

   ```sh
   ./node_modules/.bin/cockpit sibling add api --config cockpit.toml --create --purpose "HTTP API for orders" --json
   ```

   `--create` runs `git init` on an empty or missing directory and never creates a hosted
   repository. `result.publish.command` is the `gh repo create` command to hand to the human, and
   `result.publish.recordRemote` is the `sibling add <slug> --remote <url>` call that records the
   result. Then preview, publish and check:

   ```sh
   ./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run --json
   ./node_modules/.bin/cockpit sync --config cockpit.toml --json
   ./node_modules/.bin/cockpit check --config cockpit.toml --json
   ```

### Inside a product repository

Done when the human has chosen the cockpit root and `init` reports `environment-verified`
from that root, or has stopped at a named gap you have reported.

A Git checkout with a language manifest, Dockerfile, or standard Compose filename at its root is
treated as a product repository before runnable status is settled. This conservative choice keeps
`init` from writing into a possible product checkout. Run in it, the
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

With `"dedicated"`, the next run creates the folder listed in that option's `creates`, initialises
it as a local Git repository, and runs every later step there with the product repository as its
first sibling (`dir` is the product repository's name,
`siblings_root = ".."`). Keep running the same command from the product repository with the same
answers file, not from the new folder, which `init` would treat as a fresh empty cockpit;
`result.root` shows the cockpit root, and the `sync`, `check` and `sibling add`
commands that follow take `--config <result.root>/cockpit.toml`. With `"in-repo"`, `init`
observes the repository's own runnable sources as its first sibling (`dir = "."`) and proposes that
row, then asks the same runtime questions as
[One or several repositories](#one-or-several-repositories), from step 2.
Either way `init` declares only the repository it runs in, and an answers file that adds another
is refused with `DOCUMENT_ESTATE_TOPOLOGY_MISMATCH`; add the other repositories once `init` is done,
with [`sibling add`](#add-a-repository).

### Docs or decisions only

Done when `cockpit check --config cockpit.toml --json` exits 0 and `cockpit up` refuses with
`ENVIRONMENT_NOT_DECLARED`.

A repository with no language manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`,
`Gemfile`), Dockerfile or standard Compose file has nothing runnable. Run `init` from the repository itself and follow
[Empty directory](#empty-directory) steps 1 to 3: the documents repository is the cockpit root
and its own first sibling. [Environment modes](environment.md#environment-modes) explains what
surfaces-only publishes. The runtime commands refuse with `ENVIRONMENT_NOT_DECLARED`, which is the
expected result, not a failure to fix.

### One or several repositories

Done when `init` reports `environment-verified`, or has stopped at a named gap you have reported.

Run from the directory that holds the repositories. Each step stops for the human.

1. **Preview.** It writes nothing:

   ```sh
   ./node_modules/.bin/cockpit init "$(pwd)" --target claudecode --json
   ```

   Read `result.previewSha256` and `result.interview.outstanding`: every field `init` will ask,
   in order, each with a `why` and the values it could propose. This is a trimmed real preview
   for three repositories:

   <!-- cockpit:capture date=2026-10-27 version=0.0.0 -->
   ```console
   $ cockpit init "$(pwd)" --target claudecode --json
   {"result":{"stage":"surface-previewed","previewSha256":"5f16c475...",
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
   [Bootstrap without a terminal](getting-started.md#bootstrap-without-a-terminal). Ask the human
   for `cockpit.name`; the proposal is the directory name. Mark any answer you chose yourself as
   described in [Mark the answers you chose](#mark-the-answers-you-chose). Show the human the whole
   file, every inferred value with its source, and the `previewSha256`.
3. **Accept the preview and the answers** once the human agrees:

   ```sh
   ./node_modules/.bin/cockpit init "$(pwd)" --target claudecode --accept-preview <previewSha256> --answers ./answers.toml --json
   ```

   The run stops at the first field still unanswered, or at `configuration.defaults`. There,
   `result.question.document` contains the validated review draft as an array of lines.
   Joining them with `\n` reproduces the exact draft, including its final newline.
   Its provenance comments show every inferred and default value with its target and reason, and
   `result.question.expectedSha256` is the digest covering those values. The human output and
   interactive question show the same document. It is not written to `cockpit.toml` before
   acceptance; the `DOCUMENT_DEFAULT` and `DOCUMENT_INFERRED` diagnostics supply the reasons.
4. **Accept the defaults** after the human has read those attributed values:

   ```sh
   ./node_modules/.bin/cockpit init "$(pwd)" --target claudecode --accept-preview <previewSha256> --answers ./answers.toml --accept-defaults <expectedSha256> --json
   ```

   This writes `cockpit.toml`, syncs, checks and runs `preflight`. Where a runtime is declared,
   `preflight` needs a measured runtime ([Measure the runtime](#measure-the-runtime)); until then
   the run stops there and resumes when you rerun the same command. `preflight` also needs the
   cockpit repository committed and clean
   ([Preflight observations](environment.md#preflight-observations)): a new one reports
   `GIT_STATE_UNHEALTHY` because it has no commits yet, and the row's fix stages and commits
   every file Git does not ignore. Show the human `git status --short` and ask before committing
   (rule 1 of the [Safety contract](#safety-contract)), then rerun the same command.

Rerunning with the same answers file resumes. A changed value for a recorded answer is refused
with `INIT_ANSWER_CONFLICT`: drop that key to keep the recorded answer, or follow the canonical
[recorded-answer reset](getting-started.md#bootstrap-without-a-terminal) before `cockpit.toml` is
prepared. One repository gets the same cockpit as several: instructions, guards and settings.

### Mark the answers you chose

Done when every answer you chose yourself is listed under `[provenance]` and your report names it.

`init` writes a person's answer into `cockpit.toml` as something they stated. When the human
delegated a decision ("pick sensible defaults"), say so per field in the answers file, so the
value is never recorded as theirs:

```toml
[provenance]
"environment.machine" = "agent-default"
guards = "agent-default"
```

Each key is an answers-file field; the value is `"agent-default"` (you chose it) or `"human"`
(the human stated it, the same as leaving the field out). `init` writes each agent default under
`unconfirmed` at the top of `cockpit.toml` with a `# Unconfirmed:` comment, lists it in
`result.unconfirmed` and as a `DOCUMENT_ANSWER_UNCONFIRMED` warning, and `doctor` reports
`DECLARATION_UNCONFIRMED` until a person confirms each value, deletes its entry from
`unconfirmed` and runs `sync`. An `environment.machine` floor the file does not attribute is
recorded as unattributed rather than as the human's, because cockpit never proposes one.

### Scattered repositories

Done when every repository is declared and `cockpit setup --config cockpit.toml --json` exits 0.

Moving checkouts is the human's call. Either they put the repositories side by side under one
directory and you follow [One or several repositories](#one-or-several-repositories), or you
start a cockpit and point it at each checkout where it is:

```sh
./node_modules/.bin/cockpit sibling add billing --config cockpit.toml --from ~/code/billing --purpose "Billing worker" --json
./node_modules/.bin/cockpit setup --config cockpit.toml --json
```

`--from` reads the checkout's `origin` remote and records it with `acquire = "auto"`, so `setup`
clones a fresh copy into the cockpit. It never moves, changes or deletes the original, and it
refuses a checkout with no `origin`. `--from` needs an existing `cockpit.toml`, so start from
[Empty directory](#empty-directory) or from `init` over the repositories that are already together.

### Existing Compose file

Done when `cockpit check --config cockpit.toml --json` exits 0 with no `COMPOSE_PORT_NOT_LEASED`.

Keep the product's Compose file and let cockpit run it. In the answers file, answer
`environment.generated` with the file instead of a generated stack. `init` proposes it under
`inferred` only when exactly one product Compose file sits inside the cockpit root; with Compose
files in several repositories, or outside the root, it proposes none and names them under
`interview.inferenceSkipped` with the cockpit-root `compose.yml` route described below:

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

When the Compose file lives inside a product repository checked out under the cockpit root
(`siblings_root = "."`), declare that repository as a sibling and point
`environment.compose_files` at its file, as in `compose_files = ["shop/compose.yml"]`. cockpit runs
that file in place and writes only its label override. Relative paths in it, such as `build: ./api`
and `"./api:/app"`, resolve against `shop/`, exactly as `docker compose -f shop/compose.yml` resolves
them, so the product's file needs no change. Check it with
`docker compose -f shop/compose.yml config` before answering.

Two layouts need a cockpit-root `compose.yml` of their own instead, because every relative path in
the listed files resolves against the first file's directory and every listed file must stay inside
the cockpit root:

- Compose files in two or more product repositories, each with its own `./` paths.
- A dedicated cockpit beside the product (`siblings_root = ".."`), whose repositories sit outside
  its root.

In that file, reach each checkout through its sibling variable, as in `build: ${SHOP_DIR}/api` and
`"${SHOP_DIR}/api:/app"`, and publish ports from `[ports.bases]` variables. Write the services
from the product's own files and tell the human which ones you copied. A Compose `include` of the
product's file is refused: Compose would read it outside the files cockpit verifies and labels. The
generated environment mode is the other choice.

`init` then asks `environment.machine`: the floor the product needs from the container runtime
(`runtime_memory_mb`, `runtime_cpus`, `free_disk_mb`, `cold_start_seconds`). These are product
requirements and `init` proposes none of them, so ask the human rather than picking numbers, and
answer under `[environment.machine]` in the answers file. If the human told you to choose
defaults, mark the floor `"agent-default"` under `[provenance]`; a floor with no provenance is
recorded as unattributed and listed under `unconfirmed` all the same.

It then asks `environment.posture`: how the product is addressed locally and how sign-in works.
For a plain localhost stack with no sign-in, answer under `[environment.posture]` with
`addressing = "port"`, `authentication = "none"` and
`posture_requirements = [{ requirement = "leased-localhost-ports", addressing = "port" }]`.
Ask the human when the product uses hostnames or a real or bypassed sign-in; the rules are in
[Declare environment postures](environment.md#declare-environment-postures).

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
./node_modules/.bin/cockpit sync --config cockpit.toml --adopt .claude/settings.json --json
./node_modules/.bin/cockpit check --config cockpit.toml --json
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
./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run --json
./node_modules/.bin/cockpit sync --config cockpit.toml --json
./node_modules/.bin/cockpit check --config cockpit.toml --json
```

### Remove a repository

Done when the sibling is gone from `cockpit.toml` and `check` exits 0.

```sh
./node_modules/.bin/cockpit sibling remove api --config cockpit.toml --json
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

Done when `runtime measure` exits 0 and names `.cockpit/local/runtime-measurements.json`.

Before the first `up`, measure the local container runtime on this machine:

```sh
./node_modules/.bin/cockpit runtime measure --config cockpit.toml --image <local-image> --json
```

It measures the local daemon `up` will use, chosen as
[Choose the Docker daemon](environment.md#choose-the-docker-daemon) describes. Name an
image already on the machine; the probe never pulls. The probe runs only from an installed
`@b0dea/cockpit` package, not from a linked source checkout. The supported runtime identities
and the checks a measurement must pass are in
[Measure the container runtime](environment.md#measure-the-container-runtime).

A measurement takes a few minutes and prints no progress, so wait for it to finish. It records the
result for this machine only, in a directory Git ignores, and leaves `cockpit.toml` unchanged, so
`cockpit check` still passes and the guard does not hold later tool calls; the agent can go straight
on to `up`. Measure again after the container engine is upgraded: `up` refuses with
`RUNTIME_UNMEASURED` and names the engine versions.

## Daily loop

Done when the agent command has exited and `session` has released the stack.

```sh
./node_modules/.bin/cockpit session --config cockpit.toml -- claude
./node_modules/.bin/cockpit sleep --config cockpit.toml --json
./node_modules/.bin/cockpit down --config cockpit.toml --json
```

`session` starts or resumes the stack, keeps it while the agent command after `--` runs, and
releases it afterwards. `sleep` releases this checkout's hold and stops the stack only when no
other checkout holds it. `down` removes this checkout's runtime; it is destructive, so ask first.
It deletes only from the local Docker daemon it fixes at the start of the run
([Choose the Docker daemon](environment.md#choose-the-docker-daemon)). Details are in
[Run an agent inside the environment](getting-started.md#run-an-agent-inside-the-environment)
and [Environment lifecycle](environment.md#lifecycle-and-ownership).

## Upgrade loop

Done when `cockpit check --config cockpit.toml --json` exits 0 on the new version.

Install the new cockpit version the same way it was installed, then:

```sh
./node_modules/.bin/cockpit check --config cockpit.toml --json
./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run --json
./node_modules/.bin/cockpit sync --config cockpit.toml --json
```

`check` shows what the new version renders differently; the dry run lists the writes for the
human to read before `sync`. The guard trusts only the cockpit, Node and `cockpit.toml` it was
generated for, so after an upgrade, a Node switch or an edit to `cockpit.toml` it holds every agent
tool call, `cockpit sync` run through the agent included, until a human regenerates. That is
deliberate: guard policy comes from `cockpit.toml`, and an agent able to apply its own edit could
loosen its guard. The refusal names what changed and the command to run. The upgrade sequence is:

1. Select the reviewed version and run
   `npm install --save-dev --save-exact @b0dea/cockpit@<version>`.
2. In a terminal, outside the agent, run
   `./node_modules/.bin/cockpit sync --config cockpit.toml`.
3. Review and commit the regenerated files.

Each clone keeps its own machine-local guard identity in `.cockpit/local/`, which Git ignores, so
teammates run step 2 after pulling and commit nothing extra. To inspect a release before
installing it, see [Review an upgrade](harness-surfaces.md#review-an-upgrade).
