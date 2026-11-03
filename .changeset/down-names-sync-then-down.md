---
"@b00dea/cockpit": patch
---

When the generated files no longer match `cockpit.toml`, for example after upgrading cockpit, `down` and `reset` still refuse rather than hand Compose a file cockpit did not render from the current declaration, but the refusal now says nothing was stopped and prints the whole recovery: run `sync`, then `down`.
