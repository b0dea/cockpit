---
"@b00dea/cockpit": patch
---

An applied `reset` now prints what it removed and that the next `up` recreates the volumes and runs `environment.seed` where one is declared; it used to print nothing. `--json` carries the removed targets as `result.targets`.
