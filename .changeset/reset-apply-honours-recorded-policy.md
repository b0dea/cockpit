---
"@b00dea/cockpit": patch
---

`reset --apply` now decides by the autonomy policy `sync` recorded, as sync and the work commands do: when `cockpit.toml` weakens `[autonomy] reset` (for example from `person` to `agent`) and no person has accepted that weakening at `sync --interactive`, it refuses with `POLICY_WEAKENING_UNCONFIRMED` and resets nothing. It used to read the edited `cockpit.toml` and apply.
