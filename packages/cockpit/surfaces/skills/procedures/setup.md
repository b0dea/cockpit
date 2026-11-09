---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Set up and maintain a cockpit

## Running cockpit

- Run every command from the cockpit root, the directory holding `cockpit.toml`, through the
  installed package entrypoint, for example `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml`.
  This path resolves to the installed package even when pnpm writes a shell shim in `node_modules/.bin`.
  `npx --no cockpit <command>` and the `.bin` launcher count only where the guard can prove they
  start that same package. If the entrypoint is missing, stop and ask the person to install cockpit;
  a runner that downloads a package is never a substitute.
- Take flags from each command's `--help`. With `--json`, read `result`, `diagnostics[].code`,
  `guidance[]` and `invocation.exitCode`. A diagnostic's remedy is the `guidance` entry with its
  `code` and `target`; `diagnostics[].fix` appears only for a command safe to run as printed, and
  `./node_modules/@b00dea/cockpit/docs/troubleshooting.md` covers the codes that need more; the
  other user-guide pages cited here sit beside it.
- When the guard asks before a command, the person decides in Claude Code; Codex and OpenCode deny
  instead, so hand the person the exact command to run in a terminal. A refusal that holds every
  guarded tool call (a guard message saying so, `GUARD_AUTHORITY_UNAVAILABLE` or `GUARD_CONFIG_UNSYNCED`)
  follows a reinstall of cockpit or Node, or an edit to `cockpit.toml` the guard cannot build a policy
  from, and clears only when a person acts on its fix in a terminal. Any other edit to `cockpit.toml`
  holds nothing. One that does not widen what agents may do is judged as written, so run
  `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml` yourself where `[autonomy] sync =
  "agent"`; one that widens is judged under the configuration last synced, and each refusal says so,
  until a person runs that sync with `--interactive` in a terminal. When the guard refuses a
  command, read the reason. To read a file, use your tool's own file reading instead of the shell. A
  refusal for secrets, writes outside the cockpit, protected branches, declared hosts or the guard
  itself is the person's: hand them the exact command and why. Do not reword, wrap or re-spell a
  command to get past the guard. If the refused command could not touch any of those, report it as a
  cockpit gap (the command, the reason text, why it is harmless) and continue with other work rather
  than asking the person to run it.
- In Codex's sandbox `check`, `sync --dry-run` and `--help` work as it stands, unless `[browser]` is
  declared, which makes the first two read cockpit's state too. Other cockpit commands need what the
  sandbox withholds: write access to the state root, which `STATE_ROOT_UNAVAILABLE` names and a person
  can grant on that directory alone, or on its nearest existing parent before it exists; the Docker
  socket; and on macOS `/bin/ps`. First inspect the named failure and request only the missing
  access through the native approval mechanism. Prepare the concrete command and reason before
  asking; preserve existing grants. Under `codex exec`, which cannot ask, hand that command to the
  person. A sandbox refusal does not establish product failure.
- Ask, never invent. A port, image, command, host, purpose, name, version, role or credential comes
  from a file you read or from the person; with neither, name the gap and ask.

## Continue authorized setup

An adoption request authorizes routine discovery, previews and checks within the agreed roots.
Run those steps yourself and continue after each successful check. Before asking for a decision,
prepare the file delta, proposed values with their sources, and the authority change they need.
Group unresolved choices into one review; retain the person's earlier decisions when their exact
subjects are unchanged. An answers file still cannot attest that a person made a trust decision.

- **Existing configuration or a teammate's clone:** start with `check` and `doctor`, then use
  `setup` for the declared checkouts. Reuse the repository's decisions; resolve only local paths,
  credentials and native trust. Do not restart the architecture interview.
- **Interrupted initialization:** inspect the current `init` preview and readiness, preserve
  generated files and recorded answers, then resume the same root and targets. Verify effects on
  disk before retrying a write. Reuse an already authorized current digest; review a changed preview
  before accepting it. Later authenticated draft stages resume without a second preview approval.
- **Existing instructions or guards:** inventory them before generating surfaces. Keep the team's text,
  hooks and scripts; use the documented adoption or overlay flow for conflicts. Do not remove an
  old guard until equivalent protection has been measured.
- **Before activating hooks:** prepare the project-local launcher, required state-directory access
  and the next verification commands. Show any missing grants together with the proposed file and
  permission delta. A denied command follows **Running cockpit**; never disable the guard to finish.

Done when routine work has run and the remaining list contains only concrete unresolved decisions,
native trust/authentication steps, failed checks or maintainer gaps, each with its evidence.

## Bootstrap

`init` reads the repositories, interviews, writes the generated files and checks the environment;
follow what it reports rather than redoing any of that by hand. Rerunning the same command, with
the same root and `--target`, resumes where it stopped; a different target refuses with
`INIT_TARGET_CHANGED`, and a repository or draft that changed underneath it refuses with a code
such as `INIT_STATE_STALE` or `INIT_DRAFT_CHANGED` whose fix says what to restore or redo. Inside an
installed cockpit the guard asks before any `init` that carries `--answers` or an `--accept-` flag.
If cockpit is not installed in the cockpit root yet, rerun `init` with the executable that started
it until the `cockpit-installed` gap is cleared; use it only where existing permissions allow.

1. **Choose the agent tools.** Ask the person which agent tools the team uses: `claudecode`
   (Claude Code), `codexcli` (Codex CLI), `opencode` (OpenCode), `cursor` (Cursor) or `grokcli`
   (Grok Build). One tool is a complete choice; for several, pass them all, yours first and
   comma-separated (`--target claudecode,opencode`); the list needs at least one of `claudecode`,
   `codexcli` and `opencode`, the tools cockpit can guard. init writes it as `[surfaces] tools`, and
   sync writes instructions, skills and settings for those tools only. Cursor and Grok Build get
   files nobody has tested them loading (see
   `./node_modules/@b00dea/cockpit/docs/capability-matrix.md`), so propose them only when the team
   uses them. Done when you hold the `--target` value.
2. **Preview.** Run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs init . --target <tool> --json`, adding
   `--registry` only when adopting an existing registry. The preview writes nothing. Read
   `result.interview.outstanding`: every field the interview will ask, each with its `proposals`
   (each with `provenance.kind` `derived`, `measured` or `inferred`, and the file it came from) and
   `confirmedBy`. Read `result.writes`: every path, relative to the cockpit root, that init creates
   or changes once the preview is accepted, beside the setup skill in `result.files`; a path ending
   in `/` stands for files under it. In a product repository these include its **AGENTS.md**,
   **package.json** and **.gitignore**; existing team text stays outside the regions cockpit writes.
   No question is asked before acceptance: the first, `result.question`, comes with the accepted
   run. Done when you hold `result.previewSha256`, the outstanding fields and the writes.
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
     `INIT_COCKPIT_ROOT_REQUIRED`. The preview's outstanding fields are for `in-repo`; `dedicated`
     changes the proposed name and sibling, which the accepted run reports.
   - **The test gates.** For a runnable product, `init` proposes `testing` stages and gates from the
     test entry points it finds. Whether each proves anything is your judgement, made on evidence:
     name the behaviours its tests exercise, break one of them on purpose, run the proposed command
     and see it go red, then restore the file so the checkout is as you found it. That edit needs no
     yes, because it is undone within the step. Write the behaviours into the gate's `changes` text
     and keep the red run's output for your report; a gate that stays green on the break proves
     nothing about that behaviour, so say so. The person confirms which gate agents iterate with and
     which they run before handing back. A new product with no tests needs the person to choose its
     test runner first; adopting a test framework in a product repository waits for their explicit
     yes. Answer `testing = "none"` only when they decide there are no tests yet; `doctor` then
     reports `TESTING_GATE_UNDECLARED`.
   - **The non-local hosts** for `guards`: the database and live vendor API hosts of every
     production, staging or shared environment. Env templates give variable names only; each host
     comes from the person.
   - **How grading runs** for `work.grading`. Offer the person the choices in the *How grading can run*
     section of `./node_modules/@b00dea/cockpit/docs/work-and-browser.md`, with init's proposal and
     its reason: `independent` with two or more listed tools on `PATH`, so each grades the other's
     work; `independent` as a separate run with one, with a warning where the running tool is detected;
     `checks` with none. The grader is optional: `off` is reasonable when tracking matters but grading
     is not wanted. A tool without subagents, or a sandbox that blocks a nested CLI, changes the
     path and not the rule: list another tool, or let the person choose `checks`, `self` or `off`,
     and never pick something weaker yourself without marking it.
   - **How much the agent decides.** Offer the person the three columns of the table in *Who
     decides* in `./node_modules/@b00dea/cockpit/docs/safety-and-autonomy.md`: the shipped defaults,
     a stricter setting, or the *Fully agentic setup*, which hands every process gate to the agent and
     keeps every guardrail. The `[autonomy]` and `[work.gates]` fields are theirs to write: never
     write or loosen one yourself.
   - **Environment access.** Inspect filenames and declared scripts without opening plaintext
     dotenv or credential files. If a repository has dotenv files or templates, follow **Secret
     handling** even when `.env.schema` is absent. Reuse an existing Varlock setup; otherwise
     recommend adopting it and record the decision, scope and any deferred migration in the work
     log. Existing explicit authorization to adopt Varlock covers its reviewed dependency, schema
     and command changes; ask only for missing scope or provider access.
   Done when every outstanding field has the person's answer, a value they confirmed, or a default
   you chose and will mark.
4. **Write the answers file**, TOML keyed by field. Being told to "use sensible defaults" or
   "proceed without asking" covers interview answers only. Mark every answer you chose yourself in
   the file's `[provenance]` table, for example `"environment.machine" = "agent-default"`: init then
   writes the field under `unconfirmed` in `cockpit.toml` with a comment saying the setup agent
   chose it, and `doctor` reports `DECLARATION_UNCONFIRMED` until it is confirmed (step 7). Mark a
   field with `confirmedBy = "agent"` as `"derived"` instead, with no value needed: init answers it
   with what it read, refuses one that differs (`DOCUMENT_CONFIGURATION_ANSWER_NOT_DERIVED`), and
   records the file it came from. An unmarked answer is recorded as the person's, except a trust
   decision (`sibling`, `environment.install_policies`, `environment.posture`, `testing`, `guards`,
   `work.grading`): the file cannot show a person made it, so init writes it under `unconfirmed`
   whatever the file says, and the stronger default holds until a person confirms it (step 7).
   Done when the file holds every answer and marks each one you chose.
5. **Accept.** Show the person the answers file, the preview's `writes` and its digest: accepting
   it authorizes init to write those paths. Then rerun with
   `--accept-preview <previewSha256> --answers <file>`. A run stops at the first field the file
   leaves out, with `result.interview.outstanding` listing only what the file still lacks; add those
   and rerun. Otherwise it stops at `configuration.defaults`:
   once the person has read the values the draft in `result.question.document` lists under
   "A person confirms these" (the digest covers only those), rerun adding
   `--accept-defaults` with `result.question.expectedSha256`. Each digest binds consent to the bytes
   the person saw, so take it only from the latest pending run; any other is refused
   (`INIT_PREVIEW_NOT_ACCEPTED`, `INIT_DEFAULTS_NOT_ACCEPTED`). A different value for an answer
   already recorded refuses with `INIT_ANSWER_CONFLICT`; `--reset-answer <field>` previews clearing
   it. A person at a terminal can run `--interactive` instead and confirm the displayed preview and defaults; an agent session
   has no terminal, so there it refuses with `INIT_TERMINAL_REQUIRED`. Done when the run has passed
   `configuration.defaults`.
6. **Work through the expected stops**, rerunning the same accepted command after each:
   - Where a runtime is declared, preflight needs a completed first bring-up, so the run stops with
     `STATE_UNSEEDED` (exit 2, stage `draft-observed`); the diagnostics beside it name every other
     gap found without a running stack. Bring the stack up as step 7 of **Create a local setup**
     describes.
   - Preflight passes only once the cockpit repository is committed and clean, so a new one reports
     `GIT_STATE_UNHEALTHY`, whose guidance is to review `git status --short` and commit; a cockpit
     that declares no runtime reaches `surfaces-verified` without it, and `doctor` reports it as the
     required `cockpit-committed` gap. A person approves or
     runs the staging and the commit, not you: the guard asks on `git add <paths>`, denies a broad
     `git add -A` that covers a secrets directory, and the first commit stages the guard's own
     files. Show them `git status --short` and hand them that fix to run in a terminal. To read
     Git state in another directory, use `git -C <dir> status` or `cd ./<dir> && <command>`; a bare
     `cd <dir>` is refused.
   Done when the result reports `environment-verified`, or, for a cockpit that declares no runtime,
   reports `surfaces-verified` with `ENVIRONMENT_NOT_DECLARED` as information and no bring-up. That
   stage verifies the surfaces only: step 7's `doctor` is what reports its env schemas.
7. **Clear the readiness gaps.** Every `init` stop, and
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config cockpit.toml --json`, carries `result.readiness`:
   `gaps` lists each prerequisite a check reported missing, with its `level` (a `required` one is
   refused by the command that needs it), `needs` (why cockpit needs it) and `findings` (the
   diagnostic, its message and its fix); `noFinding` lists the ones no check reported, which is not
   proof, because a check that could not run reports nothing. Prepare the required gaps first,
   execute fixes covered by existing authority, and collect the remaining decisions in one review:
   say what is missing, why cockpit needs it, and the exact change you propose. A change to a
   product repository follows step 8: committing, installing cockpit, recording a remote, untracking
   a file or adding a test changes it for everyone who works on it. Whether the existing tests prove
   anything is yours to judge, as step 3 describes; where a gap needs the person's judgement (which
   test runner to adopt, where characterization tests for untested code should live), propose with
   what you read and let them decide.
   - If `cockpit-installed` is reported, clear it first using the repository's package manager
     and reviewed manifest/lockfile delta within the authorized installation scope. An existing
     project-local installation needs no reinstall. Then run
     `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml` where the current guard and policy
     permit it; hand it to the person only when the refusal requires their terminal. Done when
     `doctor` no longer reports the installation gap.
   - If anyone will run Codex in this cockpit, a person must trust its guard hook on each machine,
     and again whenever sync changes the hook: Codex silently skips a project hook nobody has
     trusted, so every tool call would run unguarded. An agent cannot give that trust. Ask the
     person to run `codex -C <cockpit root>` in a terminal (not `codex exec`), trust the folder if
     asked, and choose **Trust all and continue** when Codex shows **Hooks need review**. `doctor`
     reports `CODEX_HOOK_UNTRUSTED` until it is done.
   - `DECLARATION_UNCONFIRMED` lists the answers no person stated. Of `ports.bases` (with the stack
     up), `environment.compose_files` and `environment.machine`, confirm by observation, one at a
     time, each that `unconfirmed` lists; a derived answer is never listed and needs no confirming:
     `./node_modules/@b00dea/cockpit/bin/cockpit.mjs confirm ports.bases --config cockpit.toml --json` runs the
     observation that verifies the answer and, when it passes, removes the entry and records what
     ran. Then run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml` where `[autonomy] sync =
     "agent"`, or hand it to the person, before confirming the next one. A refusal
     (`CONFIRM_OBSERVATION_FAILED`) names what the observation saw: fix that, or the value, and
     confirm again. Never delete an `unconfirmed` entry by hand: `CONFIRM_PERSON_REQUIRED` marks the
     answers only a person confirms (the trust decisions, `work.grading` among them, `cockpit.name`,
     `estate.runnable`, `environment.test_data`), so list them in your report with their values and
     prepare one review of the outstanding trust entries and their consequences. After accepting
     those exact values, the person removes those entries together with their `# Unconfirmed`
     comments, then runs
     `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --interactive` in a terminal outside the
     agent. Sync lists the files it wrote; the person commits them with `cockpit.toml`, together with
     `.cockpit/policy.json` if an earlier sync wrote it and it is still uncommitted. Until then grading runs as `independent` and the guard admits no install policy's commands.
     Where `[autonomy] confirm_answers = "agent"`, confirm `cockpit.name`, `estate.runnable` and
     `environment.test_data` yourself instead, as in
     `./node_modules/@b00dea/cockpit/bin/cockpit.mjs confirm cockpit.name --config cockpit.toml --json`; the record says
     you decided them.
   Done when `doctor` reports no required gap and every other gap is cleared or reported. Report
   four things separately, because none implies another: **configuration generated** (`check`
   passes), **machine ready** (`doctor`, run where it can read this machine, has no required gap),
   **native trust ready** (`CODEX_HOOK_UNTRUSTED` and `CODEX_HOOK_SOURCE_MISMATCH` are clear;
   enforcement still needs a paired native probe) and **integrations proven
   live** (the stack or provider was actually exercised, which no passing check shows).
   Cockpit is usable once `check` passes. `selftest` is an optional native-evidence step a person
   runs at their terminal with one command,
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --config cockpit.toml --interactive`,
   which only they can approve. Never hold adoption for it, and do not ask the person to run it
   unless they ask for native evidence.
8. **Put product changes where the person reviews them.** A Dockerfile, Compose file or
   `.env.schema` the product needs goes on a new branch in that sibling's checkout: start the branch
   only when `git -C <sibling> status --short` prints nothing, write the files there, and put their
   diff against the starting branch in your report. Nothing is pushed, so the person reviews it
   before it reaches anyone else. Creating a hosted repository or a remote waits for their yes. Every
   other product change (an **AGENTS.md** pointer, a `package.json`, a new test framework) needs
   explicit product-change authorization covering its reviewed scope. Reuse that authorization
   when already given; ask for uncovered changes. Choosing interview defaults alone does not
   authorize product changes.
   - For a dedicated cockpit, offer an instruction pointer for each product repository. If the
     product has no **AGENTS.md**, show the exact proposed file as a draft; if it has one, show the
     marked block that would be appended without changing the team's text. After approval, set
     `instruction_pointer = true` on that sibling's table in `cockpit.toml`; the guard then holds
     every guarded call until a person runs `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml` in
     a terminal. Then continue from step 4 of **Add or remove a repository** at its `setup` command. An in-repository cockpit already uses the root guide and must not point it at itself.
   - After accepted initialization, and only with explicit permission to change the product's
     fixtures or auth setup, read `references/test-data-and-personas.md` beside the cockpit-setup
     skill and treat it as a separate product change. Bootstrap does not discover provider
     identities or create browser state.
   - For environment or secret adoption, follow **Secret handling** after sync has established its
     owned ignore boundary.
   Done when each product file is on its branch with its diff in your report, and each other offer
   is applied or declined.

Report the actual result; every gap still named; every default you chose, with its field and
value, so the person can confirm or replace each; your judgement of each test gate, with its red run;
and the diff of every product branch.

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
5. Decide where the runnable pieces live. A Dockerfile or Compose file in the product is a product
   change: write it on a branch in that repository's checkout, as step 8 of **Bootstrap** describes.
   A `compose.yml` at the cockpit root that reaches the checkout through its sibling variable leaves
   the product untouched. Done when each product file is on its branch with its diff in your report,
   or no product file was written.
6. Finish the configuration with the init flow in **Bootstrap**. On an existing cockpit, the guard
   judges calls under an edit to `cockpit.toml` that does not widen what agents may do, so run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml` yourself where `[autonomy] sync =
   "agent"`. While an edit widens it, calls are judged under the configuration last synced, every
   refusal names the widened fields, and a person runs that sync with `--interactive` in a terminal
   and confirms the change. Then run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml --json`. Done when the check exits 0.
7. Where a runtime is declared, measure it with
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs runtime measure --config cockpit.toml --image <local-image>`, using an
   image already on this machine because the probe never pulls; with none, ask the person which to
   use. It measures the local daemon `up` will use (the context `DOCKER_CONTEXT` names, or else the
   active one), can run for minutes without output, records the result for this machine only and
   leaves `cockpit.toml` unchanged, so no `sync` is needed. When Docker is missing or not running,
   it and `up` refuse with `RUNTIME_UNAVAILABLE`: ask the person to start or install it. Then start
   the stack with `./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config cockpit.toml`. Report the actual result.
   Done when the stack reports healthy, or you have named what stopped it.

## Secret handling

During adoption, inspect environment filenames and manifest commands before choosing a secret-access
path. A missing `.env.schema` is a decision to resolve, not a reason to skip this section. Recommend
Varlock when plaintext dotenv files or templates exist; record adoption or the reason it is deferred.
Read variable names with `./node_modules/@b00dea/cockpit/bin/cockpit.mjs env keys --config cockpit.toml`, never resolve values into
the agent's context. When you need a schema's text, use a reference printed by `env keys` and run
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs env schema --config cockpit.toml --path <reference>` (or name the
schema's directory: `<slug>:<dir>`, `<slug>:` or `.`, which agent secret guards that refuse any
command containing `.env` let through); a schema must
hold no secret values. Native rules may refuse direct reads of these files, so do not work around a
refusal. To change a schema, write a draft with your normal tools, as a plain file away from
environment files and secrets, then run
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs env schema --config cockpit.toml --path <reference> --replace-from <draft>`
on its own. Claude Code's native rules refuse Edit and Write of this name (measured on 2.1.318 on
2026-11-05). The result is not validated until it is committed, and `ENV_SCHEMA_UNCOMMITTED` says so;
committing is the guarded checkpoint. A person's terminal has no such limit.

Keep the tracked product `.env.schema` beside the component that owns it. Store only encrypted
Varlock resolver expressions or external-provider references under
`env/.secrets/<cockpit-project>/<component>`; the generated ignore block in the cockpit's `.gitignore`
must be current, the directory mode 0700, and resolver files mode 0600 before use. Ignoring, encryption and redaction
do not prevent same-user code from reading a resolved value. The agent receives schema and redacted
status, never a plaintext source. `./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config cockpit.toml` and `preflight` run `varlock load`, which runs a
schema's resolvers, including an `exec()` command, with the caller's environment, and the guard does
not deny editing a schema. Declared testing commands also run edited code, and cockpit is not a
sandbox. Tell the person to review schema changes as they review code, and to run `doctor` with a
provider sign-in only on schemas they trust. This was reasoned from Varlock's documented resolver
behaviour plus a failing `exec()` measured with a synthetic schema.

Reuse the product's declared command or script. Resolve both paths to absolute paths from their owning
roots so the command is independent of its working directory; repeated Varlock paths are applied in
order, so the later central path takes precedence. For status the locked executable is invoked as
`varlock load --path <absolute-component-schema-root> --path
<absolute-cockpit-root>/env/.secrets/<cockpit-project>/<component> --agent --format json-full
--summary-stderr`. For a trusted product process it is invoked as `varlock run --path
<absolute-component-schema-root> --path <absolute-cockpit-root>/env/.secrets/<cockpit-project>/<component>
--inject vars --redact-stdout -- <exact command>`, inside the declared command whose output is piped:
Varlock refuses that flag on an interactive terminal, so a person in a terminal runs the same `run`
without it. The angle brackets describe product-resolved inputs, not literal commands. Resolve the executable and version
from the product manifest and lock; runtime commands never fetch with `npx`. If the product has not
adopted Varlock, adding and locking it needs product-change authorization; reuse explicit authorization
already given for this adoption rather than asking again. `varlock init`,
provider login, encryption and secret migration stay with a person; preview their file and
provider scope instead of running them automatically. Warn them that Varlock evaluates env files, so
a copied value holding `$(...)` runs a command on load, even in double quotes: they single-quote each
migrated value, as `./node_modules/@b00dea/cockpit/docs/environment.md` describes.

Set `VARLOCK_TELEMETRY_DISABLED=true` in each declared Varlock command's environment, including
status and trusted product processes. Cockpit sets it for its own schema probes. This disables
Varlock telemetry without changing the person's global configuration; output redaction is a
separate setting and remains required in every command an agent runs.

Preflight and doctor already check every committed `.env.schema` a sibling tracks, a sibling's root
schema and the cockpit root's own, with the central path when it exists; a failing or unavailable row names the
keys. An unavailable row can mean a secret provider is signed out or unreachable: a person signs in
and reruns. To diagnose, a person runs `VARLOCK_TELEMETRY_DISABLED=true varlock load --path
<schema-directory> --path <central-directory>`. Agents use cockpit preflight for key-only status, or
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config cockpit.toml` on a cockpit that declares no runtime, where preflight refuses; raw Varlock output is
not safe to read.

Treat Varlock output as secret-tainted even in agent mode: `--redact-stdout` does not cover Varlock's
own errors, which can print source lines and a failing resolver's command and stderr. Keep raw
diagnostics with the person and use cockpit's schema probes for failures you see. Report variable names, validation state,
exit status and provenance only. Never copy raw resolved values, stdout or stderr into work-order
records. Varlock's credential proxy is preview software and same-user code is not confined here;
report secure agent secret use as unavailable unless a sandbox that has been tested proves it.

## Add or remove an agent tool

When the team starts or stops using an agent tool, the `tool` command edits only `[surfaces]
tools` in `cockpit.toml`. Adding a tool does not widen what agents may do, so you may run `tool add`,
and the guard judges calls under the edit; removing one deletes that tool's guard, so the guard asks
before `tool remove`, and until a person syncs, calls are judged under the configuration last synced
and every refusal names `surfaces.tools`.

1. Preview with `./node_modules/@b00dea/cockpit/bin/cockpit.mjs tool add <tool> --config cockpit.toml --dry-run` (or
   `tool remove`) and show the person the list it prints. Done when they agree to that list.
2. Run it without `--dry-run`. Before `tool remove`, tell the person it waits for their sync. Done
   when the command exits 0.
3. Sync: after `tool add`, run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml` yourself
   where `[autonomy] sync = "agent"`; after `tool remove`, the person runs it with `--interactive` in a
   terminal and confirms the change. An added
   tool's files are written from the same sources as the others, and a removed tool's files are
   deleted as `[autonomy] stale_delete` allows. When sync refuses with
   `GENERATED_STALE_APPROVAL_REQUIRED`, they rerun it with `--interactive` in a terminal and
   confirm the stale-file removals it shows with `yes`. Done when
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml --json` exits 0.

## Add or remove a repository

Use this on an installed cockpit when a product gains or drops a repository. The `sibling`
command edits `cockpit.toml` so the repository is declared once, with its purpose, instead of
reached by path. The guard asks before every `sibling` command, and because the command writes
`cockpit.toml` immediately, the guard then judges calls under the configuration last synced until a
person syncs.

1. **Propose the declaration.** Read the repository and ask the person for its purpose when no
   source states it. Show the human the proposed sibling declaration before invoking the command:
   slug, purpose, source mode, directory and exported variable. Done when the person approves it.
2. **Run the form that matches where the repository is.** Tell the person first that every tool
   call is held after it. For a checkout already on disk, which must have an `origin` remote, run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add billing --config cockpit.toml --from ../billing --purpose "<purpose>" --json`;
   for a new one run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add billing --config cockpit.toml --create --purpose "<purpose>" --json`
   and hand the person `result.publish.command`, which creates the hosted repository; for a known
   remote run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add billing --config cockpit.toml --remote <url> --purpose "<purpose>" --json`.
   To drop one, run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling remove billing --config cockpit.toml --json`,
   which refuses and lists every reference while anything still uses the repository, and never
   deletes the checkout. The command writes cockpit.toml immediately; `--json` changes only its
   output format, so it is neither a preview nor an acceptance gate. While the stack is up, a
   repository the stack uses is refused until the stack is stopped; you may stop it with
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config cockpit.toml`. Done when the command exits 0.
3. **Sync.** Adding or removing a repository widens what agents may do (a new repository is a new
   directory they may write), so until a person runs
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --interactive` in a terminal and confirms it, calls
   are judged under the configuration last synced and every refusal names the sibling. Then run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml --json`. Done when the check exits 0.
4. **Instruction pointer, only on request.** When the person wants the repository's **AGENTS.md**
   to link to the cockpit instructions, add `--instruction-pointer` to the step 2 command; it opts
   the sibling in and writes nothing there. A sibling already declared is opted in by setting
   `instruction_pointer = true` on its table instead, followed by a person's sync. Then run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config cockpit.toml --json`; it reports the proposed
   **AGENTS.md** path (`SETUP_INSTRUCTION_POINTER_OFFERED`) without writing it. If the guide is missing, show the exact new-file draft;
   otherwise show the appended block and the preserved team text. After approval, run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config cockpit.toml --write-instruction-pointers`, which
   writes only the marked block and refuses an edited, partial or duplicated existing one
   (`SETUP_INSTRUCTION_POINTER_INVALID`). Done when the block is written or the person declined it.
5. Run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config cockpit.toml --json` and clear any
   `sibling-instructions` gap for the new repository as **Make a repository's instructions reach
   every tool** describes. Done when `doctor` reports no gap for it.

## Make a repository's instructions reach every tool

Each product repository's own instructions must reach every agent tool, not only the one its team
uses: Codex and OpenCode load **AGENTS.md** and Claude Code loads **CLAUDE.md**, so the shared text
belongs in AGENTS.md and CLAUDE.md starts with a line reading `@AGENTS.md`. The
`sibling-instructions` readiness gap names each repository laid out otherwise.

1. Run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config cockpit.toml --json`. It reports
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
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config cockpit.toml --write-instruction-files` for the
   offered changes, and edit the others by hand. A team's instruction file stays on disk: removing
   one is the person's call. Done when `doctor` reports no `sibling-instructions` gap for the
   repository.

## After upgrading cockpit

An upgrade changes the generated files that guard and instruct every agent, so it is reviewed,
never applied silently. Installing a new cockpit also makes the guard hold every guarded call until
`sync` regenerates it for the new version.

1. **Upgrade in one command where you may.**
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config cockpit.toml --dry-run` resolves the target and
   prints the commands; show them to the person. `./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config cockpit.toml`
   (or `upgrade <version>`) then installs that exact release with the package manager the lockfile
   names, runs `sync` in a new process, and prints the `Upgrade:` lines. An agent may run it where
   `[autonomy] sync = "agent"`, the default; otherwise the guard asks, and the person runs it. When
   its sync fails (`UPGRADE_SYNC_FAILED`, for example on stale removals that need approval), the new
   version is already installed and the guard holds every guarded call: a person acts on what sync
   reported and runs `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --interactive` in a
   terminal. Done when the command exits 0 and its sync wrote the new files.
2. **Or by hand.** `npm update` does not move the exact pin, so install the reviewed release by
   version: `npm install --save-dev --save-exact @b00dea/cockpit@<version>`, and confirm the manifest
   and lockfile show that exact version. From then on the guard holds every guarded call, so a person
   runs `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --dry-run` and then
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --interactive` in a terminal. Done when
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
   Done when `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml --json` exits 0.

## Keep checkouts and stacks current

Each checkout of the cockpit, a linked worktree included, runs its own stack from the sibling
checkouts it mounts. These commands keep both current; run them yourself, except where a step
gives one to the person.

1. **Update the checkouts** with `./node_modules/@b00dea/cockpit/bin/cockpit.mjs pull --config cockpit.toml --json`. It
   only fetches and fast-forwards the cockpit and every sibling. A checkout it skips (`PULL_SKIPPED`:
   modified files, a diverged branch, a failed fetch) stays as it was; report it with the command
   the finding names. Done when every checkout is current or reported.
2. **Serve a sibling from a worktree** with
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs use sibling-slug /absolute/path/to/worktree --config cockpit.toml`,
   and go back with `use sibling-slug --clear`. The choice holds for this cockpit checkout only, and
   a checkout outside the directories you may already write is the person's to choose. A running
   stack keeps the checkout it mounted, so run `down` and `up` after it. A worktree lacks the
   ignored environment files (`SIBLING_ENVIRONMENT_FILE_MISSING`), and cockpit never copies them:
   ask the person. Done when `doctor` names the checkout under `SIBLING_CHECKOUT_OVERRIDDEN`.
3. **A stale stack.** `STACK_INPUTS_CHANGED` from `doctor`, `preflight` or `pull` means a mounted
   sibling's lockfile or declared `rebuild_inputs` changed under the running stack. While the stack
   still runs, rebuild each service whose image installs those dependencies with
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs rebuild --config cockpit.toml --service service-id`, then run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config cockpit.toml` and
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config cockpit.toml`. When `down` refuses because another
   holder still uses the stack (`CLAIM_CO_TENANT`), leave it and report who holds it. Done when
   `doctor` no longer warns, or the holder is reported.
4. **Orphaned stacks.** `STACKS_ORPHANED` from `doctor` means a stack lost its checkout, usually a
   deleted worktree. `./node_modules/@b00dea/cockpit/bin/cockpit.mjs stacks --config cockpit.toml --json` lists every
   stack with its checkout and verdict; `./node_modules/@b00dea/cockpit/bin/cockpit.mjs stacks prune --config cockpit.toml`
   previews what would go, and
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs stacks prune --config cockpit.toml --apply` removes this cockpit's
   orphans only. A prune that deletes volumes runs only where `[autonomy] reset = "agent"`, and
   another cockpit's orphans need a person: for either, hand the person
   `stacks prune --interactive` for a terminal. A stack whose worktree Git still registers, or marks
   locked, is kept until `git worktree prune` (after `git worktree unlock` for a locked one) runs in
   its main checkout. Done when `stacks` lists no orphaned stack, or the person has the command.

## Diagnose

1. Run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config cockpit.toml --json` first: it reports health,
   wiring and `result.readiness` without repairing anything. Use
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs preflight --config cockpit.toml --json` when the environment must
   pass the blocking gate.
2. Follow the fix each diagnostic names, required gaps first. When the fix is a person's step
   (trusting a Codex hook, signing in to a provider, approving a digest), hand them the exact
   command it names. A stale or orphaned stack is cleared by **Keep checkouts and stacks
   current**. Done when `doctor` reports each gap cleared, or you have reported the ones only a
   person can clear.

For an account of the result without changing anything, use the cockpit-explain skill.

## On drift

`check` reports drift as `GENERATED_ARTIFACT_DRIFT`, and the session-start hook prints the same
report before you work. Act on the fix it names:

1. **A sibling guide's copy is stale** (the message names the guide). Run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml`, review the regenerated `AGENTS.md`, and
   commit it together with the guide change. Under `[autonomy] sync = "person"` or `"ci"` the guard
   stops that sync: ask the person to run it.
2. **A generated file was edited by hand** (`SURFACE_STATE_CONFLICT`). Move the change into
   `cockpit.toml` or a `[surfaces].overlays` entry, then sync. Editing the generated file again only
   moves the drift.
3. **A formerly generated file is still on disk.** If the fix says to run `sync`, `[autonomy]
   stale_delete` lets it remove the file: run it and review what it removed. If the fix asks a
   person to approve a digest, stop and ask them.

Done when `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml --json` exits 0.
