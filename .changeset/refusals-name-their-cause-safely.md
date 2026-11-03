---
"@b0dea/cockpit": patch
---

Refusals now name their cause the same way everywhere.

- A cause cockpit worded itself is shown in full, including where several commands previously reduced it to `Error`.
- A parser, library or child-process message is no longer copied into a refusal, since it can quote the file or output being read; the refusal names the error class instead, or the line and column for an invalid JSON or TOML file.
- The `STATE_RECORD_MALFORMED` warning about other cockpits' unreadable state folders now tells the agent to ask the person who owns the machine before deleting them.
