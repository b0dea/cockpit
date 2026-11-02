# Operator paths

<!-- cockpit:verified version=0.0.0 -->

This contract is for contributors: when cockpit takes its direct-fix path and when it creates a
durable work order. It is an implementation contract, not a user procedure.

| Path | Used for | Steps |
|---|---|---|
| Direct | Small work | Reproduce, fix, verify and report, with no work order. |
| Accepted work order | Work that needs independent grading | Draft, human acceptance, execution, grading, as below. |

Cockpit may draft a work order from an upstream task or specification, what it observes in the
project, and the installed skills that apply. It asks the person only for facts those sources
cannot supply.

A person accepts the draft before cockpit fixes its criteria and the list of files the work may
change. Cockpit then saves the plan, decisions, results, attempts, open questions for a human and
progress, so a new session can resume without the earlier conversation. Before grading, cockpit
uses the installed simplification, review and security-review skills rather than duplicating them.

The accepted work order is the fixed contract for doing and grading the work: its criteria and
file list do not change during execution. It does not replace an upstream specification or
programme plan.
