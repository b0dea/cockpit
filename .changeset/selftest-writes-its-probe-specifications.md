---
"@b0dea/cockpit": patch
---

`cockpit selftest` can now be run: `selftest --config <path> --write-probe-specifications <new file>` writes the probe-specification file it needs for the current `cockpit.toml` and generated manifest.

- The file has one row per cell that needs evidence. cockpit fills what the generated manifest decides, plus the `--version` and `--help` identity commands, and leaves `invocation`, `candidateCode`, `brokenCode` and skill `sample.features` as `null` for you to write. The command prints where each value came from.
- The file no longer carries `specificationsSha256`, so you can edit the rows; approving the whole file's SHA-256 at the `--interactive` prompt is what binds them.
- `selftest` refuses a file that still has a `null` and lists the rows. A missing, malformed or stale file is refused with a fix naming the command that writes a new one.
