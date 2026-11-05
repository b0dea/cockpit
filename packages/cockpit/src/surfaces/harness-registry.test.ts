import { describe, expect, expectTypeOf, it } from 'vitest'

import {
    GUARD_SURFACE_TARGETS,
    HARNESS_REGISTRY,
    SURFACE_EXECUTION_CONTROL_PATHS,
    SURFACE_PUBLICATION_ANCHORS,
    SURFACE_TARGETS,
    isMeasurementDate,
    type GuardSurfaceTarget,
    type SurfaceTarget,
} from './harness-registry.js'
import { subagentGradingProblem } from '../grading/evaluate.js'

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
            'measuredOn' in row.native ? row.native.measuredOn : null,
        ])).toEqual([
            ['claudecode', 'Claude Code', 'claudecode', 'CLAUDE.md', '.claude/skills', '.mcp.json', ['.claude/settings.json'], ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'], 'instructed', 'instructed', null],
            ['codexcli', 'Codex', 'codexcli', 'AGENTS.md', '.agents/skills', '.codex/config.toml', ['.codex/config.toml'], ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'], 'instructed', 'instructed', null],
            ['opencode', 'OpenCode', 'opencodev1', 'AGENTS.md', '.opencode/skills', 'opencode.jsonc', ['opencode.jsonc'], ['rules', 'mcp', 'subagents', 'skills', 'hooks'], 'instructed', 'instructed', null],
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

    it('offers subagent grading only where the evaluator definition is generated, naming each tool and harness without one', () => {
        const harness = (name: string, state: 'instructed' | 'unavailable') => ({ name, capabilities: [{ feature: 'subagents' as const, state }] })
        expect(subagentGradingProblem(SURFACE_TARGETS, [harness('team-tool', 'instructed')])).toBeUndefined()
        expect(subagentGradingProblem(['claudecode'], [harness('team-tool', 'unavailable'), harness('other-tool', 'instructed')]))
            .toMatchObject({ code: 'EVALUATOR_UNAVAILABLE', message: expect.stringMatching(/generates none for team-tool$/) })
        // A definition the tool was shown to offer is measured; one only written is not called more than that.
        expect(HARNESS_REGISTRY.map(row => [row.target, row.subagentGrader.state, row.subagentGrader.measuredVersion])).toEqual([
            ['claudecode', 'instructed', '2.1.318'], ['codexcli', 'instructed', '0.166.0'], ['opencode', 'generated', null], ['cursor', 'generated', null], ['grokcli', 'generated', null]])
    })

    it('accepts a measurement date only as a real calendar day that is not in the future', () => {
        const today = new Date('2026-11-03T12:00:00.000Z')
        expect(['2026-11-03', '2026-09-26', '2024-02-29'].map(date => isMeasurementDate(date, today))).toEqual([true, true, true])
        expect(['2026-11-04', '2026-02-30', '2026-9-26', '2026-11-03T00:00:00Z', '', 20261103].map(date => isMeasurementDate(date, today)))
            .toEqual([false, false, false, false, false, false])
        // Every recorded date holds against the real clock, so a typo in the future fails here and not at a user's machine.
        const recorded = HARNESS_REGISTRY.flatMap(row => [...('measuredOn' in row.native ? [row.native.measuredOn] : []), ...('firing' in row.guard ? [row.guard.firing.measuredOn] : [])])
        expect(recorded.every(date => isMeasurementDate(date))).toBe(true)
    })

    it('keeps all shipped and guard-capable target types compiler-derived from the owner', () => {
        expectTypeOf<SurfaceTarget>().toEqualTypeOf<'claudecode' | 'codexcli' | 'opencode' | 'cursor' | 'grokcli'>()
        expectTypeOf<GuardSurfaceTarget>().toEqualTypeOf<'claudecode' | 'codexcli' | 'opencode'>()
    })
})
