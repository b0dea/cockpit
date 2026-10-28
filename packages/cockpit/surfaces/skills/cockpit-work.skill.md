---
name: cockpit-work
description: "Use when a change needs a second person to certify it, must survive a handoff, or belongs to a programme, in a cockpit with work orders configured. Experimental; ordinary fixes use cockpit-fix."
targets: ["*"]
cockpit:
  tools: [shell]
  tool-equivalences:
    claudecode: [Bash]
    codexcli: [shell]
    opencode: [bash]
  commands: [work-intake, work-status, work-grade, work-sweep, test-run]
  changes: [the repositories named in the accepted work order's Authority]
  non-goals: [grading its own work, planning inside cockpit, accepting a work order on the human's behalf]
  procedure: procedures/onboarding.md
  review: { mechanical: cockpit-skill-contract, judgment: pending }
  entry-point-lines: 10
claudecode:
  allowed-tools: [Bash]
codexcli:
  dependencies:
    tools: [{ type: executable, value: cockpit, description: Runs accepted cockpit CLI primitives. }]
opencode:
  allowed-tools: [bash]
---

<!-- cockpit:verified version=0.0.0 -->

# Work an order (experimental)

Use `Bash` in Claude Code, `shell` in Codex CLI, or `bash` in OpenCode.
Read the generated [procedures/onboarding.md](procedures/onboarding.md) beside this skill and follow **Work**, starting at its step 0: if nobody besides you must certify the result, stop and use cockpit-fix.
Run `cockpit work-status` for capacity and attempt counts, `cockpit work-intake` to prepare the order, `cockpit test-run` for the declared gate and `cockpit work-grade` to hand off to the evaluator.
Use `cockpit work-sweep` when the work-in-progress cap blocks a new order.

The evaluator subagent grades; this skill never does.
