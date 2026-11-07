---
"@b00dea/cockpit": patch
---

Allow bounded worktree inventories, file checksums and reads of package documentation through confined links. Require complete reviewed commands with an explicit working directory and fresh path evidence when extending the read-only profile to external locations, without granting writes or overriding native permissions.

Upgrade: a person reviews external read commands under guards.allow and runs cockpit sync; native permissions still apply.
