---
"@b00dea/cockpit": patch
---

An applied `sync` now says what it did: each file written or removed, how many generated files were already current, and that the written files are to be committed. The first sync after init lists `.cockpit/policy.json`, the policy record it creates. Confirming a trust answer now tells the person to run `sync --interactive` and to delete the answer's `# Unconfirmed` comment with its entry.

The `cockpit:*` package scripts run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs`, which the guard can prove under pnpm; `sync` replaces the bare `cockpit` scripts earlier releases wrote. `doctor` no longer reports `COCKPIT_LAUNCHER_UNPROVEN` for pnpm's `.bin` shell shim, which no one can make provable, and reports `ENVIRONMENT_NOT_DECLARED` as information for a cockpit that deliberately declares no runtime, as `init` does.

`TEAM_METADATA_UNAVAILABLE` names the `package.json` entry that conflicts (a version pin, an unresolved archive pin or a `cockpit:*` script the product already uses) and the command to run. `env schema --path` also takes the schema's directory (`api:services/web`, `api:`, `.`), so an agent whose secret guard refuses any command containing `.env` can still write a schema.
