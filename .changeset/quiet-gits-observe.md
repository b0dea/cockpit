---
"@b00dea/cockpit": patch
---

Keep surfaces-only `sync` and `check` working through Git activity and in checkouts only setup needs to be strict about: a plain `git status` no longer refuses them, a repository-local include is accepted, and a `.git` entry Git rejects or Git missing from `PATH` makes the directory standalone with a `GENERATED_CHECKOUT_STANDALONE` warning. A checkout observation interrupted by Git activity now retries, then says so, instead of reporting unsupported configuration origins or an invalid worktree inventory.
