---
"@b00dea/cockpit": patch
---

`runtime measure` no longer removes the running probe of a concurrent measure from another worktree or terminal. It decided whether an earlier measure was still running from directories in its own temporary directory, which agent tools set per session, so a second measure could not see the first and force-removed its probe containers. Probe resources now carry a `dev.b0dea.cockpit.probe-owner` label naming the measuring process, and only resources whose process is gone are removed.
