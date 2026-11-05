---
'@b00dea/cockpit': patch
---

`sync` and `check` no longer spend time describing every byte of a generated file they read, which took about 67 ms for each 128 KiB.
