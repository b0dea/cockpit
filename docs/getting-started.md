# Getting started

By the end of chapter 1, one repository has a reviewed `cockpit.toml`, every agent tool you listed
loads the same instructions and skills, the guard refuses a push to `main` in each of them (in Codex
once a person trusts its hook), and `cockpit check` fails the moment a generated file drifts.
Chapter 2 adds more repositories and a Compose stack each agent can bring up on its own ports.

This guide is for developers and the AI agents they ask to do the setup. To see cockpit work on a
throwaway example first, follow the [tutorial](tutorial.md).

| Your situation | Go to |
|---|---|
| One repository, one agent tool, no Docker | [Chapter 1](#chapter-1-one-repository-one-tool-no-docker) |
| You want an agent to do the setup | [Set up with an agent](#set-up-with-an-agent) |
| Several repositories, or a stack to run | [Chapter 2](#chapter-2-several-repositories-and-a-compose-stack) |
| A setup you already run with scripts or a shell registry | [Adopt an existing setup](#adopt-an-existing-setup) |
| A teammate's cockpit you are joining | [Joining a team's cockpit](joining-a-team.md) |

## Chapter 1: one repository, one tool, no Docker

You need a Node.js release listed in the
[`engines` field in the package manifest](../packages/cockpit/package.json), Git, and macOS or
Linux.

### Install cockpit

```sh
npm install --save-dev --save-exact @b00dea/cockpit
npx --no cockpit init . --target claudecode
```

With pnpm or yarn, install with `pnpm add -D -E @b00dea/cockpit` or `yarn add -D -E @b00dea/cockpit`
and run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs` wherever this guide uses `npx --no`.
The guard can prove that path under an agent, and refuses or asks about `pnpm exec cockpit` and
`yarn cockpit`. `init` detects the lockfile and writes the matching commands.

Replace `claudecode` with `codexcli` or `opencode`, or list several, yours first
(`--target claudecode,opencode`). `init` records them as `[surfaces] tools` and installs the
`cockpit-setup` skill for each. The default tools are `claudecode`, `codexcli` and `opencode`;
`cursor` and `grokcli` are written only when listed, and nobody has confirmed they load the files
([capability matrix](capability-matrix.md)). `cockpit tool add|remove <tool>` changes the list
later.

A single product repository gets an in-repo cockpit: `cockpit.toml`, the instructions and the guard
live in the repository itself, with `siblings_root = "."`. `init` previews every file and accepts
only the exact digest of that preview, then asks for each fact it cannot read from the repository
([The init interview](#the-init-interview)).

To adopt the instructions and guards before the runtime, answer `environment.compose_files` with
`[]`, even if the repository has Compose files. `init` skips the machine floor and runtime posture
questions and records the choice and who made it. Runtime commands refuse until you
[add the Compose stack](#chapter-2-several-repositories-and-a-compose-stack).

### Generate, check and commit

```sh
npx --no cockpit sync --config ./cockpit.toml --dry-run
npx --no cockpit sync --config ./cockpit.toml
npx --no cockpit check --config ./cockpit.toml
```

- `sync --dry-run` lists every write and removal. Read it.
- `sync` publishes all generated files as one recoverable transaction. It refuses to remove a stale
  generated file unless `[autonomy] stale_delete` lets it, or a person approves exactly that removal
  with `sync --interactive`.
- `check` confirms nothing has drifted and never changes a file.

Review the output and commit it. Run `npx --no cockpit doctor --config ./cockpit.toml` for what is
still missing and why. If anyone uses Codex, a person must trust its guard hook once per machine;
`doctor` says so until then. Add `npx --no cockpit check --config cockpit.toml` to CI, or use the
[`cockpit-check` action](harness-surfaces.md#publish-and-verify).

Cockpit is usable once `check` passes. `selftest` is an optional extra: it gathers native evidence
of what the tools on this machine load and enforce, and a person runs it, when they want that
evidence, with `npx --no cockpit selftest --config ./cockpit.toml --interactive`
([Skills and selftest evidence](harness-surfaces.md#skills-and-selftest-evidence)). It is not an
adoption step, so an agent never waits for it.

Run every command from the cockpit directory with a path that fails when the dependency is missing
and never downloads a package: `./node_modules/@b00dea/cockpit/bin/cockpit.mjs`,
`./node_modules/.bin/cockpit`, `npx --no`, or the `cockpit:*` package scripts `init` writes. The package ships these guides under `./node_modules/@b00dea/cockpit/docs/`,
so skills and fix hints cite them offline.

## Set up with an agent

Tell the agent: *set up cockpit for this project, following `docs/getting-started.md`*. It can read
this page from the installed package (`./node_modules/@b00dea/cockpit/docs/getting-started.md`), a
source checkout, or <https://github.com/b0dea/cockpit/blob/main/docs/getting-started.md>. The
`adopt-cockpit` skill (`npx skills add b0dea/cockpit --skill adopt-cockpit`) routes an agent here,
and after `init` every listed tool has the `cockpit-setup` skill, which carries the same procedure.

### Safety contract

A clean-looking configuration with invented values in it is the failure cockpit exists to prevent.
The agent follows these rules for the whole setup:

1. **Ask the human first, and wait for a yes,** before creating a Git remote or hosted repository,
   running a destructive command (`reset`, `sync --interactive` removals, deleting files), running
   `cockpit sync --adopt`, accepting an `init` digest, or changing a product repository in any way
   the next sentences do not allow (adopting a test framework or a dependency, for example). A
   person approves or runs staging and the commit of the cockpit: the agent hands them the command.
   A Dockerfile, Compose file or `.env.schema` the product needs goes on a new branch in that
   sibling's checkout, started with no uncommitted changes, and the hand-back shows its diff against
   the branch it started from. Nothing is pushed.
2. **Show the exact preview before asking:** the `sync --dry-run` listing, the `init` preview with
   its `previewSha256`, the answers file or the defaults digest. Consent binds to those bytes, and a
   digest from anything but the latest pending run is refused.
3. **Never invent a configuration value.** A port, image, command, health check, purpose or name
   comes from a file the agent read or from the human; otherwise it leaves a named gap and asks.
4. **Only what init read exactly is the agent's to accept.** `init` labels each proposal with
   `provenance.kind`: `derived` (the complete answer, read from the named file and line), `measured`
   (observed on this machine) or `inferred` (a hint or guess). A field whose `confirmedBy` is
   `"agent"` may be answered with `"derived"` (below); `init` checks the value against what it read,
   and bring-up proves it. Every other field, and every security boundary (the `guards` hosts,
   protected branches, guard and MCP allow-lists), becomes an answer only on the human's word.
5. **Ask for every non-local host.** The `guards` answer lists the database and live vendor API
   hosts of production, staging and shared environments. Variable names come from env templates,
   never values; each host comes from the human.
6. **Defaults never reach into a product repository.** "Use sensible defaults" covers `init` answers
   only. A pointer in a sibling's **AGENTS.md** or a change to its `package.json` still needs an
   explicit yes to that exact change, and a product file goes on a branch as rule 1 says. Every
   answer the agent chose itself is marked `"agent-default"` (below), and its report ends with each
   default, its field and its value.
7. **Confirm a default only by observing it.** The agent clears an `unconfirmed` entry only with
   `cockpit confirm`, which runs the observation that verifies that answer on this machine and
   records it. The trust decisions (`guards`, `testing`, `environment.install_policies`, `sibling`,
   `environment.posture`, `work.grading`) and the answers no observation settles (`cockpit.name`,
   `estate.runnable`, `environment.test_data`) stay a person's (below).

These rules are instructions, not enforcement. The guard cockpit installs later blocks some
commands; see [Safety and autonomy](safety-and-autonomy.md).

### Read a cockpit result

- Pass `--json` to every command except `session`. Each prints one JSON document with `result`,
  `diagnostics` (each with a `severity` and a `code`) and `invocation.exitCode`. What to do about a
  diagnostic is in `guidance`, the entry with the same `code` and `target`; a diagnostic carries
  `fix` itself only when that fix is a cockpit command safe to run as printed.
- A refusal exits nonzero and names its diagnostic; look the code up in
  [Troubleshooting](troubleshooting.md). Take flags from `cockpit <command> --help` or the
  [CLI reference](cli-reference.md), not from memory.
- `init` exits 0 when it stops at a question. Read `result.stage`, `result.question` and
  `result.interview.outstanding` for the pending decision.
- A cockpit that declares no runtime ends at stage `surfaces-verified`, not `environment-verified`:
  its generated files are checked, and nothing verified a running environment. `doctor` reports its
  schema status.

### Mark the answers you chose

When the human delegates a decision ("pick sensible defaults"), say so per field in the answers file
so the value is never recorded as theirs:

```toml
[provenance]
"environment.machine" = "agent-default"
guards = "agent-default"
```

Each such field is written under `unconfirmed` at the top of `cockpit.toml`, listed in
`result.unconfirmed`, and reported by `doctor` as `DECLARATION_UNCONFIRMED` until it is confirmed.
An `environment.machine` floor the file does not attribute is recorded as unattributed, because no
file records its free disk or cold start time.

An agent can write an answers file, so the file cannot show that a person made a trust decision.
Every trust answer it supplies (`sibling`, `environment.install_policies`, `environment.posture`,
`testing`, `guards`, `work.grading`) is written under `unconfirmed` whatever its `[provenance]` says.
Until a person confirms it, the stronger default holds where one exists: grading runs as
`independent`, and the guard admits no install policy's build or test command. A person driving
onboarding with an answers file confirms each one afterwards, as below: `cockpit confirm` refuses
them.

Three answers are facts about this machine and the running product, so an agent confirms them by
observation, one at a time:

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs confirm ports.bases --config cockpit.toml --json
```

| Answer | The observation that confirms it |
|---|---|
| `ports.bases` | `preflight` passes with the stack up and its port family leased on the declared bases |
| `environment.compose_files` | `check` passes, which parses the Compose files and resolves the stack's topology |
| `environment.machine` | the runtime measured on this machine meets the declared memory, CPU and free-disk floor |

When the observation passes, `confirm` removes that one entry from `unconfirmed` (every other byte
stays) and records what ran, when, its result and an evidence digest in
`.cockpit/local/answer-confirmations`. That file is machine-local and ignored, and the guard denies
agent writes to it. The guard treats the removed entry as non-widening only while that record
matches the configuration on disk, so the agent's own sync applies it where
`[autonomy] sync = "agent"`; any other edit, or a clone without the record, leaves it to a person. A
failed observation is refused with `CONFIRM_OBSERVATION_FAILED` beside the diagnostics that explain
it.

Every other answer is refused with `CONFIRM_PERSON_REQUIRED`. A person confirms the value with
whoever owns the product, corrects it if it is wrong, deletes its `unconfirmed` entry and its
`# Unconfirmed` comment, and runs `cockpit sync --interactive` in a terminal outside the agent. That
asks them to accept a confirmed value weaker than the policy the last sync recorded, such as
`work.grading = "off"`, and then lists the files it wrote, `.cockpit/policy.json` among them the
first time, for the person to commit.

A field whose `interview.outstanding` entry says `confirmedBy = "agent"` can instead be marked
`"derived"`, with or without a value: `init` answers it with the value it read, refuses
(`DOCUMENT_CONFIGURATION_ANSWER_NOT_DERIVED`) a value that differs or a field it read no complete
value for, and writes a `# Derived:` comment naming the source instead of an `unconfirmed` entry:

```toml
[provenance]
"cockpit.name" = "derived"
"ports.bases" = "derived"
"environment.compose_files" = "derived"
```

### Walk through readiness

Every `init` stop and `cockpit doctor --config cockpit.toml --json` carry `result.readiness`, the
prerequisites cockpit depends on. Each entry in `gaps` has an `id`, a `level` (a `required` gap is
refused by the command that needs it; a `recommended` one warns), `needs` and `findings` (each
diagnostic with its message and fix). `noFinding` lists prerequisites no check reported; a check
that could not run reports nothing, so it is not proof. Take the gaps one at a time, required first:
what is missing, why, and the exact change you propose.

Run readiness checks with the installed cockpit copy. A package-manager link, such as pnpm's, is
recognized when it resolves to that running copy; the guard binding and launcher still have to pass
their own checks.

Whether the existing tests prove anything is the agent's judgement, made on evidence. For each
proposed gate, name the behaviours its tests exercise, then break one on purpose, run the gate,
watch it go red, and restore the file so the checkout is as it was found; that edit needs no yes,
because it is undone before the step ends. Write the behaviours into the gate's `changes` text and
report the judgement, with the red run's output, in the hand-back. A gate that stays green on the
break proves nothing about that behaviour, and the report says so. Adopting a new test framework in
a product repository stays the human's call.

The cockpit directory must be a Git working tree, committed and clean, before `preflight` passes; a
new one reports `GIT_STATE_UNHEALTHY` until a person stages and commits it.

## The init interview

`init` reads the repositories under the directory and asks for every fact it cannot read from them.
Preview first, then accept in a terminal:

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs init "$(pwd)" --target <tool> --json
./node_modules/@b00dea/cockpit/bin/cockpit.mjs init "$(pwd)" --target <tool> --interactive
```

The preview writes nothing. It returns the setup skill files it would install, under `writes` every
other path `init` creates or changes once accepted (`cockpit.toml`, the root **AGENTS.md**,
**package.json**, **.gitignore** and each tool's files), a `previewSha256` digest and the next step; `--interactive` asks you to confirm the displayed preview with `yes`, binding its digest
internally. It also confirms the concrete configuration defaults without hash transcription. Later
authenticated draft stages reuse the accepted preview. Re-running resumes where it stopped, and a
changed repository invalidates earlier answers. What you get depends on what it finds:

- **A product repository** (a Git checkout with a language manifest, Dockerfile or Compose file)
  gets an in-repo cockpit and declares only that repository. For a folder of its own beside the
  repositories, answer `cockpit.root = "dedicated"`
  ([Where the cockpit lives](concepts.md#where-the-cockpit-lives)). Add other repositories
  afterwards with [`sibling add`](#add-or-remove-a-repository); naming them in the answers file is
  refused with `DOCUMENT_ESTATE_TOPOLOGY_MISMATCH`.
- **Nothing runnable** (an empty directory, or a repository of documents) gets a configuration with
  no `[environment]`; runtime commands refuse with `ENVIRONMENT_NOT_DECLARED`, which is expected.
  `init` proposes the root itself as the first sibling (`dir = "."`, `mount = "none"`).
- **A declared runtime** adds questions about the machine floor and posture the product needs.

Each outstanding field lists its `proposals`, and `confirmedBy` says who settles it: `"agent"` when
a `derived` proposal answers the whole field (today `cockpit.name`, `ports.bases` and
`environment.compose_files`, when the files leave no gap and `check` accepts the Compose file as
written), `"person"` otherwise. A source `init`
could not read, or two that disagree, leaves the field to the person.

Proposals come only from exact sources:

- a Dockerfile's `EXPOSE`, `CMD` and `ENTRYPOINT`, a `package.json` `start`, `serve` or `dev`
  script, and the `node` toolchain a lockfile names;
- each repository's `origin` remote (a URL carrying credentials is skipped, never shown);
- variable names, never values, in env templates such as `.env.example`; a name that suggests a
  database or vendor endpoint, such as `DATABASE_URL`, becomes a `guards` question about its host;
- an existing Compose file, the `services:` of GitHub workflows, and test entry points such as a
  Makefile `test` target, a `package.json` test script or `go.mod`;
- for the machine floor, the memory and CPU limits of the services the Compose file starts by
  default (`deploy.resources.limits` or `mem_limit` and `cpus`, times their replicas). Where no
  limit records one it measures this machine's container runtime (`measured`, which refuses a
  smaller machine until someone lowers it). Free disk and cold start time have no source and are
  never proposed.

Sources `init` could not use, including a runtime it could not measure, are listed in
`interview.inferenceSkipped`.

### Without a terminal

An agent or CI job has no terminal, so `--interactive` refuses with `INIT_TERMINAL_REQUIRED`. Pass
consent and answers as arguments instead; there is no blanket `--yes`.

1. Run the `--json` preview. It returns the `previewSha256` and, under `interview.outstanding`,
   every field the interview will still ask, each with a `why`, its `proposals` and `confirmedBy`.
2. Write the answers as TOML keyed by field, and show them to the human with the digest.
3. Rerun with `--accept-preview <previewSha256>` and `--answers <file>`. The run stops at the first
   unanswered field, with `interview.outstanding` listing only the fields the file still lacks, or at
   `configuration.defaults`, where `result.question.document` is the review
   draft (an array of lines). Its provenance comments split the surfaced defaults in two: schema
   defaults and the cockpit's own layout, which the agent accepts, and the security boundaries
   (protected branches, guard allow and deny lists, approved MCP servers, resettable volumes,
   generated host paths), which a person confirms. `result.question.expectedSha256` covers only the
   second group, and the human reads it before accepting that digest.
4. Rerun with `--accept-defaults <expectedSha256>` as well. A digest that is not the pending one is
   refused (`INIT_PREVIEW_NOT_ACCEPTED`, `INIT_DEFAULTS_NOT_ACCEPTED`).

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs init "$(pwd)" --target <tool> --accept-preview <previewSha256> --answers ./answers.toml --json
./node_modules/@b00dea/cockpit/bin/cockpit.mjs init "$(pwd)" --target <tool> --accept-preview <previewSha256> --answers ./answers.toml --accept-defaults <expectedSha256> --json
```

For a directory with one library and nothing runnable, the whole answers file is:

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

[work]
grading = "independent"
```

| Field | Answer |
|---|---|
| `cockpit.root` | `"dedicated"` or `"in-repo"`; asked only where both are possible, and a digest flag takes `"in-repo"` |
| `cockpit.name` | always asked; the root directory's name is proposed. It scopes Compose projects, state and generated files ([Rename a cockpit](#rename-a-cockpit)) |
| `sibling` | one `[[sibling]]` table per repository |
| `estate.runnable` | one table per repository whose run command was unknown, keyed by its slug |
| `ports.bases` | the host-published base port map; `{}` means none |
| `environment.install_policies` | asked when a sibling declares a toolchain other than `"none"`; the build and test commands per toolchain and lockfile, `[]` for none |
| `environment.test_data` | exactly the boolean keys `seeded_data` and `signed_in_users`; `false` states it is not needed |
| `environment.compose_files` | the Compose files that run the product, relative to the cockpit root; `[]` defers runtime adoption as in [chapter 1](#chapter-1-one-repository-one-tool-no-docker) |
| `environment.machine` | asked when Compose files are declared; the runtime floor: `runtime_memory_mb`, `runtime_cpus`, `free_disk_mb`, `cold_start_seconds` |
| `environment.posture` | asked when Compose files are declared; `addressing`, `authentication` and `posture_requirements` ([Declare environment postures](environment.md#declare-environment-postures)) |
| `testing` | the product's `[testing]` stages and gates; `"none"` records that it has no tests yet, so no work can be graded PASS and `doctor` warns (`TESTING_GATE_UNDECLARED`) |
| `guards` | `hosted_db_hosts` and `vendor_endpoint_hosts` of every non-local environment; `[]` for both records that none exists |
| `work.grading` | always asked; how an order earns done ([the choices](work-and-browser.md#how-grading-can-run)). Init proposes `independent` when a listed tool is on `PATH` (with only one, a separate run of it, warned where the running tool is detected) and `checks`, which needs no agent tool, when none is. A person's decision: `off` is reasonable when tracking matters but grading is not wanted. An existing cockpit keeps its value |
| `provenance` | optional; `"human"` (the default), `"agent-default"` or `"derived"` per field ([Mark the answers you chose](#mark-the-answers-you-chose)) |

A key that names no field is refused. Recorded answers are kept, so the same file can be passed on
every run; a different value for a recorded field is refused (`INIT_ANSWER_CONFLICT`) before
anything is published. Preview resetting one, and every later dependent answer, with
`cockpit init <root> --target <tool> --reset-answer <field> --json`, then repeat with
`--accept-reset <previewSha256>`. Once `cockpit.toml` is written, recorded answers can no longer be
reset: edit the value in `cockpit.toml` and rerun `init` with `--accept-preview`.

## Chapter 2: several repositories and a Compose stack

cockpit runs your own Compose files; it does not generate them. Add each further repository with
[`sibling add`](#add-or-remove-a-repository), and put the cockpit in a folder beside them
(`cockpit.root = "dedicated"`, `siblings_root = ".."`) when it should own several neutrally.

**Compose.** Declare the files that run the product, inside the cockpit root:

```toml
[environment]
install_policies = []
compose_files = ["compose.yml"]
```

| Compose files | Layout |
|---|---|
| One, inside a product repository checked out under the cockpit root (`siblings_root = "."`) | Declare the repository as a sibling and point at its file in place, as in `compose_files = ["shop/compose.yml"]`. Relative paths such as `build: ./api` resolve against `shop/`, so the file needs no change. |
| In two or more repositories, or outside the cockpit root | A `compose.yml` of your own at the cockpit root that reaches each checkout through its sibling variable (`build: ${SHOP_DIR}/api`) and publishes ports from `[ports.bases]` variables. A Compose `include` of the product's file is refused. |
| None yet | `cockpit init . --scaffold-compose <app dir> --port <port>` writes one plain `compose.yml` once ([Scaffold a Compose file](environment.md#scaffold-a-compose-file)). |

[Compose-first stacks](environment.md#compose-first-stacks) has the rules `check` applies, and
[examples/compose-first](../examples/compose-first/README.md) a working layout. Changing a product's
Compose file is a product change: an agent makes it on a branch, as the
[safety contract](#safety-contract) says.

**Data.** `seed` and `resettable_volumes` fill and wipe the stack's data
([Demo data, test users and roles](environment.md#demo-data-test-users-and-roles)).

**Docker.** Commands that run the stack need Docker Compose and a local runtime that has passed
`cockpit runtime measure --image <local-image>`;
[Measure the container runtime](environment.md#measure-the-container-runtime) lists the supported
runtimes. Configuration, generation and `check` need no runtime, though validating declared Compose
files needs Docker Compose.

### Bring the product up

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config ./cockpit.toml
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ./cockpit.toml
./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config ./cockpit.toml
./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config ./cockpit.toml
./node_modules/@b00dea/cockpit/bin/cockpit.mjs preflight --config ./cockpit.toml
```

`setup` clones or verifies each declared repository and checks its remote. `up` starts or resumes
the stack, but only `preflight` says it is healthy; it also fails with `GIT_STATE_UNHEALTHY` while
the cockpit has uncommitted changes. With `--json`, `up` reports the stack identifier, whether it
`started`, `resumed` or was `unchanged`, the leased port for each `[ports.bases]` name and the
cold-start time of the services it started.

## Other situations

| On disk | Do |
|---|---|
| Repositories scattered across the disk | Moving them is the human's call. Otherwise `sibling add <slug> --from <path> --purpose "<purpose>"` records each checkout's `origin` with `acquire = "auto"`, and `setup` clones a fresh copy into the cockpit. It never moves, changes or deletes the original. |
| A service that has only ever run in CI, staging or a cluster | Follow **Create a local setup** in the shipped [setup procedure](../packages/cockpit/surfaces/skills/procedures/setup.md#create-a-local-setup): derive each value from manifests, CI workflows and deployment files, record it as inferred with its source, and keep every unknown a named gap. |
| Committed `.claude/settings.json`, `.codex/config.toml` or `.codex/hooks.json` | [Adopt existing agent settings](#adopt-existing-agent-settings), after the human agrees. |
| A repository with dotenv files, environment templates or a `.env.schema` | Decide whether to adopt Varlock even when no schema exists, and record the adoption or the reason for deferral. Follow **Secret handling** in the [setup procedure](../packages/cockpit/surfaces/skills/procedures/setup.md#secret-handling) and [Secret sources and environment schemas](environment.md#secret-sources-and-environment-schemas). `varlock init`, provider login, encryption and moving secrets are the human's actions. |

## Adopt an existing setup

For teams that already run a multi-repository product with their own scripts or a shell-registry
cockpit, moving one layer at a time. Keep the old path runnable until the cockpit path passes the
same checks.

### Bootstrap from the registry

Preview for one harness, then accept. Replace `<tool>` with its [target](#install-cockpit); the
first command writes nothing, and the second needs a terminal to confirm that exact preview:

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs init . --target <tool> --registry ./env/lib/instance.sh --json
./node_modules/@b00dea/cockpit/bin/cockpit.mjs init . --target <tool> --registry ./env/lib/instance.sh --interactive
```

`init` reads the registry's repositories, marks every value the registry did not state with its
source and the reason it was inferred or defaulted, and asks for the rest, such as
<!-- cockpit:ref schema=ports.bases --> `ports.bases`, which no registry dialect records. A missing
registry file is refused with `REGISTRY_NOT_FOUND`. When `init` finds repositories directly beneath
the cockpit root instead of reading a registry, it records `siblings_root = "."` as an inference for
you to confirm.

### Adopt in layers

Keep each layer's old path until the new one passes:

1. **Registry.** Get the reviewed configuration to validate.
2. **Surfaces.** Run `sync --dry-run`, `sync` and `check`, and read the dry run before every `sync`.
3. **Runtime.** Run `up` and `preflight` against the same configuration.
4. **Guards, grading and more harnesses.** Add them once the earlier layers are stable. The
   [capability matrix](capability-matrix.md) shows each feature's
   [Cockpit harness capability state](concepts.md#cockpit-harness-capability-state); an `instructed`
   feature should not yet replace a legacy control that is enforced.

Two rules matter in the surfaces layer:

- **cockpit never takes over an unmanaged file.** If a file already exists where cockpit wants to
  generate one, `sync` refuses; move it deliberately. The one exception is a team's agent settings
  file, which you can [adopt](#adopt-existing-agent-settings).
  [Cockpit generated ownership](concepts.md#cockpit-generated-ownership) covers only cockpit's own
  output and never permits removing a file cockpit did not write.
- **Secrets after the ignore boundary.** Let `sync` create the ignore boundary before adopting
  environment credentials, then follow
  [Secret sources and environment schemas](environment.md#secret-sources-and-environment-schemas).

### Keep shell scripts on the registry while you migrate

`registry-resolve` validates the shell registry and prints the same rows as data a script can
`source`, so old scripts and cockpit read one checked copy:

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs registry-resolve \
  --registry ./env/lib/instance.sh --siblings-root .. --adoption ./adoption.state > resolved.sh
```

`--adoption` names a five-line file recording how far each layer has moved, in this order, each
`migrated` or `documented-only`, with migrated layers first:

```text
registry=migrated
environment=documented-only
surfaces=documented-only
guards=documented-only
grading=documented-only
```

The output assigns `COCKPIT_REGISTRY_ROWS`, `COCKPIT_SIBLING_PATHS`, `COCKPIT_SIBLING_VARIABLES` and
`COCKPIT_ADOPTION_STATES`, exports one `*_DIR` variable per sibling, and records the registry digest
in `COCKPIT_REGISTRY_SHA256`. `COCKPIT_SOURCE_REVISION` is the cockpit commit that produced the
data; a tarball packed from source has no release commit, so the value is `development` and the
command warns with `COCKPIT_REVISION_UNSTAMPED`. Nothing is printed unless every input passed
validation.

### Adopt existing agent settings

cockpit writes `.claude/settings.json`, `.codex/config.toml` and `.codex/hooks.json` whole, so where
a repository already commits one, a plain `sync` refuses with `SURFACE_STATE_CONFLICT` and names the
command that keeps the team's settings:

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --adopt .claude/settings.json
./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml
```

`--adopt <path>` can be repeated, once per file. It moves the file to `cockpit/adopted/<path>`,
records a <!-- cockpit:ref schema=surfaces.adopted --> `surfaces.adopted` row in cockpit.toml (path,
source, SHA-256 of the moved bytes, date, provenance), and syncs. The file at `<path>` becomes
cockpit's merge of the adopted copy and its own version:

- **Hooks:** the team's hooks are kept beside cockpit's guard hook. `PreToolUse` entries are
  combined; any other hook event both sides define must be identical.
- **Claude permissions:** `allow`, `ask` and `deny` rules are combined. A rule cockpit denies is
  never kept as a team `allow` or `ask`.
- **Every other key** is the team's, unless cockpit writes the same key; then the two values must
  match. Claude Code's `sandbox` is one such key: cockpit writes none, and turning it on is how a
  team protects the [guard files](safety-and-autonomy.md#guard-files-and-the-agent-tool) from
  programs run in the shell.

Commit `cockpit/adopted/` with cockpit.toml. To change the settings, edit the adopted copy, delete
the merged file and run `sync`; `check` reports a hand-edited merged file, or an adopted copy
changed since the last merge, and `sync` refuses the former. The recorded SHA-256 says which bytes
were moved; it is not a lock.

Adoption is refused with `SURFACE_ADOPTION_REFUSED`, naming the key, when the file would switch off
or route around the guard, or carries a setting cockpit declares elsewhere:

- `disableAllHooks`, `permissions.defaultMode = "bypassPermissions"`, or any hook that names a
  `.cockpit/guards/` transport;
- `permissions.additionalDirectories` and `enabledMcpjsonServers` (declare a sibling or approve the
  MCP server instead);
- in `.codex/config.toml`, `mcp_servers` and `features.codex_hooks = false`.

Adoption reads and moves only regular files inside the cockpit root, so it also refuses redirected
ancestors, links, special files and files that change while being read. A refusal is rolled back,
leaving the file in place and cockpit.toml unchanged. If a concurrent replacement prevents a safe
rollback, the refusal names every private recovery path that may still hold the original bytes, with
their SHA-256; keep those paths until the source is restored. Adoption has no dry run or
`--interactive` form, and an agent's guard never treats it as an ordinary command.

`opencode.jsonc` needs no adoption: cockpit writes only its `$schema`, `instructions`, `mcp` and
`permission` keys and keeps the team's others.

### Complete the cutover

Retire the old path only when everything it did passes under cockpit (`check`, `up` and `preflight`
for the same configuration and runtime) and you know how to roll back. Destructive environment
commands, stale-output removal, changes to external services and publication stay explicit human
decisions.

## Add or remove a repository

`sibling add` and `sibling remove` edit the `[[sibling]]` tables of `cockpit.toml` for you. They
append or delete only that table and refuse rather than write anything else. Pick the form for where
the repository is:

```sh
# a directory that already exists under the siblings root (acquire = "none")
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add api --config ./cockpit.toml --purpose "HTTP API for orders"

# a repository that does not exist yet: runs `git init` on an empty or missing path
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add api --config ./cockpit.toml --create --purpose "HTTP API for orders"

# a checkout elsewhere on disk: records its origin so `setup` clones a fresh copy
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add api --config ./cockpit.toml --from ~/code/api --purpose "HTTP API for orders"

# a known remote (acquire = "auto"); also records a remote for an existing acquire = "none" sibling
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add api --config ./cockpit.toml --remote git@example.com:team/api.git --purpose "HTTP API for orders"
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
proposal first and writes it only when asked
([Lifecycle and ownership](environment.md#lifecycle-and-ownership) has the rules):

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add api --config ./cockpit.toml --from ~/code/api \
  --purpose "HTTP API for orders" --instruction-pointer
./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config ./cockpit.toml --json
# after a human approves the exact AGENTS.md block
./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config ./cockpit.toml --write-instruction-pointers
```

The root sibling (`dir = "."`) cannot opt in: its guide is the cockpit guide.

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling remove api --config ./cockpit.toml
```

`remove` drops the table only if nothing refers to the sibling (generated services, vendor
endpoints, mounts, its exported variable, or a declared Compose file using that variable); otherwise
it lists every reference and changes nothing. It never deletes the checkout or a generated file.
After either command, run `cockpit sync --config ./cockpit.toml --dry-run` to see what changes.

While a stack is up or asleep, both commands act at once only on a repository the stack does not use
(`mount = "none"`, named by none of its Compose files); for any other they refuse and ask for
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config ./cockpit.toml` first.
[Change a running stack](environment.md#change-a-running-stack) says which hand edits need `down`
and which need only `sync`.

## Rename a cockpit

`cockpit.name` is part of every identity cockpit records: owner markers in generated files, the
ownership ledger, the Compose project and the stack's saved state. A running stack keeps the name it
started under, and only `down` under that name removes its containers, so take the stack down first:

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config ./cockpit.toml
# edit name under [cockpit] in cockpit.toml, then:
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ./cockpit.toml
./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config ./cockpit.toml
```

`sync` rewrites the generated files and the ledger under the new name and keeps your own text around
cockpit's regions. If you renamed while a stack was recorded, `sync`, `check`, `up` and `down`
refuse with `STACK_RECORDED_UNDER_EARLIER_NAME` and print the earlier name: put it back, run `down`,
then rename again. Never delete or hand-edit cockpit's ownership files to get past a refusal; they
are how `sync` knows which files are its own.

## Run an agent inside the environment

`session` is the everyday command. It runs `up`, holds the stack while your agent runs, and releases
it when the agent exits:

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs session --config ./cockpit.toml -- codex
```

Put the agent command and its arguments after `--`. Use plain `up` only when the stack should
outlive one command. [Release the stack](environment.md#release-the-stack) has the details;
[Work on one service](environment.md#work-on-one-service) and
[Serve a sibling from a worktree](environment.md#serve-a-sibling-from-a-worktree) cover the everyday
verbs.

To remove the stack and its containers, run `down`. It deletes only from a local Docker daemon,
fixed once per run ([Choose the Docker daemon](environment.md#choose-the-docker-daemon)):

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config ./cockpit.toml
```

## Upgrade cockpit

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config ./cockpit.toml --dry-run
./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config ./cockpit.toml
```

Review and commit the regenerated files. [Upgrade cockpit](harness-surfaces.md#upgrade-cockpit) has
the details.

## Install from source

To run an unreleased build, pack the package and install the tarball. That exercises the same files,
lifecycle scripts, dependencies and binary entry point as a registry install; `npm link` does not.

```sh
git clone https://github.com/b0dea/cockpit.git
cd cockpit
npm ci --ignore-scripts
npm run build
COCKPIT_PACKAGE_DIR="$(mktemp -d)"
npm pack --workspace @b00dea/cockpit --pack-destination "$COCKPIT_PACKAGE_DIR"
cd /path/to/your/repository
npm install -D "$COCKPIT_PACKAGE_DIR"/*.tgz
./node_modules/@b00dea/cockpit/bin/cockpit.mjs --help
```

If `npm pack` or `npm install` fails, stop: a command run from the source checkout does not prove
the package works. Keep the tarball while the lockfile resolves cockpit from it.
