---
name: cockpit-setup
description: "Use when the user wants to add a repository to, upgrade, or diagnose a cockpit that is already installed, or to set up test users and signed-in browser state. A repository with no cockpit yet is adopt-cockpit's job."
targets: ["*"]
cockpit:
  tools: [shell]
  tool-equivalences:
    claudecode: [Bash]
    codexcli: [shell]
    opencode: [bash]
  commands: [init, document, sync, check, doctor, up, preflight, upgrade, sibling]
  changes: [cockpit configuration and generated harness surfaces after preview]
  non-goals: [parsing registries, deciding environment policy, claiming an unproved installation]
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

# Set up and maintain an installed cockpit

Use `Bash` in Claude Code, `shell` in Codex CLI, or `bash` in OpenCode.
Read the generated [procedures/onboarding.md](procedures/onboarding.md) beside this skill and follow the section that matches the request: **Add a repository** (`cockpit sibling`), **After upgrading cockpit** (`cockpit upgrade`, then a human runs `cockpit sync --interactive`), or **Diagnose** (`cockpit doctor`, `cockpit check`, `cockpit preflight`).
**Bootstrap** (`cockpit init`, `cockpit document`, `cockpit up`) is what the first install ran; a repository that has never run locally follows **Create a local setup**.
For test users, roles and signed-in browser state, read `references/test-data-and-personas.md`. Read the identity-provider reference it names only when the lockfile shows that provider.

Preview every proposed mutation and obtain explicit confirmation before irreversible work.
The init command owns durable resume and final environment checks; show its actual result and any pending proof.
