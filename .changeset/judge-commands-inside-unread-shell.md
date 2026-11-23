---
'@b00dea/cockpit': patch
---

Shell the guard does not read is no longer left to the agent tool when a command inside it would be refused: a secret or the whole root read or archived through `eval`, `bash -c`, `script`, an unknown wrapper or `xargs` asks again, as it did before 0.1.36.
