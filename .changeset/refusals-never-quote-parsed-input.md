---
"@b0dea/cockpit": patch
---

A refusal caused by a file that does not parse now names the file, the line and column where parsing stopped when the parser reports them, and the shape it expected. It no longer repeats the parser's message, which could quote the file's contents. This covers `package.json` in team metadata, `cockpit.toml` when an adoption is recorded, state inventory entries, and harness evidence manifests.

Refusals that used to drop the filesystem error now name it. This covers a browser screenshot that fails its postcheck, a screenshot artifact root or seeded storage state that cannot be read, and a work grade whose evaluator source or Codex CLI is unavailable.
