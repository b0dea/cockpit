# Agent adoption guide

<!-- cockpit:verified version=0.0.0 -->

This guide is for an AI coding agent asked to "set up cockpit for our project", and for the human
watching it. It maps each starting situation to exact non-interactive commands and a completion
check. The [getting started guide](getting-started.md) is the same journey for a person at a
terminal.

## Safety contract

A clean-looking configuration with invented values in it is the failure cockpit exists to prevent.
Follow these rules for the whole adoption:

1. **Ask the human first, and wait for a yes,** before:
   - writing into a product repository (a Dockerfile, Compose file, `.env.schema` or anything
     else inside a sibling checkout);
   - creating a Git remote or a hosted repository;
   - any destructive command (`down`, `reset`, `sync --interactive` removals, deleting files);
   - `cockpit sync --adopt`, which moves the team's own agent settings;
   - accepting an `init` digest (`--accept-preview`, `--accept-defaults`);
   - committing in the cockpit repository, unless the human asked you to commit.
2. **Show the exact preview before you ask:** the `sync --dry-run` listing, the `init` preview
   with its `previewSha256`, the answers file, or the defaults digest. Consent binds to those
   bytes; a digest from anything but the latest pending run is refused.
3. **Never invent a configuration value.** A port, image, command, health check, purpose or name
   comes from a file you read or from the human. Otherwise leave a named gap and ask.
4. **Inferred values need confirmation.** Show everything you derive, and everything `init`
   proposes under `provenance.kind = "inferred"`, with the file it came from. It becomes an answer
   only on the human's word.
5. **Ask for every non-local host.** The `guards` answer lists the database and live vendor API
   hosts of production, staging and shared environments. Propose the variable names `init` found
   in env templates, never read their values, and take each host from the human.
6. **Defaults never reach into a product repository.** "Use sensible defaults" or "don't ask me"
   covers `init` answers only. An **AGENTS.md** pointer, a Compose file, a `package.json` or
   anything else inside a product repository still needs an explicit yes to that exact change.
   Mark every answer you chose yourself as `"agent-default"`
   ([Mark the answers you chose](#mark-the-answers-you-chose)), and end your report with every
   default you chose, its field and its value.

These rules are instructions, not enforcement. The guard cockpit installs later blocks some
commands; see [Safety and autonomy](safety-and-autonomy.md).

## Read a cockpit result

- Pass `--json` to every command except `session`. Each prints one JSON document on stdout with
  `result`, `diagnostics` (each with a `severity` and a `code`) and `invocation.exitCode`.
- A refusal exits nonzero and names its diagnostic; look the code up in
  [Troubleshooting](troubleshooting.md).
- Take flags from `cockpit <command> --help` or the [CLI reference](cli-reference.md), not from
  memory.
- `init` also exits 0 when it stops at a question. Read `result.stage`, `result.question`,
  `result.cockpitRoot` and `result.interview.outstanding` to find the pending decision.

## Install cockpit

Done when `./node_modules/.bin/cockpit --help`, run from the cockpit directory, lists the commands.

The cockpit is a directory of its own beside the product repositories. It does not exist yet, so
the first `init` runs from a temporary installation:

| Starting point | Bootstrap with |
|---|---|
| An existing product repository | [Bootstrap an existing product](getting-started.md#bootstrap-an-existing-product), run from inside the product repository, then [Inside a product repository](#inside-a-product-repository) |
| An empty directory, documents only, or several repositories side by side | [Bootstrap without a project manifest](getting-started.md#bootstrap-without-a-project-manifest), run from the intended cockpit directory |

1. Show the human which directory will receive the dependency and lockfile before installing.
   Supported Node releases and the source-package fallback are in
   [Install cockpit](getting-started.md#install-cockpit).
2. During bootstrap, replace `./node_modules/.bin/cockpit` in the `init` examples below with the
   temporary executable's path. Do not add a package manifest to the cockpit root first: it would
   make the root look like a product repository.
3. After `init` writes the cockpit's package manifest, install cockpit there and run every command
   from the cockpit directory as `./node_modules/.bin/cockpit`. A local install is not on a normal
   terminal's PATH.
4. If the executable is absent, repair the install. Never use a command runner that downloads a
   missing package: it bypasses the project's reviewed version.

Every `init` needs `--target <id>` for your agent tool. The examples use `claudecode`; Codex CLI
is `codexcli` and OpenCode is `opencode`. These three get cockpit's guard hook. Other targets get
generated files and no guard, and generation alone does not establish guard or permission
enforcement; for an instructions-only tool follow
[Capability states](harness-surfaces.md#capability-states). The
[capability matrix](capability-matrix.md) lists every target and what it is measured to enforce.

## Choose your situation

Look at what is on disk before asking; start from that, not from what the human called it.

| On disk | Go to |
|---|---|
| Nothing yet: an empty directory, a product not started | [Empty directory](#empty-directory) |
| You are inside an existing product repository | [Inside a product repository](#inside-a-product-repository) |
| One repository of documents, decisions or notes, with nothing to run | [Docs or decisions only](#docs-or-decisions-only) |
| One repository with a service that runs, or several side by side | [One or several repositories](#one-or-several-repositories) |
| Repositories scattered across the disk | [Scattered repositories](#scattered-repositories) |
| A Compose file that already starts the product | [Existing Compose file](#existing-compose-file) |
| A service that has only ever run in CI, staging or a cluster | [No local setup](#no-local-setup) |
| Committed `.claude/settings.json`, `.codex/config.toml` or `.codex/hooks.json` | [Existing agent settings](#existing-agent-settings) |
| A cockpit exists and a repository joins it | [Add a repository](#add-a-repository) |
| A cockpit exists and a repository leaves it | [Remove a repository](#remove-a-repository) |
| A sibling has a `.env.schema` (Varlock) | [Varlock-managed environment](#varlock-managed-environment) |

Several can apply at once. Handle the bootstrap case first, then the others.

The cockpit checkout is the directory holding `cockpit.toml` and the generated files;
[Where the cockpit lives](concepts.md#where-the-cockpit-lives) says why it sits beside the product
repositories and covers the exceptions. If it is not a Git repository yet, ask before running
`git init` there: the generated files are meant to be committed.

### Empty directory

Done when `cockpit check --config cockpit.toml --json` and `cockpit setup --config cockpit.toml --json`
exit 0 and every repository the human named is declared. `setup` refuses a cockpit root outside
Git (`SETUP_PATH_TYPE_INVALID`); `init` and `doctor` report it under `cockpit-git` in
`result.readiness`.

With no repository under the root, `init` builds a surfaces-only cockpit whose first sibling is
the root itself: the schema needs one sibling, and the root holds the product's notes and
decisions until its repositories exist.

1. **Preview** from the directory that will hold the cockpit:

   ```sh
   ./node_modules/.bin/cockpit init "$(pwd)" --target claudecode --json
   ```

   `result.interview.outstanding` lists `cockpit.name` (proposed: the directory name),
   `sibling`, `ports.bases`, `guards` and `configuration.defaults`. Under `sibling`, `inferred`
   proposes the root row: the directory name as `slug`, `dir = "."`, `mount = "none"`,
   `acquire = "none"`, and no `purpose`.
2. **Write the answers file** with the purpose and non-local hosts from the human. A product not
   yet started usually has no hosts; an explicit empty answer is recorded as a decision. For a
   directory named `orders`:

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

   `mount = "none"` is correct while the root has no runtime. If the generated stack later must
   bind-mount it, change the row to `mount = "always"`, then run
   `cockpit sync --config cockpit.toml` and `cockpit check --config cockpit.toml`. The root
   `AGENTS.md` and `CLAUDE.md` are already native harness inputs, so sync does not project them
   into themselves; other declared guide paths still project normally.
3. **Accept the preview, the answers and the defaults** exactly as in steps 3 and 4 of
   [One or several repositories](#one-or-several-repositories). The run ends at
   `environment-verified` and reports `ENVIRONMENT_NOT_DECLARED` as information.
4. **Add each repository** the product will have. `--purpose` is required and comes from the
   human:

   ```sh
   ./node_modules/.bin/cockpit sibling add api --config cockpit.toml --create --purpose "HTTP API for orders" --json
   ```

   `--create` runs `git init` on an empty or missing directory and never creates a hosted
   repository. Hand the human `result.publish.command` (a `gh repo create` command);
   `result.publish.recordRemote` is the `sibling add <slug> --remote <url>` call that records the
   result. Then preview, publish and check:

   ```sh
   ./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run --json
   ./node_modules/.bin/cockpit sync --config cockpit.toml --json
   ./node_modules/.bin/cockpit check --config cockpit.toml --json
   ```

### Inside a product repository

Done when the human has chosen the cockpit root and `init` reports `environment-verified` from
that root, or has stopped at a named gap you have reported.

A Git checkout with a language manifest, Dockerfile or standard Compose filename at its root is
treated as a product repository, so `init` never writes into it unasked. Its `--json` preview
carries `result.cockpitRoot` first: the question, both options with the exact paths each writes,
and `recommended = "dedicated"`.

1. Relay the question to the human with both trade-offs
   ([Where the cockpit lives](concepts.md#where-the-cockpit-lives) states them). Never answer it
   yourself: `--accept-preview` and `--accept-defaults` refuse with `INIT_COCKPIT_ROOT_REQUIRED`
   until the answers file has it:

   ```toml
   cockpit.root = "dedicated"   # or "in-repo"
   ```

   An option with `unavailable` set cannot be taken (for example, a repository directory name that
   is not a valid sibling slug); it says why and what to do instead.
2. Continue by answer:

   | Answer | What `init` does | Where you keep running |
   |---|---|---|
   | `"dedicated"` | Creates the folder in that option's `creates`, initialises it as a local Git repository, and declares the product repository as its first sibling (`dir` is the repository's name, `siblings_root = ".."`). | The same command, from the product repository, with the same answers file. Run from the new folder, `init` would see a fresh empty cockpit. `result.root` is the cockpit root; later `sync`, `check` and `sibling add` take `--config <result.root>/cockpit.toml`. |
   | `"in-repo"` | Proposes the repository's own runnable sources as its first sibling (`dir = "."`). | The product repository, continuing from step 2 of [One or several repositories](#one-or-several-repositories). |

Either way `init` declares only the repository it runs in; an answers file that adds another is
refused with `DOCUMENT_ESTATE_TOPOLOGY_MISMATCH`. Add other repositories after `init`, with
[`sibling add`](#add-a-repository).

### Docs or decisions only

Done when `cockpit check --config cockpit.toml --json` exits 0 and `cockpit up` refuses with
`ENVIRONMENT_NOT_DECLARED`.

A repository with no language manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`,
`Gemfile`), Dockerfile or standard Compose file has nothing runnable. Run `init` from it and follow
[Empty directory](#empty-directory) steps 1 to 3: the repository is the cockpit root and its own
first sibling. [Environment modes](environment.md#environment-modes) explains what surfaces-only
publishes. `ENVIRONMENT_NOT_DECLARED` from the runtime commands is the expected result, not a
failure to fix.

### One or several repositories

Done when `init` reports `environment-verified`, or has stopped at a named gap you have reported.

Run from the directory that holds the repositories. One repository gets the same cockpit as
several: instructions, guards and settings. Each step stops for the human.

1. **Preview.** It writes nothing:

   ```sh
   ./node_modules/.bin/cockpit init "$(pwd)" --target claudecode --json
   ```

   Read `result.previewSha256` and `result.interview.outstanding`: every field `init` will ask, in
   order, each with a `why` and the values it could propose. A trimmed real preview for three
   repositories:

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

2. **Write the answers file:** one TOML key per outstanding field, from what you read and what the
   human told you. The field table and an example are in
   [Bootstrap without a terminal](getting-started.md#bootstrap-without-a-terminal). Ask the human
   for `cockpit.name` (the proposal is the directory name). Mark answers you chose yourself
   ([Mark the answers you chose](#mark-the-answers-you-chose)). Show the human the whole file,
   every inferred value with its source, and the `previewSha256`.
3. **Accept the preview and the answers** once the human agrees:

   ```sh
   ./node_modules/.bin/cockpit init "$(pwd)" --target claudecode --accept-preview <previewSha256> --answers ./answers.toml --json
   ```

   The run stops at the first unanswered field, or at `configuration.defaults`. There,
   `result.question.document` holds the validated review draft as an array of lines; joining them
   with `\n` reproduces it exactly, final newline included. Its provenance comments show every
   inferred and default value with its target and reason, and
   `result.question.expectedSha256` covers those values. Nothing is written to `cockpit.toml`
   before acceptance; the `DOCUMENT_DEFAULT` and `DOCUMENT_INFERRED` diagnostics give the reasons.
4. **Accept the defaults** after the human has read those attributed values:

   ```sh
   ./node_modules/.bin/cockpit init "$(pwd)" --target claudecode --accept-preview <previewSha256> --answers ./answers.toml --accept-defaults <expectedSha256> --json
   ```

   This writes `cockpit.toml`, syncs, checks and runs `preflight`. Where a runtime is declared,
   the run stops with `STATE_UNSEEDED` (exit 2, `result.stage = "draft-observed"`): `preflight`
   needs a completed first bring-up. The diagnostics beside it are every other gap found without
   a running stack; `result.readiness` groups them ([Walk through readiness](#walk-through-readiness)).
   Clear them, then rerun the same command:
   - The cockpit repository must be committed and clean
     ([Preflight observations](environment.md#preflight-observations)). A new one reports
     `GIT_STATE_UNHEALTHY` (no commits yet), and the row's fix stages and commits every file Git
     does not ignore. Show the human `git status --short` and ask before committing (rule 1 of the
     [Safety contract](#safety-contract)).
   - The runtime must be measured ([Measure the runtime](#measure-the-runtime)), and then the stack
     brought up once with `cockpit up --config cockpit.toml`.

Rerunning with the same answers file resumes. A changed value for a recorded answer is refused with
`INIT_ANSWER_CONFLICT`: drop that key to keep the recorded answer, or follow the
[recorded-answer reset](getting-started.md#bootstrap-without-a-terminal) before `cockpit.toml` is
prepared.

### Walk through readiness

Done when every gap in `result.readiness` is cleared, or reported to the human with its fix.

Every `init` stop and `cockpit doctor --config cockpit.toml --json` carry `result.readiness`: the
prerequisites cockpit depends on, grouped from the diagnostics that run reported. Each entry in
`gaps` has an `id`, a `level` (`required` ones are refused by the command that needs them;
`recommended` ones only warn), `needs` (why cockpit needs it) and `findings` (each diagnostic with
its message and fix). `noFinding` lists the prerequisites no check reported; a check that could not
run reports nothing, so it is not proof. Before the first `up`, `doctor` and `preflight` still run
every check that needs no running stack, and report the rest as not applicable.

Take the gaps one at a time, required ones first: what is missing, why cockpit needs it, and the
exact change you propose. Ask before touching a product repository (rule 1 of the
[Safety contract](#safety-contract)). Judgement calls (which test runner to adopt, whether the
existing tests prove anything, where characterization tests go) are the human's: propose, with
what you read. `init` runs from a temporary install, so `cockpit-installed` is reported on every
new cockpit: run `npm install` in the cockpit root, then ask the human to run
`./node_modules/.bin/cockpit sync --config cockpit.toml` in a terminal so the guard hook runs the
installed copy. Rerun `doctor` after each fix.

### Mark the answers you chose

Done when every answer you chose yourself is listed under `[provenance]` and your report names it.

`init` records a person's answer in `cockpit.toml` as something they stated. When the human
delegated a decision ("pick sensible defaults"), say so per field so the value is never recorded
as theirs:

```toml
[provenance]
"environment.machine" = "agent-default"
guards = "agent-default"
```

Each key is an answers-file field. The value is `"agent-default"` (you chose it) or `"human"` (the
human stated it; the same as leaving the field out). For each agent default, `init`:

- writes it under `unconfirmed` at the top of `cockpit.toml` with a `# Unconfirmed:` comment;
- lists it in `result.unconfirmed` and as a `DOCUMENT_ANSWER_UNCONFIRMED` warning.

`doctor` then reports `DECLARATION_UNCONFIRMED` until a person confirms each value, deletes its
entry from `unconfirmed` and runs `sync`. An `environment.machine` floor the file does not
attribute is recorded as unattributed, not as the human's, because cockpit never proposes one.

### Scattered repositories

Done when every repository is declared and `cockpit setup --config cockpit.toml --json` exits 0.

Moving checkouts is the human's call. Either they put the repositories side by side and you follow
[One or several repositories](#one-or-several-repositories), or you point a cockpit at each
checkout where it is:

```sh
./node_modules/.bin/cockpit sibling add billing --config cockpit.toml --from ~/code/billing --purpose "Billing worker" --json
./node_modules/.bin/cockpit setup --config cockpit.toml --json
```

`--from` records the checkout's `origin` remote with `acquire = "auto"`, so `setup` clones a fresh
copy into the cockpit. It never moves, changes or deletes the original, and refuses a checkout
with no `origin`. It needs an existing `cockpit.toml`: start from
[Empty directory](#empty-directory), or from `init` over the repositories already together.

### Existing Compose file

Done when `cockpit check --config cockpit.toml --json` exits 0 with no `COMPOSE_PORT_NOT_LEASED`.

Keep the product's Compose file and let cockpit run it: answer `environment.generated` with the
file instead of a generated stack. `init` proposes it under `inferred` only when exactly one
product Compose file sits inside the cockpit root. With Compose files in several repositories, or
outside the root, it proposes none and names them under `interview.inferenceSkipped`.

```toml
[environment]
install_policies = []
compose_files = ["compose.yml"]
```

`check` reads the topology with `docker compose config`. Every published host port must come from
a `[ports.bases]` variable, and a service without a healthcheck warns. The rules are in
[Environment modes](environment.md#environment-modes); a working layout is
[examples/compose-first](../examples/compose-first/README.md). Changing the Compose file is a
product change: ask first.

Pick the layout by where the Compose files are:

| Compose files | Answer |
|---|---|
| One, inside a product repository checked out under the cockpit root (`siblings_root = "."`) | Declare that repository as a sibling and point at its file in place, as in `compose_files = ["shop/compose.yml"]`. Relative paths such as `build: ./api` and `"./api:/app"` resolve against `shop/`, as with `docker compose -f shop/compose.yml`, so the product file needs no change. Check it with `docker compose -f shop/compose.yml config` before answering. cockpit writes only its label override. |
| In two or more product repositories, each with its own `./` paths | A cockpit-root `compose.yml` of your own (below). |
| Outside the cockpit root, as in a dedicated cockpit (`siblings_root = ".."`) | A cockpit-root `compose.yml` of your own (below). |

The last two need their own file because relative paths in every listed file resolve against the
first file's directory, and every listed file must stay inside the cockpit root. In that file,
reach each checkout through its sibling variable (`build: ${SHOP_DIR}/api`,
`"${SHOP_DIR}/api:/app"`) and publish ports from `[ports.bases]` variables. Write the services from
the product's own files and tell the human which ones you copied. A Compose `include` of the
product's file is refused: Compose would read it outside the files cockpit verifies and labels. The
generated environment mode is the other choice.

`init` then asks two more fields:

- `environment.machine`: the floor the product needs from the container runtime
  (`runtime_memory_mb`, `runtime_cpus`, `free_disk_mb`, `cold_start_seconds`). These are product
  requirements and `init` proposes none, so ask the human; answer under `[environment.machine]`.
  If told to choose defaults, mark the floor `"agent-default"` under `[provenance]`. A floor with
  no provenance is recorded as unattributed and listed under `unconfirmed` all the same.
- `environment.posture`: how the product is addressed locally and how sign-in works. For a plain
  localhost stack with no sign-in, answer under `[environment.posture]` with
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
proposes some of these: a Dockerfile's `EXPOSE`, `CMD` and `HEALTHCHECK`, a `package.json`
`start`, `serve` or `dev` script, the toolchain a Node lockfile names, each repository's `origin`
remote, `.env.example` variable names, and the `services:` of GitHub workflows.

### Existing agent settings

Done when `cockpit check --config cockpit.toml --json` exits 0 and the adopted copy sits under
`cockpit/adopted/`.

A plain `sync` refuses to overwrite a committed `.claude/settings.json`, `.codex/config.toml` or
`.codex/hooks.json` with `SURFACE_STATE_CONFLICT` and names the command that keeps it. Show the
human the file, ask, then adopt it:

```sh
./node_modules/.bin/cockpit sync --config cockpit.toml --adopt .claude/settings.json --json
./node_modules/.bin/cockpit check --config cockpit.toml --json
```

Repeat `--adopt` once per file. OpenCode needs no adoption. What is merged, and which settings are
refused with `SURFACE_ADOPTION_REFUSED`, is in
[Adopt existing agent settings](adoption.md#adopt-existing-agent-settings).

### Add a repository

Done when `cockpit check --config cockpit.toml --json` exits 0 after the sync.

Pick the `sibling add` form by where the repository is: already under the siblings root (no flag),
not yet existing (`--create`), elsewhere on disk (`--from`) or only a remote (`--remote`). The
forms are in [Add or remove a repository](getting-started.md#add-or-remove-a-repository). Then:

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

`remove` refuses, listing every reference, while anything still uses the sibling. It never deletes
the checkout; `result.flaggedForReview` names generated files to look at. Then run the sync
sequence from [Add a repository](#add-a-repository). If `sync` would remove a stale generated file
it refuses; the human approves the removal in a terminal with `cockpit sync --interactive`.

### Varlock-managed environment

Done when `preflight` reports no `ENV_SCHEMA_UNHEALTHY` row.

`preflight` and `doctor` check every sibling with a `.env.schema` through Varlock and report key
names and validity, never values. Follow **Secret handling** in the
[shipped procedure](../packages/cockpit/surfaces/skills/procedures/onboarding.md#secret-handling)
and [Secret sources and environment schemas](environment.md#secret-sources-and-environment-schemas).
`varlock init`, provider login, encryption and moving secrets are the human's actions: preview
them, do not run them.

## Measure the runtime

Done when `runtime measure` exits 0 and names `machine/runtime-measurements.json` under the per-user state root.

Before the first `up`, measure the local container runtime on this machine:

```sh
./node_modules/.bin/cockpit runtime measure --config cockpit.toml --image <local-image> --json
```

- It measures the daemon `up` will use, chosen as
  [Choose the Docker daemon](environment.md#choose-the-docker-daemon) describes.
- Name an image already on the machine; the probe never pulls.
- The probe runs only from an installed `@b0dea/cockpit` package, not a linked source checkout.
- It can run for minutes with no progress output; wait for it to exit.
- It records the result for this machine only, under the per-user state root, so every checkout and
  worktree shares it, and leaves `cockpit.toml` unchanged. `cockpit check` still passes and the guard does not hold later tool
  calls, so go straight on to `up`.
- Measure again after the container engine is upgraded: `up` refuses with `RUNTIME_UNMEASURED` and
  names the engine versions.

Supported runtimes and the checks a measurement must pass are in
[Measure the container runtime](environment.md#measure-the-container-runtime).

## Daily loop

Done when the agent command has exited and `session` has released the stack.

```sh
./node_modules/.bin/cockpit session --config cockpit.toml -- claude
./node_modules/.bin/cockpit sleep --config cockpit.toml --json
./node_modules/.bin/cockpit down --config cockpit.toml --json
```

| Command | Effect |
|---|---|
| `session` | Starts or resumes the stack, keeps it while the agent command after `--` runs, then releases it. |
| `sleep` | Releases this checkout's hold; stops the stack only when no other checkout holds it. |
| `down` | Removes this checkout's runtime, only from the local Docker daemon fixed at the start of the run ([Choose the Docker daemon](environment.md#choose-the-docker-daemon)). Destructive: ask first. |

Details: [Run an agent inside the environment](getting-started.md#run-an-agent-inside-the-environment)
and [Environment lifecycle](environment.md#lifecycle-and-ownership).

## Upgrade loop

Done when `cockpit check --config cockpit.toml --json` exits 0 on the new version.

Install the new version the same way as the old one, then:

```sh
./node_modules/.bin/cockpit check --config cockpit.toml --json
./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run --json
./node_modules/.bin/cockpit sync --config cockpit.toml --json
```

`check` shows what the new version renders differently; the dry run lists the writes for the human
to read before `sync`.

The guard trusts only the cockpit, Node and `cockpit.toml` it was generated for. After an upgrade,
a Node switch or an edit to `cockpit.toml`, it holds every agent tool call, `cockpit sync` run
through the agent included, until a human regenerates. That is deliberate: guard policy comes from
`cockpit.toml`, and an agent able to apply its own edit could loosen its guard. The refusal names
what changed and the command to run. The upgrade sequence:

1. Select the reviewed version and run
   `npm install --save-dev --save-exact @b0dea/cockpit@<version>`.
2. In a terminal, outside the agent, run
   `./node_modules/.bin/cockpit sync --config cockpit.toml`.
3. Review and commit the regenerated files.

Each clone keeps its own machine-local guard identity in `.cockpit/local/`, which Git ignores, so
teammates run step 2 after pulling and commit nothing extra. To inspect a release before
installing it, see [Review an upgrade](harness-surfaces.md#review-an-upgrade).
