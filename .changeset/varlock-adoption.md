---
'@b00dea/cockpit': patch
---

Make environment access an explicit setup decision even without a schema. `init` and `doctor` recommend Varlock with `ENV_SCHEMA_UNDECLARED` when a root holds dotenv or template files and no `.env.schema`, reading file names and types only, within a bounded scan. Every cockpit Varlock probe and setup or recovery command sets `VARLOCK_TELEMETRY_DISABLED=true`, and raw Varlock diagnosis stays with a person while agents get key names and validation only. Existing scoped authorization is reused rather than asked for twice.

The environment-file denial now points at a command that runs: an agent uses a declared project command that wraps Varlock, and a person in a terminal runs it without `--redact-stdout`, which Varlock refuses there. The documented Claude Code shell workaround for dotenv documentation files was disproved and removed; those files stay denied under the broad secret rule until a safe replacement passes native probes.
