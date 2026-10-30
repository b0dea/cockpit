---
"@b0dea/cockpit": minor
---

<!-- cockpit:verified version=0.0.0 -->

Initial public release.

- One validated `cockpit.toml` declares a product's sibling repositories, services, ports, guards and MCP servers.
- `cockpit sync` generates the Docker Compose stack and agent instructions, skills, subagents, hooks and permissions for Claude Code, Codex CLI and OpenCode, with `--dry-run` previews. Cursor and Grok Build files are generated but not yet verified against those tools.
- `cockpit check` fails when a generated file no longer matches the configuration, locally or in CI.
- `setup`, `up`, `session`, `sleep`, `down`, `reset`, `preflight`, `doctor` and `logs` run the stack on your live checkouts, with port leases and holders so one agent cannot stop another agent's stack.
- One guard policy blocks pushes to protected branches, edits to environment and secret files, and commands against declared hosted databases or vendor hosts.
- `cockpit init` and `cockpit document` start a cockpit from scratch or from an existing shell-based setup, marking every inferred value for review.
- Experimental: work orders graded by a separate evaluator, browser checks, and `upgrade` plans.
