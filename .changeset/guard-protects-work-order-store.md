---
"@b0dea/cockpit": patch
---

The guard denies agent writes, edits and removals under `.cockpit/work-orders/`, `.cockpit/transactions/` and `.cockpit/actors/`. Their records carry no secret, so a contract, state, answer or completion an agent wrote there, signed as the operator, was accepted by the next `cockpit work` command.
