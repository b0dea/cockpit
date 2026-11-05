---
'@b00dea/cockpit': patch
---

Validate env schemas the way they are documented. The probe adds `env/.secrets/<cockpit name>/<slug>` as a second `--path` when it exists, checks every tracked `.env.schema` in a sibling and the cockpit root's own, reads the checkout `cockpit use` serves, finds a linked worktree's gitignored store in its main checkout, and ignores inherited `_VARLOCK_*` variables. Only the required-empty message means missing. Any other key error, such as a signed-out or unreachable secret provider, makes the row unavailable with a sign-in remedy, where it used to read as an invalid key. Keys the caller's shell satisfied raise the new `ENV_SCHEMA_OVERRIDDEN` warning, and a missing Varlock is a recommended readiness gap, not a required one.

`doctor` and `preflight` run a schema's resolvers, so review schema changes as you review code.
