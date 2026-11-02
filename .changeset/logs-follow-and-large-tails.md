---
"@b0dea/cockpit": patch
---

`logs --follow` and large `--tail` reads now return records.

- `--follow` is no longer cut off by the ten-second budget of an ordinary read, which made it fail with `EXECUTION_TIMEOUT` and no records. It collects until it is interrupted (exit 130 with the records collected), the container stops, or two hours pass.
- A read whose output exceeds the 1 MiB limit (64 KiB for stderr) no longer fails with `EXECUTION_STDOUT_LIMIT` and no records. It returns the newest whole records that fit, sets `truncated: true` in the JSON result and warns with `LOGS_TRUNCATED`.
