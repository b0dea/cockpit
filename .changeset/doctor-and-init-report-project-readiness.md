---
"@b00dea/cockpit": patch
---

`doctor` and `init` now say what the project still lacks for cockpit to work, before the first `up` and without guessing.

- Before the first bring-up, while the stack sleeps, and (in `doctor`) for a cockpit that declares no runtime, `doctor` and `preflight` run every check that needs no running stack (Git state, sibling presence, the machine floor, the runtime measurement, the env schema, the generated surfaces) and report the rest as not applicable. `STATE_UNSEEDED`, `STACK_NOT_RUNNING` or `ENVIRONMENT_NOT_DECLARED` is listed first instead of replacing every check, and `preflight` still never passes in those states. A container runtime that is missing then is reported as `RUNTIME_UNAVAILABLE` with a fix.
- `doctor --json` carries `result.readiness`, and the human report has one line per gap. It groups the reported diagnostics under the prerequisites cockpit depends on, each with why cockpit needs it and whether it is required (refused by the command that needs it) or recommended. Every `init` stop carries the same `result.readiness`, the preview included.
- New warnings: `COCKPIT_NOT_INSTALLED` when cockpit is not installed in the cockpit root or the guard hook runs a copy outside it (every new cockpit, because `init` runs from a temporary install); `SIBLING_REMOTE_UNRECORDED` when a sibling is its own Git repository but `cockpit.toml` records no remote, so a teammate's `setup` cannot obtain it; `SECRET_FILE_TRACKED` when a repository commits a `.env`-style file, named by path only and never read. `init` also warns `SETUP_PATH_TYPE_INVALID` when the cockpit root is not in a Git working tree.
- `check` and `sync` report a declared sibling that is absent as `SIBLING_MISSING`, with how to obtain it, instead of `GENERATED_SIBLING_ROOT_INVALID` with a raw `realpath ENOENT`.
- The setup skill's onboarding procedure walks the human through each readiness gap and asks before touching a product repository. The documented `init` stops now include `STATE_UNSEEDED`.
