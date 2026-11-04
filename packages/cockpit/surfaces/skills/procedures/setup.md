---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Set up and maintain a cockpit

## Running cockpit

- Run every command from the cockpit root, the directory holding `cockpit.toml`, through the
  project-local binary, for example `./node_modules/.bin/cockpit check --config cockpit.toml`.
  `npx --no cockpit <command>` starts the same binary, but the path form still runs where the
  guard cannot prove what npx starts. If the binary is missing, stop and ask the person to install cockpit; a
  runner that downloads a package is never a substitute.
- Take flags from each command's `--help`. With `--json`, read `result`, `diagnostics[].code` and
  `invocation.exitCode`. Every diagnostic names its fix, and
  `./node_modules/@b00dea/cockpit/docs/troubleshooting.md` covers the codes that need more; the
  other user-guide pages cited here sit beside it.
- When the guard asks before a command, the person decides in Claude Code; Codex and OpenCode deny
  instead, so hand the person the exact command to run in a terminal. A refusal that holds every
  tool call (a guard message saying so, `GUARD_AUTHORITY_UNAVAILABLE` or `GUARD_CONFIG_UNSYNCED`)
  follows any edit to `cockpit.toml` or reinstall of cockpit or Node. `GUARD_CONFIG_UNSYNCED` means
  the edit does not widen what agents may do, so run
  `./node_modules/.bin/cockpit sync --config cockpit.toml` yourself where `[autonomy] sync =
  "agent"`; any other hold clears only when a person runs it in a terminal. A refused command is the
  person's to run: never reword, wrap or re-spell it to get past the guard.
- In Codex's sandbox only `check`, `sync --dry-run` and `--help` work. Every other cockpit command
  there cannot read cockpit's state or the Docker socket, so a failure it reports is not evidence:
  ask the person to approve running it outside the sandbox, or to run it in a terminal. Under
  `codex exec`, which cannot ask, a person runs it.
- Ask, never invent. A port, image, command, host, purpose, name, version, role or credential comes
  from a file you read or from the person; with neither, name the gap and ask.

## Bootstrap

`init` reads the repositories, interviews, writes the generated files and checks the environment;
follow what it reports rather than redoing any of that by hand. Rerunning the same command, with
the same root and `--target`, resumes where it stopped; a different target refuses with
`INIT_TARGET_CHANGED`, and a repository or draft that changed underneath it refuses with a code
such as `INIT_STATE_STALE` or `INIT_DRAFT_CHANGED` whose fix says what to restore or redo. Inside an
installed cockpit the guard asks before any `init` that carries `--answers` or an `--accept-` flag.
Until step 7 installs cockpit in the cockpit root, rerun `init` with the same executable that
started it, even where it lives outside this root.

1. **Choose the agent tools.** Ask the person which agent tools the team uses: `claudecode`
   (Claude Code), `codexcli` (Codex CLI), `opencode` (OpenCode), `cursor` (Cursor) or `grokcli`
   (Grok Build). One tool is a complete choice; for several, pass them all, yours first and
   comma-separated (`--target claudecode,opencode`); the list needs at least one of `claudecode`,
   `codexcli` and `opencode`, the tools cockpit can guard. init writes it as `[surfaces] tools`, and
   sync writes instructions, skills and settings for those tools only. Cursor and Grok Build get
   files nobody has tested them loading (see
   `./node_modules/@b00dea/cockpit/docs/capability-matrix.md`), so propose them only when the team
   uses them. Done when you hold the `--target` value.
2. **Preview.** Run `./node_modules/.bin/cockpit init . --target <tool> --json`, adding
   `--registry` only when adopting an existing registry. The preview writes nothing. Read
   `result.stage`, `result.question` and `result.interview.outstanding`: every field the interview
   will ask, each with its `proposals` (each with `provenance.kind` `derived`, `measured` or
   `inferred`, and the file it came from) and `confirmedBy`. Done when you hold
   `result.previewSha256` and the outstanding fields.
3. **Explore, then ask in one small round.** Read the repositories for each outstanding field
   before asking, ask only for what the files and CLI output cannot answer. A field with
   `confirmedBy = "agent"` is yours to accept as read (step 4); present every other proposal with
   its source for confirmation. Always settle these with the person:
   - **The name.** `init` proposes the cockpit root's directory name for `cockpit.name`. It scopes
     the cockpit's Compose projects, state and generated files, so changing it after the first sync
     means following the *Rename a cockpit* section of
     `./node_modules/@b00dea/cockpit/docs/getting-started.md` (`down`, edit the name, `sync`, `check`).
   - **The root placement**, when init runs inside a product repository (a git checkout with a root
     language manifest, Dockerfile or standard Compose file) and the preview carries
     `result.cockpitRoot`: a question, its options and a recommended answer. Relay that question to
     the human, explaining the trade-off in a sentence or two from the root placement choices in
     `./node_modules/@b00dea/cockpit/docs/concepts.md`, and write their answer under the
     `cockpit.root` key: `dedicated` creates a sibling `<repo>-cockpit` directory so generated files
     stay out of the product's history; `in-repo` is the default when accepting without an answer,
     except for a directory name that is not a valid sibling slug, which refuses with
     `INIT_COCKPIT_ROOT_REQUIRED`.
   - **The test gates.** For a runnable product, `init` proposes `testing` stages and gates from the
     test entry points it finds. Confirm which commands prove a change: the targeted gate agents
     iterate with, and the full gate they run before handing back. A new product with no tests needs
     the person to choose its test runner first; adding a test framework to a product repository
     waits for their explicit yes. Answer `testing = "none"` only when they decide there are no
     tests yet; `doctor` then reports `TESTING_GATE_UNDECLARED`.
   - **The non-local hosts** for `guards`: the database and live vendor API hosts of every
     production, staging or shared environment. Env templates give variable names only; each host
     comes from the person.
   Done when every outstanding field has the person's answer, a value they confirmed, or a default
   you chose and will mark.
4. **Write the answers file**, TOML keyed by field. Being told to "use sensible defaults" or
   "proceed without asking" covers interview answers only. Mark every answer you chose yourself in
   the file's `[provenance]` table, for example `"environment.machine" = "agent-default"`: init then
   writes the field under `unconfirmed` in `cockpit.toml` with a comment saying the setup agent
   chose it, and `doctor` reports `DECLARATION_UNCONFIRMED` until a person confirms it. Mark a
   field with `confirmedBy = "agent"` as `"derived"` instead, with no value needed: init answers it
   with what it read, refuses one that differs (`DOCUMENT_CONFIGURATION_ANSWER_NOT_DERIVED`), and
   records the file it came from. An unmarked answer is recorded as the person's. Done when the file holds every answer and marks each one you
   chose.
5. **Accept.** Show the person the answers file and the preview digest, then rerun with
   `--accept-preview <previewSha256> --answers <file>`. The run stops at `configuration.defaults`:
   once the person has read the values the draft in `result.question.document` lists under
   "A person confirms these" (the digest covers only those), rerun adding
   `--accept-defaults` with `result.question.expectedSha256`. Each digest binds consent to the bytes
   the person saw, so take it only from the latest pending run; any other is refused
   (`INIT_PREVIEW_NOT_ACCEPTED`, `INIT_DEFAULTS_NOT_ACCEPTED`). A different value for an answer
   already recorded refuses with `INIT_ANSWER_CONFLICT`; `--reset-answer <field>` previews clearing
   it. A person at a terminal can run `--interactive` instead and type each digest; an agent session
   has no terminal, so there it refuses with `INIT_TERMINAL_REQUIRED`. Done when the run has passed
   `configuration.defaults`.
6. **Work through the expected stops**, rerunning the same accepted command after each:
   - Where a runtime is declared, preflight needs a completed first bring-up, so the run stops with
     `STATE_UNSEEDED` (exit 2, stage `draft-observed`); the diagnostics beside it name every other
     gap found without a running stack. Bring the stack up as step 7 of **Create a local setup**
     describes.
   - Preflight passes only once the cockpit repository is committed and clean, so a new one reports
     `GIT_STATE_UNHEALTHY` with the commands that commit the generated files. A person approves or
     runs the staging and the commit, not you: the guard asks on `git add <paths>`, denies a broad
     `git add -A` that covers a secrets directory, and the first commit stages the guard's own
     files. Show them `git status --short` and hand them that fix to run in a terminal. To read
     Git state in another directory, use `git -C <dir> status` or `cd ./<dir> && <command>`; a bare
     `cd <dir>` is refused.
   Done when the result reports `environment-verified`, or, for a cockpit that declares no runtime,
   reports it with `ENVIRONMENT_NOT_DECLARED` as information and no bring-up.
7. **Clear the readiness gaps.** Every `init` stop, and
   `./node_modules/.bin/cockpit doctor --config cockpit.toml --json`, carries `result.readiness`:
   `gaps` lists each prerequisite a check reported missing, with its `level` (a `required` one is
   refused by the command that needs it), `needs` (why cockpit needs it) and `findings` (the
   diagnostic, its message and its fix); `noFinding` lists the ones no check reported, which is not
   proof, because a check that could not run reports nothing. Take the gaps one at a time, required
   first: say what is missing, why cockpit needs it, and the exact change you propose. Ask before
   touching any product repository; committing, installing cockpit, recording a remote, untracking
   a file or adding a test changes it for everyone who works on it. Where a gap needs judgement
   (which test runner to adopt, whether the existing tests prove anything, where characterization
   tests for untested code should live), propose with what you read and let the person decide.
   - The `cockpit-installed` gap clears first: `init` ran from a temporary copy, so run
     `npm install` in the cockpit root, then ask the person to run
     `./node_modules/.bin/cockpit sync --config cockpit.toml` in a terminal so the guard hook runs
     the installed copy.
   - If anyone will run Codex in this cockpit, a person must trust its guard hook on each machine,
     and again whenever sync changes the hook: Codex silently skips a project hook nobody has
     trusted, so every tool call would run unguarded. An agent cannot give that trust. Ask the
     person to run `codex -C <cockpit root>` in a terminal (not `codex exec`), trust the folder if
     asked, and choose **Trust all and continue** when Codex shows **Hooks need review**. `doctor`
     reports `CODEX_HOOK_UNTRUSTED` until it is done.
   Done when `doctor` reports no required gap and every other gap is cleared or reported.
8. **Offer the product changes, one yes each.** "Use sensible defaults" never extends to writing
   inside a product repository: an **AGENTS.md** pointer, a Compose file, a `package.json`, a
   Dockerfile or a `.env.schema` in a sibling checkout each needs the person's explicit yes to that
   exact change, because it changes the product for everyone who works on it.
   - For a dedicated cockpit, offer an instruction pointer for each product repository. If the
     product has no **AGENTS.md**, show the exact proposed file as a draft; if it has one, show the
     marked block that would be appended without changing the team's text. After approval, set
     `instruction_pointer = true` on that sibling's table in `cockpit.toml`; the guard then holds
     every tool call until a person runs `./node_modules/.bin/cockpit sync --config cockpit.toml` in
     a terminal. Then continue from step 4 of **Add or remove a repository** at its `setup` command. An in-repository cockpit already uses the root guide and must not point it at itself.
   - After accepted initialization, and only with explicit permission to change the product's
     fixtures or auth setup, read `references/test-data-and-personas.md` beside the cockpit-setup
     skill and treat it as a separate product change. Bootstrap does not discover provider
     identities or create browser state.
   - For environment or secret adoption, follow **Secret handling** after sync has established its
     owned ignore boundary.
   Done when each offer is applied or declined.

Report the actual result, every gap still named, and every default you chose, with its field and
value, so the person can confirm or replace each.

## Create a local setup

Use this when a repository has no local setup: it has only ever run in CI, staging or a cluster,
so there is no Dockerfile, Compose file or documented way to start it on a laptop. Cockpit cannot
read a setup that does not exist, and a setup it guessed would look complete while holding
guesses. So derive each value from what the repository shows, record it as inferred, and let the human confirm it.

1. Read what the repository already states, without running or changing anything: the manifests and
   lockfiles for the runtime and entrypoint, CI workflows for the services they start, deployment
   files for the ports and variable names they inject, and the code for its health endpoint.
   The init preview from **Bootstrap** already proposes several of these under `interview.outstanding`; reuse them
   rather than re-deriving. Done when you hold a list of entrypoint and runtime, ports, environment
   variable names, backing services with images, and a health endpoint, each with the file it came from.
2. Record variable names only. Values belong to whoever owns the secret; see **Secret handling**. Done when
   no value from an env file, manifest or workflow appears in your notes or output.
3. Mark every derived value as `inferred` with its source file and the reason you read it from there.
   Show the human the whole list and ask them to confirm or correct it. Done when the human has
   answered for every inferred value; confirm one only on their word.
4. Turn each unknown into a named gap instead of a value: an undecided decision for data, mounts,
   ports and restore, and an explicit vendor posture for every third-party endpoint. Cockpit renders
   a subject with no decision as undecided, which keeps the gap visible. Done when each unknown is
   named with who can resolve it, and nothing in the declaration was filled in to make it load.
   Answer `environment.test_data` with exact booleans for `seeded_data` and `signed_in_users`. A false
   answer is retained as a not-declared decision. A true answer is only a requirement: it remains unresolved
   until product-owned seed operations or browser authentication states are declared, and never proves that
   data or a login exists.
5. Decide where the runnable pieces live. A Dockerfile or Compose file written into a product
   repository is a product change, so ask the human first and show the exact path and contents.
   Without that permission, declare an environment cockpit renders itself and leave the product
   untouched. Done when either the human approved that specific file or no product file was written.
6. Finish the configuration with the init flow in **Bootstrap**. On an existing cockpit, an edit to
   `cockpit.toml` makes the guard hold every tool call, so a person runs
   `./node_modules/.bin/cockpit sync --config cockpit.toml` in a terminal; then run
   `./node_modules/.bin/cockpit check --config cockpit.toml --json`. Done when the check exits 0.
7. Where a runtime is declared, measure it with
   `./node_modules/.bin/cockpit runtime measure --config cockpit.toml --image <local-image>`, using an
   image already on this machine because the probe never pulls; with none, ask the person which to
   use. It measures the local daemon `up` will use (the context `DOCKER_CONTEXT` names, or else the
   active one), can run for minutes without output, records the result for this machine only and
   leaves `cockpit.toml` unchanged, so no `sync` is needed. When Docker is missing or not running,
   it and `up` refuse with `RUNTIME_UNAVAILABLE`: ask the person to start or install it. Then start
   the stack with `./node_modules/.bin/cockpit up --config cockpit.toml`. Report the actual result.
   Done when the stack reports healthy, or you have named what stopped it.

## Secret handling

Keep the tracked product `.env.schema` beside the component that owns it. Store only encrypted
Varlock resolver expressions or external-provider references under
`env/.secrets/<cockpit-project>/<component>`; the generated `env/.secrets/.gitignore` must be current,
the directory mode 0700, and resolver files mode 0600 before use. Ignoring, encryption and redaction
do not prevent same-user code from reading a resolved value. The agent receives schema and redacted
status, never a plaintext source.

Reuse the product's declared command or script. Resolve both paths to absolute paths from their owning
roots so the command is independent of its working directory; repeated Varlock paths are applied in
order, so the later central path takes precedence. For status the locked executable is invoked as
`varlock load --path <absolute-component-schema-root> --path
<absolute-cockpit-root>/env/.secrets/<cockpit-project>/<component> --agent --format json-full
--summary-stderr`. For a trusted product process it is invoked as `varlock run --path
<absolute-component-schema-root> --path <absolute-cockpit-root>/env/.secrets/<cockpit-project>/<component>
--inject vars --redact-stdout -- <exact command>`. The angle brackets describe product-resolved inputs,
not literal commands. Resolve the executable and version
from the product manifest and lock; runtime commands never fetch with `npx`. If the product has not
adopted Varlock, you need explicit permission to change the product before adding and locking it. `varlock init`,
provider login, encryption and secret migration stay with a person; preview their file and
provider scope instead of running them automatically.

Preflight and doctor already check the schema of every sibling that has a `.env.schema`; a failing row
names the keys, and `varlock load` in that sibling shows why.

Treat Varlock output as secret-tainted even in agent mode. Report variable names, validation state,
exit status and provenance only. Never copy raw resolved values, stdout or stderr into work-order
records. Varlock's credential proxy is preview software and same-user code is not confined here;
report secure agent secret use as unavailable unless a sandbox that has been tested proves it.

## Add or remove an agent tool

When the team starts or stops using an agent tool, the `tool` command edits only `[surfaces]
tools` in `cockpit.toml`. The guard asks before every `tool` command, the preview included, and
after the edit it holds every tool call until it is synced. Adding a tool does not widen what
agents may do; removing one deletes that tool's guard, so the hold then names `surfaces.tools`
and waits for a person.

1. Preview with `./node_modules/.bin/cockpit tool add <tool> --config cockpit.toml --dry-run` (or
   `tool remove`) and show the person the list it prints. Done when they agree to that list.
2. Run it without `--dry-run`. Tell the person first that every tool call is held after it. Done
   when the command exits 0.
3. Sync: after `tool add`, run `./node_modules/.bin/cockpit sync --config cockpit.toml` yourself
   where `[autonomy] sync = "agent"`; after `tool remove`, the person runs it in a terminal. An added
   tool's files are written from the same sources as the others, and a removed tool's files are
   deleted as `[autonomy] stale_delete` allows. When sync refuses with
   `GENERATED_STALE_APPROVAL_REQUIRED`, they rerun it with `--interactive` and type the
   stale-removal digest it shows. Done when
   `./node_modules/.bin/cockpit check --config cockpit.toml --json` exits 0.

## Add or remove a repository

Use this on an installed cockpit when a product gains or drops a repository. The `sibling`
command edits `cockpit.toml` so the repository is declared once, with its purpose, instead of
reached by path. The guard asks before every `sibling` command, and because the command writes
`cockpit.toml` immediately, the guard then holds every tool call until it is synced.

1. **Propose the declaration.** Read the repository and ask the person for its purpose when no
   source states it. Show the human the proposed sibling declaration before invoking the command:
   slug, purpose, source mode, directory and exported variable. Done when the person approves it.
2. **Run the form that matches where the repository is.** Tell the person first that every tool
   call is held after it. For a checkout already on disk, which must have an `origin` remote, run
   `./node_modules/.bin/cockpit sibling add billing --config cockpit.toml --from ../billing --purpose "<purpose>" --json`;
   for a new one run
   `./node_modules/.bin/cockpit sibling add billing --config cockpit.toml --create --purpose "<purpose>" --json`
   and hand the person `result.publish.command`, which creates the hosted repository; for a known
   remote run
   `./node_modules/.bin/cockpit sibling add billing --config cockpit.toml --remote <url> --purpose "<purpose>" --json`.
   To drop one, run `./node_modules/.bin/cockpit sibling remove billing --config cockpit.toml --json`,
   which refuses and lists every reference while anything still uses the repository, and never
   deletes the checkout. The command writes cockpit.toml immediately; `--json` changes only its
   output format, so it is neither a preview nor an acceptance gate. While the stack is up, a
   repository the stack uses is refused until a person runs
   `./node_modules/.bin/cockpit down --config cockpit.toml`. Done when the command exits 0.
3. **Sync.** When the hold says the edit does not widen what agents may do, as adding a
   repository inside the siblings root does, run
   `./node_modules/.bin/cockpit sync --config cockpit.toml` yourself where `[autonomy] sync =
   "agent"`. When it names the fields that widen, as removing one does, a person runs it in a
   terminal. Then run
   `./node_modules/.bin/cockpit check --config cockpit.toml --json`. Done when the check exits 0.
4. **Instruction pointer, only on request.** When the person wants the repository's **AGENTS.md**
   to link to the cockpit instructions, add `--instruction-pointer` to the step 2 command; it opts
   the sibling in and writes nothing there. A sibling already declared is opted in by setting
   `instruction_pointer = true` on its table instead, followed by a person's sync. Then run
   `./node_modules/.bin/cockpit setup --config cockpit.toml --json`; it reports the proposed
   **AGENTS.md** path (`SETUP_INSTRUCTION_POINTER_OFFERED`) without writing it. If the guide is missing, show the exact new-file draft;
   otherwise show the appended block and the preserved team text. After approval, run
   `./node_modules/.bin/cockpit setup --config cockpit.toml --write-instruction-pointers`, which
   writes only the marked block and refuses an edited, partial or duplicated existing one
   (`SETUP_INSTRUCTION_POINTER_INVALID`). Done when the block is written or the person declined it.
5. Run `./node_modules/.bin/cockpit doctor --config cockpit.toml --json` and clear any
   `sibling-instructions` gap for the new repository as **Make a repository's instructions reach
   every tool** describes. Done when `doctor` reports no gap for it.

## Make a repository's instructions reach every tool

Each product repository's own instructions must reach every agent tool, not only the one its team
uses: Codex and OpenCode load **AGENTS.md** and Claude Code loads **CLAUDE.md**, so the shared text
belongs in AGENTS.md and CLAUDE.md starts with a line reading `@AGENTS.md`. The
`sibling-instructions` readiness gap names each repository laid out otherwise.

1. Run `./node_modules/.bin/cockpit setup --config cockpit.toml --json`. It reports
   `SETUP_INSTRUCTION_FILES_OFFERED` for the two changes that need no judgement: a CLAUDE.md
   importing an existing AGENTS.md, or a lone CLAUDE.md moved byte for byte into AGENTS.md. Done
   when you know which repositories it offers and which need a proposal of yours.
2. Propose the files, read first. Before proposing a move, read the CLAUDE.md: lines only Claude
   Code can act on (Claude Code commands, settings or tool names) go back into CLAUDE.md under the
   `@AGENTS.md` line once moved, so show the person those lines and where each would go. When both
   files exist without the import, read both and propose one AGENTS.md holding everything every
   tool needs and a CLAUDE.md of `@AGENTS.md` plus Claude-only lines. When neither exists, or the
   instructions sit in files such as **.cursorrules** or **GEMINI.md**, draft the AGENTS.md from
   what you read. Done when the person has seen the exact text of every file.
3. After their yes to that exact text, run
   `./node_modules/.bin/cockpit setup --config cockpit.toml --write-instruction-files` for the
   offered changes, and edit the others by hand. A team's instruction file stays on disk: removing
   one is the person's call. Done when `doctor` reports no `sibling-instructions` gap for the
   repository.

## After upgrading cockpit

An upgrade changes the generated files that guard and instruct every agent, so it is reviewed,
never applied silently. Installing a new cockpit also makes the guard hold every tool call until
`sync` regenerates it for the new version.

1. **Upgrade in one command where you may.**
   `./node_modules/.bin/cockpit upgrade --config cockpit.toml --dry-run` resolves the target and
   prints the commands; show them to the person. `./node_modules/.bin/cockpit upgrade --config cockpit.toml`
   (or `upgrade <version>`) then installs that exact release with the package manager the lockfile
   names, runs `sync` in a new process, and prints the `Upgrade:` lines. An agent may run it where
   `[autonomy] sync = "agent"`, the default; otherwise the guard asks, and the person runs it. When
   its sync fails (`UPGRADE_SYNC_FAILED`, for example on stale removals that need approval), the new
   version is already installed and the guard holds every tool call: a person acts on what sync
   reported and runs `./node_modules/.bin/cockpit sync --config cockpit.toml --interactive` in a
   terminal. Done when the command exits 0 and its sync wrote the new files.
2. **Or by hand.** `npm update` does not move the exact pin, so install the reviewed release by
   version: `npm install --save-dev --save-exact @b00dea/cockpit@<version>`, and confirm the manifest
   and lockfile show that exact version. From then on the guard holds every tool call, so a person
   runs `./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run` and then
   `./node_modules/.bin/cockpit sync --config cockpit.toml --interactive` in a terminal. Done when
   that sync exits 0.
3. **Review the diff.** A hand edit to a skill, agent settings file or cockpit-owned region stops
   sync with `SURFACE_STATE_CONFLICT`: move that change into a `[surfaces].overlays` entry instead of
   editing the generated file. An upgrade that changes something you overrode reports
   `OVERRIDDEN_CORE_CHANGED`: review the new built-in against your override before updating its
   recorded hash. Done when every changed file is accounted for.
4. **Do what sync does not.** Read the newly installed `./node_modules/@b00dea/cockpit/CHANGELOG.md`
   between the old and new version for lines starting `Upgrade:`; each names a step that sync alone
   does not do. Done when every `Upgrade:` line has been done or reported to the person.
5. **Commit together.** Ask the person to commit the lockfile and the regenerated files together.
   Done when `./node_modules/.bin/cockpit check --config cockpit.toml --json` exits 0.

## Diagnose

1. Run `./node_modules/.bin/cockpit doctor --config cockpit.toml --json` first: it reports health,
   wiring and `result.readiness` without repairing anything. Use
   `./node_modules/.bin/cockpit preflight --config cockpit.toml --json` when the environment must
   pass the blocking gate.
2. Follow the fix each diagnostic names, required gaps first. When the fix is a person's step
   (trusting a Codex hook, signing in to a provider, approving a digest), hand them the exact
   command it names. Done when `doctor` reports each gap cleared, or you have reported the ones
   only a person can clear.

For an account of the result without changing anything, use the cockpit-explain skill.

## On drift

`check` reports drift as `GENERATED_ARTIFACT_DRIFT`, and the session-start hook prints the same
report before you work. Act on the fix it names:

1. **A sibling guide's copy is stale** (the message names the guide). Run
   `./node_modules/.bin/cockpit sync --config cockpit.toml`, review the regenerated `AGENTS.md`, and
   commit it together with the guide change. Under `[autonomy] sync = "person"` or `"ci"` the guard
   stops that sync: ask the person to run it.
2. **A generated file was edited by hand** (`SURFACE_STATE_CONFLICT`). Move the change into
   `cockpit.toml` or a `[surfaces].overlays` entry, then sync. Editing the generated file again only
   moves the drift.
3. **A formerly generated file is still on disk.** If the fix says to run `sync`, `[autonomy]
   stale_delete` lets it remove the file: run it and review what it removed. If the fix asks a
   person to approve a digest, stop and ask them.

Done when `./node_modules/.bin/cockpit check --config cockpit.toml --json` exits 0.
