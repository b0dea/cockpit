---
'@b00dea/cockpit': patch
---

Validate the environment schema of the checkout `cockpit use` serves rather than the declared directory, and find a linked worktree's gitignored `env/.secrets` store in its main checkout, so a worktree no longer reports every provider-backed key as missing.
