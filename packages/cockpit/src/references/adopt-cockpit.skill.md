---
name: adopt-cockpit
description: "Set up or adopt cockpit for a project, bring a multi-repo product up for AI agents, or start a new product with cockpit. Use whenever the user wants cockpit set up, adopted or extended with another repository, or wants their repositories organised and their stack brought up for agents, even when they name no cockpit command. Routes by what is on disk to cockpit's non-interactive commands, asks before writing into product repositories, and never invents configuration values."
---

<!-- cockpit:verified version=0.0.0 -->

# Adopt cockpit

Use this when a human asks you to set cockpit up, adopt it, or bring their product up for agents.
cockpit declares a product's repositories once in `cockpit.toml`, generates the same agent
instructions, skills, guards and permissions for every harness, and runs the stack against the
live checkouts.

The full guide, with every situation and its completion check, ships inside the cockpit package
under `docs/`. Once cockpit is installed (below), read
`./node_modules/@b0dea/cockpit/docs/agent-adoption.md`. Until then, read the same page from a
package tarball (`package/docs/agent-adoption.md` inside the `.tgz`), a cockpit source checkout
(`docs/agent-adoption.md`) or <https://github.com/b0dea/cockpit/blob/main/docs/agent-adoption.md>.
Each step below names its guide section. Guide pages cited after the install step are in that
installed directory.

## Safety contract

A clean-looking configuration with invented values in it is the failure cockpit exists to prevent.
Follow these rules throughout:

1. Ask the human before writing into a product repository, creating a Git remote or hosted
   repository, running a destructive command (`down`, `reset`, approving removals), running
   `sync --adopt`, or accepting an `init` digest.
2. Show the exact preview first: the `sync --dry-run` listing, the `init` preview and its
   `previewSha256`, the answers file, or the defaults digest. Consent binds to those bytes.
3. Take every value (port, image, command, health check, purpose, name) from a file you read or
   from the human. When neither has it, name the gap and ask.
4. Show every inferred value with the file it came from, including what `init` proposes under
   `provenance.kind = "inferred"`. It becomes an answer only on the human's word.
5. Ask the human for the database and live vendor API hosts of every non-local environment
   (production, staging, shared) for the `guards` answer; env templates give variable names only.
6. "Use sensible defaults" covers `init` answers only, never writing inside a product repository:
   an **AGENTS.md** pointer, a Compose file or a `package.json` there needs the human's explicit
   yes to that change. Mark every answer you chose as `"agent-default"` in the answers file's
   `[provenance]` table, and end your report with every default you chose, its field and value.

## Install cockpit if it is missing

Done when the exact project-local executable lists the commands.

1. Tell the human that cockpit is not yet published, then follow *Install cockpit* in
   `docs/getting-started.md`, from the same sources as the guide above. It covers the registry
   install and the source-package fallback.
2. For an existing product, install in a dedicated cockpit directory beside the product
   repositories; leave the product repositories untouched unless the human agrees.
3. Verify without permitting an implicit download:

   ```sh
   ./node_modules/.bin/cockpit --help
   ```

4. Every `init` below takes `--target <tool>`: replace `<tool>` with the target of the agent tool
   you are running in, as the **Bootstrap** section lists. For an instructions-only tool, follow
   the *Capability states* section of `./node_modules/@b0dea/cockpit/docs/harness-surfaces.md`.

Run every command from the cockpit root through `./node_modules/.bin/cockpit`; if that file is
absent, stop and repair the project-local install. Read flags from
`./node_modules/.bin/cockpit <command> --help`. In Codex's sandbox only `check`, `sync --dry-run`
and `--help` run; ask the person to approve running any other cockpit command outside the sandbox,
or to run it in a terminal. Pass `--json` and read `result`,
`diagnostics[].code` and `invocation.exitCode`. A pending `init` also exits 0, so read its
`result.stage` and `result.question`.

## Route by what is on disk

Look at the directory before asking. Several cases can apply; bootstrap first.

| On disk | Do | Guide section |
|---|---|---|
| Inside an existing product repository (a Git checkout with a language manifest, Dockerfile or Compose file at its root) | The `--json` preview's `result.cockpitRoot` asks for the cockpit root before anything is written. Relay the question, both options with their exact paths and trade-offs, and the recommendation (`dedicated`: a new `../<repo>-cockpit` folder with this repository as its first sibling). Put the human's choice in the answers file as `cockpit.root = "dedicated"` or `"in-repo"`. Never choose it yourself: the digest flags refuse with `INIT_COCKPIT_ROOT_REQUIRED` until it is answered. | *Inside a product repository* |
| An empty directory, or only documents and decisions | Follow **Bootstrap** below. With no manifest, `init` builds a surfaces-only cockpit whose first sibling is the root itself (`dir = "."`, `mount = "none"`); the purpose comes from the human. Add each repository later with `./node_modules/.bin/cockpit sibling add <slug> --config cockpit.toml --create --purpose "<purpose>" --json` and hand the human its `result.publish.command` (`gh repo create`). | *Empty directory*, *Docs or decisions only* |
| One or several repositories with services | From the directory that holds them, follow **Bootstrap** below: `./node_modules/.bin/cockpit init "$(pwd)" --target <tool> --json`, then the same command with `--accept-preview` and `--answers`, then with `--accept-defaults` as well. | *One or several repositories* |
| Repositories scattered across the disk | Moving them is the human's call. Otherwise declare each with `./node_modules/.bin/cockpit sibling add <slug> --config cockpit.toml --from <path> --purpose "<purpose>" --json`, then run `./node_modules/.bin/cockpit setup --config cockpit.toml --json`. | *Scattered repositories* |
| An existing Compose file | Answer `environment.compose_files = ["compose.yml"]` instead of a generated stack. For a Compose file inside a product repository, declare that repository as a sibling and point `compose_files` at the file in its checkout. Ask the human for the `environment.machine` floors and the `environment.posture` (how the product is reached and signed into) that `init` asks next. | *Existing Compose file* |
| A service with no local setup | Follow **Create a local setup** below. | *No local setup* |
| Committed `.claude/settings.json`, `.codex/config.toml` or `.codex/hooks.json` | `sync` refuses with `SURFACE_STATE_CONFLICT`. With the human's yes, run `./node_modules/.bin/cockpit sync --config cockpit.toml --adopt <path> --json`. | *Existing agent settings* |
| A repository joins or leaves an existing cockpit | Run `./node_modules/.bin/cockpit sibling add <slug> --config cockpit.toml` or `./node_modules/.bin/cockpit sibling remove <slug> --config cockpit.toml`, then `sync --dry-run`, `sync` and `check`. | *Add a repository*, *Remove a repository* |
| A sibling has a `.env.schema` | Follow **Secret handling** below. | *Varlock-managed environment* |

## After bootstrap

Done when `./node_modules/.bin/cockpit check --config cockpit.toml --json` exits 0, where a
runtime is declared `./node_modules/.bin/cockpit preflight --config cockpit.toml --json` passes,
and every gap in `result.readiness` of `./node_modules/.bin/cockpit doctor --config cockpit.toml --json`
has been cleared or reported to the human.

- **Before the first `up`**, run
  `./node_modules/.bin/cockpit runtime measure --config cockpit.toml --image <local-image> --json`.
  It measures the local daemon `up` will use, can run for minutes with no progress output, records
  the result for this machine only and leaves `cockpit.toml` unchanged, so go straight on to `up`.
  The guide's *Measure the runtime* says which runtimes are recognised.
- **Daily:** `./node_modules/.bin/cockpit session --config cockpit.toml -- <agent command>`.
  `./node_modules/.bin/cockpit sleep --config cockpit.toml` releases this checkout's hold.
  `./node_modules/.bin/cockpit down --config cockpit.toml` removes its runtime from the local
  Docker daemon fixed at the start of the run; ask first.
- **Upgrade:** install the new version, then run
  `./node_modules/.bin/cockpit check --config cockpit.toml`,
  `./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run` and
  `./node_modules/.bin/cockpit sync --config cockpit.toml`. The guard trusts only the cockpit, Node
  and `cockpit.toml` it was generated for, so after an upgrade, a Node switch or a `cockpit.toml`
  edit it holds tool calls until the human runs
  `./node_modules/.bin/cockpit sync --config cockpit.toml` in a terminal. Guide: *Upgrade loop*.

## Shipped procedure

These sections are the procedure cockpit installs into every cockpit it bootstraps, copied here by
its reference generator so this skill and the installed one cannot disagree.

<!-- cockpit:procedure-section Bootstrap -->

<!-- cockpit:procedure-section Create a local setup -->

<!-- cockpit:procedure-section Secret handling -->
