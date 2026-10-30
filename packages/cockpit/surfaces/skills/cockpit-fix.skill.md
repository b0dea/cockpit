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
  commands: [doctor, up, logs, check]
  changes: [the repository that owns the reproduced defect]
  non-goals: [scaffolding a cockpit, creating programme ceremony, copying environment policy]
  procedure: procedures/onboarding.md
  review: { mechanical: cockpit-skill-contract, judgment: pending }
  entry-point-lines: 14
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

Use `Bash` in Claude Code, `shell` in Codex CLI, or `bash` in OpenCode.
Read the generated [procedures/onboarding.md](procedures/onboarding.md) beside this skill and follow **Fix**.
Route through `cockpit doctor`, `cockpit logs`, and `cockpit check` as the defect requires. Use `cockpit up` only for behavior that depends on a live process or integration.

This is the direct-fix door. It changes only the repository that owns a reproduced defect.
It does not scaffold a cockpit or copy the environment, tier, or proof decisions that the CLI makes.

If a second person must certify this, use cockpit-work instead.
