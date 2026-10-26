# Capability matrix

<!-- cockpit:verified version=0.0.0 -->

Shipped owner facts retain their evidence strength. Native and operator judgments remain pending where stated.

Source manifest: `e3ad45c36649a4d9e9994f7ced009148111ac5c97edf32baa797f9a463228c24`.

| Harness | Capability | Skill | State | Evidence | Provenance | Measured on | Measured version |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claudecode | guard-firing | n/a | instructed | pending_evidence | paired native PreToolUse payload and decision probe | 2026-08-25 | 2.1.220 |
| codexcli | guard-firing | n/a | instructed | pending_evidence | paired native PreToolUse payload, apply_patch and ask-decision probe | 2026-08-24 | 0.149.0 |
| opencode | guard-firing | n/a | instructed | pending_evidence | paired native tool.execute.before payload, apply_patch and thrown-refusal probe | 2026-08-24 | 1.18.15 |
| claudecode | instruction-loading | n/a | instructed | pending_evidence | claude-relative-import: source setup projection header and in-tree relative import measurement | 2026-09-26 | unmeasured |
| codexcli | instruction-loading | n/a | instructed | pending_evidence | codex-root-instruction: Codex reads root AGENTS.md; native file-import syntax remains unavailable | 2026-09-26 | unmeasured |
| opencode | instruction-loading | n/a | instructed | pending_evidence | opencode-instructions: source instructions-list loading measurement | 2026-09-26 | unmeasured |
| claudecode | skill-parity | bootstrap | instructed | human_needed | inspectSkillSet rendered .claude/skills/bootstrap/SKILL.md; SHA-256 161d7baccb6b1c44d97ebf5bb7f1d7c23472dc9e1f662668b010a4fb891db321; operator parity judgment pending | unmeasured | unmeasured |
| claudecode | skill-parity | explain | instructed | human_needed | inspectSkillSet rendered .claude/skills/explain/SKILL.md; SHA-256 a9c193427f54a49e8eeacb7016ed4d5846f04cbe590fedb8b352af4d7010da69; operator parity judgment pending | unmeasured | unmeasured |
| claudecode | skill-parity | fix | instructed | human_needed | inspectSkillSet rendered .claude/skills/fix/SKILL.md; SHA-256 db7222c226be8349de24764a12942a3a41e52ea6c09ceeac6d95768bd643050f; operator parity judgment pending | unmeasured | unmeasured |
| codexcli | skill-parity | bootstrap | instructed | human_needed | inspectSkillSet rendered .agents/skills/bootstrap/SKILL.md; SHA-256 816b2ce17102729724da90e712127f6edb8205b5fcbb1533f17b1e14765f170c; operator parity judgment pending | unmeasured | unmeasured |
| codexcli | skill-parity | explain | instructed | human_needed | inspectSkillSet rendered .agents/skills/explain/SKILL.md; SHA-256 af3da76795cb8184338f250d184920aa1761607da6b404967cf87665bc5af4f3; operator parity judgment pending | unmeasured | unmeasured |
| codexcli | skill-parity | fix | instructed | human_needed | inspectSkillSet rendered .agents/skills/fix/SKILL.md; SHA-256 79e92c7fe94efb99a1dc024fcf5090fdd555cce2092a6a67b7c9b2b26643a3a1; operator parity judgment pending | unmeasured | unmeasured |
| opencode | skill-parity | bootstrap | instructed | human_needed | inspectSkillSet rendered .opencode/skills/bootstrap/SKILL.md; SHA-256 0246f73c1a5957e7dcf1d25508becc42f18a7357be4e33fcea08378bf29ceccc; operator parity judgment pending | unmeasured | unmeasured |
| opencode | skill-parity | explain | instructed | human_needed | inspectSkillSet rendered .opencode/skills/explain/SKILL.md; SHA-256 23e9c15543c4c4beee1801b51d1dc48a03a586dcf88d90ce969a4e84c03c1953; operator parity judgment pending | unmeasured | unmeasured |
| opencode | skill-parity | fix | instructed | human_needed | inspectSkillSet rendered .opencode/skills/fix/SKILL.md; SHA-256 ea45466146a7fcd682b3713ed4303a42eabec751e547a5edac9ad28c61190d10; operator parity judgment pending | unmeasured | unmeasured |
