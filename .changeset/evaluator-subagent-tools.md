---
"@b00dea/cockpit": patch
---

`sync` now writes a tool list into Claude Code's evaluator subagent definition: `Read`, `Grep`, `Glob` and exactly the browser tools the cockpit lets Claude Code call (every tool of the `playwright` server, or those `[mcp.allowed_tools]` lists for it). Claude Code refuses the subagent's file writes and shell commands, so under `[work] grading = "subagent"` its read-only is enforced there; the capability matrix records the measurement. Codex and OpenCode definitions are unchanged, and the verdict the working agent relays is still its word.
