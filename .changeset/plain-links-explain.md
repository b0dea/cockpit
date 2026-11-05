---
"@b00dea/cockpit": patch
---

Make pnpm installs work and their diagnostics accurate. `COCKPIT_LAUNCHER_UNPROVEN` now names the route the guard can prove, the package's `bin/cockpit.mjs`, instead of recommending pnpm's shell shim. `COCKPIT_NOT_INSTALLED` says when another copy of cockpit is running, names both copies, and gives the install command of the package manager whose lockfile is present. `sync` and `check` accept a `file:` pin that pnpm links and `pnpm-lock.yaml` resolves.
