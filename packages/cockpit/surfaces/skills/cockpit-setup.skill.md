---
name: cockpit-setup
description: "Use when the user wants to add a repository to, upgrade, or diagnose a cockpit that is already installed, to make a repository's AGENTS.md and CLAUDE.md reach every agent tool, or to set up test users and signed-in browser state. A repository with no cockpit yet is adopt-cockpit's job."
targets: ["*"]
cockpit:
  tools: [shell]
  tool-equivalences:
    claudecode: [Bash]
    codexcli: [shell]
    opencode: [bash]
  commands: [init, setup, sync, check, doctor, up, preflight, upgrade, sibling, tool]
  changes: [cockpit configuration and generated harness surfaces after preview]
  non-goals: [parsing registries, deciding environment policy, claiming an unproved installation]
  procedure: procedures/setup.md
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
Read the generated [procedures/setup.md](procedures/setup.md) beside this skill and follow the section that matches the request: **Add a repository** (`npx --no cockpit sibling add <slug> --config cockpit.toml`), **Add or remove an agent tool** (`npx --no cockpit tool add <tool> --config cockpit.toml`), **Make a repository's instructions reach every tool** (`npx --no cockpit setup --config cockpit.toml`), **After upgrading cockpit** (run `npx --no cockpit upgrade --config cockpit.toml` (`--dry-run` previews); or by hand, install the new release with `npm install --save-dev --save-exact @b00dea/cockpit@<version>`, then ask a human to run `npx --no cockpit sync --config cockpit.toml --interactive`), or **Diagnose** (`npx --no cockpit doctor --config cockpit.toml`, `npx --no cockpit check --config cockpit.toml`, `npx --no cockpit preflight --config cockpit.toml`).
**Bootstrap** (`npx --no cockpit init . --target <tool>`, `npx --no cockpit up --config cockpit.toml`) is what the first install ran; a repository that has never run locally follows **Create a local setup**.
For test users, roles and signed-in browser state, read `references/test-data-and-personas.md`.

Preview every proposed mutation and obtain explicit confirmation before irreversible work.
The init command resumes after an interruption and runs the final environment checks; show its actual result and anything still unconfirmed.
