---
"@b0dea/cockpit": patch
---

Commands run inside a sandbox such as Codex's `workspace-write` now pass where they can and say why where they cannot.

- `test-run` no longer reports `DEGRADED` with "repository subject … root is unavailable" inside the sandbox. macOS's `git` warned on stderr because cockpit's Git probes ran without `TMPDIR`; they now pass the temporary directory. When a probe does fail, the reason quotes the command and its first stderr line.
- `STATE_ROOT_UNAVAILABLE` names the state root, the directory that failed and the error (for example `EPERM`) instead of "requires an absolute usable home directory". A permission failure says to run the command outside the sandbox or let the sandbox write there.
- `up`, `doctor` and the other lifecycle and health commands forward that refusal instead of reporting `LIFECYCLE_EVIDENCE_INVALID` "state namespace is unavailable" or "doctor observation source is unavailable".
