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
  procedure: procedures/explain.md
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
Read the generated [procedures/explain.md](procedures/explain.md) beside this skill and follow **Explain**.
Choose only the question-relevant read-only command: `npx --no cockpit doctor --config cockpit.toml`, `npx --no cockpit check --config cockpit.toml`, or `npx --no cockpit preflight --config cockpit.toml`.

This skill changes nothing.
