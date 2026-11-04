---
"@b00dea/cockpit": patch
---

`cockpit use` now grants the agent tools a checkout outside the declared one, so they no longer prompt or refuse edits there. Claude Code gets it in `.claude/settings.local.json` (`use` keeps everything else in that file and `use --clear` removes only the entry it added), and OpenCode gets it in its machine-local grant file, which `sync` now keeps. Codex has no machine-local setting for this, so `use` tells you to start it with `--add-dir <checkout>`; Cursor and Grok Build get nothing and `use` says so. `--json` reports the tools as `agentGrants`. `use` also refuses with `EVIDENCE_UNAVAILABLE` when the declared checkout exists but cannot be resolved, instead of guessing its path, and `pull` reports a checkout whose repository cannot be resolved with `PULL_SKIPPED` under its label, where it used to report it as missing.
