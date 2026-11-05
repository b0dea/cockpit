---
"@b00dea/cockpit": patch
---

`doctor` and `check` now check Codex hook trust against the hooks file Codex actually loads in a bare repository's worktree, a submodule, a checkout with a separate Git directory and a cockpit root outside Git: the directory's own `.codex/hooks.json`. They used to report `CODEX_HOOK_UNTRUSTED` as unverified in those layouts, which no trust could clear. A linked worktree whose shared Git directory is named `.git` still sources its hooks from the original checkout.
