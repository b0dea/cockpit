---
"@b0dea/cockpit": patch
---

Generated agent surfaces are portable across clones and tolerate the product teams' own edits.

- A projected sibling guide is recorded by sibling and by its path inside that sibling, not by an absolute path, file identity or content digest. Editing, checking out or pulling the sibling's guide, or cloning the workspace to another path, no longer makes `check`, `sync` or `down` refuse with `SURFACE_STATE_CONFLICT`; the agent reads the new guide through the same link. A link replaced by a file or pointed elsewhere is still refused.
- MCP server configs and wrapper scripts no longer contain absolute paths: every harness starts `.cockpit/mcp/<id>.sh` relative to the cockpit root, and the wrapper finds its sibling from its own location, so a clone's `sync` rewrites nothing. Measured with Claude Code 2.1.316, Codex 0.166.0 and OpenCode 1.19.5; start the agent in the cockpit root, as the guard hooks already require.
- MCP wrappers pass `PATH` and the same non-secret variables product test stages receive, so `npx` and other `#!/usr/bin/env node` servers start.
- Sibling grants now reach the sibling. Codex resolves a relative `writable_roots` entry from `.codex/`, so the grant is written relative to that directory. OpenCode matches `external_directory` against absolute paths only, so the committed pattern reads the sibling's directory from a machine-local file that `sync` writes under `.cockpit/local/`; OpenCode refuses to start, naming that file, until `sync` has run on the machine.
- An MCP server missing from `[mcp].approved` is listed in Claude Code's `disabledMcpjsonServers`, because Claude Code ignores `disabled` in `.mcp.json` and offered the server for one-click approval. `sync` and `check` now print `MCP_NOT_APPROVED` for it.
- A changed core original under an overlay's `replaces.sha256` pin stops `sync` and `check` with `OVERRIDDEN_CORE_CHANGED`, naming the current digest; `sync --dry-run` and `doctor` still preview it.
- A rules overlay with Rulesync frontmatter (`root: false`, `globs: ["**/*"]`) no longer fails every sync; a rule that narrows itself with `globs` is refused as `SURFACE_RULE_SCOPE_UNSUPPORTED`, because cockpit writes rules overlays into the always-loaded instruction file. A generator failure now leads with the generator's own error.
- Going over `cockpit.guide_cap` reports `GUIDE_CAP_EXCEEDED` with the measured lines, the harness and the cap, from `sync`, `check` and `preflight`, including when a linked sibling guide grows past it.
- `preflight` names why it could not read a running stack (for example `GENERATED_ENVIRONMENT_UNAVAILABLE` for a `cockpit.toml` edit that was not synced) instead of a bare `LIFECYCLE_EVIDENCE_INVALID`.
- `check` tells you to run `sync --interactive` in a terminal for a formerly generated path, since plain `sync` refuses to remove it without a person's approval.
- The Claude plugin bundle carries the references its `cockpit-setup` skill tells the agent to read.
