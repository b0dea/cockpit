# Capability matrix

<!-- cockpit:verified version=0.0.0 -->

This generated matrix is for users checking what each harness can enforce, instruct or cannot provide. Shipped owner facts retain their evidence strength. Native and operator judgments remain pending where stated.

Source manifest: `9a2d4385670cbec71f2f5d8dee3d66f57cdab204276efe7af7b9f4e46c65e2af`.

| Harness | Capability | Skill | State | Evidence | Provenance | Measured on | Measured version |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claudecode | guard-firing | n/a | instructed | pending_evidence | paired native PreToolUse payload and decision probe | 2026-08-25 | 2.1.220 |
| codexcli | guard-firing | n/a | instructed | pending_evidence | paired native PreToolUse payload, apply_patch and ask-decision probe | 2026-08-24 | 0.149.0 |
| opencode | guard-firing | n/a | instructed | pending_evidence | paired native tool.execute.before payload, apply_patch and thrown-refusal probe | 2026-08-24 | 1.18.15 |
| cursor | guard-firing | n/a | unavailable | not_applicable | no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
| grokcli | guard-firing | n/a | unavailable | not_applicable | no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
| claudecode | instruction-loading | n/a | instructed | pending_evidence | claude-relative-import: source setup projection header and in-tree relative import measurement | 2026-09-26 | unmeasured |
| codexcli | instruction-loading | n/a | instructed | pending_evidence | codex-root-instruction: Codex reads root AGENTS.md; native file-import syntax remains unavailable | 2026-09-26 | unmeasured |
| opencode | instruction-loading | n/a | instructed | pending_evidence | opencode-instructions: source instructions-list loading measurement | 2026-09-26 | unmeasured |
| cursor | instruction-loading | n/a | unavailable | not_applicable | rulesync-rules: no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
| grokcli | instruction-loading | n/a | unavailable | not_applicable | rulesync-rules: no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
| claudecode | skill-parity | cockpit-explain | instructed | human_needed | inspectSkillSet rendered .claude/skills/cockpit-explain/SKILL.md; SHA-256 761cbf4a128e5f888409bd7588785f44e8c7be4343ffef60214a58069bfc8f73; operator parity judgment pending | unmeasured | unmeasured |
| claudecode | skill-parity | cockpit-fix | instructed | human_needed | inspectSkillSet rendered .claude/skills/cockpit-fix/SKILL.md; SHA-256 ea36c1c1cdfb4b23fb93885c89adff39a6a6158f55c4f01d10fcbf074f18eb13; operator parity judgment pending | unmeasured | unmeasured |
| claudecode | skill-parity | cockpit-setup | instructed | human_needed | inspectSkillSet rendered .claude/skills/cockpit-setup/SKILL.md; SHA-256 5a8a2cbc260e638a34fdb1ffec556b744dba53df3c39c86ecc7309277c0d72fe; operator parity judgment pending | unmeasured | unmeasured |
| claudecode | skill-parity | cockpit-work | instructed | human_needed | inspectSkillSet rendered .claude/skills/cockpit-work/SKILL.md; SHA-256 ee3929ed7c5d6f5f9d49356d6097df9125499b76bade33a1f29be031e84072da; operator parity judgment pending | unmeasured | unmeasured |
| codexcli | skill-parity | cockpit-explain | instructed | human_needed | inspectSkillSet rendered .agents/skills/cockpit-explain/SKILL.md; SHA-256 518e396424bf14743122ca29803604b37180297d293da177e8e9152a4e87435b; operator parity judgment pending | unmeasured | unmeasured |
| codexcli | skill-parity | cockpit-fix | instructed | human_needed | inspectSkillSet rendered .agents/skills/cockpit-fix/SKILL.md; SHA-256 4b39ef910545f1465fc1773609326cbb904dfb4ba11ed2c15cee4c73a2e94d3d; operator parity judgment pending | unmeasured | unmeasured |
| codexcli | skill-parity | cockpit-setup | instructed | human_needed | inspectSkillSet rendered .agents/skills/cockpit-setup/SKILL.md; SHA-256 619b32a9ffea329d08d7d70fd0e4d99345d3515fd9baa9aec25f1d572b2883e4; operator parity judgment pending | unmeasured | unmeasured |
| codexcli | skill-parity | cockpit-work | instructed | human_needed | inspectSkillSet rendered .agents/skills/cockpit-work/SKILL.md; SHA-256 f12cae28ec7cf8be6946e8287c896047d3b3c7c2daf32f8609a03ef7db5ad20b; operator parity judgment pending | unmeasured | unmeasured |
| opencode | skill-parity | cockpit-explain | instructed | human_needed | inspectSkillSet rendered .opencode/skills/cockpit-explain/SKILL.md; SHA-256 518e396424bf14743122ca29803604b37180297d293da177e8e9152a4e87435b; operator parity judgment pending | unmeasured | unmeasured |
| opencode | skill-parity | cockpit-fix | instructed | human_needed | inspectSkillSet rendered .opencode/skills/cockpit-fix/SKILL.md; SHA-256 4b39ef910545f1465fc1773609326cbb904dfb4ba11ed2c15cee4c73a2e94d3d; operator parity judgment pending | unmeasured | unmeasured |
| opencode | skill-parity | cockpit-setup | instructed | human_needed | inspectSkillSet rendered .opencode/skills/cockpit-setup/SKILL.md; SHA-256 619b32a9ffea329d08d7d70fd0e4d99345d3515fd9baa9aec25f1d572b2883e4; operator parity judgment pending | unmeasured | unmeasured |
| opencode | skill-parity | cockpit-work | instructed | human_needed | inspectSkillSet rendered .opencode/skills/cockpit-work/SKILL.md; SHA-256 f12cae28ec7cf8be6946e8287c896047d3b3c7c2daf32f8609a03ef7db5ad20b; operator parity judgment pending | unmeasured | unmeasured |
| cursor | skill-parity | cockpit-explain | unavailable | not_applicable | no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
| cursor | skill-parity | cockpit-fix | unavailable | not_applicable | no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
| cursor | skill-parity | cockpit-setup | unavailable | not_applicable | no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
| cursor | skill-parity | cockpit-work | unavailable | not_applicable | no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
| grokcli | skill-parity | cockpit-explain | unavailable | not_applicable | no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
| grokcli | skill-parity | cockpit-fix | unavailable | not_applicable | no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
| grokcli | skill-parity | cockpit-setup | unavailable | not_applicable | no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
| grokcli | skill-parity | cockpit-work | unavailable | not_applicable | no authenticated native candidate and broken-control probe is committed | 2026-10-28 | unmeasured |
