---
"@b00dea/cockpit": patch
---

The generated `.claude/settings.json` now allows, by prefix, the cockpit commands the shipped skills tell an agent to run and the guard admits, such as `test-run`, `check` and `doctor`. Claude Code's default mode previously refused them in a headless session. Person-only commands such as `sync`, `down` and `work accept` still prompt, the guard hook still decides first, and Claude Code applies the rules only once a person has trusted the workspace.

The shipped Fix procedure is now a direct fix: run the declared gate before and after the change, with no intake or source audit. The guides say which cockpit commands a Codex user runs outside Codex's sandbox, that the person commits the cockpit repository, and use `--target <tool>` instead of one tool's target.

The vendor-specific identity-provider starter is no longer written into every cockpit; its two general lessons (confirm the roles the provider instance exposes, sign in through the provider's own test helper without a second token helper) are now in the test-data reference.
