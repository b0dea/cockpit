---
"@b00dea/cockpit": patch
---

New `cockpit approve` replaces every `--interactive` approval. When an agent's run needs a person (a sync that widens what agents may do or enables an MCP server, a reset or prune that deletes data with no seed, or a person's work-order step), the command says so and keeps the step. The person then runs `npx --no cockpit approve` in a terminal outside the agent. It shows each waiting step on a short screen: what it does, why it needs them, and one line per detail. They answer `y` to apply it, `n` to skip it, or `d` to see the details in full. Each step is checked again against the current state before it is shown. No digest to type.

Upgrade: drop `--interactive` from `sync`, `reset`, `stacks prune`, `work accept`, `work signoff`, `work acknowledge` and `work retry` in scripts and notes; run the command plainly, then `npx --no cockpit approve`. `init --interactive` is unchanged.
