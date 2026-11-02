---
"@b0dea/cockpit": patch
---

Generated agent surfaces are portable across clones and tolerate the product teams' own edits.

- A projected sibling guide is recorded by sibling and by its path inside that sibling, not by an absolute path, file identity or content digest. Editing, checking out or pulling the sibling's guide, or cloning the workspace to another path, no longer makes `check`, `sync` or `down` refuse with `SURFACE_STATE_CONFLICT`; the agent reads the new guide through the same link. A link replaced by a file or pointed elsewhere is still refused.
