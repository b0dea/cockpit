---
name: cockpit-fix
description: "Use when a named bug, failing test, wrong value or stack trace needs fixing in a repository of an installed cockpit, and no second person must certify the result."
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
  entry-point-lines: 15
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
Read the generated [procedures/fix.md](procedures/fix.md) beside this skill and follow **Fix**.
Run the declared gate with `npx --no cockpit test-run --config cockpit.toml --gate <gate>` before and after the change. Route through `npx --no cockpit doctor --config cockpit.toml`, `npx --no cockpit logs --config cockpit.toml --service <service>`, and `npx --no cockpit check --config cockpit.toml` as the defect requires. Use `npx --no cockpit up --config cockpit.toml` only for behavior that depends on a live process or integration.

This is the direct-fix door. It changes only the repository that owns a reproduced defect.
It does not scaffold a cockpit or copy the environment, tier, or proof decisions that the CLI makes.

If a second person must certify this, use cockpit-work instead.
If `check` or the session-start report names drift, follow *On drift* in the cockpit-setup skill's procedure, `../cockpit-setup/procedures/setup.md`, first.
