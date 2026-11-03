---
'@b00dea/cockpit': patch
---

The guard now admits `jq` reading files as read-only, like `cat`, unless the filter reads the environment or a module, or the command writes.
