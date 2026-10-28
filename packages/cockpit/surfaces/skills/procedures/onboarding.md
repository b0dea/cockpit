---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Cockpit skill procedures

Run from the cockpit root. Invoke each cockpit command through the exact project-local
executable, `./node_modules/.bin/cockpit`. If that file is absent, stop:
do not use a command runner that can download a missing package implicitly.

## Bootstrap

Choose the current harness target explicitly from the
[capability matrix](https://github.com/b0dea/cockpit/blob/main/docs/capability-matrix.md),
which separates generation from measured native enforcement.
For Codex CLI, preview with `cockpit init . --target codexcli --json`; substitute the selected
target for another harness. Supply `--registry` only when adopting an existing registry.
The CLI owns registry interpretation, preview, durable state, artifact publication and environment checks.
Do not re-derive those decisions in this procedure.

Explore the repository estate before asking questions. Ask only for facts the repositories
and CLI output cannot answer, in a small answerable round. Present inferred facts
for confirmation. These conversation controls are instructed; no harness enforces their count.

Show the exact preview before mutation. In a human terminal, run
`cockpit init . --target codexcli --interactive` and accept only the exact displayed digest.
JSON mode returns a preview without acceptance. An agent session has no terminal, so it uses the
non-interactive form instead. Run the `--json` preview and read `interview.outstanding`: every field
the interview will ask, each with its inferred values and the file each came from. Write the answers
file keyed by field, show the human that file and the preview digest, and only then re-run with
`--accept-preview` and `--answers`. The run stops at `configuration.defaults`; once the human has read
the surfaced defaults, add `--accept-defaults` with the digest the run printed. Each digest binds
consent to the bytes the human saw, so never copy one from anywhere but the latest pending run; ask
init for `--help` to list its flags. The step is done when the result reports
`environment-verified`. Re-run the same explicit root and target to
resume; changed bytes or ownership require repair. The command validates the configuration,
synchronizes generated output, checks drift and runs preflight. Show its actual result and
named gaps. Native discovery, a real interview and clean-machine proof require separate evidence.

For a dedicated cockpit, offer an instruction pointer for each product repository during the
preview. Do not enable or write one without human approval: it changes what every agent session in
that repository loads. If the product has no **AGENTS.md**, show the exact proposed file as a draft;
if it has one, show the marked block that would be appended without changing the team's text. After
approval, record `instruction_pointer = true` on that sibling and follow **Add a repository** to
apply it. An in-repository cockpit already uses the root guide and must not point it at itself.

When init runs inside a product repository (a git checkout with a root package manifest), its
`--json` preview carries `result.cockpitRoot`: a question, its options and a recommended answer.
Relay that question to the human and write their answer under the `cockpit.root` key of the answers
file (`dedicated` or `in-repo`); never answer it yourself. It decides where every generated file
lives, and accepting without an answer refuses with `INIT_COCKPIT_ROOT_REQUIRED`. `dedicated`
creates a sibling `<repo>-cockpit` directory so generated files stay out of the product's history.
Explain the trade-off in a sentence or two from [root placement choices](https://github.com/b0dea/cockpit/blob/main/docs/concepts.md#where-the-cockpit-lives).

After accepted initialization, and only with explicit authorization to change product-owned fixtures
or auth setup, read `references/test-data-and-personas.md` beside the cockpit-setup skill and treat
it as a separate product change. Bootstrap does not discover provider identities or create browser
state.

For environment or secret adoption, follow **Secret handling** after sync has established its owned
ignore boundary.

## Create a local setup

Use this when a repository has no local setup: it has only ever run in CI, staging or a cluster,
so there is no Dockerfile, Compose file or documented way to start it on a laptop. Cockpit cannot
read a setup that does not exist, and a setup it guessed would look complete while holding
guesses. So derive each value from evidence, record it as inferred, and let the human confirm it.

1. Read what the repository already states, without running or changing anything: the manifests and
   lockfiles for the runtime and entrypoint, CI workflows for the services they start, deployment
   files for the ports and variable names they inject, and the code for its health endpoint.
   The init preview from **Bootstrap** already proposes several of these under `interview.outstanding`; reuse them
   rather than re-deriving. Done when you hold a list of entrypoint and runtime, ports, environment
   variable names, backing services with images, and a health endpoint, each with the file it came from.
2. Record variable names only. Values belong to the secret owner; see **Secret handling**. Done when
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
   Without that authorisation, declare an environment cockpit renders itself and leave the product
   untouched. Done when either the human approved that specific file or no product file was written.
6. Finish the configuration with the init flow in **Bootstrap**, or on an existing cockpit run
   `cockpit sync --config cockpit.toml` then `cockpit check --config cockpit.toml --json`. Done when
   the check exits 0. Where a runtime is declared, measure it with
   `cockpit runtime measure --config cockpit.toml --image <local-image> --write`, using an image
   already on this machine because the probe never pulls. Then start the stack with
   `cockpit up --config cockpit.toml`, or hold it for one agent command with the session command.
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
adopted Varlock, explicit product-change authority is required to add and lock it. `varlock init`,
provider login, encryption and secret migration remain human/operator actions; preview their file and
provider scope instead of running them automatically.

Preflight and doctor already check the schema of every sibling that has a `.env.schema`; a failing row
names the keys, and `varlock load` in that sibling shows why.

Treat Varlock output as secret-tainted even in agent mode. Report variable names, validation state,
exit status and provenance only. Never copy raw resolved values, stdout or stderr into work-order
evidence. Varlock's credential proxy is preview software and same-user code is not confined here;
report secure agent secret use as unavailable unless a separate measured sandbox proves it.

## Add a repository

Use this on an installed cockpit when a product gains another repository. The `sibling` command edits
`cockpit.toml` so the new repository is declared once, with its purpose, instead of reached by path.
Read the repository and ask the human for the purpose when no source states it. Show the human the proposed
sibling declaration before invoking the command: slug, purpose, source mode, directory and exported variable.
Pick the form by where the repository is. For a checkout already on disk run
`cockpit sibling add billing --config cockpit.toml --from ../billing --purpose "<purpose>" --json`;
for a new one run `cockpit sibling add billing --config cockpit.toml --create --purpose "<purpose>" --json`;
for a known remote run
`cockpit sibling add billing --config cockpit.toml --remote <url> --purpose "<purpose>" --json`.
The command writes cockpit.toml immediately; `--json` changes only its output format, so it is neither a preview
nor an acceptance gate. After the edit, a human runs `cockpit sync --config cockpit.toml` in a terminal because
the changed declaration affects the guard. Then run `cockpit check --config cockpit.toml --json`. Done when the
check exits 0.

Add `--instruction-pointer` only after the human approves the exact marked block. First run
`cockpit setup --config cockpit.toml --json`; it reports the proposed **AGENTS.md** path without
writing it. If the guide is missing, show the exact new-file draft; otherwise show the appended
block and the preserved team text. After approval, run
`cockpit setup --config cockpit.toml --write-instruction-pointers`, which writes only the marked
block and refuses an edited or ambiguous existing block.

## After upgrading cockpit

An upgrade changes the generated files that guard and instruct every agent, so it is reviewed, never
applied silently.

1. Run `npm install --save-dev --save-exact @b0dea/cockpit@<version>`, replacing `<version>` with the reviewed
   release. Done when both the manifest and lockfile show that exact version.
2. Preview without writing: `cockpit upgrade --config cockpit.toml` (a read-only plan) or
   `cockpit sync --dry-run --config cockpit.toml`.
3. A human runs `cockpit sync --interactive --config cockpit.toml` in a terminal and approves the exact
   stale-removal digest when the upgrade renamed or retired an owned surface. The guard blocks an agent from
   regenerating its own guard, so do not try to route around it; ask the human to run it.
4. Review the diff. A hand edit to an owned file stops sync with a conflict (`SURFACE_STATE_CONFLICT`):
   move that change into a `[surfaces].overlays` entry instead of editing the generated file. An upgrade that
   changes something you overrode reports `OVERRIDDEN_CORE_CHANGED`: review the new built-in against your
   override before updating its recorded hash.
5. Commit the lockfile and the regenerated files together.
6. Read `CHANGELOG.md` between the old and new version for lines starting `Upgrade:`. Each names a step
   that sync alone does not do. The convention is in `.changeset/README.md` in the cockpit repository.

Done when `cockpit check --config cockpit.toml --json` exits 0 and every `Upgrade:` line has been done or
reported to the human.

## Diagnose

Run `cockpit doctor --config cockpit.toml --json` first: it reports health and wiring without repairing
anything. Follow the fix each diagnostic names. Use `cockpit preflight --config cockpit.toml --json` when
the environment must pass the blocking gate, and **Explain** to turn the result into a plain account.

## Explain

Run only the read-only command that answers the question. Use `cockpit doctor --config cockpit.toml --json`
for environment health and wiring, `cockpit check --config cockpit.toml --json` for generated-surface
drift, or `cockpit preflight --config cockpit.toml --json` for dependency and readiness checks.
Combine them only when the question crosses those boundaries. Explain the relevant installed lanes,
wired repositories, recorded reasons, current gaps and next accepted commands.
For a secret question, follow **Secret handling** and distinguish tracked schema, encrypted/provider
source, redacted status, trusted child injection and unavailable same-user read confinement.

## Fix

Before creating files, route the intent through the current work-order routing and capacity owner.
Start from the task, issue, specification, decision record or next programme item; do not require an
empty work-order template. Independent certification, a durable handoff or a programme requires the
work-order lane. A fix result creates zero work-order files. Re-evaluate the route when scope
changes or the work needs a handoff; do not wait until hand-back to discover that boundary.

Inspect repository- and user-installed skills for applicable brainstorming, research, specification
and planning procedures before using a cockpit fallback. Reuse their procedures and link their
outputs as upstream sources instead of copying or replacing the planning system. Record capability
selection, chosen source, applicability and reason in the source audit, with the auditor and linked
output sources. Record explicit absence when no applicable skill is available; absence never skips
the required source audit. A generated skill inventory or a file hash alone proves no applicability.

Only after route and capacity admission, prepare a draft through the work-order owner. Link the
upstream artifact as authority, audit its sources and unresolved gaps, and validate the canonical
contract. Keep programme intent in its ordered ledger; prepare only its currently admitted next item
against the estate that exists now. Operator acceptance remains a separate gate.

Name the defect, expected behavior, and observed behavior. Reproduce at the narrowest real boundary:
for logic-only changes use the owning product test or read-only command without starting the stack;
use `cockpit up --config cockpit.toml` only when the behavior depends on a live process or integration.
Then change the repository that owns it. Use `cockpit logs --config cockpit.toml --service service-id`
and `cockpit doctor --config cockpit.toml` only for relevant runtime evidence. Use
`cockpit check --config cockpit.toml` for generated-surface drift. Replace `service-id` with the
declared service being inspected. Follow the generated testing tiers: extend the nearest behavior
test through its public surface, iterate with the narrowest selector, and batch complete or shared
gates after the change stabilizes. Do not repeat weaker proof already established by a stronger test. In the
work-order lane, persist step checks and heartbeat before moving on; record attempts, root causes,
human gaps, evidence and decisions through their owned writers. Preserve each evidence layer.
For environment or credential defects, follow **Secret handling** before invoking the exact declared
product command.

After each substantial implementation batch and again before grading, perform simplification first,
then independent code review, with security emphasis when the changed boundary warrants it. Reuse an
applicable installed code-review or security-review skill and its procedure; otherwise use a
specialist reviewer or apply that sequence directly. Keep findings in the existing review output,
not a parallel checklist or plan. Persist findings and dispositions, fix blocking findings, and
re-run the affected proof. The grader starts only after final declared verification is current. Apply the same sequence proportionally to
a fix without adding work-order files or an independent grading requirement.

Before hand-back, enumerate the exact files, temporary artifacts, processes and runtime claims this
task created. Remove only task-owned temporary artifacts. Preserve pre-existing dirty state, other
agents' files, co-tenant claims and review evidence. Release a runtime claim only through the existing
cockpit lifecycle command, honoring any applicable existing operator gate. Rely on its lifecycle
outcome; retain and report the owner, refusal and evidence when it cannot authenticate safe release.
Report every retained task-owned item and why.

Semantic applicability and these conversation steps are instructed, including skill and review
routing. Contract validation, capacity admission, durable progress and completion checks belong to
their CLI owners. Report any missing mechanical support as a gap; never describe an instruction as
an enforced harness restriction.

If a second person must certify this, use cockpit-work instead.

## Work

Experimental. This is the work-order loop for changes a second person must certify. Cockpit owns the
contract and the independent grading, not the thinking: reuse the planning skills the harness already has.

0. **Is this a work order?** Ask whether anyone besides you must certify the result, or whether the work
   must survive a handoff or span a programme. If not, stop and follow **Fix**: most changes are fixes, and the
   ceremony costs more than it proves. Then check there is room: `cockpit work-status --config cockpit.toml --json` lists open orders, and the configured `workorders.wip_cap` and `workorders.programme_wip_cap` bound them. With no
   room, park something (step 7) before starting. Done when you can say who certifies and capacity exists.
1. **Intake.** Run the harness's installed brainstorming and planning skills, then compile their output into
   the work-order schema with `cockpit work-intake --config cockpit.toml --intent intents/task.json --candidate drafts/task.md`.
   The contract needs the parser-admitted number of acceptance criteria, each a Given/When/Then that independent reviewers could not
   disagree about, an Authority list of exact files and a verification command per criterion. Read the new ID from
   intake, then a human accepts it in a terminal with `cockpit work-accept --config cockpit.toml --work-order WO-001 --interactive`,
   replacing `WO-001` with that ID. JSON and CI refuse, so an agent cannot accept its own work. Done when
   `cockpit work-status --config cockpit.toml --work-order WO-001 --json` reports it accepted.
2. **Work test-first inside Authority.** Write the failing test for a criterion, then the code, touching only
   files the Authority lists. If the work needs another file, stop and ask for a renewed contract
   (`work-renew`) rather than editing outside it. Record progress with `cockpit work-record --config cockpit.toml --work-order WO-001 --event-file events/progress.json`.
3. **Run the criterion's declared gate** with `cockpit test-run --config cockpit.toml --gate declared-gate-id`,
   replacing `declared-gate-id` with its ID from `[testing.gates]`. Only the complete declared gate can PASS; a
   subset reports PARTIAL. Done when that gate reports PASS.
4. **Before grading, run reviews.** Run the harness's installed simplification and code-review skills. Apply security emphasis
   when the change touches authentication, secrets, guards or reach to non-local hosts. Fix their blocking
   findings and re-run affected proof. Then run
   `cockpit work-review --config cockpit.toml --work-order WO-001` to run and persist cockpit's independent
   simplification, code/spec and security findings. Fix every blocking finding and repeat the command until all
   all required review lanes pass.
5. **Hand off to the evaluator subagent** through `cockpit work-grade --config cockpit.toml --work-order WO-001`. Never grade
   your own work: the evaluator is the grader and there is no separate grader skill. Its outcome per
   criterion is one of the verdicts in the evaluator's instructions; anything but "passed with current
   supporting evidence" sends you back to step 2 for that criterion.
6. **Attempt cap.** At the configured failed-attempt cap for one criterion, make a different move, for example a
   root-cause diagnosis in a fresh context, before a third try. Read the count from work-order state, not
   from memory: `cockpit work-status --config cockpit.toml --work-order WO-001 --json` returns the selected
   order under `result.orders[0]`, with the counters at `result.orders[0].state.attempts`
   (step, approach, `failures`, `rootCause`), and the attempt cap is `workorders.attempt_cap`. A missing
   counter is not zero: if you cannot read it, say so and treat the step as unknown. Record the root cause
   with `work-record` as above, then run `cockpit work-execute --config cockpit.toml --work-order WO-001 --approach second-try`, which refuses a
   capped approach.
7. **Park, sweep and unpark.** `cockpit work-sweep --config cockpit.toml` previews which untouched drafts
   would be parked to free capacity; add `--apply` to park them. `cockpit work-reverse --config cockpit.toml --work-order WO-001`
   restores a swept order. An order a human parked by hand is reversed by a human, not by the sweep.

Report the outcome of each criterion with the evidence the evaluator quoted, and name any step you could not run.
