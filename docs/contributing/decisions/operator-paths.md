# Operator paths

<!-- cockpit:verified version=0.0.0 -->

This contributor decision records when cockpit uses its direct-fix path and when it creates a
durable work order. It is an implementation contract, not a user procedure.

Cockpit supports two execution paths.

Small work uses the direct path: reproduce, fix, verify, and report without creating a work
order. Work that needs independent grading uses an accepted work order. Cockpit may compile
that order from an upstream task or specification, live estate evidence, and applicable
installed capabilities, but it asks the operator only for facts the available sources cannot
establish.

The operator accepts the draft before cockpit freezes its criteria and authority. Cockpit
then persists the plan, decisions, evidence, attempts, human gaps, and progress needed for a
fresh session to resume without relying on a previous conversation. Before grading, cockpit
uses available simplification, review, and security-review capabilities rather than
duplicating them.

The accepted work order is the stable execution-and-grading contract. It does not replace an
upstream specification or programme plan, and its criteria and authority do not move during
execution.
