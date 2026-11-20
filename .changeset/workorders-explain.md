---
'@b00dea/cockpit': patch
---

A work order grade that a cockpit or machine error ends before it judges the product no longer spends an attempt. A check that could not run, an evaluator that could not run or whose answer could not be read, a change that could not be read, or a locked order now answers `WORK_GRADE_INTERRUPTED` with the error and its fix, and the order's record and `work status` keep it under `interrupted`. A gate left DEGRADED only by the environment (no running stack, a stage command cockpit could not start, or an undeclared selection) counts as interrupted too, and `grade --criteria` no longer shows the evaluator a check that could not run. A check or stage that times out, prints too much or names a command file the work removed still fails the grade, and so does a gate the checkouts changed under.

When the grader's quote is not found in what it cites, the grade now says to quote the evidence verbatim from that source.

The cockpit-explain skill maps a pasted guard refusal, as the guard words it now, to its rule and the spelling that runs instead.

When an agent leaves a step for a person, its message now gives one line to copy, `cd <root> && npx --no cockpit approve`, and says to run it in a terminal of their own, not with `!` in the agent session, which cannot take their answer. `approve` refused inside an agent session says the same.
