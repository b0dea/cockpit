---
"@b00dea/cockpit": patch
---

The generated guard hook registrations for Claude Code (`.claude/settings.json`) and Codex (`.codex/hooks.json`) now state a 30-second `timeout` instead of inheriting each harness's default; on a heavily loaded machine Codex reported a guard call as timed out after 5 seconds. Run `sync` to regenerate them; Codex asks you to trust the changed hooks again.
