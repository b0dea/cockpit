---
"@b0dea/cockpit": patch
---

Rewriting the `cockpit selftest` probe-specification file after a config change keeps the probes you wrote.

- `selftest --write-probe-specifications <new file> --probe-specifications <earlier file>` copies each complete row from the earlier file whose cell still exists, and reports how many it kept. Rows for new or changed cells, and rows still partly `null`, start over. Before, the only way forward from a stale file was a new file with every row reset to `null`.
- The refusal for a stale file now names that command.
