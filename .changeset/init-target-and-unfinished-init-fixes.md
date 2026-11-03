---
"@b00dea/cockpit": patch
---

`INIT_TARGET_CHANGED` carries a fix: resume the init with the target it was started with, or, after asking the person who owns the machine, delete the named state file that holds only that init's progress and start again with the new target. A plain `sync` that meets a setup file an unfinished init published, which no longer holds what that init recorded, says so and names the `init` command that resumes it.
