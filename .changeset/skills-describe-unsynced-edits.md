---
"@b00dea/cockpit": patch
---

The shipped cockpit skills now describe what the guard does after an edit of `cockpit.toml`: an edit that does not widen what agents may do is judged as written and the agent may sync it where `[autonomy] sync = "agent"`; one that widens, such as adding or removing a repository or removing an agent tool, is judged under the configuration last synced until a person runs `sync --interactive` and confirms it. They no longer tell agents that every edit holds every guarded call. Run `sync` to regenerate the skills.
