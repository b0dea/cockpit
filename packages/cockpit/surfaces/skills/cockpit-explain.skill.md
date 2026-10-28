---
name: cockpit-explain
description: "Use when someone asks what an installed cockpit does, why it refused or flagged something, or which command to run next, and nothing should change."
targets: ["*"]
cockpit:
  tools: [shell]
  tool-equivalences:
    claudecode: [Bash]
    codexcli: [shell]
    opencode: [bash]
  commands: [doctor, check, preflight]
  changes: [nothing]
  non-goals: [editing configuration, starting services, repairing drift]
  procedure: procedures/onboarding.md
  review: { mechanical: cockpit-skill-contract, judgment: pending }
  entry-point-lines: 11
claudecode:
  allowed-tools: [Bash]
codexcli:
  dependencies:
    tools: [{ type: executable, value: cockpit, description: Runs accepted cockpit CLI primitives. }]
opencode:
  allowed-tools: [bash]
---

<!-- cockpit:verified version=0.0.0 -->

# Explain an installed cockpit

Use `Bash` in Claude Code, `shell` in Codex CLI, or `bash` in OpenCode.
Read the generated [procedures/onboarding.md](procedures/onboarding.md) beside this skill and follow **Explain**.
Choose only the question-relevant read-only command: `cockpit doctor`, `cockpit check`, or `cockpit preflight`.

This skill changes nothing.
