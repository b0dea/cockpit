---
'@b00dea/cockpit': patch
---

Two failures on a heavily loaded machine are gone. `session` no longer ends with `EXECUTION_TERMINATION_UNCONFIRMED` when the command leaves a slow-to-stop process behind, such as a dev server started in the background: what the command left is now always killed before cockpit gives up on it. And `up` joining a stack another session holds reads a running service a second time before refusing it as stopped, since the first Docker read can fail while the container is healthy.
