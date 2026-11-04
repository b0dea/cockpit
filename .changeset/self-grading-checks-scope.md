---
"@b00dea/cockpit": patch
---

`work grade` under `[work] grading = "self"` now runs the order's checks and compares its `scope`, as
`independent` and `checks` already did, and a failed check or a change outside scope fails the grade.
Before, an agent's own `met` closed an order whose check failed or whose diff reached files the order
never allowed.
