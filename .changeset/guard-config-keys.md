---
"@b00dea/cockpit": patch
---

New `[guards]` keys let an agent work with less waiting while dangerous actions stay refused:

- `secret_paths` declares files and directories, in the cockpit or a sibling, that agents never read, write, search or stage, in every guarded tool. Claude Code's own Read and Edit tools are denied them too.
- `related_checkouts` lets agents read, search and run read-only Git in another checkout, such as the upstream of a tool you install. Writes and other Git commands there stay refused.
- `unresolved = "deny"` refuses instead of asking, keeping the reason and the route, so an autonomous session continues another way.
- `external_writes = "native"` leaves writes outside the cockpit to the agent tool's own permission. Agent and shell configuration, credentials, secret names, guards, Git hooks and scheduled jobs stay refused.

Adding a secret path or refusing unresolved commands narrows and needs no person. The other keys widen and wait for a person's `sync --interactive`.

An ask that a `[[guards.allow]]` entry would admit now names that exact entry. While `cockpit.toml` does not load, an agent may correct it, without touching `[work]`, `[autonomy]` or MCP restrictions, and run `check` or `sync --dry-run`; everything else stays held. A version mismatch between the installed cockpit and the generated guards now says whether to reinstall dependencies or sync. An edit refused because the tool decoded a TOML `\u` escape now says so and how to spell it. The generated Claude Code and Codex hook command is one short line, so refusals no longer print a long shell program. Setup now warns when test output lands in a secret path.
