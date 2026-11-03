---
"@b0dea/cockpit": patch
---

An interrupted restore, and Git or state read failures, no longer leave a stack wedged or a check silently clean.

- A restore records the process running it. When that process dies mid-restore, the next `up`, `sleep`, `down` or `reset` releases its reservation instead of refusing `CLAIM_CO_TENANT` until the state was edited by hand, and warns with `RESTORE_INTERRUPTED` that the stack's data may be partially restored. A running restore still blocks, and the refusal names its process and how to recover.
- A repository Git refuses to read, such as one owned by another user (`safe.directory`), is reported as unchecked with the command a person may run to trust it, instead of as committing no secret files or as no Git working tree.
- `doctor` says when it could not read the machine's cockpit state, instead of silently dropping its check for other cockpits' unreadable state.
- The Codex hook trust warning names why `config.toml` could not be read, such as a file over the size bound, instead of "unknown error".
