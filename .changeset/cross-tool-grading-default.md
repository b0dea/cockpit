---
'@b00dea/cockpit': patch
---

When `work.evaluators` is not set, `work grade` and `cockpit grade` now try the other listed agent tool first and the tool running the command last, detected from `CLAUDECODE` or `CODEX_THREAD_ID`. A declared list is used as written.

`work grade` and `grade --criteria` accept `--evaluator <tool>` to grade one run with only that tool, with no fallback.
