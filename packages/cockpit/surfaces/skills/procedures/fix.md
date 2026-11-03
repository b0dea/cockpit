---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Fix a defect

Run from the cockpit root. Invoke each cockpit command through the exact project-local
executable, `./node_modules/.bin/cockpit`, or through its `npx --no` form, such as
`npx --no cockpit check --config cockpit.toml`, which runs that same binary and never downloads
one. If the binary is absent, stop: do not use a command runner that can download a missing
package implicitly. The user guide this procedure cites is installed with cockpit: open each page
with a file read from `./node_modules/@b00dea/cockpit/docs/`. In Codex's sandbox only `check`,
`sync --dry-run` and `--help` run; ask the person to approve running any other cockpit command
outside the sandbox, or to run it in a terminal.

## Fix

A fix is a change you make and prove yourself. It needs no intake, draft, source audit or
work-order file. Use the cockpit-work skill instead when someone else must certify the result, or the work must
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
For environment or credential defects, follow the *Secret handling* section of the cockpit-setup skill's procedure, `../../cockpit-setup/procedures/setup.md` from this file, before invoking the exact declared
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
