---
"@b00dea/cockpit": patch
---

**Fixed:** a work-order grade no longer counts the default branch's work merged into the order's branch as the order's change. A file still exactly as the last merged default-branch commit (`origin/HEAD`) has it is left out of the grade, its scope check and its test-protection check; a file the order also edited still counts.
