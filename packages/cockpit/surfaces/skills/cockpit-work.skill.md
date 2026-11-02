---
name: cockpit-work
description: "Use when a change needs a second person to certify it, must carry on in a later session, or belongs to a programme, in a cockpit with work orders configured. Review and grading require the Codex CLI; ordinary fixes use cockpit-fix."
targets: ["*"]
cockpit:
  tools: [shell]
  tool-equivalences:
    claudecode: [Bash]
    codexcli: [shell]
    opencode: [bash]
  commands: [work intake, work status, work accept, work renew, work record, work answer, work execute, work review, work grade, work sweep, work reverse, test-run]
  changes: [the repositories named in the accepted work order's Authority]
  non-goals: [grading its own work, planning inside cockpit, accepting a work order, answering a gap or recording a decision on the human's behalf]
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

# Work an order

Use `Bash` in Claude Code, `shell` in Codex CLI, or `bash` in OpenCode.
Read the generated [procedures/onboarding.md](procedures/onboarding.md) beside this skill and follow **Work**, starting at its step 0: if nobody besides you must certify the result, stop and use cockpit-fix.
Run `npx --no cockpit work status --config cockpit.toml --json` for capacity and attempt counts, `npx --no cockpit work intake --config cockpit.toml --intent <intent-file> --candidate <draft-file> --json` to prepare the order, `npx --no cockpit work execute --config cockpit.toml --work-order <id> --approach <text> --json` to check each Plan step, `npx --no cockpit work review --config cockpit.toml --work-order <id> --json` for the independent reviews and `npx --no cockpit work grade --config cockpit.toml --work-order <id> --json` to pass it to the evaluator.
When the work-in-progress cap blocks a new order, `npx --no cockpit work sweep --config cockpit.toml` previews what a sweep would park; a person applies it, accepts or renews an order, and answers a gap or records a decision with `work answer`.

The evaluator subagent grades; this skill never does.
