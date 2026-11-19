---
'@b00dea/cockpit': patch
---

An agent's `upgrade` now waits for a person at `npx --no cockpit approve` instead of installing, and every upgrade ends with the steps that follow it.

- Run from Claude Code, Codex or OpenCode, `upgrade` resolves the release, installs nothing and records the step for approve (`UPGRADE_PERSON_REQUIRED`). Its output says to run `npx --no cockpit approve` in the cockpit root, in a terminal outside the agent. The person's screen names both versions and the install command; on `y` it installs with `SAFE_CHAIN_MINIMUM_PACKAGE_AGE_EXCLUSIONS=@b00dea/cockpit` set for that install alone, so Safe Chain's minimum package age check skips cockpit and nothing else. Nobody types the variable, and the agent never has it.
- The output ends with `next:` lines in order: start a branch first (`git switch -c cockpit-<version> origin/<default>`) when the tree was dirty, the branch has no upstream or it is the default branch; commit exactly the files the upgrade changed, named by path; then run `check` and `doctor`. An agent sees the branch line before its approve step, since a dirty tree can stop a later `git switch`.
- `upgrade --commit` stages exactly the files the upgrade changed, by path, and commits them as `chore: upgrade cockpit to <version>` with the repository's hooks. It refuses before installing while anything else is staged (`UPGRADE_COMMIT_REFUSED`), and commits nothing when a changed file already held edits (`UPGRADE_COMMIT_FAILED`). An agent's `upgrade --commit` leaves the commit to the person's approve too, which shows the exact files before staging them.
