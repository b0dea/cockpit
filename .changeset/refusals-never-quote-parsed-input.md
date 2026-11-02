---
"@b0dea/cockpit": patch
---

Refusals no longer repeat a parser's message, which could quote the file's contents. An unparseable `package.json` in team metadata, or a `cockpit.toml` an adoption would leave unparseable, is reported with the line and column where parsing stopped, when the parser gives them. A harness evidence manifest that does not parse is reported with its line, column and expected shape. A state inventory entry that fails for an unexpected reason is reported by its system error or error class only. A `package.json` or `.gitignore` that is not valid UTF-8 is named as such.

Refusals that used to drop the filesystem error now name it. This covers a browser screenshot that fails its postcheck, a screenshot artifact root or seeded storage state that cannot be read, and a work grade whose evaluator source or Codex CLI is unavailable.
