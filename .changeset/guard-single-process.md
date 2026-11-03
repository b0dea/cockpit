---
"@b00dea/cockpit": patch
---

The guard now authenticates and evaluates in one Node process instead of dispatching a second handler process per tool call, and it asks Git once per checkout instead of repeating identical probes. Run `npx --no cockpit sync` to regenerate `.cockpit/guards/bash-guard.sh`.
