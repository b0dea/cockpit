---
"@b00dea/cockpit": patch
---

`selftest` no longer throws away a whole approved run when one cell's probe fails. That cell is recorded `human_needed` with the new reason `probe_failed` and what failed and what to do, every other cell is still measured, and the evidence and report are written. The command exits non-zero and its summary leads with each failed cell. A change to the reviewed artifact, configuration, generated manifest, approved executable or guard runtime, an unusable probe directory, or evidence that fails validation still stops the whole run.

Before you approve a run that includes the Claude Code guard probe, `selftest --interactive` now lists every hook registration in the generated `.claude/settings.json` that cockpit did not generate, with its event, matcher and command. Claude Code can run each of them during the probe.
