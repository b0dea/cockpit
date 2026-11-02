---
"@b0dea/cockpit": patch
---

Generated agent surfaces are portable across clones and tolerate the product teams' own edits.

- A projected sibling guide is recorded by sibling and by its path inside that sibling, not by an absolute path, file identity or content digest. Editing, checking out or pulling the sibling's guide, or cloning the workspace to another path, no longer makes `check`, `sync` or `down` refuse with `SURFACE_STATE_CONFLICT`; the agent reads the new guide through the same link. A link replaced by a file or pointed elsewhere is still refused.
- MCP server configs and wrapper scripts no longer contain absolute paths: every harness starts `.cockpit/mcp/<id>.sh` relative to the cockpit root, and the wrapper finds its sibling from its own location, so a clone's `sync` rewrites nothing. Measured with Claude Code 2.1.316, Codex 0.166.0 and OpenCode 1.19.5; start the agent in the cockpit root, as the guard hooks already require.
- MCP wrappers pass `PATH` and the same non-secret variables product test stages receive, so `npx` and other `#!/usr/bin/env node` servers start.
