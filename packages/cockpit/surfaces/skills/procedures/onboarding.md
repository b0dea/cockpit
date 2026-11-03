---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Cockpit skill procedures

Run from the cockpit root. Invoke each cockpit command through the exact project-local
executable, `./node_modules/.bin/cockpit`, or through its `npx --no` form, such as
`npx --no cockpit check --config cockpit.toml`, which runs that same binary and never downloads
one. If the binary is absent, stop: do not use a command runner that can download a missing
package implicitly. The user guide this procedure cites is installed with cockpit: open each page
with a file read from `./node_modules/@b00dea/cockpit/docs/`. In Codex's sandbox only `check`,
`sync --dry-run` and `--help` run; ask the person to approve running any other cockpit command
outside the sandbox, or to run it in a terminal.

## Bootstrap

Replace `<tool>` below with the target of the agent tool you are running in: `claudecode` (Claude
Code), `codexcli` (Codex CLI), `opencode` (OpenCode), `cursor` (Cursor) or `grokcli` (Grok Build).
The capability matrix, `./node_modules/@b00dea/cockpit/docs/capability-matrix.md`, separates what
cockpit generates for each from what has been tested as enforced.
Preview with `./node_modules/.bin/cockpit init . --target <tool> --json`. Supply `--registry` only
when adopting an existing registry.
The CLI reads the registry, shows the preview, keeps state, writes the generated files and checks the environment.
Do not redo those steps here.

Explore the repository estate before asking questions. Ask only for facts the repositories
and CLI output cannot answer, in a small answerable round. Present inferred facts
for confirmation. These conversation controls are instructed; no harness enforces their count.

Show the exact preview before mutation. In a human terminal, run
`./node_modules/.bin/cockpit init . --target <tool> --interactive` and accept only the exact displayed digest.
JSON mode returns a preview without acceptance. An agent session has no terminal, so it uses the
non-interactive form instead. Run the `--json` preview and read `interview.outstanding`: every field
the interview will ask, each with its inferred values and the file each came from. Write the answers
file keyed by field, show the human that file and the preview digest, and only then re-run with
`--accept-preview` and `--answers`. The run stops at `configuration.defaults`; once the human has read
the surfaced defaults, add `--accept-defaults` with the digest the run printed. Each digest binds
consent to the bytes the human saw, so never copy one from anywhere but the latest pending run; ask
init for `--help` to list its flags. Re-run the same explicit root and target to
resume; changed bytes or ownership require repair. The command validates the configuration,
synchronizes generated output, checks drift and runs preflight. Show its actual result and
named gaps. Where a runtime is declared, preflight needs a completed first bring-up, so the run
stops with `STATE_UNSEEDED` (exit 2, stage `draft-observed`); that is the expected stop, and the
diagnostics beside it name every other gap found without a running stack. Preflight also passes
only once the cockpit repository is committed and clean, so a new one reports `GIT_STATE_UNHEALTHY`
(no commits yet) with the commands that commit the generated files. A person approves or runs
the staging and the commit, not you: the guard asks on `git add <paths>`, denies a broad `git add -A`
that covers a secrets directory, and the first commit stages the guard's own files. Show them
`git status --short` and hand them that fix to run in a terminal. If you must run Git in another
directory, use `git -C <dir>` or `cd ./<dir> && <command>`; a bare `cd <dir>` is refused. Then bring the
stack up (step 6 of **Create a local setup**) and re-run the same command. The step is done when
the result reports `environment-verified`; a cockpit that declares no runtime reports it, with
`ENVIRONMENT_NOT_DECLARED` as information, without a bring-up. Native discovery, a real interview
and a clean-machine run each still need their own check.

Walk the human through what is still missing. Every `init` stop, and
`./node_modules/.bin/cockpit doctor --config cockpit.toml --json`, carries `result.readiness`:
`gaps` lists each prerequisite cockpit depends on that a check reported missing, each with its
`level` (a `required` one is refused by the command that needs it), `needs` (why cockpit needs it)
and `findings` (the diagnostic, its message and its fix); `noFinding` lists the ones no check
reported. Take the gaps one at a time, required ones first:
say what is missing, why cockpit needs it, and the exact change you propose. Ask before touching
any product repository; committing, installing cockpit, recording a remote, untracking a file or
adding a test changes it for everyone who works on it. Where a gap needs judgement (which test
runner to adopt, whether the existing tests prove anything, where characterization tests for
untested code should live), propose with what you read and let the human decide. A gap is a fact:
clear it by changing what it reports, then re-run `doctor` to confirm. `noFinding` is not proof,
because a check that could not run reports nothing. The `cockpit-installed` gap is the first to
clear: `init` ran from a temporary copy, so run `npm install` in the cockpit root, then ask the
human to run `./node_modules/.bin/cockpit sync --config cockpit.toml` in a terminal so the guard
hook runs the installed copy.

If anyone will run Codex in this cockpit, a person must trust its guard hook on each machine, and
again whenever sync changes the hook: Codex silently skips a project hook nobody has trusted, so
every tool call would run unguarded. An agent cannot give that trust. Ask the human to run
`codex -C <cockpit root>` in a terminal (not `codex exec`), trust the folder if asked, and choose
**Trust all and continue** when Codex shows **Hooks need review**.
`./node_modules/.bin/cockpit doctor --config cockpit.toml` reports `CODEX_HOOK_UNTRUSTED` until it is done.

`init` asks `cockpit.name` first and proposes the cockpit root's directory name. Ask the human for
the name before accepting: it scopes the cockpit's Compose projects, state and generated files, so
changing it after the first sync means bringing the stack down and syncing again. Never edit
`cockpit.name` while the stack is up; to rename, follow the *Rename a cockpit* section of
`./node_modules/@b00dea/cockpit/docs/getting-started.md` (`down`, edit the name, `sync`, `check`).

For a runnable product, `init` asks `testing` and proposes stages and gates from the test entry
points it finds, each naming the file it came from. Confirm with the human which commands prove a
change: the targeted gate agents iterate with, and the full gate they run before handing back. For a
new product with no tests, ask the human to choose its test runner and declare those gates before
behavior is written; never add a test framework to a product repository without their explicit yes.
Answer `testing = "none"` only when they decide there are no tests yet; `doctor` then reports
`TESTING_GATE_UNDECLARED`.

Being told to "use sensible defaults" or "proceed without asking" covers interview answers only.
It never extends to writing inside a product repository: an **AGENTS.md** pointer, a Compose file,
a `package.json`, a Dockerfile or a `.env.schema` in a sibling checkout each needs the human's
explicit yes to that exact change, because it changes the product for everyone who works on it.
For every answer you choose yourself, record that you chose it in the answers file's `[provenance]`
table, for example `"environment.machine" = "agent-default"`. init then writes the field under
`unconfirmed` in `cockpit.toml` with a comment saying the setup agent chose it, and `doctor` warns
until a person confirms it; an unmarked answer is recorded as the human's, so never leave one you
chose unmarked. End your report by listing every default you chose, with its field and value, so the
human can confirm or replace each.

For a dedicated cockpit, offer an instruction pointer for each product repository during the
preview. Do not enable or write one without a person's approval: it changes what every agent session in
that repository loads. If the product has no **AGENTS.md**, show the exact proposed file as a draft;
if it has one, show the marked block that would be appended without changing the team's text. After
approval, record `instruction_pointer = true` on that sibling and follow **Add a repository** to
apply it. An in-repository cockpit already uses the root guide and must not point it at itself.

When init runs inside a product repository (a git checkout with a root language manifest,
Dockerfile, or standard Compose filename), it conservatively asks for root placement before it
settles whether that source is runnable. Its
`--json` preview carries `result.cockpitRoot`: a question, its options and a recommended answer.
Relay that question to the human and write their answer under the `cockpit.root` key of the answers
file (`dedicated` or `in-repo`); never answer it yourself. It decides where every generated file
lives, and accepting without an answer refuses with `INIT_COCKPIT_ROOT_REQUIRED`. `dedicated`
creates a sibling `<repo>-cockpit` directory so generated files stay out of the product's history.
Explain the trade-off in a sentence or two from the root placement choices in
`./node_modules/@b00dea/cockpit/docs/concepts.md`.

After accepted initialization, and only with explicit permission to change the product's fixtures
or auth setup, read `references/test-data-and-personas.md` beside the cockpit-setup skill and treat
it as a separate product change. Bootstrap does not discover provider identities or create browser
state.

For environment or secret adoption, follow **Secret handling** after sync has established its owned
ignore boundary.

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
6. Finish the configuration with the init flow in **Bootstrap**, or on an existing cockpit run
   `./node_modules/.bin/cockpit sync --config cockpit.toml` then `./node_modules/.bin/cockpit check --config cockpit.toml --json`. Done when
   the check exits 0. Where a runtime is declared, measure it with
   `./node_modules/.bin/cockpit runtime measure --config cockpit.toml --image <local-image>`,
   using an image already on this machine because the probe never pulls. It measures the local
   daemon `up` will use: the context `DOCKER_CONTEXT` names, or else the active one. It records the
   result for this machine only and leaves `cockpit.toml` unchanged, so no `sync` is needed. Then start the stack with
   `./node_modules/.bin/cockpit up --config cockpit.toml`, or hold it for one agent command with the session command.
   Report the actual result. Done when the stack reports healthy, or you have named what stopped it.

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

## Add a repository

Use this on an installed cockpit when a product gains another repository. The `sibling` command edits
`cockpit.toml` so the new repository is declared once, with its purpose, instead of reached by path.
Read the repository and ask the human for the purpose when no source states it. Show the human the proposed
sibling declaration before invoking the command: slug, purpose, source mode, directory and exported variable.
Pick the form by where the repository is. For a checkout already on disk run
`./node_modules/.bin/cockpit sibling add billing --config cockpit.toml --from ../billing --purpose "<purpose>" --json`;
for a new one run `./node_modules/.bin/cockpit sibling add billing --config cockpit.toml --create --purpose "<purpose>" --json`;
for a known remote run
`./node_modules/.bin/cockpit sibling add billing --config cockpit.toml --remote <url> --purpose "<purpose>" --json`.
The command writes cockpit.toml immediately; `--json` changes only its output format, so it is neither a preview
nor an acceptance gate. After the edit, a human runs `./node_modules/.bin/cockpit sync --config cockpit.toml` in a terminal because
the changed declaration affects the guard. Then run `./node_modules/.bin/cockpit check --config cockpit.toml --json`. Done when the
check exits 0.

Add `--instruction-pointer` only after the human approves the exact marked block. First run
`./node_modules/.bin/cockpit setup --config cockpit.toml --json`; it reports the proposed **AGENTS.md** path without
writing it. If the guide is missing, show the exact new-file draft; otherwise show the appended
block and the preserved team text. After approval, run
`./node_modules/.bin/cockpit setup --config cockpit.toml --write-instruction-pointers`, which writes only the marked
block and refuses an edited or ambiguous existing block.

Then run `./node_modules/.bin/cockpit doctor --config cockpit.toml --json` and clear any
`sibling-instructions` gap for the new repository as **Make a repository's instructions reach every
tool** describes.

## Make a repository's instructions reach every tool

Each product repository's own instructions must reach every agent tool, not only the one its team
uses: Codex and OpenCode load **AGENTS.md** and Claude Code loads **CLAUDE.md**, so the shared text
belongs in AGENTS.md and CLAUDE.md starts with a line reading `@AGENTS.md`. The `sibling-instructions`
readiness gap names each repository laid out otherwise. Plain
`./node_modules/.bin/cockpit setup --config cockpit.toml --json` reports `SETUP_INSTRUCTION_FILES_OFFERED`
for the two changes that need no judgement (a CLAUDE.md importing an existing AGENTS.md, or a lone
CLAUDE.md moved byte for byte into AGENTS.md); show the human the exact files, and after their yes
run `./node_modules/.bin/cockpit setup --config cockpit.toml --write-instruction-files`. Before
proposing a move, read the CLAUDE.md: lines that only Claude Code can act on (Claude Code commands,
settings or tool names) belong back in CLAUDE.md under the `@AGENTS.md` line once moved, so show the
human those lines and where each would go. When both files exist without the import, read both,
propose one AGENTS.md holding everything every tool needs and a CLAUDE.md of `@AGENTS.md` plus
Claude-only lines, and edit only after the human approves that exact text. When neither exists, or
the instructions sit in files such as **.cursorrules** or **GEMINI.md**, draft the AGENTS.md from what
you read for the human to approve. Never delete a team's instruction file yourself.

## After upgrading cockpit

An upgrade changes the generated files that guard and instruct every agent, so it is reviewed, never
applied silently. For a read-only release plan before installing, follow the *Review an upgrade*
section of `./node_modules/@b00dea/cockpit/docs/harness-surfaces.md`.

1. Run `npm install --save-dev --save-exact @b00dea/cockpit@<version>`, replacing `<version>` with the reviewed
   release. Done when both the manifest and lockfile show that exact version.
2. Preview the generated changes without writing:
   `./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run`.
3. A human runs `./node_modules/.bin/cockpit sync --config cockpit.toml --interactive` in a terminal and approves the exact
   stale-removal digest when the upgrade renamed or retired an owned surface. The guard blocks an agent from
   regenerating its own guard, so do not try to route around it; ask the human to run it.
4. Review the diff. A hand edit to a skill, agent settings file or cockpit-owned region stops sync with a conflict (`SURFACE_STATE_CONFLICT`):
   move that change into a `[surfaces].overlays` entry instead of editing the generated file. An upgrade that
   changes something you overrode reports `OVERRIDDEN_CORE_CHANGED`: review the new built-in against your
   override before updating its recorded hash.
5. Ask the person to commit the lockfile and the regenerated files together.
6. Read the newly installed `./node_modules/@b00dea/cockpit/CHANGELOG.md` between the old and new
   version for lines starting `Upgrade:`. Each names a step
   that sync alone does not do. The convention is in `.changeset/README.md` in the cockpit repository.

Done when `./node_modules/.bin/cockpit check --config cockpit.toml --json` exits 0 and every `Upgrade:` line has been done or
reported to the human.

## Diagnose

Run `./node_modules/.bin/cockpit doctor --config cockpit.toml --json` first: it reports health and wiring without repairing
anything. Follow the fix each diagnostic names. Use `./node_modules/.bin/cockpit preflight --config cockpit.toml --json` when
the environment must pass the blocking gate, and **Explain** to turn the result into a plain account.

## Explain

Run only the read-only command that answers the question. Use `./node_modules/.bin/cockpit doctor --config cockpit.toml --json`
for environment health and wiring, `./node_modules/.bin/cockpit check --config cockpit.toml --json` for generated-surface
drift, or `./node_modules/.bin/cockpit preflight --config cockpit.toml --json` for dependency and readiness checks.
Combine them only when the question crosses those boundaries. When explaining drift, say what each
command does: `check` repairs nothing; `sync` rewrites a hand-edited generated artifact such as
`compose.generated.yml`, and refuses a hand-edited skill, agent settings file or cockpit-owned
region with `SURFACE_STATE_CONFLICT`. Explain the relevant installed lanes,
wired repositories, recorded reasons, current gaps and next accepted commands.
For a secret question, follow **Secret handling** and distinguish tracked schema, encrypted/provider
source, redacted status, trusted child injection and unavailable same-user read confinement.

## Fix

A fix is a change you make and prove yourself. It needs no intake, draft, source audit or
work-order file. Use **Work** instead when someone else must certify the result, or the work must
carry on in a later session or belongs to a programme; check that again whenever the scope changes,
not at hand-back.

Name the defect, expected behavior, and observed behavior. Reproduce at the narrowest real boundary:
for logic-only changes use the owning product test or read-only command without starting the stack;
use `./node_modules/.bin/cockpit up --config cockpit.toml` only when the behavior depends on a live process or integration.
Run the declared gate that covers the change before you edit
(`./node_modules/.bin/cockpit test-run --config cockpit.toml --gate declared-gate-id --json`, with its ID from
`[testing.gates]`), so you know what already passed, and again after. Then change the repository that owns
the defect. Use `./node_modules/.bin/cockpit logs --config cockpit.toml --service service-id`
and `./node_modules/.bin/cockpit doctor --config cockpit.toml` only for relevant runtime output. Use
`./node_modules/.bin/cockpit check --config cockpit.toml` for generated-surface drift. Replace `service-id` with the
declared service being inspected. Follow the generated testing tiers: extend the nearest behavior
test through its public surface, iterate with the narrowest selector, and run the full gate once
after the change stabilizes. Do not repeat weaker proof already established by a stronger test.
For environment or credential defects, follow **Secret handling** before invoking the exact declared
product command.

After the change stabilizes, simplify it, then review it independently, with security emphasis when
the changed boundary warrants it. Reuse an applicable installed code-review or security-review skill;
otherwise apply that sequence directly. Fix blocking findings and re-run the affected proof.

Before you report back, list the exact files, temporary files, processes and stack claims this
task created. Remove only the temporary files this task created. Keep earlier uncommitted changes, other
agents' files, claims held by other holders and the review results. Release a stack claim only with the existing
cockpit lifecycle command, following any approval step it already requires. Trust its
result; when cockpit cannot confirm that release is safe, keep the claim and report who holds it, the refusal and the output.
Report every item this task created that you kept, and why, and the gate results before and after.

If a second person must certify this, use cockpit-work instead.

## Work

This is the work-order loop for changes a second person must certify. Cockpit owns the
contract and the independent grading, not the thinking: reuse the planning skills the harness already has.

0. **Is this a work order?** Ask whether anyone besides you must certify the result, or whether the work
   must carry on in a later session or span a programme. If not, stop and follow **Fix**: most changes are fixes, and the
   overhead costs more than it proves. Then check there is room: `./node_modules/.bin/cockpit work status --config cockpit.toml --json` lists open orders; the configured `workorders.wip_cap` bounds them, and a programme holds at most one. With no
   room, park something (step 7) before starting. Done when you can say who certifies and capacity exists.
1. **Intake.** When preparing an intent descriptor, draft contract or source audit, follow the
   examples in the *Declare work and the files it may change* section of
   `./node_modules/@b00dea/cockpit/docs/work-and-browser.md` so the closed formats bind the inspected
   request without guessing fields. Inspect applicable installed
   thinking, research, specification and planning skills, and link each selected output in the source audit.
   Record an audited empty selection when none applies. Then compile them into the work-order schema with
   `./node_modules/.bin/cockpit work intake --config cockpit.toml --intent intents/task.json --candidate drafts/task.md`.
   The contract needs the number of acceptance criteria the parser allows, each a Given/When/Then that independent reviewers could not
   disagree about, an Authority list of exact files and a verification command per criterion. Read the new ID from
   intake, then a human accepts it in a terminal with `./node_modules/.bin/cockpit work accept --config cockpit.toml --work-order WO-001 --interactive`,
   replacing `WO-001` with that ID. Cockpit refuses JSON, CI and calls without a terminal, but it cannot tell a
   person from a program driving one: never accept on the human's behalf. Done when
   `./node_modules/.bin/cockpit work status --config cockpit.toml --work-order WO-001 --json` reports it accepted.
2. **Work test-first inside Authority, one Plan step at a time.** Write the failing test for a criterion, then the code, touching only
   files the Authority lists. If the work needs another file, stop and ask for a renewed contract
   (`work renew`) rather than editing outside it. Record progress with `./node_modules/.bin/cockpit work record --config cockpit.toml --work-order WO-001 --event-file workorders/events/progress.json`;
   keep event files under `workorders/events/`, where they do not make earlier proof stale. When you need a
   person's input, record a `gap` event with your question and stop. Answers and decisions are the person's:
   `work record` refuses `resolve-gap` and `decision` events, and the person records them in a terminal with
   `./node_modules/.bin/cockpit work answer --config cockpit.toml --work-order WO-001 --event-file workorders/events/answer.json --interactive`.
   You may draft that file for them; never answer on their behalf.
3. **Check each Plan step** with `./node_modules/.bin/cockpit work execute --config cockpit.toml --work-order WO-001 --approach first-try --json`
   once its work is done, replacing `first-try` with a short name for your approach. It runs that step's declared verification command; a failure returns the command's exit
   status and the end of its output in `result.verification`. Fix and rerun. While iterating, the declared gate
   (`./node_modules/.bin/cockpit test-run --config cockpit.toml --gate declared-gate-id --json`, with its ID from `[testing.gates]`) is
   faster feedback; it does not check a step. Done when `./node_modules/.bin/cockpit work resume --config cockpit.toml --json`
   says every step has current checked proof and the order awaits grading.
4. **Before grading, run reviews.** Run the harness's installed simplification and code-review skills. Apply security emphasis
   when the change touches authentication, secrets, guards or reach to non-local hosts. Fix their blocking
   findings and re-run affected proof. Then run
   `./node_modules/.bin/cockpit work review --config cockpit.toml --work-order WO-001 --json` to run and persist cockpit's independent
   simplification, code/spec and security findings. Fix every blocking finding and repeat the command until
   all required review lanes pass. The reviews and the grade run in the Codex CLI, which must be on `PATH` and
   signed in; if a refusal says it could not run, report that cause to the human instead of retrying.
5. **Pass the work to the evaluator** through `./node_modules/.bin/cockpit work grade --config cockpit.toml --work-order WO-001 --json`. Never grade
   your own work: the evaluator is the grader and there is no separate grader skill. The result lists each
   criterion's outcome and reasons under `result.criteria`; anything but "passed with current
   supporting evidence" sends you back to step 2 for that criterion.
6. **Attempt cap.** At the configured failed-attempt cap for one criterion, make a different move, for example a
   root-cause diagnosis in a fresh context, before a third try. Read the count from work-order state, not
   from memory: `./node_modules/.bin/cockpit work status --config cockpit.toml --work-order WO-001 --json` returns the selected
   order under `result.orders[0]`, with the counters at `result.orders[0].state.attempts`
   (step, approach, `failures`, `rootCause`), and the attempt cap is `workorders.attempt_cap`. A missing
   counter is not zero: if you cannot read it, say so and treat the step as unknown. Record the root cause
   with `work record` as above, then run `./node_modules/.bin/cockpit work execute --config cockpit.toml --work-order WO-001 --approach second-try`, which refuses a
   capped approach.
7. **Park, sweep and unpark.** `./node_modules/.bin/cockpit work sweep --config cockpit.toml` previews which untouched drafts
   would be parked to free capacity. Parking changes what counts against the cap a person set, so a person adds `--apply` to park them,
   and runs `./node_modules/.bin/cockpit work reverse --config cockpit.toml --work-order WO-001` to restore a swept order. An order a human
   parked by hand is reversed by a human, not by the sweep.

Report the outcome of each criterion with the reasons the grade gave, and name any step you could not run.
