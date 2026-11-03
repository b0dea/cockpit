---
"@b00dea/cockpit": patch
---

`sync`, `check` and `up` no longer fail with "surface staging cleanup did not complete" when the temporary directory is reached through a symbolic link (macOS with `TMPDIR` unset or set to `/tmp`), and no longer leave `cockpit-surfaces-*` directories behind.
