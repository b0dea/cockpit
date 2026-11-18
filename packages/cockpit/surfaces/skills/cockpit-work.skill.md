---
name: cockpit-work
description: "Use when someone names a work order, or a change must be held to criteria someone else set, graded by something other than you, or carried across sessions, in a cockpit with work orders. Ordinary fixes use cockpit-fix."
targets: ["*"]
cockpit:
  tools: [shell]
  tool-equivalences:
    claudecode: [Bash]
    codexcli: [shell]
    opencode: [bash]
  commands: [work status, work accept, work check, work note, work decide, work answer, work acknowledge, work grade, work signoff, work retry, work recover, docs check, test-run]
  procedure: procedures/work.md
  entry-point-lines: 9
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

{{tool-equivalence}}
Read [procedures/work.md](procedures/work.md) beside this skill and follow **Work** from step 0, which resumes an existing order at the step its state names.
Under independent grading another agent tool grades the order; never grade your own work.
When a command answers `WORK_PERSON_REQUIRED`, stop and ask the person to run `npx --no cockpit approve` in a terminal outside the agent: never answer it for them.
If `check` or the session-start report names drift, follow *On drift* in the cockpit-setup skill's procedure, `../cockpit-setup/procedures/setup.md`, first.
