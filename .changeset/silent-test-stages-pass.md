---
"@b0dea/cockpit": patch
---

`test-run` judges a stage by its exit status alone. A stage that exits 0 having printed nothing, such as `tsc --noEmit`, `node --check` or a quiet linter, now passes instead of reporting DEGRADED, so it can satisfy a gate. A run blocked by a stopped stack names only the stack, and the `TEST_GATE_UNSATISFIED` fix says what to do for each verdict: fix the product for FAIL, start the stack, make the stage command runnable, raise its timeout or declare its `select` arguments for DEGRADED, rerun VOID once the checkouts stop changing, and run the complete gate for PARTIAL.
