---
"@b00dea/cockpit": patch
---

`setup` now refuses with `SETUP_REMOTE_UNRESOLVABLE` when a sibling's declared remote, or an existing checkout's origin, is a relative local path that cannot be resolved (for example it passes through a regular file, loops through symlinks, or is unreadable). The message names the remote and the error code. Previously the error escaped, setup's lifecycle record stayed `started`, and `doctor` and `preflight` lost the cause.

`doctor` and `preflight` now include the underlying error when they cannot issue their observation source.
