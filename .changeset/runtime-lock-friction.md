---
"@b00dea/cockpit": patch
---

A runtime command killed while it held cockpit's state lock no longer blocks every later `session`, `up` and `test-run`: the next command takes the lock over once the holder's process is gone from this host, and reports `STATE_LOCK_RECLAIMED`. A lock written on another host, from inside a container or sandbox, or by an earlier release is still refused.

A command that finds the state lock busy now waits a few seconds instead of failing at once, and `STATE_LOCKED` names the holder's process and command.

`cockpit session` tells you to run `sleep` after a failed run only when an earlier `up` from your own checkout still holds the stack, not when another checkout holds it.

`preflight` and `doctor` warn (`GIT_WORKING_TREE_DIRTY`) about uncommitted changes in the cockpit instead of failing; a repository with no commits still fails.

When a failed service's logs cannot be collected, the error names the `cockpit logs --service <name>` command that shows them.

`cockpit env keys` marks the names a schema writes no value for, and the missing-variable error points at `env keys` to find them.
