# Operator paths

<!-- cockpit:verified version=0.0.0 -->

This contributor decision records when cockpit uses its direct-fix path and when it creates a
durable work order. It is an implementation contract, not a user procedure.

Cockpit supports two execution paths.

Small work uses the direct path: reproduce, fix, verify, and report without creating a work
order. Work that needs independent grading uses an accepted work order. Cockpit may draft
that order from an upstream task or specification, what it can observe in the project, and the
installed skills that apply, but it asks the person only for facts those sources cannot
supply.

A person accepts the draft before cockpit fixes its criteria and its list of files the work may
change. Cockpit then saves the plan, decisions, results, attempts, open questions for a human,
and progress, so a new session can resume without the earlier conversation. Before grading,
cockpit uses the simplification, review, and security-review skills that are installed rather
than duplicating them.

The accepted work order is the fixed contract for doing and grading the work. It does not replace an
upstream specification or programme plan, and its criteria and file list do not change during
execution.
