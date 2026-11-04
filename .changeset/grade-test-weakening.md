---
'@b00dea/cockpit': patch
---

Grading now detects a change that weakens tests: deleted test files, skipped or focused tests, suppressed checks, removed or loosened assertions, and narrowed test configuration, judged against the order's recorded base commits. Under `checks` grading such a change fails until it is acknowledged with the new `work acknowledge` command (`[work.gates] acknowledge`, default `agent`); under `independent` and `self` grading the findings are judged as the `test-changes-justified` criterion instead. `[testing] test_files` declares which files are tests; common layouts are the default.
