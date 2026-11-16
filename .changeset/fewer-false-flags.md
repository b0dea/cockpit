---
"@b00dea/cockpit": patch
---

Three false alarms are gone.

**Fixed:** a `jq` filter that only mentions `env` inside a string, such as `test("local|env")`, is no longer refused as printing the environment; `env`, `$ENV` and `\(env…)` in the filter's code still are. `doctor` no longer warns about the team settings kept under `cockpit/adopted/`, which sync merges into the root's. The message for a stack with no recorded bring-up now says that a stack started by an earlier release counts as not yet up, and that `up` fixes it.
