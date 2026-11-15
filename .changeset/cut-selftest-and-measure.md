---
"@b00dea/cockpit": patch
---

Two person-run steps are gone.

**Removed:**

- `cockpit selftest`. What each agent tool loads and enforces is measured by the cockpit maintainers and published in the capability matrix (`docs/capability-matrix.md`); nothing on your machine needs to run or approve a probe.
- `cockpit runtime measure` and the check that refused until it had run. `up`, `session`, `down` and `reset` no longer wait for a measurement of this machine's runtime.

**Changed:** every command that runs the stack checks that Docker answers and that Docker Compose is 2.35.0 or later, and refuses with one `RUNTIME_UNAVAILABLE` that names the cause and the fix. `doctor` and `preflight` report the same before the first `up`.

Upgrade: stop running `cockpit selftest` and `cockpit runtime measure`, and remove them from any script, CI job or `[[guards.allow]]` rule that names them. Delete `.cockpit/local/probes/` and `machine/runtime-measurements.json` under cockpit's state directory if you want the space back; nothing reads them. `[environment.machine]` is unchanged.
