---
'@b00dea/cockpit': patch
---

An agent that changes into a linked worktree where nobody has installed and synced cockpit no longer loses its shell: the checkout above the worktree judges its calls until `sync` runs there, admitting only `cd` and `pwd`, so the agent can leave. Before, every later call was refused, including the `cd` back out, and only a person could recover the session.
