# Getting started

<!-- cockpit:verified version=0.0.0 -->

This guide takes you from an npm install to your own product running under cockpit. It is
for developers setting up cockpit for a product with one or several repositories. To see cockpit
work first on a throwaway example, follow the [tutorial](tutorial.md).

## Install cockpit

You need a Node.js release admitted by the
[`engines` field in the package manifest](../packages/cockpit/package.json), Git, and macOS or
Linux. The commands that run the stack (`up`, `session`, `preflight`, `down`, `reset`) also need Docker Compose and a
local runtime that has passed cockpit's measurement probe. The
[runtime identity table and measurement procedure](environment.md#measure-the-container-runtime)
are the canonical runtime support record. Configuration, generation, `setup` and `check` work
without Docker.

```sh
npm install --save-dev --save-exact @b0dea/cockpit
./node_modules/.bin/cockpit --help
```

The install is project-local and recorded in the project's lockfile. From the project root, run
the exact installed executable as `./node_modules/.bin/cockpit <command>`. This path fails when
the dependency is missing; it cannot implicitly download a different package. After `init`
publishes the cockpit-owned package scripts, use those scripts for setup, sync and check.

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
cd /path/to/the-cockpit-project
npm install -D "$COCKPIT_PACKAGE_DIR"/*.tgz
./node_modules/.bin/cockpit --help
```

Keep the tarball while the project lockfile resolves cockpit from that local file. Deleting it
breaks a later `npm ci`; an external local archive is not a portable dependency for teammates.
After a published version replaces that resolution in both manifest and lockfile, remove the
archive with `rm -r "$COCKPIT_PACKAGE_DIR"`. If `npm pack` or `npm install` fails, stop there: a source command
is not evidence that the package users receive works. A new dedicated cockpit directory needs a
`package.json`; run `npm init --yes` there before installing.

Check the install:

<!-- cockpit:capture date=2026-10-27 version=0.0.0 -->
```console
$ ./node_modules/.bin/cockpit --help
Usage: cockpit <command> [options]

Commands:
  init                   Preview or accept one explicit bootstrap target in an existing checkout
  ...
  session                Keep the environment available for one command, then release it
  ...
```

The [CLI reference](cli-reference.md) lists every command and flag.

## Choose a starting point

| Your situation | Start with |
|---|---|
| A product with no cockpit yet | `cockpit init`, below |
| An existing cockpit driven by a shell registry | [Incremental adoption](adoption.md) |
| You would rather write the configuration by hand | The annotated example in the [tutorial](tutorial.md#read-the-configuration) |

The cockpit lives in a folder of its own beside the product's repositories, which holds
<!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`; [Where the cockpit lives](concepts.md#where-the-cockpit-lives)
explains the default, the new-product case and why a product repository is not the default root.

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
[Where the cockpit lives](concepts.md#where-the-cockpit-lives). A directory
with nothing runnable gets a surfaces-only configuration with no `[environment]`, and `init` says
that no runtime is declared; see [Environment modes](environment.md#environment-modes). That
includes an empty directory and a repository of documents with no package manifest: there,
`init` proposes the cockpit root itself as the first sibling (`dir = "."`, `mount = "none"`),
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
   first field still unanswered, or at `configuration.defaults`, whose surfaced values are in the
   diagnostics and whose digest is in `question.expectedSha256`.
4. Rerun with `--accept-defaults <expectedSha256>` as well. A digest that is not the pending one
   is refused (`INIT_PREVIEW_NOT_ACCEPTED`, `INIT_DEFAULTS_NOT_ACCEPTED`).

```sh
./node_modules/.bin/cockpit init "$(pwd)" --target codexcli --json
./node_modules/.bin/cockpit init "$(pwd)" --target codexcli --accept-preview <previewSha256> --answers ./answers.toml --json
./node_modules/.bin/cockpit init "$(pwd)" --target codexcli --accept-preview <previewSha256> --answers ./answers.toml --accept-defaults <expectedSha256> --json
```

The answers file spells each field as a TOML path, so `ports.bases` is the `bases` key of a
`[ports]` table. A key that names no field is refused. For a directory with one library that
has nothing runnable, the whole file is:

```toml
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
| `cockpit.name` | the cockpit name, only when the directory name is not a valid one |
| `sibling` | one `[[sibling]]` table per repository |
| `estate.runnable` | one table per repository whose run command was unknown, keyed by its slug |
| `ports.bases` | the host-published base port map; `{}` means none |
| `environment.install_policies` | the dependency install protocols; `[]` for none |
| `environment.generated` | the generated environment to render |
| `environment.compose_files` | a Compose file the checkout already has, instead of `environment.generated` |
| `environment.machine` | the runtime floor: `runtime_memory_mb`, `runtime_cpus`, `free_disk_mb`, `cold_start_seconds`; asked only where a runtime is declared, never proposed |
| `guards` | `hosted_db_hosts` and `vendor_endpoint_hosts` of every non-local environment; both `[]` records that none exists |

Answers an earlier run recorded are kept, so the same file can be passed on every run as long as
it repeats them. A different value for a recorded field is refused (`INIT_ANSWER_CONFLICT`) before
anything is published: drop that field from the file to keep the recorded answer. `init` has no
command to reset a recorded answer. A field the interview never asked for is reported as
`INIT_ANSWER_UNUSED`. The proposed values come from
cheap, exact sources only: a Dockerfile's `EXPOSE`, `CMD` and `ENTRYPOINT`, the variable names
(never the values) in env templates such as `.env.example` and `.env.staging.example`, an
existing Compose file, and the `services:` of GitHub workflows. A variable whose name suggests a
database or a vendor endpoint, such as `DATABASE_URL`, is proposed under `guards` as a question
about which host it points at, not as a host. Each is a proposal to confirm, not an answer; an unreadable source is listed in
`interview.inferenceSkipped`. A run that declares a runtime ends with `preflight`, which needs the Docker runtime named in
[Install cockpit](#install-cockpit); without it the run stops there and resumes when you rerun.

## Bring the product up

This is the canonical sequence. Every other page links here rather than repeating it.

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

`--dir <relative dir>` sets the directory under the siblings root (default: the slug), `--var <NAME>`
the exported variable (default: the slug as `API_DIR`). `--purpose "<text>"` says what the
repository is for; it is required for a new sibling and never defaulted.
`--instruction-pointer` opts a separate sibling into a marked link from its **AGENTS.md** to the
cockpit instructions. This changes what agents in that repository load, so setup first reports the
proposal without writing it:

```sh
cockpit sibling add api --config ./cockpit.toml --from ~/code/api --purpose "HTTP API for orders" --instruction-pointer
cockpit setup --config ./cockpit.toml --json
# after a human approves the exact AGENTS.md block
cockpit setup --config ./cockpit.toml --write-instruction-pointers
```

The link points to **AGENTS.md** beside the selected **cockpit.toml**, including when that configuration
is below the Git checkout root. Paths are encoded as Markdown destinations. The approved write
preserves existing team text and appends only the marked block. If **AGENTS.md**
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
endpoints, mounts, its exported variable). Otherwise it lists every reference and changes nothing.
It never deletes the checkout or any generated file. After either command, run
`cockpit sync --config ./cockpit.toml --dry-run` to see which generated files change.

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

## Next steps

- [Environment lifecycle](environment.md): ownership, resources, cold-start limits and recovery.
- [Harness surfaces](harness-surfaces.md): what `sync` writes for each agent tool.
- [Safety and autonomy](safety-and-autonomy.md): what the guards allow, ask about and deny.
- [Troubleshooting](troubleshooting.md): every diagnostic code and its remedy.
- [FAQ](faq.md): short answers to common questions.
