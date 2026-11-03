---
"@b00dea/cockpit": patch
---

`doctor` and `init` now warn when a sibling repository's root instruction files leave some agent tool without its instructions: Codex and OpenCode load `AGENTS.md`, Claude Code loads `CLAUDE.md`, and files such as `.cursorrules` or `GEMINI.md` reach none of them. The warnings are `SIBLING_INSTRUCTIONS_AGENTS_ONLY`, `SIBLING_INSTRUCTIONS_CLAUDE_ONLY`, `SIBLING_INSTRUCTIONS_UNLINKED`, `SIBLING_INSTRUCTIONS_MISSING` and `SIBLING_INSTRUCTIONS_TOOL_ONLY`, grouped under the `sibling-instructions` readiness gap.

`setup` proposes the two fixes that need no judgement and makes them only with the new `--write-instruction-files` flag, which a person runs after reviewing them: a sibling with only `AGENTS.md` gets a `CLAUDE.md` reading `@AGENTS.md`, and a sibling whose lone `CLAUDE.md` imports nothing else has it moved byte for byte into `AGENTS.md` and replaced by that import. The shipped setup procedure walks an agent through the cases that need a person.
