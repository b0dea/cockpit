---
"@b00dea/cockpit": patch
---

An order's grade no longer judges another open order's work. A long-lived order's grade diffed the whole tree, so it failed with `WORK_TEST_WEAKENED` for test files a later order deleted. A changed path outside an order's `scope` and inside another open order's accepted `scope` is now that order's: the grade, `work acknowledge` and `test-run` leave it out of the change, `outOfScope` and test protection, and list it under `otherOrders`. A path in the order's own scope, or one that differs between the two orders' bases, stays its own. `cockpit grade` with a `scope` does the same. An order whose grade left changes to an order that then closed partial or abandoned must be graded again before it closes as done, and once it has closed done, the order holding those changes closes partial or abandoned only through a person or CI.
