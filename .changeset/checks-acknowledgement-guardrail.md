---
"@b00dea/cockpit": patch
---

Under `[work] grading = "checks"`, acknowledging a test weakening is a person's or CI's step even where `[work.gates] acknowledge = "agent"`, because no model reads the change and the acknowledgement alone passes the `test-protection` check. An agent's `work acknowledge` there is refused with `WORK_PERSON_REQUIRED` unless the gate is `ci`, and an acknowledgement the agent recorded under another grading mode no longer passes the check. Under `independent`, `subagent` and `self` grading the field works as before.
