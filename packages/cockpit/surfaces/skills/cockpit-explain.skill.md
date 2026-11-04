---
name: cockpit-explain
description: "Use when someone asks what an installed cockpit does, what a diagnostic or refusal means, or which command to run next, and wants an answer rather than a change."
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
  procedure: procedures/explain.md
  review: { mechanical: cockpit-skill-contract, judgment: pending }
  entry-point-lines: 7
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

{{tool-equivalence}}
Read [procedures/explain.md](procedures/explain.md) beside this skill and follow **Explain**: answer from what `doctor`, `check` or `preflight` reports now, quoting it.
This skill changes nothing. When the answer is a change, name the command and who runs it, and leave the change to the person or to the skill that owns it: cockpit-setup for configuration and drift, cockpit-fix for a product defect.
