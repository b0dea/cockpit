---
"@b00dea/cockpit": patch
---

Two warnings about the machine rather than the cockpit now appear only where they apply.

- `check` and `doctor` no longer report `CODEX_HOOK_UNTRUSTED` when Codex has never run as this user (no `CODEX_HOME` or `~/.codex`). With no Codex installed, no Codex session can skip the guard hook.
- `STATE_RECORD_MALFORMED` for state folders that other cockpits, usually earlier versions, left behind is reported once by `doctor` with its cleanup command, and no longer on every `up` and `session`.
