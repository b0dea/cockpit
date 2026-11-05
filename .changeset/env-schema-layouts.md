---
"@b00dea/cockpit": patch
---

Validate env schemas the way they are documented. The probe adds the central resolver directory as a second `--path`, checks every tracked `.env.schema` in a sibling and the cockpit root's own, and ignores inherited `_VARLOCK_*` variables. A key a provider could not resolve now makes the row unavailable, with a sign-in remedy, instead of invalid; only the required-empty message means missing. Keys the caller's shell satisfied raise the new `ENV_SCHEMA_OVERRIDDEN` warning, and a missing Varlock is a recommended readiness gap rather than a required one.
