---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Cockpit skill procedures

## Bootstrap

Choose the current harness target explicitly: `claudecode`, `codexcli`, or `opencode`.
For Codex CLI, preview with `cockpit init . --target codexcli --json`; substitute the selected
target for another harness. Supply `--registry` only when adopting an existing registry.
The CLI owns registry interpretation, preview, durable state, artifact publication and environment checks.
Do not re-derive those decisions in this procedure.

Explore the repository estate before asking questions. Ask only for facts the repositories
and CLI output cannot answer, with at most three questions per round. Present inferred facts
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

After accepted initialization, and only with explicit authorization to change product-owned fixtures
or auth setup, follow **Authenticated testing** as a separate product change. Bootstrap does not
discover provider identities or create browser state.

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

## Authenticated testing

When authentication affects product behavior, inspect the consumer's package manifests and locks,
product models, fixture source, seed commands and probes, auth setup, ignore rules and authorization
tests. Extend the existing owners. Resolve test-library versions from the consumer lock; never invent
an authoritative version, provider setting, custom role or permission.

Create or extend the product-owned persona source with stable synthetic persona IDs such as
`auth-admin` and `auth-member`. Give each a stable external key, non-secret test identifier, expected
product row, provider identity reference, confirmed role and permission expectations, and one
permitted or denied product operation. Credentials, provider keys and browser state stay outside the
fixture. The product-model seeder owns product rows; the existing provider adapter owns identity
provider users, organizations and memberships. Bind their idempotent commands to the existing seeded
operations and probes. When an adapter is genuinely absent, add a thin consumer-owned adapter behind
that seed command, with stable-key adoption and a sweep restricted to the synthetic namespace.
Existing product-fixture edit authority does not authorize provider mutation. Before provider writes,
bind authority to one named development instance and the exact synthetic users, organization and
memberships in scope. When the user has not already authorized that exact scope, preview the
mutations and obtain approval. Otherwise stay within the recorded scope. Cleanup can remove only the
same bounded synthetic provider resources; preserve unrelated identities and record the result.

Mint browser state serially from a clean context under the declared ignored auth root. Create the
root mode 0700 and each state file mode 0600, one state per persona, using the consumer's authenticated
Playwright package. Verify the active synthetic identity, organization, role and application
permission before saving state. Then run one permitted and one denied authorization behavior through
the product surface. Reset the task's auth/browser artifacts through cockpit and read back their
absence while preserving unowned state.

Use the Clerk starter only when the manifests, lock and application confirm Clerk plus
`@clerk/testing` and `@playwright/test`. Confirm that the instance exposes each assigned role;
`org:admin` and `org:member` are starter candidates, while custom roles, Role Sets and permissions
come only from the instance and product authorization model. System permissions are not session
claims. The consumer adapter creates or adopts the stable synthetic users and organization and uses
direct memberships with confirmed roles; secrets cross only its existing secret-bearing command.
In a serial project-based Playwright setup, call `clerkSetup()`. For each persona, navigate to an
unprotected page that loads Clerk, call `clerk.signIn({ page, emailAddress })`, verify authorization,
and write the declared state. `clerk.signIn` supplies its testing-token step; do not add a duplicate
token helper around it.

Report each evidence layer independently as PASS, FAIL or NOT_RUN: source inspection, synthetic
provider boundary and live provider. Existing-state consumption proves only that cockpit can use
those bytes; a synthetic provider boundary proves integration mechanics. Report `CLERK LIVE NOT_RUN`
until an authorized masked-secret probe against the named development instance creates or adopts only
the scoped identities, seeds twice, mints every state, checks both authorization outcomes, cleans only
those scoped provider resources and records the cleanup receipt. Keep provider SDKs in the consumer,
not cockpit.
Current API references: [Clerk Playwright setup](https://clerk.com/docs/guides/development/testing/playwright/overview),
[Clerk sign-in helper](https://clerk.com/docs/guides/development/testing/playwright/test-helpers),
[Clerk roles and permissions](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions),
and [Playwright authentication](https://playwright.dev/docs/auth).

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
