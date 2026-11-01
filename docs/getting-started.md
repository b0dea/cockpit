# Getting started

<!-- cockpit:verified version=0.0.0 -->

This guide takes you from an npm install to your own product running under cockpit. It is
for developers setting up cockpit for a product with one or several repositories. To see cockpit
work first on a throwaway example, follow the [tutorial](tutorial.md).

## Install cockpit

You need a Node.js release listed in the
[`engines` field in the package manifest](../packages/cockpit/package.json), Git, and macOS or
Linux. The commands that run the stack (`up`, `session`, `preflight`, `down`, `reset`) also need Docker Compose and a
local runtime that has passed `cockpit runtime measure`. The
[runtime identity table and measurement procedure](environment.md#measure-the-container-runtime)
are the one record of supported runtimes. Configuration, generation and surfaces-only `setup` and
`check` work without a container runtime; validating declared Compose files requires Docker Compose.

For an existing product, the cockpit lives in a dedicated directory beside the product
repositories (for example `shop-cockpit` next to `shop`), not in a product repository, so the
product stays untouched unless you agree to a change in it. Do not create that directory yourself:
run the first `init` from inside the product repository with a temporary installation, as
[Bootstrap an existing product](#bootstrap-an-existing-product) shows, and `init` creates it with
the product repository as its first sibling. An `init` run in an empty directory you made beside
the product sees nothing to run there and builds a cockpit that does not know the product. For an
empty directory or a new product, follow
[Bootstrap without a project manifest](#bootstrap-without-a-project-manifest) instead; it explains
why the first install is temporary. Once the cockpit directory has its own `package.json`, install
cockpit in it:

```sh
npm install --save-dev --save-exact @b0dea/cockpit
./node_modules/.bin/cockpit --help
```

The install is project-local and recorded in that directory's lockfile. Run the exact installed
executable as `./node_modules/.bin/cockpit <command>` from the cockpit directory; every command in
this guide runs there. This path fails when the dependency is missing; it cannot implicitly
download a different package. The `npx --no` form, such as
`npx --no cockpit check --config cockpit.toml`, runs the same installed binary and never downloads
one; cockpit's fix hints print commands in that form. After `init` writes the `cockpit:*` package scripts, use those
scripts for setup, sync and check.

The installation carries this guide for its own version, without the contributor pages, under
`./node_modules/@b0dea/cockpit/docs/`. The skills cockpit generates and its fix hints cite pages
there, so an agent can read them offline.

### Install from source

To test an unpublished checkout, pack the package and install that tarball. This exercises the
same package files, lifecycle scripts, dependencies and binary entry point as the registry
package; `npm link` does not.

```sh
git clone https://github.com/b0dea/cockpit.git
cd cockpit
npm ci --ignore-scripts
npm run build
COCKPIT_PACKAGE_DIR="$(mktemp -d)"
npm pack --workspace @b0dea/cockpit --pack-destination "$COCKPIT_PACKAGE_DIR"
cd /path/to/the-cockpit-directory
npm install -D "$COCKPIT_PACKAGE_DIR"/*.tgz
./node_modules/.bin/cockpit --help
```

Keep the tarball while the project lockfile resolves cockpit from that local file. Deleting it
breaks a later `npm ci`; an external local archive is not a portable dependency for teammates.
After a published version replaces that resolution in both manifest and lockfile, remove the
archive with `rm -r "$COCKPIT_PACKAGE_DIR"`. If `npm pack` or `npm install` fails, stop there: a source command
does not show that the package users receive works. When bootstrapping a directory without a
product manifest, install this same archive in the temporary tool directory described below.

Check the install with `./node_modules/.bin/cockpit --help`: it prints `Usage: cockpit <command>
[options]` and the command list. The [command list](command-list.md) and the
[CLI reference](cli-reference.md) are generated from the same CLI, so they match the installed
version, flag for flag.

### Bootstrap without a project manifest

Keep the first tool installation outside an empty, documents-only or central multi-repository
cockpit directory. `init` treats a Git checkout with a language manifest, Dockerfile, or standard
Compose filename as a product repository before it decides whether that source is runnable. An
installation-only manifest and a dependency-free library can look identical, so this conservative
root choice prevents `init` from writing into a possible product checkout.

From the intended cockpit directory, install a temporary, explicit executable and preview:

```sh
COCKPIT_BOOTSTRAP_DIR="$(mktemp -d)"
npm install --prefix "$COCKPIT_BOOTSTRAP_DIR" --save-dev --save-exact @b0dea/cockpit
"$COCKPIT_BOOTSTRAP_DIR/node_modules/.bin/cockpit" init "$(pwd)" --target codexcli --json
```

For an unpublished source package, replace `@b0dea/cockpit` in that install command with
`"$COCKPIT_PACKAGE_DIR"/*.tgz` from [Install from source](#install-from-source). Use that exact
temporary executable for the remaining `init` commands below, including preview and defaults
acceptance. It is an installed package, not a command runner that downloads a missing binary.

After `init` writes the cockpit's package manifest, install its dependency in the cockpit directory
and verify `./node_modules/.bin/cockpit --help`. For a source package, install the preserved archive
there as well. Continue with the project-local executable, then remove only the temporary tool
installation after the [canonical setup, sync and check sequence](#bring-the-product-up) passes:

```sh
rm -r -- "$COCKPIT_BOOTSTRAP_DIR"
```

If the central directory already has an installation manifest, keep it. Declare its repositories
through the [hand-written configuration route](#choose-a-starting-point) and preview `sync`, or
start from an actual product repository and choose a dedicated cockpit. Do not delete package
files or classify a library as tooling just to change discovery.

### Bootstrap an existing product

From inside the product repository, install the same temporary executable and preview:

```sh
COCKPIT_BOOTSTRAP_DIR="$(mktemp -d)"
npm install --prefix "$COCKPIT_BOOTSTRAP_DIR" --save-dev --save-exact @b0dea/cockpit
"$COCKPIT_BOOTSTRAP_DIR/node_modules/.bin/cockpit" init "$(pwd)" --target codexcli --json
```

The preview first asks for the cockpit root (`cockpit.root`). Answer `"dedicated"`, the
recommendation: `init` then creates `../<repo>-cockpit`, initialises it as a local Git
repository, and declares the product repository as its first sibling with `siblings_root = ".."`.
Keep running the same `init` command from the product repository, with the same answers file;
`result.root` names the new cockpit, and later commands take `--config <result.root>/cockpit.toml`.
[Inside a product repository](agent-adoption.md#inside-a-product-repository) walks through each
answer, and [Where the cockpit lives](concepts.md#where-the-cockpit-lives) explains the choice.
Then install cockpit in the new directory and remove the temporary installation as above.

A Compose file inside the product repository stays outside a dedicated cockpit, and Compose files
must sit inside the cockpit root, so a dedicated cockpit declares a generated environment instead;
[Existing Compose file](agent-adoption.md#existing-compose-file) covers the alternatives.

## Choose a starting point

| Your situation | Start with |
|---|---|
| An existing product repository with no cockpit yet | [Bootstrap an existing product](#bootstrap-an-existing-product) |
| A new product, or an empty directory | `cockpit init`, below |
| An existing cockpit driven by a shell registry | [Incremental adoption](adoption.md) |
| You would rather write the configuration by hand | The annotated example in the [tutorial](tutorial.md#read-the-configuration) |

The cockpit lives in a folder of its own beside the product's repositories, which holds
<!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`; [Where the cockpit lives](concepts.md#where-the-cockpit-lives)
explains the default, the new-product case and why a product repository is not the default root.
For a valid hand-written configuration, the first `sync` also adds the exact `cockpit:*` scripts,
package pin and marked `.gitignore` region that `init` would create. Preview them with `sync
--dry-run`; an existing conflicting pin, a cockpit declaration in `dependencies`,
`optionalDependencies` or `peerDependencies`, a conflicting script, or an edited marked region is
refused rather than overwritten. Keep the exact cockpit pin only in `devDependencies` so the team
has one place that sets the version.

## Bootstrap a new product

Pick your agent harness's target identifier from the [capability matrix](capability-matrix.md).
For example, Codex uses `codexcli`. From the directory that will hold the configuration, preview
the bootstrap:

```sh
./node_modules/.bin/cockpit init "$(pwd)" --target codexcli --json
```

The preview writes nothing. It returns the files it would install (the cockpit-setup skill for that
harness), a `previewSha256` digest and the next step. To accept, run the same command
interactively in a terminal and type the digest it shows:

```sh
./node_modules/.bin/cockpit init "$(pwd)" --target codexcli --interactive
```

`init` then looks at the repositories under the directory and asks for every fact it cannot
read from them: commands, images, health checks and the port map. Each accepted answer records
where it came from, and a changed repository invalidates earlier answers instead of reusing
them. Re-running the same command resumes where it stopped. A single repository gets the same
cockpit as several: instructions, guards, settings and the environment. Run inside an existing
product repository, `init` first asks for the cockpit root (`cockpit.root`); see
[Where the cockpit lives](concepts.md#where-the-cockpit-lives). It then declares only that
repository: add the others afterwards with [`sibling add`](#add-or-remove-a-repository), since
naming them in the answers file is refused with `DOCUMENT_ESTATE_TOPOLOGY_MISMATCH`. A directory
with nothing runnable gets a surfaces-only configuration with no `[environment]`, and `init` says
that no runtime is declared; see [Environment modes](environment.md#environment-modes). That
includes an empty directory and a repository of documents with no language manifest, Dockerfile or
standard Compose file: there, `init` proposes the cockpit root itself as the first sibling (`dir = "."`, `mount = "none"`),
and you add the product's repositories later with [`sibling add`](#add-or-remove-a-repository).

Where a runtime is declared, `init` also asks for the machine floor the product needs. On every
interview it asks for the database and live vendor API hosts of each non-local environment
(production, staging, shared), which the generated guard denies to agents; an explicit empty
answer is recorded as a decision in `cockpit.toml`.

Review the port map, the generated environment declaration, the guard hosts and the defaults
before accepting the configuration.

`init` also adds exact `cockpit:*` package scripts, pins this cockpit version as a development
dependency, and maintains a marked block in the root `.gitignore`. Commit those team-owned files
with the generated cockpit. Teammates then follow [Joining a team's cockpit](joining-a-team.md).

### Bootstrap without a terminal

An agent or CI job has no terminal, so `--interactive` refuses with `INIT_TERMINAL_REQUIRED`.
Give `init` the consent and the answers as arguments instead. Every digest comes from a pending
run, so consent stays bound to the exact bytes it was shown; there is no blanket `--yes`.

1. Run the preview. With `--json` it lists the `previewSha256` to accept and, under
   `interview.outstanding`, every field the interview will still ask, in order. Each entry has a
   `why` and the values `init` could propose, each with `provenance.kind` `inferred` and the file
   it was read from.
2. Write the answers as TOML, keyed by field, and show them to the human together with the digest.
3. Rerun with `--accept-preview <previewSha256>` and `--answers <file>`. The run stops at the
   first field still unanswered, or at `configuration.defaults`. There, `result.question.document`
   is an array of lines from the review draft; joining them with `\n` reproduces
   the exact draft, including its final newline. It contains the validated configuration that
   will be published after confirmation, including your explicit answers. Its provenance comments
   list each inferred or default value, its target and reason; `result.question.expectedSha256`
   is the digest covering those values.
   Read the document before asking the human to accept that digest. The human output and the
   interactive question show the same document; it is not written to `cockpit.toml`.
   If the draft or its exact review is too large to show, init refuses it with
   `INIT_DRAFT_INVALID` before offering defaults confirmation. Shorten the answers so the whole
   configuration can be reviewed; for a recorded answer, use the reset commands below before
   supplying its replacement.
4. Rerun with `--accept-defaults <expectedSha256>` as well. A digest that is not the pending one
   is refused (`INIT_PREVIEW_NOT_ACCEPTED`, `INIT_DEFAULTS_NOT_ACCEPTED`).

If the installed cockpit package changes during an interrupted pre-configuration bootstrap, rerun
the same read-only `init` preview, review its current bootstrap bytes, and accept that fresh
`previewSha256` before continuing. A missing or edited bootstrap file is refused and left in place
for inspection instead of being replaced.

```sh
./node_modules/.bin/cockpit init "$(pwd)" --target codexcli --json
./node_modules/.bin/cockpit init "$(pwd)" --target codexcli --accept-preview <previewSha256> --answers ./answers.toml --json
./node_modules/.bin/cockpit init "$(pwd)" --target codexcli --accept-preview <previewSha256> --answers ./answers.toml --accept-defaults <expectedSha256> --json
```

The answers file spells each field as a TOML path, so `ports.bases` is the `bases` key of a
`[ports]` table. A key that names no field is refused. For a directory with one library that
has nothing runnable, the whole file is:

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
| `cockpit.root` | `"dedicated"` or `"in-repo"`, only when `init` runs inside a product repository; never chosen by a digest flag ([Where the cockpit lives](concepts.md#where-the-cockpit-lives)) |
| `cockpit.name` | the cockpit name, always asked; the cockpit root's directory name is proposed when it is a valid name. It scopes Compose projects, state and generated files ([Rename a cockpit](#rename-a-cockpit)) |
| `sibling` | one `[[sibling]]` table per repository |
| `estate.runnable` | one table per repository whose run command was unknown, keyed by its slug |
| `ports.bases` | the host-published base port map; `{}` means none |
| `environment.install_policies` | the dependency install protocols; `[]` for none |
| `environment.test_data` | a table with exactly the boolean keys `seeded_data` and `signed_in_users`; `{ seeded_data = false, signed_in_users = false }` states neither is needed, while true keeps the corresponding product-owned work visible |
| `environment.generated` | the generated environment to render |
| `environment.compose_files` | a Compose file the checkout already has, instead of `environment.generated` |
| `environment.machine` | the runtime floor: `runtime_memory_mb`, `runtime_cpus`, `free_disk_mb`, `cold_start_seconds`; asked only where a runtime is declared, never proposed |
| `guards` | `hosted_db_hosts` and `vendor_endpoint_hosts` of every non-local environment; both `[]` records that none exists |
| `provenance` | optional table saying who chose each answer, keyed by field: `"human"` (the default) or `"agent-default"`, for example `"environment.machine" = "agent-default"` |

An answer is recorded in `cockpit.toml` as one a person stated unless `[provenance]` marks it
`"agent-default"`. Each agent default, and an `environment.machine` floor the file does not
attribute, is listed under `unconfirmed` at the top of `cockpit.toml` with a comment, reported in
`result.unconfirmed`, and named by `doctor` (`DECLARATION_UNCONFIRMED`) until a person confirms
the value, deletes its entry from `unconfirmed` and runs `cockpit sync`. The setup agent's side is
in [Mark the answers you chose](agent-adoption.md#mark-the-answers-you-chose).

Answers an earlier run recorded are kept, so the same file can be passed on every run as long as
it repeats them. A different value for a recorded field is refused (`INIT_ANSWER_CONFLICT`) before
anything is published: drop that field from the file to keep the recorded answer. Before
`cockpit.toml` is prepared, preview resetting that answer and every later dependent answer with
`cockpit init <root> --target <target> --reset-answer <field> --json`, then repeat the command with
`--accept-reset <previewSha256>`. The reset keeps earlier answers and the resumed interview requires
explicit answers and defaults acceptance again. A field the interview never asked for is reported as
`INIT_ANSWER_UNUSED`. The proposed values come from
cheap, exact sources only: a Dockerfile's `EXPOSE`, `CMD` and `ENTRYPOINT`, the variable names
(never the values) in env templates such as `.env.example` and `.env.staging.example`, an
existing Compose file, and the `services:` of GitHub workflows. A variable whose name suggests a
database or a vendor endpoint, such as `DATABASE_URL`, is proposed under `guards` as a question
about which host it points at, not as a host. Each is a proposal to confirm, not an answer; an unreadable source is listed in
`interview.inferenceSkipped`. A Compose file is proposed for `environment.compose_files` only when
it is the one product Compose file inside the cockpit directory. Compose files outside the cockpit
directory, or in several repositories, are listed under `interview.inferenceSkipped` instead,
because compose-first accepts only paths inside the cockpit and resolves every relative path
against the first listed file's directory. Choose a generated environment, or write one
`compose.yml` at the cockpit root that reaches each checkout through its sibling variable
([Existing Compose file](agent-adoption.md#existing-compose-file)) and rerun the same `init` command.
A run that declares a runtime ends with `preflight`, which requires a completed first bring-up;
if it reports `STATE_UNSEEDED`, follow [Bring the product up](#bring-the-product-up), then rerun
the same accepted `init` command to resume verification.

## Bring the product up

This is the canonical sequence. Every other page links here rather than repeating it.
The directory containing `cockpit.toml` must be in a Git working tree so `setup` can limit its
repository writes. In a new directory, run `git init` there first; for an existing checkout,
inspect `git rev-parse --show-toplevel` and repair its Git metadata if that fails.

```sh
./node_modules/.bin/cockpit setup --config ./cockpit.toml
./node_modules/.bin/cockpit sync --config ./cockpit.toml --dry-run
./node_modules/.bin/cockpit sync --config ./cockpit.toml
./node_modules/.bin/cockpit check --config ./cockpit.toml
```

- `setup` clones or verifies each declared repository and checks its remote.
- `sync --dry-run` lists every write and removal. Read it.
- `sync` publishes all generated files as one recoverable transaction. If it would remove a
  stale generated file, plain `sync` refuses; review the request and use
  `sync --interactive` to approve exactly that removal.
- `check` confirms nothing has drifted. It never changes a file.

Review and commit the generated files, then start the stack and run the gate:

```sh
./node_modules/.bin/cockpit up --config ./cockpit.toml
./node_modules/.bin/cockpit preflight --config ./cockpit.toml
```

`up` starts or resumes the stack. `preflight` is the gate: a successful `up` is not proof the
environment is healthy, `preflight` is. In `--json` mode a successful `up` reports the stack
identifier, whether it `started`, `resumed` or was `unchanged`, the entrypoints with their leased
ports, and, for services it started, the cold-start time against your configured limit. (This
result shape is read from the source; the synthetic example has no runnable services.)

## Add or remove a repository

`sibling add` and `sibling remove` edit the `[[sibling]]` tables of `cockpit.toml` for you. They
append or delete only that table, keep every comment and line elsewhere in the file, and refuse
rather than write anything that is not exactly the intended change. Choose the form that matches
where the repository is:

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

`--dir <relative dir>` sets the directory under the siblings root (default: the slug), and
`--var <NAME>` sets the exported variable (default: the slug as `API_DIR`). A slug whose default
would begin with a Docker, Compose or host-process control prefix gets `SIBLING_` prepended;
cockpit refuses an explicit control variable because handing it to Compose could change the
runtime plan. `--purpose "<text>"` says what the repository is for; it is required
for a new sibling and never defaulted.
`--mount <always|none|profile:NAME>` says how the stack uses the checkout. In a compose-first
cockpit it defaults to `none`, because cockpit never edits your Compose files and `check` and `up`
refuse a `mount = "always"` sibling that no service bind-mounts; pass `--mount always` once a
service in your Compose file mounts the sibling's variable. Elsewhere it defaults to `always`.
`--instruction-pointer` opts a separate sibling into a marked link from its **AGENTS.md** to the
cockpit instructions. This changes what agents in that repository load, so setup first reports the
proposal without writing it:

```sh
./node_modules/.bin/cockpit sibling add api --config ./cockpit.toml --from ~/code/api \
  --purpose "HTTP API for orders" --instruction-pointer
./node_modules/.bin/cockpit setup --config ./cockpit.toml --json
# after a human approves the exact AGENTS.md block
./node_modules/.bin/cockpit setup --config ./cockpit.toml --write-instruction-pointers
```

The link points to **AGENTS.md** beside the selected **cockpit.toml**, including when that
configuration is below the Git checkout root. Paths are encoded as Markdown destinations. The
approved write preserves existing team text and appends only the marked block. If **AGENTS.md**
is missing, the proposal is a new guide containing that block. An edited, partial or duplicate
pointer is refused rather than replaced. The root sibling (`dir = "."`) cannot opt in because its
guide already is the cockpit guide.
A duplicate slug, directory or variable is refused by name. `--create` never creates a GitHub
repository: it prints the `gh repo create` command to run and the `--remote` call that records
the result, and with `--json` returns them as `result.publish.command` and
`result.publish.recordRemote`. `--from` never moves, modifies or deletes the original checkout, and refuses one with
no `origin` remote.

```sh
./node_modules/.bin/cockpit sibling remove api --config ./cockpit.toml
```

`remove` drops the table only if nothing else refers to the sibling (generated services, vendor
endpoints, mounts, its exported variable, or a declared Compose file that uses that variable).
Otherwise it lists every reference and changes nothing.
It never deletes the checkout or any generated file. After either command, run
`cockpit sync --config ./cockpit.toml --dry-run` to see which generated files change.
While a stack is up or asleep, a repository the stack does not use (`mount = "none"`, named by
no generated service) is added or removed at once. Any other row would change the environment
underneath the running stack, so both commands refuse it and ask you to run
`./node_modules/.bin/cockpit down --config ./cockpit.toml`
first.

Editing `cockpit.toml` by hand works the same way. A change that never reaches a container, such
as a sibling's `purpose`, the guards, MCP, skills, surfaces, comments or formatting, leaves the
running stack alone: run `sync` and keep working, and the next `up` resumes the same stack. A
change to services, ports, mounts, images or anything else the containers receive makes `up` refuse
with `LIFECYCLE_PROGRESS_INVALID`, because `up` never replaces a running stack in place; run the
`down` it prints, then `up`.

## Rename a cockpit

`cockpit.name` is part of every identity cockpit records: the owner markers in generated files,
the ownership ledger, the Compose project and the stack's saved state. Renaming it is supported;
take the stack down first, because a running stack keeps the name it started under and only `down`
run under that name removes its containers. In a terminal:

```sh
./node_modules/.bin/cockpit down --config ./cockpit.toml
# edit name under [cockpit] in cockpit.toml, then:
./node_modules/.bin/cockpit sync --config ./cockpit.toml
./node_modules/.bin/cockpit check --config ./cockpit.toml
```

`sync` rewrites the generated files and the ledger under the new name and keeps your own text
around cockpit's regions. If you renamed while a stack was recorded, `sync`, `check`, `up` and
`down` refuse with `STACK_RECORDED_UNDER_EARLIER_NAME` and print the earlier name: put it back, run
`down`, then rename again. Never delete or hand-edit cockpit's generated ownership files to get past
a refusal: they are how `sync` knows which files are its own.

## Run an agent inside the environment

`session` is the everyday command. It runs `up`, keeps the stack held while your agent runs, and
releases it when the agent exits:

```sh
./node_modules/.bin/cockpit session --config ./cockpit.toml -- codex
```

Put the agent command after `--`, with its own arguments. Once the command's process group has
stopped, `session` calls `sleep`, which shuts the stack down only if no other checkout still
holds it. Interrupting `session` stops only the process group it started. A second
`cockpit session` inside the first is refused.
Use plain `up` only when the stack should outlive one command.

To remove the stack and its containers, run `down`. It reads the active Docker context once and
deletes only from that daemon, and refuses one that is not local, so a deletion never lands on a
remote daemon or on a context switched mid-command:

```sh
./node_modules/.bin/cockpit down --config ./cockpit.toml
```

[Choose the Docker daemon](environment.md#choose-the-docker-daemon) states the daemon rules for
`down`, `reset` and `runtime measure`.

## Next steps

- [Environment lifecycle](environment.md): who holds the stack, resources, cold-start limits and recovery.
- [Harness surfaces](harness-surfaces.md): what `sync` writes for each agent tool.
- [Safety and autonomy](safety-and-autonomy.md): what the guards allow, ask about and deny.
- [Troubleshooting](troubleshooting.md): every diagnostic code and its remedy.
- [FAQ](faq.md): short answers to common questions.
