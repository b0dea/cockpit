---
"@b00dea/cockpit": patch
---

When a session in one checkout names a path in another checkout of the same repository, the refusal now gives advice that works. Under Claude Code it says to move the session there with the EnterWorktree tool, since a Bash `cd` outside the session's directories does not persist; under Codex and OpenCode it says to start the session in that checkout. It no longer says to `cd` there first.
