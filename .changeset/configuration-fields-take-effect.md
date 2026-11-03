---
"@b00dea/cockpit": patch
---

Every `cockpit.toml` field now has an effect, or it is gone.

- Removed `cockpit.guide`, which nothing read. A configuration that still sets it is refused as an unknown key, so delete the line.
- A sibling guide declared under `guides` that does not exist, other than the default `CLAUDE.md` and `AGENTS.md`, now fails `sync` and `check` with `SIBLING_GUIDE_MISSING`. It used to link nothing and say nothing.
- Browser driver versions accept a semantic-version pre-release, such as the Playwright alpha an MCP image bundles. The runner image must still match `browser.project.driver_version` exactly; the MCP image must share its major.minor.
