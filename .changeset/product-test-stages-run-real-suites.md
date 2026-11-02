---
"@b0dea/cockpit": patch
---

Product test stages can now run real suites under a build tool.

- Each `[testing]` stage takes an optional `timeout_seconds`; the default is far longer than the previous fixed limit. A stage that runs out of time reports that it timed out and names the field to raise.
- Output past the capture limit no longer makes a stage DEGRADED: cockpit keeps the tail and judges the stage by its exit status. A stage that exits non-zero now reports FAIL instead of DEGRADED.
- Stages receive `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE` and `TZ` from the calling environment, so tools that keep caches under the home directory work. Every other variable is still withheld.
