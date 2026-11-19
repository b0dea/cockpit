---
'@b00dea/cockpit': patch
---

A work order grade that a cockpit or machine error ends before it judges the product no longer spends an attempt. A check that could not run, an evaluator that could not run or whose answer could not be read, a change that could not be read, or a locked order now answers `WORK_GRADE_INTERRUPTED` with the error and its fix, and the order's record and `work status` keep it under `interrupted`. A check that times out, prints too much or names a command file the work removed still fails the grade.

When the grader's quote is not found in what it cites, the grade now says to quote the evidence verbatim from that source.

The cockpit-explain skill maps a pasted guard refusal to its rule and the spelling that runs instead.
