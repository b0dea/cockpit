---
"@b00dea/cockpit": patch
---

`[surfaces] tools` in cockpit.toml lists the agent tools `sync` writes and `check` compares. It defaults to Claude Code, Codex and OpenCode, the tools whose guard is measured; Cursor and Grok Build are written only when listed. A list names at least one of the guarded tools.

- `npx --no cockpit tool add <tool> --config cockpit.toml` and `tool remove` edit that list (with `--dry-run` to preview). The next sync writes an added tool's files; a removed tool's files go through the stale-removal approval.
- Doctor and check report Codex hook trust only when Codex is listed, and sibling instruction findings name only layouts that leave a listed tool without instructions.
- `init --target` takes one tool or a comma-separated list (`--target claudecode,opencode`) and writes it as `[surfaces] tools`; the first tool gets the setup skill before the interview, and the final sync writes every chosen tool. Readiness reports Codex hook trust only for a cockpit that lists Codex.
- `workorders.evaluators`, left unset, is the listed tools that can evaluate, in their order, so a cockpit that lists only Claude Code grades with Claude Code and doctor does not ask for Codex.
