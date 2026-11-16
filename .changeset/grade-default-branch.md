---
"@b00dea/cockpit": patch
---

**Fixed:** a work-order grade no longer counts the default branch's work merged into the order's branch as the order's change. A file still exactly as the last merged default-branch commit (`origin/HEAD`) has it is left out of the grade, its scope check and its test-protection check; a file the order also edited still counts.

A change inside another open order's scope is also left to that order when that order was accepted from this order's base or an earlier one, since its grade sees all of the change; one an order accepted later could not see stays this order's.
