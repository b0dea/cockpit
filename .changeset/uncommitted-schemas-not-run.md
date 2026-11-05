---
'@b00dea/cockpit': patch
---

`preflight` and `doctor` no longer run Varlock on a schema Git does not show as committed and unchanged, because loading one runs its resolvers. Such a schema keeps the row passing and warns with `ENV_SCHEMA_UNCOMMITTED`.
