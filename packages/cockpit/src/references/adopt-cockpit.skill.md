---
name: adopt-cockpit
description: "Set up or adopt cockpit for a project, bring a multi-repo product up for AI agents, or start a new product with cockpit. Use whenever the user wants cockpit set up, adopted or extended with another repository, or wants their repositories organised and their stack brought up for agents, even when they name no cockpit command. Routes by what is on disk to cockpit's non-interactive commands, asks before writing into product repositories, and never invents configuration values."
---

<!-- cockpit:verified version=0.0.0 -->

# Adopt cockpit

Use this when a human asks you to set cockpit up, adopt it, or bring their product up for
agents. cockpit declares a product's repositories once in `cockpit.toml`, renders the same agent
instructions, skills, guards and permissions for every harness, and runs the stack against the
live checkouts. The complete guide, with every situation and its completion criteria, is
<https://raw.githubusercontent.com/b0dea/cockpit/main/docs/agent-adoption.md>; read the section a
step below points to.

## Safety contract

cockpit exists so that an agent's environment holds no guesses: a clean-looking configuration
with invented values in it is the failure it is built to prevent. Work under five rules:

1. Ask the human before writing into a product repository, creating a Git remote or hosted
   repository, running a destructive command (`down`, `reset`, approving removals), running
   `cockpit sync --adopt`, or accepting an `init` digest.
2. Show the exact preview first: the `sync --dry-run` listing, the `init` preview and its
   `previewSha256`, the answers file, or the defaults digest. Consent binds to those bytes.
3. Take every value (port, image, command, health check, purpose, name) from a file you read or
   from the human. When neither has it, name the gap and ask.
4. Show every inferred value with the file it came from, including what `init` proposes under
   `provenance.kind = "inferred"`. It becomes an answer only on the human's word.
5. Ask the human for the database and live vendor API hosts of every non-local environment
   (production, staging, shared) for the `guards` answer; env templates give variable names only.

## Install cockpit if it is missing

Done when `cockpit --help` lists the commands.

cockpit installs from source today. Tell the human, then run the commands from the Quickstart in
<https://raw.githubusercontent.com/b0dea/cockpit/main/README.md>, which is the current path:

```sh
git clone https://github.com/b0dea/cockpit.git && cd cockpit
npm ci --ignore-scripts && npm run build
npm link --workspace @b0dea/cockpit
```

Your harness target is the tool you run in: `claudecode` (Claude Code), `codexcli` (Codex CLI),
`opencode` (OpenCode), `cursor` (Cursor), or `grokcli` (Grok Build). If your tool isn't one of the
built-ins, cockpit's AGENTS.md still gives it the instructions; guards and permissions are not enforced there
(<https://raw.githubusercontent.com/b0dea/cockpit/main/docs/capability-matrix.md>).

Read flags from `cockpit <command> --help`. Pass `--json` and read `result`, `diagnostics[].code`
and `invocation.exitCode`; a pending `init` also exits 0, so read its `result.stage` and
`result.question`.

## Route by what is on disk

Look at the directory before asking. Several cases can apply; bootstrap first. Each line names
the guide section that owns the detail.

- **Inside an existing product repository** (a Git checkout with a package manifest at its
  root). The `--json` preview's `result.cockpitRoot` asks for the cockpit root before
  anything is written. Relay the question, both options with their exact paths and trade-offs,
  and the recommendation (`dedicated`: a new `../<repo>-cockpit` folder with this repository as
  its first sibling) to the human, and put their choice in the answers file as
  `cockpit.root = "dedicated"` or `"in-repo"`. Never choose it yourself: the digest flags refuse
  with `INIT_COCKPIT_ROOT_REQUIRED` until it is answered. Guide: *Inside a product repository*.
- **Empty directory, or only documents and decisions.** Follow **Bootstrap** below: with no
  package manifest `init` builds a surfaces-only cockpit and proposes the cockpit root itself as
  the first sibling (`dir = "."`, `mount = "none"`); the purpose comes from the human. Add each
  repository later with
  `cockpit sibling add <slug> --config cockpit.toml --create --purpose "<purpose>" --json`, whose
  `result.publish.command` is the `gh repo create` command to hand to the human.
  Guide: *Empty directory*, *Docs or decisions only*.
- **One or several repositories with services.** From the directory that holds them, follow
  **Bootstrap** below: `cockpit init "$(pwd)" --target <target> --json`, then the same command
  with `--accept-preview` and `--answers`, then with `--accept-defaults` as well.
  Guide: *One or several repositories*.
- **Repositories scattered across the disk.** Moving them is the human's call. Otherwise declare
  each with `cockpit sibling add <slug> --config cockpit.toml --from <path> --purpose "<purpose>" --json`
  and run `cockpit setup --config cockpit.toml --json`. Guide: *Scattered repositories*.
- **An existing Compose file.** Answer `environment.compose_files = ["compose.yml"]` instead of a
  generated stack, and ask the human for the `environment.machine` floors `init` asks next.
  Guide: *Existing Compose file*.
- **A service with no local setup.** Follow **Create a local setup** below.
- **Committed `.claude/settings.json`, `.codex/config.toml` or `.codex/hooks.json`.** `sync`
  refuses with `SURFACE_STATE_CONFLICT`. With the human's yes, run
  `cockpit sync --config cockpit.toml --adopt <path> --json`. Guide: *Existing agent settings*.
- **A repository joins or leaves an existing cockpit.** Run `cockpit sibling add` or
  `cockpit sibling remove`, then the `sync --dry-run`, `sync` and `check` sequence.
  Guide: *Add a repository*, *Remove a repository*.
- **A sibling has a `.env.schema`.** Follow **Secret handling** below.

## After bootstrap

Done when `cockpit check --config cockpit.toml --json` exits 0 and, where a runtime is declared,
`cockpit preflight --config cockpit.toml --json` passes.

- Before the first `up`, measure the runtime with
  `cockpit runtime measure --config cockpit.toml --image <local-image> --write --json`. The
  guide's *Measure the runtime* says which runtimes are recognised and which have been measured.
- Daily: `cockpit session --config cockpit.toml -- <agent command>`. `cockpit sleep` releases
  this checkout's hold; `cockpit down` removes its runtime, so ask first.
- Upgrade: install the new version, then run `cockpit check`, `cockpit sync --dry-run` and
  `cockpit sync`. The guard pins the CLI it was rendered for, so after an upgrade the human may
  need to run `cockpit sync --config cockpit.toml` in a terminal.

## Shipped procedure

These sections are the procedure cockpit installs into every cockpit it bootstraps, copied here
by its reference generator so this skill and the installed one cannot disagree.

<!-- cockpit:procedure-section Bootstrap -->

<!-- cockpit:procedure-section Create a local setup -->

<!-- cockpit:procedure-section Secret handling -->
