import { describe, expect, expectTypeOf, it } from 'vitest'

import {
    GUARD_SURFACE_TARGETS,
    HARNESS_REGISTRY,
    SURFACE_EXECUTION_CONTROL_PATHS,
    SURFACE_PUBLICATION_ANCHORS,
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
            row.outputs.permissions,
            row.rulesyncFeatures,
            row.guard.capability,
            row.native.state,
            row.native.measuredOn,
        ])).toEqual([
            ['claudecode', 'Claude Code', 'claudecode', 'CLAUDE.md', '.claude/skills', '.mcp.json', ['.claude/settings.json'], ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'], 'instructed', 'pending_evidence', '2026-09-26'],
            ['codexcli', 'Codex', 'codexcli', 'AGENTS.md', '.agents/skills', '.codex/config.toml', ['.codex/config.toml'], ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'], 'instructed', 'pending_evidence', '2026-09-26'],
            ['opencode', 'OpenCode', 'opencodev1', 'AGENTS.md', '.opencode/skills', 'opencode.jsonc', ['opencode.jsonc'], ['rules', 'mcp', 'subagents', 'skills', 'hooks'], 'instructed', 'pending_evidence', '2026-09-26'],
            ['cursor', 'Cursor', 'cursor', '.cursor/rules', '.cursor/skills', '.cursor/mcp.json', ['.cursor/cli.json'], ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'], 'unavailable', 'generated', '2026-10-28'],
            ['grokcli', 'Grok Build', 'grokcli', 'AGENTS.md', '.grok/skills', '.grok/config.toml', ['.grok/config.toml'], ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'], 'unavailable', 'generated', '2026-10-28'],
        ])
        expect(GUARD_SURFACE_TARGETS).toEqual(['claudecode', 'codexcli', 'opencode'])
        expect(SURFACE_PUBLICATION_ANCHORS).toEqual(['.agents', '.claude', '.codex', '.cursor', '.grok', '.opencode'])
        expect(SURFACE_EXECUTION_CONTROL_PATHS).toEqual([
            '.claude/settings.json', '.codex/config.toml', '.cursor/cli.json', '.cursor/mcp.json',
            '.grok/config.toml', '.mcp.json', 'opencode.jsonc',
        ])
        expect(Object.isFrozen(SURFACE_EXECUTION_CONTROL_PATHS)).toBe(true)
        expect(Object.isFrozen(HARNESS_REGISTRY)).toBe(true)
        expect(HARNESS_REGISTRY.every(row => Object.isFrozen(row) && Object.isFrozen(row.outputs)
            && Object.isFrozen(row.outputs.permissions)
            && Object.isFrozen(row.guard) && Object.isFrozen(row.native))).toBe(true)
    })

    it('keeps all shipped and guard-capable target types compiler-derived from the owner', () => {
        expectTypeOf<SurfaceTarget>().toEqualTypeOf<'claudecode' | 'codexcli' | 'opencode' | 'cursor' | 'grokcli'>()
        expectTypeOf<GuardSurfaceTarget>().toEqualTypeOf<'claudecode' | 'codexcli' | 'opencode'>()
    })
})
