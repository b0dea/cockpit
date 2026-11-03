---
"@b00dea/cockpit": patch
---

Every `cockpit.toml` field now has an effect, or it is gone.

- Removed fields that nothing read or that had one legal value: `cockpit.guide`; `environment.generated.data.fixtures` `writer`, `stable_key`, `random_seed`, `sweep_scope`, `identity_owner` and `default_small`; `environment.generated.data.modes[].constraints_and_indexes`; the vendor `normalize_empty`, `tls.verification`, and the callback `feature_flag`, `verifier_source`, `order` and `fixture.immutable_raw_bytes`; `environment.generated.decisions.ownership`; `services[].one_shot_failure`; and `workorders.programme_wip_cap`. A configuration that still sets one is refused as an unknown key, so delete the line. A one-shot service still parks when it fails, a programme still holds at most one open work order, and a fixture seed the product reads belongs in the fixture operation's `argv`.
- A sibling guide declared under `guides` that does not exist, other than the default `CLAUDE.md` and `AGENTS.md`, now fails `sync` and `check` with `SIBLING_GUIDE_MISSING`. It used to link nothing and say nothing.
- Browser driver versions accept a semantic-version pre-release, such as the Playwright alpha an MCP image bundles. The runner image must still match `browser.project.driver_version` exactly; the MCP image must share its major.minor.
