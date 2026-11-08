---
"@b00dea/cockpit": patch
---

`selftest` now measures Claude Code guard firing when the team's own hooks sit beside cockpit's guard in `.claude/settings.json`. It previously stopped with `SELFTEST_EXECUTION_INVALID: probe execution could not establish guard-firing for Claude Code` and no reason. The broken control now replaces only cockpit's guard command, found by the exact command `sync` generated, so the team's hooks run unchanged under both controls. If one of them refuses a probe command, the failure names the registration and the hook's reason and asks for the probe's two commands to be let through, keeping the hook in place.

Every other `SELFTEST_EXECUTION_INVALID` from a probe now says what failed and what to do, such as an unrecognised `--version` output, a step that could not start, or a missing generated `CLAUDE.md` import. The cockpit-setup skill now tells agents that a person approves by answering yes at the terminal prompt that shows the digest, rather than by entering a digest.
