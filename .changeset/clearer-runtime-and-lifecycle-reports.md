---
"@b0dea/cockpit": patch
---

Several runtime and lifecycle reports now say what actually happened.

- When Docker Engine or Docker Compose prints a version with no numeric X.Y.Z core, `up` and `runtime measure` say which tool printed what, and the fix is to install a release that prints one. The fix used to be "start the configured container runtime", which was already running.
- When `up` refuses because a running stack's declaration changed, the message names the file that changed (for example `compose.yml`, or `[ports]` in `cockpit.toml`) instead of always naming `cockpit.toml`.
- A successful `baseline-record` prints the version, stack and time it recorded. It used to print nothing.
- When a long-running command keeps only the tail of its output, the tail now starts at a whole UTF-8 character, so the first character is no longer garbled.
