---
"@b00dea/cockpit": patch
---

Correct the Varlock guidance with measured behaviour. `--redact-stdout` does not cover Varlock's own errors, which can print source lines and a failing resolver's command and stderr. Env files are evaluated when loaded, so a migrated value holding `$(...)` runs a command, even in double quotes; only single quotes keep it literal. Cockpit's schema probes already keep only key names and status, and their behaviour does not change.
