---
"@b00dea/cockpit": patch
---

`sync` now copies each active sibling's guides into cockpit's region of the root `AGENTS.md`, under a heading naming the sibling, instead of linking them through `.sibling-*` symlinks, `CLAUDE.local.md` imports, a "read this file" line for Codex and the `opencode.jsonc` `instructions` list. Measured on 2026-11-03, the copy is the one route Claude Code, Codex and OpenCode all load: Claude Code skipped the linked guide in a workspace it had not trusted and Codex only ever saw the line pointing at it. The capability matrix records the runs.

A copy goes stale when a sibling edits its guide: `check` and `preflight` then report `GENERATED_ARTIFACT_DRIFT` naming each out-of-date `<sibling>/<guide>` until a person runs `sync` and commits `AGENTS.md`, so a guide edit reaches later agent sessions only after review. `GUIDE_CAP_EXCEEDED` now also fires when cockpit's region of `AGENTS.md` passes 32768 bytes, past which Codex silently drops the rest. A guide containing cockpit's own instruction region markers is refused.

Upgrade: run cockpit sync --interactive and approve removing the `.sibling-*` links and the cockpit region of `CLAUDE.local.md`, then commit `AGENTS.md`.
