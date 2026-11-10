---
'@b00dea/cockpit': patch
---

The guard now proves a cockpit command started by Node's absolute path, such as `/opt/homebrew/bin/node ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --dry-run`, as it proves the same command started by bare `node`. Before, it took that Node binary for the cockpit launcher itself, so the proof failed and an agent's `sync --dry-run` asked as a person's command even under `[autonomy] sync = "agent"`. The absolute path counts only when it is the `node` in a directory the agent's command search path names, spelled as that entry spells it. A `node` anywhere else, an interpreter option before the script, or a script other than the installed launcher still asks, and a `sync` while `cockpit.toml` holds an unapproved widening edit is still refused.
