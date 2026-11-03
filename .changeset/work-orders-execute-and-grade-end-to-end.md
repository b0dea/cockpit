---
"@b00dea/cockpit": patch
---

Work orders can now be executed, reviewed and graded end to end.

- `work review` and `work grade` work with the real Codex CLI: the evaluator output schemas are closed, as OpenAI structured outputs require. When the Codex CLI is missing, exits with an error or times out, the refusal names the cause it reported instead of saying a review is required. `doctor` warns with `EVALUATOR_UNAVAILABLE` when a cockpit has work orders but `codex` is not on `PATH`.
- Each review and grading run has its own budget, `workorders.evaluator_timeout_seconds`, instead of one shared five-minute deadline.
- Declared verification commands in `work execute`, `work grade` and review reruns run like product test stages: judged by exit status, with the end of long output kept, the same non-secret variables, and `workorders.verification_timeout_seconds` to run. A failing command reports `Declared verification failed with exit N` with its output tail, and reaches the grader as "failed after execution".
- A grade that does not pass returns each criterion's outcome and reasons and is kept with the order (`WORK_GRADE_UNSATISFIED`). A `work execute` step whose verification fails returns the attempt (`WORK_EXECUTION_PAUSED`).
- `test-run` returns its verdict and observations for every verdict; anything but PASS exits non-zero with `TEST_GATE_UNSATISFIED`.
- `test-run --select` no longer appends `--select kind:value` to stage commands, which stock runners reject. A stage declares a `select` table of arguments per kind in its tool's own spelling, with `{value}` replaced; a stage without one for the selected kind reports DEGRADED instead of running unselected.
- `work execute --work-order` runs the selected order when several accepted orders are active.
- `work metrics` records creation history for an order published as a near-copy of its draft or of another order.
- Progress event files under `workorders/events/` no longer make earlier step proof stale.
- The grader receives the evaluator instructions without cockpit's maintainer notes.
- Work, browser and test commands print their result without `--json`.
