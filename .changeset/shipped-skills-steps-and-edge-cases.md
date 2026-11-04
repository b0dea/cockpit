---
"@b00dea/cockpit": patch
---

The shipped skills now walk an agent through numbered steps that each end on a check, and handle the cases the CLI really reaches: a guard prompt that Codex and OpenCode turn into a denial, a guard that holds every call after `cockpit.toml` changes or cockpit is reinstalled, Codex's sandbox, a resumed or refused `init`, readiness gaps, a missing evaluator, stale and blocked work orders, person gates, and a stack that will not start. Corrected claims: `tool add --dry-run`, `sibling add` and `setup --write-*` are commands the guard asks about; a removed tool's files are deleted by `sync` as `[autonomy] stale_delete` allows, with a digest only when it refuses; after a manual `npm install` of a new release, a person runs `sync` in a terminal; `--instruction-pointer` opts a sibling in before `setup` shows the block. Every procedure invokes cockpit through `./node_modules/.bin/cockpit`, which runs where the guard cannot prove `npx`.
