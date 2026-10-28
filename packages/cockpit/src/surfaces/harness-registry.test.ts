import { describe, expect, expectTypeOf, it } from 'vitest'

import {
    GUARD_SURFACE_TARGETS,
    HARNESS_REGISTRY,
    SURFACE_TARGETS,
    type GuardSurfaceTarget,
    type SurfaceTarget,
} from './harness-registry.js'

describe('shipped harness registry', () => {
    it('owns immutable target, display, generator, output, and native evidence facts', () => {
        expect(SURFACE_TARGETS).toEqual(['claudecode', 'codexcli', 'opencode', 'cursor', 'grokcli'])
        expect(HARNESS_REGISTRY.map(row => [
            row.target,
            row.displayName,
            row.rulesyncTarget,
            row.outputs.instruction,
            row.outputs.skills,
            row.outputs.mcp,
            row.rulesyncFeatures,
            row.guard.capability,
            row.native.state,
            row.native.measuredOn,
        ])).toEqual([
            ['claudecode', 'Claude Code', 'claudecode', 'CLAUDE.md', '.claude/skills', '.mcp.json', ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'], 'instructed', 'pending_evidence', '2026-09-26'],
            ['codexcli', 'Codex', 'codexcli', 'AGENTS.md', '.agents/skills', '.codex/config.toml', ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'], 'instructed', 'pending_evidence', '2026-09-26'],
            ['opencode', 'OpenCode', 'opencode', 'AGENTS.md', '.opencode/skills', 'opencode.jsonc', ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'], 'instructed', 'pending_evidence', '2026-09-26'],
            ['cursor', 'Cursor', 'cursor', '.cursor/rules', '.cursor/skills', '.cursor/mcp.json', ['rules', 'mcp', 'subagents', 'skills', 'hooks'], 'unavailable', 'unavailable', '2026-10-28'],
            ['grokcli', 'Grok Build', 'grokcli', 'AGENTS.md', '.grok/skills', '.grok/config.toml', ['rules', 'mcp', 'subagents', 'skills', 'hooks'], 'unavailable', 'unavailable', '2026-10-28'],
        ])
        expect(GUARD_SURFACE_TARGETS).toEqual(['claudecode', 'codexcli', 'opencode'])
        expect(Object.isFrozen(HARNESS_REGISTRY)).toBe(true)
        expect(HARNESS_REGISTRY.every(row => Object.isFrozen(row) && Object.isFrozen(row.outputs)
            && Object.isFrozen(row.guard) && Object.isFrozen(row.native))).toBe(true)
    })

    it('keeps all shipped and guard-capable target types compiler-derived from the owner', () => {
        expectTypeOf<SurfaceTarget>().toEqualTypeOf<'claudecode' | 'codexcli' | 'opencode' | 'cursor' | 'grokcli'>()
        expectTypeOf<GuardSurfaceTarget>().toEqualTypeOf<'claudecode' | 'codexcli' | 'opencode'>()
    })
})
