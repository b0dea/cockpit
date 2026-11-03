---
"@b00dea/cockpit": patch
---

Work orders are one front-matter contract with a short lifecycle, and `cockpit.toml` says who takes each decision cockpit gates.

- A work order is `workorders/<id>.md`. Its YAML front-matter (`id`, `objective`, `scope`, `depends_on`, `gates`, `criteria` with an optional `check` and `source` each, `non_goals`) is the whole contract; the Markdown body is free notes cockpit never reads. One schema validates it and names each field it refuses.
- The commands are `work status`, `accept` (also accepts a changed contract), `check`, `note` (`--ask` records an open question), `answer`, `grade`, `signoff` (`--partial` or `--abandon` with a note), `recover` and `verify`. An order moves draft, accepted, checked, graded, done; `status` also shows stale, blocked, partial and abandoned. `work grade` reports every change outside `scope`, which fails the grade. `work intake`, `renew`, `resume`, `execute`, `record`, `review`, `sweep`, `reverse`, `programme-mint` and `metrics` are gone, with intent descriptors, source audits, programmes and review lanes.
- `cockpit grade --criteria <file>` grades uncommitted work against a criteria file with the independent evaluator, and records nothing.
- `[work]` replaces `[workorders]` and adds `grading`: `independent` (an evaluator grades, the default), `checks` (done only when cockpit ran every criterion's check and all passed) or `self` (the agent reports met or unmet with a note). The record, `work status` and `doctor` say how each order closed. `work.evaluators` is the ordered list of evaluator tools.
- `[work.gates]` sets who passes `accept`, `amend`, `answer` and `signoff`: `agent`, `person` (the digest typed after `--interactive`, refused as `WORK_PERSON_REQUIRED` without a terminal) or `ci` (counts once the required `work verify` job passes). Removing or rewriting an accepted criterion always needs a person.
- `[autonomy]` sets who may run a writing `sync`, remove stale generated files, apply `reset --apply` and approve MCP servers, with `preset = "agent"` defaulting every unset field to `agent`. The guard denies an agent's edit of `[work]`, `[work.gates]` or `[autonomy]`, and of `[mcp]` while a person approves servers. A sync that finds a weaker policy than the one it last recorded in `.cockpit/policy.json` writes nothing until a person types its digest (`POLICY_WEAKENING_UNCONFIRMED`).
- The Claude Code and Codex hooks run `cockpit check` as a session starts, so the agent sees drift and its fix first; Codex runs it once a person trusts the new hook. A stale sibling guide copy names the guide, and its fix is to sync and commit `AGENTS.md` with the guide change.

