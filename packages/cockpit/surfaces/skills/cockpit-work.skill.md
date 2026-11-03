---
name: cockpit-work
description: "Use when a change must be held to criteria someone else set, graded by something other than you, or carried across sessions, in a cockpit with work orders. Ordinary fixes use cockpit-fix."
targets: ["*"]
cockpit:
  tools: [shell]
  tool-equivalences:
    claudecode: [Bash]
    codexcli: [shell]
    opencode: [bash]
  commands: [work status, work accept, work check, work note, work grade, work signoff, test-run]
  changes: [the files the accepted work order's scope names]
  non-goals: [grading its own work under independent grading, passing a gate the policy gives a person, editing the policy in cockpit.toml]
  procedure: procedures/work.md
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

# Work an order

Use `Bash` in Claude Code, `shell` in Codex CLI, or `bash` in OpenCode.
Read the generated [procedures/work.md](procedures/work.md) beside this skill and follow **Work**; if nobody else sets the criteria, stop and use cockpit-fix.
Write `workorders/<id>.md`, then run `npx --no cockpit work accept --config cockpit.toml --work-order <id>`, `npx --no cockpit work check --config cockpit.toml --work-order <id>`, `npx --no cockpit work grade --config cockpit.toml --work-order <id>` and `npx --no cockpit work signoff --config cockpit.toml --work-order <id>`.
`npx --no cockpit work status --config cockpit.toml --json` says each order's state and how it closed; record questions with `npx --no cockpit work note --config cockpit.toml --work-order <id> --ask --text <question>`.
When a command answers `WORK_PERSON_REQUIRED`, stop and ask the person: never type a digest for them.
If `check` or the session-start report names drift, follow *On drift* in the cockpit-setup skill's procedure, `../cockpit-setup/procedures/setup.md`, first.
