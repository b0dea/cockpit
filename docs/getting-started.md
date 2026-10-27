# Getting started

<!-- cockpit:verified version=0.0.0 -->

This guide takes you from a source install to your own product running under cockpit. It is
for developers setting up cockpit for a product made of several repositories. To see cockpit
work first on a throwaway example, follow the [tutorial](tutorial.md).

## Install cockpit

You need Node.js `^22.13.0 || ^24.0.0 || ^26.0.0`, Git, and macOS or Linux. The commands that
run the stack (`up`, `session`, `preflight`, `down`, `reset`) also need Docker with Compose, and
today their runtime check admits only Docker Desktop: OrbStack, Colima, Rancher Desktop and
Linux Docker Engine are refused with `LIFECYCLE_EVIDENCE_INVALID`. Wider runtime support is being
designed. Configuration, generation, `setup` and `check` work without Docker.

```sh
git clone https://github.com/b0dea/cockpit.git
cd cockpit
npm ci --ignore-scripts
npm run build
npm link --workspace @b0dea/cockpit
```

`npm link` puts a `cockpit` command on your PATH that runs this checkout, so a later
`git pull && npm run build` updates it. Every page in these docs writes commands as `cockpit
<command>`. If you prefer not to link, use `node /path/to/cockpit/packages/cockpit/bin/cockpit.mjs`
in place of `cockpit`.

Check the install:

<!-- cockpit:capture date=2026-10-27 version=0.0.0 -->
```console
$ cockpit --help
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

Put the product's repositories side by side under one directory. That directory becomes the
cockpit checkout and holds <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`.

## Bootstrap a new product

Pick the agent harness you will use first: `claudecode`, `codexcli` or `opencode`. From the
directory that will hold the configuration, preview the bootstrap:

```sh
cockpit init "$(pwd)" --target codexcli --json
```

The preview writes nothing. It returns the files it would install (the bootstrap skill for that
harness), a `previewSha256` digest and the next step. To accept, run the same command
interactively in a terminal and type the digest it shows:

```sh
cockpit init "$(pwd)" --target codexcli --interactive
```

`init` then looks at the repositories under the directory and asks for every fact it cannot
read from them: commands, images, health checks and the port map. Each accepted answer records
where it came from, and a changed repository invalidates earlier answers instead of reusing
them. Re-running the same command resumes where it stopped. A single repository gets stack
scope: the environment without the multi-repository registry and guide projection. A directory
with nothing runnable gets a surfaces-only configuration with no `[environment]`, and `init` says
that no runtime is declared; see [Environment modes](environment.md#environment-modes).

Review the port map, the generated environment declaration and the defaults before accepting
the configuration.

## Bring the product up

This is the canonical sequence. Every other page links here rather than repeating it.

```sh
cockpit setup --config ./cockpit.toml
cockpit sync --config ./cockpit.toml --dry-run
cockpit sync --config ./cockpit.toml
cockpit check --config ./cockpit.toml
```

- `setup` clones or verifies each declared repository and checks its remote.
- `sync --dry-run` lists every write and removal. Read it.
- `sync` publishes all generated files as one recoverable transaction. If it would remove a
  stale generated file, plain `sync` refuses; review the request and use
  `sync --interactive` to approve exactly that removal.
- `check` confirms nothing has drifted. It never changes a file.

Review and commit the generated files, then start the stack and run the gate:

```sh
cockpit up --config ./cockpit.toml
cockpit preflight --config ./cockpit.toml
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
cockpit sibling add api --config ./cockpit.toml --purpose "HTTP API for orders"

# a repository that does not exist yet: runs `git init` on an empty or missing path
cockpit sibling add api --config ./cockpit.toml --create --purpose "HTTP API for orders"

# a checkout elsewhere on disk: records its origin so `setup` clones a fresh copy
cockpit sibling add api --config ./cockpit.toml --from ~/code/api --purpose "HTTP API for orders"

# a known remote (acquire = "auto"); also records a remote for an existing acquire = "none" sibling
cockpit sibling add api --config ./cockpit.toml --remote git@example.com:team/api.git --purpose "HTTP API for orders"
```

`--dir <relative dir>` sets the directory under the siblings root (default: the slug), `--var <NAME>`
the exported variable (default: the slug as `API_DIR`). `--purpose "<text>"` says what the
repository is for; it is required for a new sibling and never defaulted.
A duplicate slug, directory or variable is refused by name. `--create` never creates a GitHub
repository: it prints the `gh repo create` command to run and the `--remote` call that records
the result. `--from` never moves, modifies or deletes the original checkout, and refuses one with
no `origin` remote.

```sh
cockpit sibling remove api --config ./cockpit.toml
```

`remove` drops the table only if nothing else refers to the sibling (generated services, vendor
endpoints, mounts, its exported variable). Otherwise it lists every reference and changes nothing.
It never deletes the checkout or any generated file. After either command, run
`cockpit sync --config ./cockpit.toml --dry-run` to see which generated files change.

## Run an agent inside the environment

`session` is the everyday command. It runs `up`, keeps the stack held while your agent runs, and
releases it when the agent exits:

```sh
cockpit session --config ./cockpit.toml -- codex
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
