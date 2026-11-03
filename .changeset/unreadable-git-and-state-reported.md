---
"@b00dea/cockpit": patch
---

Git or state read failures no longer leave a check silently clean.

- A repository Git refuses to read, such as one owned by another user (`safe.directory`), is reported as unchecked with the command a person may run to trust it, instead of as committing no secret files or as no Git working tree.
- `doctor` says when it could not read the machine's cockpit state, instead of silently dropping its check for other cockpits' unreadable state.
- The Codex hook trust warning names why `config.toml` could not be read, such as a file over the size bound, instead of "unknown error".
