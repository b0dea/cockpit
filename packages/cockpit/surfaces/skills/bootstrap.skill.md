---
name: bootstrap
description: "Use when starting, adopting, extending, or diagnosing a cockpit from an agent harness."
targets: ["*"]
cockpit:
  tools: [shell]
  tool-equivalences:
    claudecode: [Bash]
    codexcli: [shell]
    opencode: [bash]
  commands: [init, document, sync, check, doctor, up, preflight]
  changes: [cockpit configuration and generated harness surfaces after preview]
  non-goals: [parsing registries, deciding environment policy, claiming an unproved installation]
  procedure: procedures/onboarding.md
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

# Bootstrap a cockpit

Use `Bash` in Claude Code, `shell` in Codex CLI, or `bash` in OpenCode.
Read the generated [procedures/onboarding.md](procedures/onboarding.md) beside this skill and follow **Bootstrap**.
Start with `cockpit init` using one explicit root and harness target. Compose `cockpit document`, `cockpit sync`, `cockpit check`, `cockpit doctor`, `cockpit up`, and `cockpit preflight` only when that procedure reaches them.

Preview every proposed mutation and obtain explicit confirmation before irreversible work.
The init command owns durable resume and final environment checks; show its actual result and any pending proof.
