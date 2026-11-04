---
'@b00dea/cockpit': patch
---

`work grade`, `cockpit grade` and `test-run` now fail a change that weakens tests: deleted test files, skipped or focused tests, suppressed checks, removed or loosened assertions, and narrowed test configuration, judged against the order's recorded base commits. A person acknowledges a legitimate change with the new `work acknowledge` command (`[work.gates] acknowledge`, default `person`). `[testing] test_files` declares which files are tests; common layouts are the default.
