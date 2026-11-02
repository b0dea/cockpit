---
"@b0dea/cockpit": patch
---

`cockpit selftest` no longer asks you to fill probe rows for custom harness cells that it never ran.

- `--write-probe-specifications` writes rows for built-in tools only, and warns `SELFTEST_CUSTOM_PROBE_UNSUPPORTED` for each custom harness cell it left out, naming the cell and why. Before, it wrote a `{node}` row for each custom cell, and `selftest` recorded that cell `human_needed` whatever you put in the row.
- `selftest` records each custom cell `human_needed` with `enforcement_probe_required` without a row, and refuses a probe-specification file with a custom row, naming each one.
- What breaks: a filled probe-specification file that has custom rows is refused. Delete those rows, or write a new file.
