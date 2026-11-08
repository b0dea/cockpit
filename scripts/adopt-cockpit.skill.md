---
name: adopt-cockpit
description: "Set up or adopt cockpit for a project, bring a multi-repo product up for AI agents, or start a new product with cockpit. Use whenever the user wants cockpit set up, adopted or extended with another repository, or wants their repositories organised and their stack brought up for agents, even when they name no cockpit command. Routes by what is on disk to cockpit's non-interactive commands, keeps product-repository changes on a branch for review, and never invents configuration values."
---

# Adopt cockpit

Use this when a human asks you to set cockpit up, adopt it, or bring their product up for agents.
cockpit declares a product's repositories once in `cockpit.toml`, generates the same agent
instructions, skills, guards and permissions for every harness, and runs the stack against the
live checkouts.

The full guide, with every situation, ships inside the cockpit package
under `docs/`. Once cockpit is installed (below), read
`./node_modules/@b00dea/cockpit/docs/getting-started.md`. Until then, read the same page from a
package tarball (`package/docs/getting-started.md` inside the `.tgz`), a cockpit source checkout
(`docs/getting-started.md`) or <https://github.com/b0dea/cockpit/blob/main/docs/getting-started.md>.
Each step below names its guide section. Guide pages cited after the install step are in that
installed directory.

## Safety contract

A clean-looking configuration with invented values in it is the failure cockpit exists to prevent.
Follow these rules throughout. Reuse explicit authorization already given for the stated scope;
ask when scope is missing or an exact preview still needs acceptance:

1. Ask the human before creating a Git remote or hosted repository, running a destructive command
   (`reset`, approving removals), running `sync --adopt`, accepting an `init` digest, or adopting a
   test framework or dependency outside already authorized product-change scope. A Dockerfile, Compose file or `.env.schema`
   the product needs goes on a new branch in that sibling's checkout, started with no uncommitted
   changes; show its diff against the starting branch in your report. Nothing is pushed.
2. Show the exact preview first: the `sync --dry-run` listing, the `init` preview and its
   `previewSha256`, the answers file, or the defaults digest. Consent binds to those bytes.
3. Take every value (port, image, command, health check, purpose, name) from a file you read or
   from the human. When neither has it, name the gap and ask.
4. Accept as read only a field `init` marks `confirmedBy = "agent"` (a `derived` proposal), by
   marking it `"derived"`. Show every other proposal with the file it came from; it becomes an
   answer only on the human's word.
5. Ask the human for the database and live vendor API hosts of every non-local environment
   (production, staging, shared) for the `guards` answer; env templates give variable names only, and once a cockpit exists `./node_modules/@b00dea/cockpit/bin/cockpit.mjs env keys --config cockpit.toml` lists them.
6. Offer the human `work.grading` as a real choice with `init`'s proposal and reason: the grader is
   optional, and `off` is reasonable when tracking matters but grading is not wanted.
7. "Use sensible defaults" covers `init` answers only, never another change inside a product
   repository: an **AGENTS.md** pointer or a `package.json` change needs explicit product-change
   authorization covering its reviewed scope, which can already have been given. For the files
   `init` writes, that scope is the `writes` list of the preview the human accepts. Mark every answer you chose as `"agent-default"` in the answers file's
   `[provenance]` table, and end your report with every default you chose, its field and value.
8. Every trust answer the answers file supplies (`sibling`, `environment.install_policies`,
   `environment.posture`, `testing`, `guards`, `work.grading`) lands under `unconfirmed` whatever the
   file says, and the stronger default holds until a person confirms it. Prepare one review of
   the outstanding trust entries, their values and consequences. After accepting those values,
   the human removes the reviewed entries from `unconfirmed` together, then runs
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --interactive` in a terminal outside the agent
   (the confirm command refuses these).

## Install cockpit if it is missing

Done when the exact project-local executable lists the commands.

1. Follow *Install cockpit* in `docs/getting-started.md`, from the same sources as the guide above:
   an exact dev dependency of the repository, with *Install from source* as the fallback for an
   unreleased build. Show the human the manifest and lockfile change before installing.
2. For several repositories, the human may prefer a cockpit directory beside them; that is their
   call. Leave the product repositories untouched unless the human agrees.
3. Verify without permitting an implicit download:

   ```sh
   ./node_modules/@b00dea/cockpit/bin/cockpit.mjs --help
   ```

4. Every `init` below takes `--target <tool>`: replace `<tool>` with the target of the agent tool
   you are running in. For an instructions-only tool, follow
   the *Capability states* section of `./node_modules/@b00dea/cockpit/docs/harness-surfaces.md`.

Run every command from the cockpit root through `./node_modules/@b00dea/cockpit/bin/cockpit.mjs`; if that file is
absent, stop and repair the project-local install. Read flags from
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs <command> --help`. In Codex's sandbox `check`, `sync --dry-run` and
`--help` run as it stands, unless `[browser]` is declared; other cockpit commands can need access
such as the state directory, Docker socket or macOS `/bin/ps`. Inspect the named failure and request
only missing access through the native approval mechanism, with the concrete command and reason.
Follow **Running cockpit** in the installed setup procedure for refusals. Pass `--json` and read `result`,
`diagnostics[].code` and `invocation.exitCode`. A pending `init` also exits 0, so read its
`result.stage` and `result.question`.

## Route by what is on disk

Look at the directory before asking. Several cases can apply; bootstrap first.

| On disk | Do | Guide section |
|---|---|---|
| Inside an existing product repository (a Git checkout with a language manifest, Dockerfile or Compose file at its root) | A single repository gets an in-repo cockpit by default. If the human wants the cockpit in a folder of its own beside several repositories, put `cockpit.root = "dedicated"` in the answers file; never choose that for them. | *Chapter 1* and *The init interview* |
| An empty directory, or only documents and decisions | Follow **Bootstrap** below. With no manifest, `init` builds a surfaces-only cockpit whose first sibling is the root itself (`dir = "."`, `mount = "none"`); the purpose comes from the human. Add each repository later with `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add <slug> --config cockpit.toml --create --purpose "<purpose>" --json` and hand the human its `result.publish.command` (`gh repo create`). | *The init interview* |
| One or several repositories with services | From the directory that holds them, follow **Bootstrap** below: `./node_modules/@b00dea/cockpit/bin/cockpit.mjs init "$(pwd)" --target <tool> --json`, then the same command with `--accept-preview` and `--answers`, then with `--accept-defaults` as well. | *The init interview* |
| Repositories scattered across the disk | Moving them is the human's call. Otherwise declare each with `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add <slug> --config cockpit.toml --from <path> --purpose "<purpose>" --json`, then run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config cockpit.toml --json`. | *Other situations* |
| An existing Compose file | Answer `environment.compose_files = ["compose.yml"]`. For a Compose file inside a product repository, declare that repository as a sibling and point `compose_files` at the file in its checkout. Ask the human for the `environment.machine` floors and the `environment.posture` (how the product is reached and signed into) that `init` asks next. | *Chapter 2* |
| A service with no local setup | Follow **Create a local setup** below. | *Other situations* |
| Committed `.claude/settings.json`, `.codex/config.toml` or `.codex/hooks.json` | `sync` refuses with `SURFACE_STATE_CONFLICT`. With the human's yes, run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --adopt <path> --json`. | *Adopt existing agent settings* |
| A repository joins or leaves an existing cockpit | Run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add <slug> --config cockpit.toml` or `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling remove <slug> --config cockpit.toml`, then `sync --dry-run`, `sync` and `check`. | *Add or remove a repository* |
| A repository has dotenv files, environment templates or a `.env.schema` | Follow **Secret handling** below. | *Other situations* |

## After bootstrap

Done when `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml --json` exits 0, where a
runtime is declared `./node_modules/@b00dea/cockpit/bin/cockpit.mjs preflight --config cockpit.toml --json` passes,
and every gap in `result.readiness` of `./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config cockpit.toml --json`
has been cleared or reported to the human.

- **Only where a runtime is declared, before the first `up`**, run
  `./node_modules/@b00dea/cockpit/bin/cockpit.mjs runtime measure --config cockpit.toml --image <local-image> --json`.
  It measures the local daemon `up` will use, can run for minutes with no progress output, records
  the result for this machine only and leaves `cockpit.toml` unchanged, so go straight on to `up`.
  A surfaces-only product finishes with `check` and `doctor`; add runtime declarations when runnable code exists.
  The guide's *Chapter 2* says which runtimes are recognised.
- **Daily, with a declared runtime:** `./node_modules/@b00dea/cockpit/bin/cockpit.mjs session --config cockpit.toml -- <agent command>`.
  `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sleep --config cockpit.toml` releases this checkout's hold.
  `./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config cockpit.toml` removes its containers, keeping data
  volumes, from the local Docker daemon fixed at the start of the run.
- **Upgrade:** `./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config cockpit.toml` does the move (`--dry-run`
  previews). By hand, install the new version, then run
  `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml`,
  `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --dry-run` and
  `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml`. The guard trusts only the cockpit, Node
  and `cockpit.toml` it was generated for, so after an upgrade, a Node switch or a `cockpit.toml`
  edit can hold tool calls. Follow the refusal as **Running cockpit** describes: a restrictive
  configuration edit can be synced under existing agent authority; a changed executable or widened
  authority needs the person. Guide: *Upgrade cockpit*.

## Shipped procedure

These sections are the procedure cockpit installs into every cockpit it bootstraps, copied here by
its reference generator so this skill and the installed one cannot disagree.

<!-- cockpit:procedure-section Continue authorized setup -->

<!-- cockpit:procedure-section Bootstrap -->

<!-- cockpit:procedure-section Create a local setup -->

<!-- cockpit:procedure-section Secret handling -->
