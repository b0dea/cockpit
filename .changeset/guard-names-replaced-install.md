---
'@b00dea/cockpit': patch
---

After a package manager installs cockpit at a new path, as pnpm does on an upgrade, a guard hold no longer reports the earlier version as the installed one or says sync is not the fix: it names both versions and the sync command. `doctor` reports the state as `GUARD_HANDLER_SUPERSEDED`.
