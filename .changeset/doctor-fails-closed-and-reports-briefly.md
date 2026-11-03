---
"@b00dea/cockpit": patch
---

`doctor` now exits 2 when `cockpit.toml` is missing or invalid, instead of exiting 0 with an unavailable verdict. Its human output is a short report, one line per area with the commands that show the detail, instead of thousands of lines, and `--json` reports whether the generated files are current (`freshness.local` holds the check's kind, status and diagnostics) instead of embedding the complete check result.
