---
"@b00dea/cockpit": patch
---

On a busy machine, measuring an explicit native hook's cost no longer times out after 10 seconds and reports `native hook cost execution failed: EXECUTION_TIMEOUT`. The measurement now has 60 seconds, so a hook over its `native-hook-ms` cap is reported as one to move to CI.
