---
"@b00dea/cockpit": patch
---

`work grade` now shows the evaluator the files under `workorders/` that the order's scope names. Before, every path under `workorders/` was left out as coordination, so an order whose work lives there, such as a register kept beside the orders, was graded with no changes: the evaluator had nothing to quote, and each `met` verdict read as `unclear`. Files under `workorders/` that the scope does not name, and cockpit's records under `.cockpit/`, stay out. `cockpit grade --criteria` applies the criteria file's scope the same way.

New `work retry --work-order <id> --note <the root cause> --interactive` lets a person grant an order at its attempt cap a fresh set of attempts at its unchanged contract and base, after reading what failed last and the cause. The record keeps the failed count, the cause and, in brief, what failed. It is always a person's step, whatever `[work.gates]` says.

An amendment the agent accepts no longer resets the attempt count, so reordering a list in its own contract cannot undo the cap; one a person or CI accepts still does. The attempt-cap refusal names `work retry`, and `work accept` on an unchanged order now says that nothing changed to amend and what clears the cap, instead of a message that stopped at "unchanged since".
