---
'@b00dea/cockpit': patch
---

Make pnpm installs work and their diagnostics accurate. A package link is accepted only when it resolves to the exact cockpit copy running. `COCKPIT_LAUNCHER_UNPROVEN` names the route the guard can prove, the package's `bin/cockpit.mjs`, instead of pnpm's shell shim. `COCKPIT_NOT_INSTALLED` says when another copy is running and names both. Install commands in these refusals follow the lockfile present, and `sync` and `check` accept a `file:` pin that pnpm links and `pnpm-lock.yaml` resolves.
