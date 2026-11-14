---
"@b00dea/cockpit": patch
---

Fewer steps and fewer rules nothing used.

**Changed:**

- A team's own `.claude/settings.json`, `.codex/config.toml` or `.codex/hooks.json` is adopted by moving it to `cockpit/adopted/<the same path>`. Every `sync` merges what is there. `sync --adopt` and the `[[surfaces.adopted]]` rows are gone.
- `preflight` and `doctor` warn about an env schema gap (`ENV_SCHEMA_UNHEALTHY`) instead of failing on it.
- A work order spends an attempt only on a grade with an `unmet` verdict. A failed check no longer counts, and `work check` records nothing. `checks` and `off` grading have no attempt cap.
- `browser drive` and `browser screenshot` work on any version of a listed agent tool, not only the versions measured in August.
- A skill you add needs only a `name` and a `description`. The other skill metadata fields, the line cap and the one-procedure rule no longer apply to your skills.
- A provenance needs only `source` and `reason`. `observed_on` and `kind` are optional.
- Bootstrap records of checkouts that no longer exist are removed from the machine state directory.

**Removed:** custom harnesses (`[[surfaces.harnesses]]`), the Claude plugin bundle (`[surfaces] bundles`), `[testing] native_hooks` and `native_hook_policy`, and an unused internal helper.

Upgrade: delete every `[[surfaces.adopted]]` row from cockpit.toml and keep the files under `cockpit/adopted/`; also delete `native_hooks` and `native_hook_policy` from `[testing]`, and any `[[surfaces.harnesses]]` or `bundles`, if present; then a person runs `cockpit sync --interactive`.
