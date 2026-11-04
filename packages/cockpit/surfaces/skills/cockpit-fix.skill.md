---
name: cockpit-fix
description: "Use when a bug, failing test, error or stack trace needs fixing in a repository of an installed cockpit, and nobody else must certify the result."
targets: ["*"]
cockpit:
  tools: [shell]
  tool-equivalences:
    claudecode: [Bash]
    codexcli: [shell]
    opencode: [bash]
  commands: [doctor, up, logs, check, test-run]
  changes: [the repository that owns the reproduced defect]
  non-goals: [scaffolding a cockpit, creating programme ceremony, copying environment policy]
  procedure: procedures/fix.md
  review: { mechanical: cockpit-skill-contract, judgment: pending }
  entry-point-lines: 12
claudecode:
  allowed-tools: [Bash]
codexcli:
  dependencies:
    tools: [{ type: executable, value: cockpit, description: Runs accepted cockpit CLI primitives. }]
opencode:
  allowed-tools: [bash]
---

<!-- cockpit:verified version=0.0.0 -->

<!-- SHIPPED SURFACE: guidance for the product in the installed cockpit. -->

# Fix a defect

{{tool-equivalence}}
This is the direct-fix door. It changes only the repository that owns a reproduced defect, and proves the change with the declared test gate before and after.
It does not scaffold a cockpit or copy the environment, tier, or proof decisions that the CLI makes.
Read [procedures/fix.md](procedures/fix.md) beside this skill and follow **Fix** step by step; each step ends on the check that says it is done.
When someone else must set the criteria or grade the result, or the work must carry on in a later session, use cockpit-work instead.
If `check` or the session-start report names drift, follow *On drift* in the cockpit-setup skill's procedure, `../cockpit-setup/procedures/setup.md`, first.
