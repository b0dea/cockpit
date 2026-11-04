---
name: cockpit-setup
description: "Use when a repository or agent tool joins or leaves an installed cockpit, cockpit is upgraded, check or doctor reports drift or a gap to repair, a repository's AGENTS.md and CLAUDE.md must reach every agent tool, a repository has never run locally, or test users and signed-in browser state need setting up. A directory with no cockpit yet is adopt-cockpit's job."
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

# Set up and maintain an installed cockpit

{{tool-equivalence}}
Before running any command, read [procedures/setup.md](procedures/setup.md) beside this skill: its **Running cockpit** section, then the one section the request needs, followed step by step.
- Drift named by `check` or the session-start report: **On drift**, before anything else.
- A repository or an agent tool joins or leaves: **Add or remove a repository**, **Add or remove an agent tool**.
- A repository's AGENTS.md and CLAUDE.md must reach every tool: **Make a repository's instructions reach every tool**.
- A repository that has never run locally: **Create a local setup**; secrets and `.env.schema`: **Secret handling**.
- A new cockpit release: **After upgrading cockpit**. A gap or refusal to repair: **Diagnose**.
- An interrupted or unfinished `init`: **Bootstrap**, rerun with the same root and target. A directory with no cockpit yet is the adopt-cockpit skill's job.
- Test users, roles and signed-in browser state: `references/test-data-and-personas.md`, a product change that needs the person's permission first.
Show the person every proposed change and get their explicit yes before writing to `cockpit.toml` or a product repository, or accepting a digest.
