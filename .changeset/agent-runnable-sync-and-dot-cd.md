---
"@b00dea/cockpit": patch
---

Sync refusals that point at the installed cockpit now print the exact line to run, `cd <checkout> && ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml`, and say "in a terminal" only where the guard would stop an agent running it. In a linked worktree whose main checkout is synced, they also name the bind to that checkout's cockpit.

Under Claude Code, `cd .name && …` is no longer refused when CDPATH is empty: the shell resolves it from the working directory, so the guard judges it as `cd ./.name`. A non-empty CDPATH, Codex and OpenCode keep the old behaviour.
