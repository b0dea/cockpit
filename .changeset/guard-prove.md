---
'@b00dea/cockpit': patch
---

`cockpit guard prove` re-proves the guard after an upgrade or a `[guards]` change, so nobody has to pipe hand-written payloads into the hooks.

- It sends a short standard set of probes, plus the commands in a new `[guards] cases` file (or `--cases <file>`), through every generated Claude Code and Codex hook command, shaped as that harness's own call. It reads each answer back and checks it against the case's optional `expect` (`allow`, `refuse` or `ask`). Codex has no prompt, so there `ask` and `refuse` both mean "not allowed".
- It runs in a scratch clone of the committed cockpit and its siblings, synced from your working `cockpit.toml` for this machine. Your dirty guard files and your branch's upstream can't change the answers. When no valid clone can be made, it runs in your checkout and records the branch, upstream and uncommitted files it saw (`GUARD_PROVE_IN_PLACE`).
- The case file must be a `.json` file inside the cockpit, outside what the guard protects, and a refusal never quotes its contents.
- The report goes to `.cockpit/local/guard-prove/<version>.json` and is compared with the newest report from another version, so a rerun keeps a regression flagged. Each answer that differs from its expectation (`GUARD_PROVE_MISMATCH`), and each case allowed now that was refused before (`GUARD_PROVE_REGRESSION`), gets one line, and the command exits nonzero.
- `doctor` warns when `[guards] cases` is declared and the installed version has no report yet, or its report failed or can't be read.
- `--real-sessions` prints the `claude -p` and `codex exec` commands that would run each probe in a real session, and does not run them: each is a paid model call, and its answer is the model's choice.

Upgrade: after upgrading, run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs guard prove --config cockpit.toml`.
