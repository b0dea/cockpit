---
"@b00dea/cockpit": patch
---

`selftest` runs with one command: `cockpit selftest --config cockpit.toml --interactive`. With no `--probe-specifications`, it writes fresh probe specifications for that run to a new file under the ignored `.cockpit/local/probes`, shows the same approval as before, bound to that file's digest, and runs. Each run writes its own file, so one from before an upgrade or a `cockpit.toml` edit is never reused. Without `--interactive`, or with `--json` or in CI, it still refuses and writes nothing. Keeping specifications under review in your tree works as before with `--write-probe-specifications` and `--probe-specifications`.

`--write-probe-specifications <file> --replace` writes over an existing file, and the `OUTPUT_EXISTS` refusal names it, so you no longer invent new file names after every upgrade.

When the guard was installed by `sync` under another Node than the one running an interactive `selftest` (a Node version manager in one shell and another Node in the next), `selftest` now says it is rerunning under the guard's Node and runs again under it, with the same arguments and the same terminal for the approvals. It does so only when that Node is still at the recorded path with the SHA-256 `sync` recorded; otherwise, or when the run is not interactive, it refuses with `SELFTEST_GUARD_IDENTITY_MISMATCH` as before. `doctor`'s `GUARD_NODE_DIFFERS` note says so too.

The docs and the setup skills now say plainly that cockpit is usable once `check` passes and that `selftest` is optional native evidence a person runs when they want it; agents no longer treat it as an adoption step.
