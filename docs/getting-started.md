# Getting started

<!-- cockpit:verified version=0.0.0 -->

This guide takes you from installing cockpit to your own product running under it. It is for
developers setting cockpit up for a product with one or several repositories. To watch cockpit
work on a throwaway example first, follow the [tutorial](tutorial.md).

## Choose a starting point

| Your situation | Start with |
|---|---|
| An existing product repository with no cockpit yet | [Bootstrap an existing product](#bootstrap-an-existing-product) |
| A new product, an empty directory or a folder of documents | [Bootstrap without a project manifest](#bootstrap-without-a-project-manifest) |
| An existing cockpit driven by a shell registry | [Incremental adoption](adoption.md) |
| You would rather write the configuration by hand | The annotated example in the [tutorial](tutorial.md#read-the-configuration) |

Every route ends with a cockpit directory of its own beside the product's repositories, holding
<!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`. [Where the cockpit lives](concepts.md#where-the-cockpit-lives)
explains why a product repository is not the default, and
[Configuration essentials](configuration-essentials.md) walks through the tables a typical
`cockpit.toml` sets.

A hand-written configuration needs no `init`: its first `sync` adds the `cockpit:*` scripts,
package pin and marked `.gitignore` region `init` would (preview with `sync --dry-run`). It refuses
a conflicting script or pin, an edited marked region, and a cockpit entry in `dependencies`,
`optionalDependencies` or `peerDependencies`: the exact pin belongs in `devDependencies` only.

## Install cockpit

You need a Node.js release listed in the
[`engines` field in the package manifest](../packages/cockpit/package.json), Git, and macOS or
Linux. Commands that run the stack also need Docker Compose and a local runtime that has passed
`cockpit runtime measure`; [Measure the container runtime](environment.md#measure-the-container-runtime)
lists those commands and the supported runtimes. Configuration, generation, and surfaces-only
`setup` and `check` need no container runtime; validating declared Compose files needs Docker
Compose.

Do not create a cockpit directory and install into it first: the first `init` runs from a
temporary installation, as the two bootstrap sections below show. (An `init` run in an empty
directory beside the product finds nothing to run and builds a cockpit that does not know the
product.) Once the cockpit directory has its own `package.json`, install cockpit there:

```sh
npm install --save-dev --save-exact @b00dea/cockpit
./node_modules/.bin/cockpit --help
```

Until the first release, install from source instead: build the tarball as in
[Install from source](#install-from-source), and wherever this guide installs `@b00dea/cockpit`,
install `"$COCKPIT_PACKAGE_DIR"/*.tgz`.

Run every command from the cockpit directory as `./node_modules/.bin/cockpit <command>`. That
path fails when the dependency is missing and never downloads a package; so does the `npx --no`
form fix hints print, such as `npx --no cockpit check --config cockpit.toml`. Once `init` has
written the `cockpit:*` package scripts, use them for setup, sync and check. The package ships
these guides under `./node_modules/@b00dea/cockpit/docs/`, so skills and fix hints cite them offline.

### Install from source

Pack the package and install the tarball. That exercises the same files, lifecycle scripts,
dependencies and binary entry point as a registry install; `npm link` does not.

```sh
git clone https://github.com/b0dea/cockpit.git
cd cockpit
npm ci --ignore-scripts
npm run build
COCKPIT_PACKAGE_DIR="$(mktemp -d)"
npm pack --workspace @b00dea/cockpit --pack-destination "$COCKPIT_PACKAGE_DIR"
cd /path/to/the-cockpit-directory
npm install -D "$COCKPIT_PACKAGE_DIR"/*.tgz
./node_modules/.bin/cockpit --help
```

`--help` prints `Usage: cockpit <command> [options]` and the command list; the
[command list](command-list.md) and [CLI reference](cli-reference.md) are generated from the same
CLI. If `npm pack` or `npm install` fails, stop: a command run from the source checkout does not
prove the package works. Keep the tarball while the lockfile resolves cockpit from it (deleting it
breaks `npm ci`, and teammates cannot install from your local file); remove it with
`rm -r "$COCKPIT_PACKAGE_DIR"` once a registry version replaces it in manifest and lockfile.

### Bootstrap without a project manifest

For an empty directory, a folder of documents, or a central directory for several repositories.
Keep the first installation outside it: `init` treats a Git checkout with a language manifest,
Dockerfile or standard Compose file as a product repository, and a `package.json` that only
installs cockpit looks like a dependency-free library.

From the intended cockpit directory, install a temporary executable and preview:

```sh
COCKPIT_BOOTSTRAP_DIR="$(mktemp -d)"
npm install --prefix "$COCKPIT_BOOTSTRAP_DIR" --save-dev --save-exact @b00dea/cockpit
"$COCKPIT_BOOTSTRAP_DIR/node_modules/.bin/cockpit" init "$(pwd)" --target <tool> --json
```

Replace `<tool>` with your agent tool's target, listed under
[Bootstrap a new product](#bootstrap-a-new-product). Run every remaining `init` command, including
acceptance, with that same temporary executable.
Then continue with [Bootstrap a new product](#bootstrap-a-new-product). Once `init` has written
the cockpit's `package.json`, install cockpit in the cockpit directory as above and check
`./node_modules/.bin/cockpit --help`. Remove the temporary installation only after the
[setup, sync and check sequence](#bring-the-product-up) passes:

```sh
rm -r -- "$COCKPIT_BOOTSTRAP_DIR"
```

If a central directory already has a `package.json`, keep it: write the configuration by hand and
preview `sync`, or start from a product repository instead. Do not delete package files to change
what `init` discovers.

### Bootstrap an existing product

From inside the product repository, install the same temporary executable and preview, replacing
`<tool>` as above:

```sh
COCKPIT_BOOTSTRAP_DIR="$(mktemp -d)"
npm install --prefix "$COCKPIT_BOOTSTRAP_DIR" --save-dev --save-exact @b00dea/cockpit
"$COCKPIT_BOOTSTRAP_DIR/node_modules/.bin/cockpit" init "$(pwd)" --target <tool> --json
```

The first question is the cockpit root (`cockpit.root`). Answer `"dedicated"`, the
recommendation: `init` creates `../<repo>-cockpit`, initialises it as a local Git repository, and
declares the product repository as its first sibling with `siblings_root = ".."`. Keep running the
same `init` command from the product repository with the same answers file; `result.root` names
the new cockpit, and later commands take `--config <result.root>/cockpit.toml`.
The rest of the interview is described under [Bootstrap a new product](#bootstrap-a-new-product),
and [Inside a product repository](agent-adoption.md#inside-a-product-repository) walks through each
answer. Then install cockpit in the new directory and remove the temporary installation as above.

Compose files must sit inside the cockpit root, so a Compose file in the product repository is
out of reach of a dedicated cockpit; declare a generated environment instead, or see
[Existing Compose file](agent-adoption.md#existing-compose-file) for the alternatives.

## Bootstrap a new product

This is the `init` interview every bootstrap goes through. The commands below use
`./node_modules/.bin/cockpit`; until the cockpit directory has its own installation, run them with
the temporary executable from the bootstrap step.

Replace `<tool>` in these commands with your agent tool's target: `claudecode` (Claude Code),
`codexcli` (Codex CLI), `opencode` (OpenCode), `cursor` (Cursor) or `grokcli` (Grok Build). The
[capability matrix](capability-matrix.md) says what each one enforces. Preview:

```sh
./node_modules/.bin/cockpit init "$(pwd)" --target <tool> --json
```

The preview writes nothing. It returns the files it would install (the cockpit-setup skill for
that harness), a `previewSha256` digest and the next step. To accept, run the same command in a
terminal and type the digest it shows:

```sh
./node_modules/.bin/cockpit init "$(pwd)" --target <tool> --interactive
```

`init` reads the repositories under the directory and asks for every fact it cannot read from
them: commands, images, health checks and the port map. Each accepted answer records where it came
from; a changed repository invalidates earlier answers instead of reusing them. Re-running the
same command resumes where it stopped. What you get depends on what it finds:

- **Inside an existing product repository**, `init` asks for `cockpit.root` first (see
  [Where the cockpit lives](concepts.md#where-the-cockpit-lives)) and declares only that
  repository. Add the others afterwards with [`sibling add`](#add-or-remove-a-repository);
  naming them in the answers file is refused with `DOCUMENT_ESTATE_TOPOLOGY_MISMATCH`.
- **Nothing runnable** gets a surfaces-only configuration with no `[environment]`, and `init`
  says no runtime is declared ([Environment modes](environment.md#environment-modes)). In an empty
  directory or a repository of documents, `init` proposes the cockpit root itself as the first
  sibling (`dir = "."`, `mount = "none"`); add the product's repositories later with `sibling add`.
- **A declared runtime** adds a question about the machine floor the product needs.

Every interview asks for the database and live vendor API hosts of each non-local environment
(production, staging, shared), which the generated guard denies to agents; an explicit empty answer
is recorded as a decision. Review the port map, environment declaration, guard hosts and defaults
before accepting. `init` also adds the `cockpit:*` scripts, the exact version pin and a marked
`.gitignore` block: commit them with the generated cockpit, and point teammates at
[Joining a team's cockpit](joining-a-team.md).

### Bootstrap without a terminal

An agent or CI job has no terminal, so `--interactive` refuses with `INIT_TERMINAL_REQUIRED`.
Pass consent and answers as arguments instead. Each digest comes from a pending run, so consent
stays bound to the exact bytes shown; there is no blanket `--yes`.

1. Run the preview. With `--json` it returns the `previewSha256` to accept and, under
   `interview.outstanding`, every field the interview will still ask, in order. Each entry has a
   `why` and the values `init` could propose, each with `provenance.kind` `inferred` and the file
   it was read from.
2. Write the answers as TOML, keyed by field, and show them to the human with the digest.
3. Rerun with `--accept-preview <previewSha256>` and `--answers <file>`. The run stops at the
   first unanswered field, or at `configuration.defaults`. There, `result.question.document` is
   the review draft as an array of lines (join with `\n` for the exact draft, final newline
   included): the validated configuration that will be published, with provenance comments for
   each inferred or default value. `result.question.expectedSha256` covers those values. Read the
   draft before asking the human to accept that digest; it is not yet written to `cockpit.toml`.
   A draft too large to review in full is refused with `INIT_DRAFT_INVALID`; shorten the answers,
   resetting a recorded one first (below).
4. Rerun with `--accept-defaults <expectedSha256>` as well. A digest that is not the pending one is
   refused (`INIT_PREVIEW_NOT_ACCEPTED`, `INIT_DEFAULTS_NOT_ACCEPTED`).

If the installed cockpit package changes during an interrupted bootstrap, rerun the read-only
preview and accept its fresh `previewSha256`. A missing or edited bootstrap file is refused and
left in place for inspection.

```sh
./node_modules/.bin/cockpit init "$(pwd)" --target <tool> --json
./node_modules/.bin/cockpit init "$(pwd)" --target <tool> --accept-preview <previewSha256> --answers ./answers.toml --json
./node_modules/.bin/cockpit init "$(pwd)" --target <tool> --accept-preview <previewSha256> --answers ./answers.toml --accept-defaults <expectedSha256> --json
```

The answers file spells each field as a TOML path, so `ports.bases` is the `bases` key of a
`[ports]` table; a key that names no field is refused. For a directory with one library and
nothing runnable, the whole file is:

```toml
[cockpit]
name = "library"

[[sibling]]
slug = "library"
dir = "library"
mount = "always"
acquire = "none"
var = "LIBRARY_DIR"
purpose = "Shared library"

[ports]
bases = {}

[guards]
hosted_db_hosts = []
vendor_endpoint_hosts = []
```

| Field | Answer |
|---|---|
| `cockpit.root` | `"dedicated"` or `"in-repo"`, asked only inside a product repository and never chosen by a digest flag ([Where the cockpit lives](concepts.md#where-the-cockpit-lives)) |
| `cockpit.name` | always asked; the root directory's name is proposed when valid. It scopes Compose projects, state and generated files ([Rename a cockpit](#rename-a-cockpit)) |
| `sibling` | one `[[sibling]]` table per repository |
| `estate.runnable` | one table per repository whose run command was unknown, keyed by its slug |
| `ports.bases` | the host-published base port map; `{}` means none |
| `environment.install_policies` | the dependency install protocols; `[]` for none |
| `environment.test_data` | exactly the boolean keys `seeded_data` and `signed_in_users`; `false` states it is not needed, `true` keeps the product-owned work visible |
| `environment.generated` | the generated environment to render |
| `environment.compose_files` | a Compose file the checkout already has, instead of `environment.generated` |
| `environment.machine` | the runtime floor: `runtime_memory_mb`, `runtime_cpus`, `free_disk_mb`, `cold_start_seconds`; asked only where a runtime is declared, never proposed |
| `environment.posture` | exactly `addressing`, `authentication` and `posture_requirements`: how the product is reached locally and how sign-in works; asked only where a runtime is declared, and a posture that would fail `preflight` is refused ([Declare environment postures](environment.md#declare-environment-postures)) |
| `testing` | the product's `[testing]` stages and gates, asked only where a runtime is declared; `"none"` records that the product has no tests yet, so no work can be graded PASS and `doctor` warns (`TESTING_GATE_UNDECLARED`) |
| `guards` | `hosted_db_hosts` and `vendor_endpoint_hosts` of every non-local environment; `[]` for both records that none exists |
| `provenance` | optional; who chose each answer, keyed by field: `"human"` (the default) or `"agent-default"`, for example `"environment.machine" = "agent-default"`. Each key must be a field the same file answers; `cockpit.root` takes none |

An answer is recorded as stated by a person unless `[provenance]` marks it `"agent-default"`. Each
agent default, and any `environment.machine` floor the file does not attribute, is listed under
`unconfirmed` at the top of `cockpit.toml`, reported in `result.unconfirmed`, and named by
`doctor` (`DECLARATION_UNCONFIRMED`) until a person confirms the value, deletes its `unconfirmed`
entry and runs `cockpit sync`. The setup agent's side is in
[Mark the answers you chose](agent-adoption.md#mark-the-answers-you-chose).

Recorded answers are kept, so you can pass the same file on every run. A different value for a
recorded field is refused (`INIT_ANSWER_CONFLICT`) before anything is published; drop the field to
keep the recorded answer. To change one before `cockpit.toml` is written, preview resetting it and
every later dependent answer with `cockpit init <root> --target <tool> --reset-answer <field> --json`,
then repeat with `--accept-reset <previewSha256>`; the resumed interview asks for explicit answers
and defaults acceptance again. A field the interview never asked for is reported as
`INIT_ANSWER_UNUSED`.

Once `cockpit.toml` is written, recorded answers can no longer be reset. If `init` stops while
verifying it (`INIT_VERIFICATION_INCOMPLETE`), edit the value in `cockpit.toml` itself, then rerun
`npx --no cockpit init <root> --target <tool> --accept-preview <sha256>`. If the published files and
`cockpit.toml` are all gone because the root was deleted and recreated, `init` starts again from the
preview and discards the recorded answers (`INIT_STATE_RESTARTED`).

Proposals come only from exact sources: a Dockerfile's `EXPOSE`, `CMD`, `ENTRYPOINT` and
`HEALTHCHECK`, a `package.json` `start`, `serve` or `dev` script, the `node` toolchain a Node
lockfile names, each repository's `origin` remote in `.git/config` (a URL carrying credentials is
skipped, never shown), variable names (never values) in env templates such as `.env.example`, an
existing Compose file, and the `services:` of GitHub workflows. A name that suggests a database or vendor endpoint, such as
`DATABASE_URL`, becomes a `guards` question about its host. Test stages and gates are proposed from a repository's test entry point: a Bazel workspace, `nx.json`, a `turbo.json` test task, a Makefile `test` target, a `package.json` test script (run by the package manager its lockfile names), pytest configuration, `go.mod` or `Cargo.toml`; a tool that selects affected tests supplies the targeted gate. A repository with none is listed in `interview.inferenceSkipped` with what was looked for. Sources `init` could not use are listed
in `interview.inferenceSkipped`. That includes Compose files outside the cockpit directory or in
several repositories, because compose-first accepts only paths inside the cockpit and resolves them
against the first file's directory: choose a generated environment, or write one `compose.yml` at
the cockpit root that reaches each checkout through its sibling variable
([Existing Compose file](agent-adoption.md#existing-compose-file)), and rerun `init`.

A run that declares a runtime ends with `preflight`, which needs a completed first bring-up. If it
reports `STATE_UNSEEDED`, follow [Bring the product up](#bring-the-product-up), then rerun the same
accepted `init` command to finish verification.

## What cockpit checks in your project

cockpit depends on a few things in your product and cockpit, and reports each one missing rather
than guessing around it: the cockpit root in Git and committed, cockpit installed in the cockpit
root, every declared repository present and, for a teammate's clone, recorded with its remote, a
reachable and measured container runtime, the declared machine floor, a valid `.env.schema`
wherever a repository has one, declared guard hosts and test gates, no secret files committed in a
repository, and a trusted Codex hook and evaluator where you use Codex. Every `init` stop and
`cockpit doctor` show them as a readiness section, one line per gap with why cockpit needs it:

```sh
./node_modules/.bin/cockpit doctor --config ./cockpit.toml
./node_modules/.bin/cockpit doctor --config ./cockpit.toml --json   # result.readiness
```

A `required` gap is also refused by the command that needs it (`setup`, `check`, `up` or
`preflight`); a `recommended` one only warns. Before the first `up`, `doctor` and `preflight` still
run every check that needs no running stack. cockpit reports facts here and changes nothing; the
setup skill walks you through each gap and asks before touching a product repository.

## Bring the product up

This is the canonical sequence; other pages link here rather than repeat it. The directory holding
`cockpit.toml` must be in a Git working tree so `setup` can limit its repository writes: run
`git init` in a new directory, and if `git rev-parse --show-toplevel` fails in an existing one,
repair its Git metadata first.

```sh
./node_modules/.bin/cockpit setup --config ./cockpit.toml
./node_modules/.bin/cockpit sync --config ./cockpit.toml --dry-run
./node_modules/.bin/cockpit sync --config ./cockpit.toml
./node_modules/.bin/cockpit check --config ./cockpit.toml
```

- `setup` clones or verifies each declared repository and checks its remote.
- `sync --dry-run` lists every write and removal. Read it.
- `sync` publishes all generated files as one recoverable transaction. It refuses to remove a stale
  generated file; review the request and approve exactly that removal with `sync --interactive`.
- `check` confirms nothing has drifted and never changes a file.

Review and commit the generated files, then start the stack and run the gate:

```sh
./node_modules/.bin/cockpit up --config ./cockpit.toml
./node_modules/.bin/cockpit preflight --config ./cockpit.toml
```

`up` starts or resumes the stack, but only `preflight` says it is healthy. `preflight` also fails
with `GIT_STATE_UNHEALTHY` while generated files, or any later change in the cockpit repository,
are uncommitted ([Preflight observations](environment.md#preflight-observations)). With `--json`,
`up` reports the stack identifier, whether it `started`, `resumed` or was `unchanged`, the leased
port for each `[ports.bases]` name, the entrypoints built from them, and the cold-start time of
the services it started.

## Add or remove a repository

`sibling add` and `sibling remove` edit the `[[sibling]]` tables of `cockpit.toml` for you. They
append or delete only that table, keep every other line and comment, and refuse rather than write
anything that is not exactly the intended change. Pick the form for where the repository is:

```sh
# a directory that already exists under the siblings root (acquire = "none")
./node_modules/.bin/cockpit sibling add api --config ./cockpit.toml --purpose "HTTP API for orders"

# a repository that does not exist yet: runs `git init` on an empty or missing path
./node_modules/.bin/cockpit sibling add api --config ./cockpit.toml --create --purpose "HTTP API for orders"

# a checkout elsewhere on disk: records its origin so `setup` clones a fresh copy
./node_modules/.bin/cockpit sibling add api --config ./cockpit.toml --from ~/code/api --purpose "HTTP API for orders"

# a known remote (acquire = "auto"); also records a remote for an existing acquire = "none" sibling
./node_modules/.bin/cockpit sibling add api --config ./cockpit.toml --remote git@example.com:team/api.git --purpose "HTTP API for orders"
```

| Option | Meaning |
|---|---|
| `--purpose "<text>"` | what the repository is for; required for a new sibling, never defaulted |
| `--dir <relative dir>` | directory under the siblings root; defaults to the slug |
| `--var <NAME>` | exported variable; defaults to the slug as `API_DIR`. A default that would start with a Docker, Compose or host-process control prefix gets `SIBLING_` prepended, and an explicit control variable is refused, because handing it to Compose could change the runtime plan |
| `--mount <always\|none\|profile:NAME>` | how the stack uses the checkout. Defaults to `always`, except in a compose-first cockpit, where it defaults to `none`: cockpit never edits your Compose files, and `check` and `up` refuse a `mount = "always"` sibling no service bind-mounts. Pass `--mount always` once a service mounts the sibling's variable |

A duplicate slug, directory or variable is refused by name. `--create` never creates a GitHub
repository: it prints the `gh repo create` command to run and the `--remote` call that records the
result (with `--json`, `result.publish.command` and `result.publish.recordRemote`). `--from` never
moves, modifies or deletes the original checkout, and refuses one with no `origin` remote.

`--instruction-pointer` opts a separate sibling into a marked link from its **AGENTS.md** to the
cockpit instructions. That changes what agents in that repository load, so `setup` reports the
proposal first and writes it only when asked:

```sh
./node_modules/.bin/cockpit sibling add api --config ./cockpit.toml --from ~/code/api \
  --purpose "HTTP API for orders" --instruction-pointer
./node_modules/.bin/cockpit setup --config ./cockpit.toml --json
# after a human approves the exact AGENTS.md block
./node_modules/.bin/cockpit setup --config ./cockpit.toml --write-instruction-pointers
```

The link targets the **AGENTS.md** beside the selected **cockpit.toml**. The write appends only the
marked block and keeps existing team text (a missing **AGENTS.md** becomes a new guide); an edited,
partial or duplicate pointer is refused. The root sibling (`dir = "."`) cannot opt in: its guide
is the cockpit guide.

```sh
./node_modules/.bin/cockpit sibling remove api --config ./cockpit.toml
```

`remove` drops the table only if nothing refers to the sibling (generated services, vendor
endpoints, mounts, its exported variable, or a declared Compose file using that variable);
otherwise it lists every reference and changes nothing. It never deletes the checkout or a
generated file. After either command, run `cockpit sync --config ./cockpit.toml --dry-run` to see
what changes.

While a stack is up or asleep, both commands act at once only on a repository the stack does not
use (`mount = "none"`, named by no generated service); for any other they refuse and ask for
`./node_modules/.bin/cockpit down --config ./cockpit.toml` first. Hand edits follow the same rule:
a change that never reaches a container (a `purpose`, guards, MCP, skills, surfaces, comments,
the `[environment.machine]` floor and cold-start budget) needs only `sync`, and the next `up` resumes the same stack. A change to services, ports, mounts,
images or anything else the containers receive makes `up` refuse with `LIFECYCLE_PROGRESS_INVALID`,
because `up` never replaces a running stack in place; run the `down` it prints, then `up`.

## Rename a cockpit

`cockpit.name` is part of every identity cockpit records: owner markers in generated files, the
ownership ledger, the Compose project and the stack's saved state. A running stack keeps the name
it started under, and only `down` under that name removes its containers, so take the stack down
before renaming:

```sh
./node_modules/.bin/cockpit down --config ./cockpit.toml
# edit name under [cockpit] in cockpit.toml, then:
./node_modules/.bin/cockpit sync --config ./cockpit.toml
./node_modules/.bin/cockpit check --config ./cockpit.toml
```

`sync` rewrites the generated files and the ledger under the new name and keeps your own text
around cockpit's regions. If you renamed while a stack was recorded, `sync`, `check`, `up` and
`down` refuse with `STACK_RECORDED_UNDER_EARLIER_NAME` and print the earlier name: put it back, run
`down`, then rename again. Never delete or hand-edit cockpit's ownership files to get past a
refusal; they are how `sync` knows which files are its own.

## Run an agent inside the environment

`session` is the everyday command. It runs `up`, holds the stack while your agent runs, and
releases it when the agent exits:

```sh
./node_modules/.bin/cockpit session --config ./cockpit.toml -- codex
```

Put the agent command and its arguments after `--`. It starts with each `[ports.bases]` name set
to the stack's leased port and each entrypoint under `COCKPIT_ENTRYPOINT_`
([Environment lifecycle](environment.md#lifecycle-and-ownership)). When the command's process
group stops, `session` calls `sleep`, which stops the stack only if no other checkout still holds
it. Interrupting `session` stops only the process group it started, and a `session` inside another
is refused. Use plain `up` only when the stack should outlive one command.

To remove the stack and its containers, run `down`. It reads the active Docker context once,
refuses one that is not local, and deletes only from that daemon, so a deletion never lands on a
remote daemon or on a context switched mid-command
([Choose the Docker daemon](environment.md#choose-the-docker-daemon)):

```sh
./node_modules/.bin/cockpit down --config ./cockpit.toml
```

## Next steps

- [Environment lifecycle](environment.md): who holds the stack, resources, cold-start limits and recovery.
- [Harness surfaces](harness-surfaces.md): what `sync` writes for each agent tool.
- [Safety and autonomy](safety-and-autonomy.md): what the guards allow, ask about and deny.
- [Troubleshooting](troubleshooting.md): every diagnostic code and its remedy.
- [FAQ](faq.md): short answers to common questions.
