---
"@b00dea/cockpit": patch
---

`work review` and `work grade` can run the independent reviewers and grader in Claude Code (`claude --print`) or OpenCode (`opencode run`) as well as the Codex CLI. `workorders.evaluators` is an ordered list (default `["codexcli", "claudecode", "opencode"]`): the first tool that runs answers, and one that is missing, signed out, rate-limited or timed out is passed over and recorded. Each run starts fresh in a private directory, held read-only by the tool's own mechanism, and its answer is checked against the role's output schema whichever tool gave it; an answer that fails is refused, never retried with another tool. A refusal names each tool's cause and fix, and `doctor` warns when no listed tool is on `PATH` rather than always about `codex`.
