---
"@b00dea/cockpit": patch
---

The bundled surface generator is now Rulesync 43.4.2. OpenCode MCP tool switches in `opencode.jsonc`
now use the names OpenCode itself gives tools, with every character other than a letter, digit,
`_` or `-` in the server or tool name replaced by `_`. Before, a `disabledTools` entry on a server
such as `web.search` was written as `web.search_fetch.page`, which OpenCode never matched, so the
tool stayed enabled. When two switches reduce to the same name, the one that disables now wins.
`cockpit check` reports the rewritten `opencode.jsonc` as drift until `cockpit sync` runs. The Claude
Code and Codex CLI surfaces are unchanged.
