---
"@b00dea/cockpit": patch
---

`cockpit check` now fails with `POLICY_WEAKENING_UNCONFIRMED` while `[work]`, `[work.gates]` or `[autonomy]` in `cockpit.toml` is weaker than the policy the last sync recorded, instead of leaving the weakening to surface only at the next sync.
