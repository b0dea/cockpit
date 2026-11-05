---
'@b00dea/cockpit': patch
---

`[work] grading` gains two choices, so every way of grading is supported and documented. `subagent` records a verdict the working agent relays from a read-only subagent it spawned, closes as `subagent-reported` and says cockpit cannot verify it; with nothing submitted, `work grade` runs a separate evaluator instead. `off` makes the grader optional: orders are tracked and close as `ungraded` whatever their checks showed, with those facts kept on the record. Moving to either from a stronger mode needs a person, as moving to `self` does.

`init` now asks `work.grading`, proposing a value from the listed tools it finds on `PATH` with its reason. An answers file that omits it stops at that question. Existing cockpits keep their value. `doctor` now reports whether `independent` or `subagent` can run here before any work order exists, and no longer warns about evaluators under `checks`, `self` or `off`. A grade by the tool running the command, with no other tool passed over, now warns (`EVALUATOR_IS_RUNNING_TOOL`).
