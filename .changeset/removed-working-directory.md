---
'@b00dea/cockpit': patch
---

A shell left in a directory that was removed, such as a worktree after `git worktree remove`, no longer has every call refused: the guard judges its calls from the cockpit root, so `cd` back into a checkout works.
