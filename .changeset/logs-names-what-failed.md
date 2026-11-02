---
"@b0dea/cockpit": patch
---

`logs` no longer reports `RUNTIME_UNMEASURED` for failures that have nothing to do with the runtime measurement, and it no longer tells you to run `runtime measure` on a runtime that is already measured.

- A failure to read or parse the logs, such as a record that cannot be redacted safely, now reports `EVIDENCE_UNAVAILABLE` and names the cause.
- When the runtime itself cannot be used, `logs` now reports the actual refusal, including `RUNTIME_UNMEASURED` when the runtime really is unmeasured, instead of `log observation is unavailable`.

The `runtime measure` summary names the configuration file you passed instead of always saying `cockpit.toml`.
