# Capability matrix

<!-- cockpit:verified version=0.0.0 -->

Shipped owner facts retain their evidence strength. Native and operator judgments remain pending where stated.

Source manifest: `c9d28e8b417727c9a112f4276e3b0edb237ef9b77dbaff6e72429b7c0807e5fe`.

| Harness | Capability | Skill | State | Evidence | Provenance | Measured on | Measured version |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claudecode | guard-firing | n/a | instructed | pending_evidence | paired native PreToolUse payload and decision probe | 2026-08-25 | 2.1.220 |
| codexcli | guard-firing | n/a | instructed | pending_evidence | paired native PreToolUse payload, apply_patch and ask-decision probe | 2026-08-24 | 0.149.0 |
| opencode | guard-firing | n/a | instructed | pending_evidence | paired native tool.execute.before payload, apply_patch and thrown-refusal probe | 2026-08-24 | 1.18.15 |
| claudecode | instruction-loading | n/a | instructed | pending_evidence | claude-relative-import: source setup projection header and in-tree relative import measurement | 2026-09-26 | unmeasured |
| codexcli | instruction-loading | n/a | instructed | pending_evidence | codex-root-instruction: Codex reads root AGENTS.md; native file-import syntax remains unavailable | 2026-09-26 | unmeasured |
| opencode | instruction-loading | n/a | instructed | pending_evidence | opencode-instructions: source instructions-list loading measurement | 2026-09-26 | unmeasured |
| claudecode | skill-parity | cockpit-explain | instructed | human_needed | inspectSkillSet rendered .claude/skills/cockpit-explain/SKILL.md; SHA-256 761cbf4a128e5f888409bd7588785f44e8c7be4343ffef60214a58069bfc8f73; operator parity judgment pending | unmeasured | unmeasured |
| claudecode | skill-parity | cockpit-fix | instructed | human_needed | inspectSkillSet rendered .claude/skills/cockpit-fix/SKILL.md; SHA-256 ea36c1c1cdfb4b23fb93885c89adff39a6a6158f55c4f01d10fcbf074f18eb13; operator parity judgment pending | unmeasured | unmeasured |
| claudecode | skill-parity | cockpit-setup | instructed | human_needed | inspectSkillSet rendered .claude/skills/cockpit-setup/SKILL.md; SHA-256 5a8a2cbc260e638a34fdb1ffec556b744dba53df3c39c86ecc7309277c0d72fe; operator parity judgment pending | unmeasured | unmeasured |
| claudecode | skill-parity | cockpit-work | instructed | human_needed | inspectSkillSet rendered .claude/skills/cockpit-work/SKILL.md; SHA-256 ee3929ed7c5d6f5f9d49356d6097df9125499b76bade33a1f29be031e84072da; operator parity judgment pending | unmeasured | unmeasured |
| codexcli | skill-parity | cockpit-explain | instructed | human_needed | inspectSkillSet rendered .agents/skills/cockpit-explain/SKILL.md; SHA-256 518e396424bf14743122ca29803604b37180297d293da177e8e9152a4e87435b; operator parity judgment pending | unmeasured | unmeasured |
| codexcli | skill-parity | cockpit-fix | instructed | human_needed | inspectSkillSet rendered .agents/skills/cockpit-fix/SKILL.md; SHA-256 4b39ef910545f1465fc1773609326cbb904dfb4ba11ed2c15cee4c73a2e94d3d; operator parity judgment pending | unmeasured | unmeasured |
| codexcli | skill-parity | cockpit-setup | instructed | human_needed | inspectSkillSet rendered .agents/skills/cockpit-setup/SKILL.md; SHA-256 619b32a9ffea329d08d7d70fd0e4d99345d3515fd9baa9aec25f1d572b2883e4; operator parity judgment pending | unmeasured | unmeasured |
| codexcli | skill-parity | cockpit-work | instructed | human_needed | inspectSkillSet rendered .agents/skills/cockpit-work/SKILL.md; SHA-256 f12cae28ec7cf8be6946e8287c896047d3b3c7c2daf32f8609a03ef7db5ad20b; operator parity judgment pending | unmeasured | unmeasured |
| opencode | skill-parity | cockpit-explain | instructed | human_needed | inspectSkillSet rendered .opencode/skills/cockpit-explain/SKILL.md; SHA-256 d66670155dcd75f41521f7e345f8e3165c620d0d5b8679fcba67b6c5a25b194b; operator parity judgment pending | unmeasured | unmeasured |
| opencode | skill-parity | cockpit-fix | instructed | human_needed | inspectSkillSet rendered .opencode/skills/cockpit-fix/SKILL.md; SHA-256 044b597aa4da4971d102545af9e33c039092a930b7a59be8a9848b687ed7e0fa; operator parity judgment pending | unmeasured | unmeasured |
| opencode | skill-parity | cockpit-setup | instructed | human_needed | inspectSkillSet rendered .opencode/skills/cockpit-setup/SKILL.md; SHA-256 a29004b883f74069f677def837f457d9d8a17e00811d5ea53de7df4722b5aa8b; operator parity judgment pending | unmeasured | unmeasured |
| opencode | skill-parity | cockpit-work | instructed | human_needed | inspectSkillSet rendered .opencode/skills/cockpit-work/SKILL.md; SHA-256 4c43702f97d08634cd320dad8b81c6c3caba2fe0cfaf5203d1017d73d9c1f2f0; operator parity judgment pending | unmeasured | unmeasured |
