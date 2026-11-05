---
"@b00dea/cockpit": patch
---

Check Codex hook discovery against the original checkout before checking trust in linked worktrees. Report missing or different source hooks separately, and name the actual source when matching hooks need human trust review.

Upgrade: if a linked worktree reports CODEX_HOOK_SOURCE_MISMATCH, review and roll out matching hooks in the original checkout, then trust that source in interactive Codex.
