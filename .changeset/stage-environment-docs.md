---
"@b00dea/cockpit": patch
---

The configuration reference and the test-run docs now say that a stage does not get variables from the shell that runs `test-run`, so a gate's result does not depend on who ran it, and how to give a stage a value it needs: set it at the start of its command, as `["env", "STEP_TIMEOUT=3600", "pnpm", "selftest"]`.
