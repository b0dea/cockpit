---
"@b00dea/cockpit": patch
---

A session whose shell was left in a removed linked worktree outside the checkout's roots is no longer locked out. The `cd` back to the checkout, file tools given full paths and, from a worktree of this repository, any call that names no `..` are judged from the checkout. Other calls from a directory the guard does not run in are refused with the `cd <directory> && ` prefix that runs them.

The worktree bind now also checks cockpit's regions of shared files in the main checkout, such as `AGENTS.md`, against what its last sync recorded, as it already did for whole files.

Fix texts that told an agent to do what it cannot now say who acts and give one runnable line: the worktree bind's refusals name the real sync line, upgrade's approve, the stale-claim `down` and `up`, an unresolved MCP command and a missing local guard registration print `cd <root> && …`, and writes to `.claude/settings.local.json` are named as a person's. Every hand-off to a person's approve now reads `cd <root> && npx --no cockpit approve` in a terminal outside the agent.
