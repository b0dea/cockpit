---
"@b00dea/cockpit": patch
---

`work review` and `work grade` can run the independent reviewers and grader in Claude Code (`claude --print`) or OpenCode (`opencode run`) as well as the Codex CLI: set `workorders.evaluator` to `claudecode`, `opencode` or `codexcli` (the default). Each run starts fresh in a private directory, held read-only by the tool's own mechanism, and its answer is checked against the role's output schema whichever tool gave it. A missing or signed-out tool is refused naming the install or sign-in command, and `doctor` warns about the selected tool rather than always about `codex`.
