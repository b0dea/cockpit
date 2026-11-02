import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { configurationDefaults } from '../schema.js'
import { createEnvironmentSnapshot, createStabilityCapturePlan, authenticateStabilityCapture, captureRuntimeEvidence, type RuntimeEvidence } from '../environment/evidence.js'
import { executeProbe } from '../environment-exec/execute.js'
import type { StackId } from '../environment/contract.js'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripDevelopmentMarkers } from '../surfaces/development-markers.js'
import { createGateRegistry, runGate, renderTierGuide, TESTING_GUIDE_REGISTRY, GATE_SELECTOR_OPTION, type GateSelector, type ProductGateInvocation } from './gates.js'
import type { ProjectionPlannerInput } from '../surfaces/projection.js'

const registry = () => createGateRegistry({
    stages: [
        { id: 'unit', command: ['product-tool', 'unit'], requiresStack: false, timeoutSeconds: 60,
            select: { spec: ['--spec', '{value}'], file: ['{value}'], test: ['-t', '{value}'], route: ['--route={value}'] } },
        { id: 'browser', command: ['product-tool', 'drive'], requiresStack: true, timeoutSeconds: 60 },
    ],
    gates: [
        { id: 'focused', tier: 'targeted', stages: ['unit'], changes: 'Isolated behavior' },
        { id: 'release', tier: 'full', stages: ['unit', 'browser'], changes: 'Shared or cross-system behavior' },
    ],
})
const dependencies = () => ({
    subject: async () => 'a'.repeat(64),
    runProductTool: async (_invocation: ProductGateInvocation) => ({ kind: 'executed' as const, exitCode: 0, signal: null, outputBytes: 1, assertion: 'passed' as const }),
})
const guideInput = (): ProjectionPlannerInput => ({
    canonicalMainCheckout: '/synthetic/cockpit', siblingsRoot: '/synthetic', activeProfiles: [],
    guideCapLines: configurationDefaults().cockpit.guide_cap, siblings: [], mountedPaths: [], directoryGrants: [],
    guideObservations: [], existingEntries: [], priorOwnedLinks: [],
    standingSources: ['claudecode', 'codexcli', 'opencode'].map(target => ({
        target: target as 'claudecode' | 'codexcli' | 'opencode', path: 'AGENTS.md', content: 'Existing instruction\n', scope: 'always',
    })),
    loadCharacterizations: Object.fromEntries(['claudecode', 'codexcli', 'opencode'].map(target => [target, {
        measuredOn: '2026-10-23', provenance: 'synthetic instruction-loading control', metric: 'lines', scopeSemantics: 'full',
    }])),
})

describe('product-owned gates', () => {
    it('delivers a selection as the stage\'s declared arguments, never as shell text, and never runs a stage unselected', async () => {
        expect(GATE_SELECTOR_OPTION).toBe('--select')
        const value = 'name with spaces; $(false)'
        const expected = { spec: ['--spec', value], file: [value], test: ['-t', value], route: [`--route=${value}`] }
        for (const kind of ['spec', 'file', 'test', 'route'] as const) {
            const select: GateSelector = { kind, value }
            const calls: ProductGateInvocation[] = []
            const result = await runGate(registry(), { gate: 'focused', select }, {
                ...dependencies(), runProductTool: async invocation => {
                    calls.push(invocation)
                    return { kind: 'executed', exitCode: 0, signal: null, outputBytes: 1, assertion: 'passed' }
                },
            })
            expect(calls).toEqual([{ gate: 'focused', stage: 'unit', command: ['product-tool', 'unit', ...expected[kind]], timeoutSeconds: 60, select }])
            expect(result.verdict).toBe('PARTIAL')
        }
        const calls: string[] = []
        const unselectable = await runGate(registry(), { gate: 'release', select: { kind: 'test', value }, stack: { state: 'available' } }, {
            ...dependencies(), runProductTool: async invocation => { calls.push(invocation.stage); return dependencies().runProductTool(invocation) },
        })
        expect(calls).toEqual(['unit'])
        expect(unselectable.verdict).toBe('DEGRADED')
        expect(unselectable.observations).toContainEqual({ id: 'browser', kind: 'unavailable',
            reason: "stage browser declares no test selection; add testing.stages[].select.test with the tool's own arguments" })
    })

    it('continues after disagreement and names every unavailable selected prerequisite', async () => {
        const calls: string[] = []
        const result = await runGate(registry(), { gate: 'release', stack: { state: 'unavailable', reason: 'daemon stopped' } }, {
            ...dependencies(), runProductTool: async invocation => {
                calls.push(invocation.stage)
                return { kind: 'executed', exitCode: 1, signal: null, outputBytes: 1, assertion: 'failed' }
            },
        })
        expect(calls).toEqual(['unit'])
        expect(result.verdict).toBe('FAIL')
        expect(result.observations).toContainEqual({ id: 'browser', kind: 'unavailable', reason: 'stack unavailable: daemon stopped' })
    })

    it('runs every selected stage after a thrown tool error and never promotes missing stability', async () => {
        const calls: string[] = []
        const result = await runGate(registry(), { gate: 'release', stack: { state: 'available' } }, {
            ...dependencies(), runProductTool: async invocation => {
                calls.push(invocation.stage)
                if (invocation.stage === 'unit') throw new Error('executable missing')
                return { kind: 'executed', exitCode: 0, signal: null, outputBytes: 1, assertion: 'passed' }
            },
        })
        expect(calls).toEqual(['unit', 'browser'])
        expect(result.verdict).toBe('DEGRADED')
        expect(result.reasons.join(' ')).toContain('executable missing')
        const drift = ['a'.repeat(64), 'b'.repeat(64)]
        expect((await runGate(registry(), { gate: 'focused' }, { ...dependencies(), subject: async () => drift.shift()! })).verdict).toBe('VOID')
    })

    it('rejects invalid selection before dispatch and deduplicates a requested subset', async () => {
        let calls = 0
        const deps = { ...dependencies(), runProductTool: async (invocation: ProductGateInvocation) => { calls++; return dependencies().runProductTool(invocation) } }
        for (const stages of [[], ['unknown']]) await expect(runGate(registry(), { gate: 'release', stages }, deps)).rejects.toThrow('selection')
        expect(calls).toBe(0)
        expect((await runGate(registry(), { gate: 'release', stages: ['unit', 'unit'] }, deps))).toMatchObject({ verdict: 'PARTIAL', executed: 1 })
        expect(calls).toBe(1)
        expect(() => createGateRegistry({ stages: [], gates: [] })).toThrow('registry')
    })

    it('composes authenticated runtime captures around execution and rejects drift, stale and replayed evidence', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'cockpit-gate-runtime-'))
        const sha = (value: string) => createHash('sha256').update(value).digest('hex')
        const executable = join(directory, 'runtime')
        const source = '#!/bin/sh\ncase "$*" in\n *"/proc/1/stat"*) printf "777 12345\\n" ;;\n *cockpit-content-hash*) printf "%s  -\\n" "$CONTENT_HASH" ;;\n *) exit 9 ;;\nesac\n'
        writeFileSync(executable, source)
        chmodSync(executable, 0o755)
        const stackId = `stack:${sha('stack')}` as StackId
        const configSha256 = sha('config')
        const snapshot = createEnvironmentSnapshot({ stackId, configSha256, createdAt: new Date().toISOString(), creationSource: 'resolved-config', intendedState: { services: ['api'] } })
        let sequence = 0
        let content = sha('content')
        let config = configSha256
        const capture = async (): Promise<RuntimeEvidence> => {
            const plan = createStabilityCapturePlan({ stackId, configSha256: config,
                runtimeExecutable: { canonicalPath: executable, invocationPath: join(directory, 'docker'), sha256: sha(source), executionMode: 'verified-path' },
                cwd: directory, env: { PATH: '/usr/bin', CONTENT_HASH: content }, containerId: 'synthetic', batchId: sha(`batch-${sequence++}`),
                runtime: { name: 'docker', version: '27.1.2' }, contentPaths: ['/workspace/api'], timeoutMs: 5000, outputLimitBytes: 4096 })
            if (plan.kind !== 'preview') throw new Error('capture plan refused')
            const results = []
            for (const step of plan.plan.steps) results.push(await executeProbe(step))
            const authenticated = authenticateStabilityCapture({ plan, results })
            if ('state' in authenticated) return authenticated
            return captureRuntimeEvidence({ capture: authenticated })
        }
        try {
            const deps = { ...dependencies(), runtime: { snapshot, capture } }
            const request = { gate: 'release', stack: { state: 'available' as const } }
            const oldBefore = await capture()
            const oldAfter = await capture()
            if (oldBefore.state !== 'available' || oldAfter.state !== 'available') throw new Error('synthetic capture unavailable')
            expect((await runGate(registry(), request, deps)).verdict).toBe('PASS')
            expect((await runGate(registry(), request, { ...deps, runProductTool: async invocation => {
                content = sha('changed')
                return deps.runProductTool(invocation)
            } })).verdict).toBe('VOID')
            expect((await runGate(registry(), request, { ...deps, runProductTool: async invocation => {
                config = sha('new-config')
                return deps.runProductTool(invocation)
            } })).verdict).toBe('VOID')
            const oldPair = [oldBefore, oldAfter]
            expect((await runGate(registry(), request, { ...deps, runtime: { snapshot, capture: async () => oldPair.shift()! } })).verdict).toBe('VOID')
            expect((await runGate(registry(), request, { ...deps, runtime: { snapshot, capture: async () => oldBefore } })).verdict).toBe('DEGRADED')
        } finally { rmSync(directory, { recursive: true, force: true }) }
    })

    it('derives all three tiers from a declared registry within the unchanged total guide cap', () => {
        const guide = renderTierGuide(registry(), guideInput())
        expect(guide.kind).toBe('complete')
        if (guide.kind !== 'complete') throw new Error('guide refused')
        // The guide is compared with the shipped file on every sync, so a version marker rendered
        // from the installed package made sync refuse after each release bump.
        expect(guide.bytes).not.toContain('cockpit:verified')
        expect(guide.bytes).toContain('| None |')
        expect(guide.bytes).toContain('`focused` (unit)')
        expect(guide.bytes).toContain('Full')
        expect(guide.bytes).toContain('--select')
        expect(guide.bytes).toContain('Extend an existing behavior test')
        expect(guide.bytes).toContain('Each test must fail when that behavior regresses')
        expect(guide.bytes).toContain('If the declared tier is Full, run the complete gate once after implementation and review stabilize, before handing back')
        expect(guide.bytes).toContain('affected or changed-since selection of the product build or test tool, let that tool choose the tests')
        expect(guide.bytes).toContain('Do not duplicate proof')
        expect(guide.costs).toHaveLength(3)
        expect(guide.costs.every(cost => cost.status === 'within_cap' && cost.value === guide.lines + 1)).toBe(true)
        const existing = guideInput()
        const rerender = renderTierGuide(registry(), { ...existing, guideCapLines: guide.lines + 1,
            standingSources: [...existing.standingSources, ...(['claudecode', 'codexcli', 'opencode'] as const).map(target => ({
                target, path: 'packages/cockpit/surfaces/references/testing-tiers.md', content: 'Old guide\n'.repeat(200), scope: 'always' as const,
            }))] })
        expect(rerender).toMatchObject({ kind: 'complete', bytes: guide.bytes, costs: guide.costs.map(cost => ({ ...cost, cap: guide.lines + 1 })) })
        expect(renderTierGuide(registry(), { ...guideInput(), guideCapLines: guide.lines }).kind).toBe('refusal')
        expect(renderTierGuide(registry(), { ...guideInput(), loadCharacterizations: {} }).kind).toBe('refusal')
        expect(() => renderTierGuide({ ...TESTING_GUIDE_REGISTRY }, guideInput())).toThrow('issued')
    })

    it('tells agents with no declared gate to add a characterization test and never claim PASS, as the shipped guide', () => {
        const guide = renderTierGuide(TESTING_GUIDE_REGISTRY, guideInput())
        if (guide.kind !== 'complete') throw new Error('guide refused')
        expect(guide.bytes).toContain('declares no product test gate, so no change can be graded PASS')
        expect(guide.bytes).toContain('add a characterization test at the nearest public boundary')
        expect(guide.bytes).toContain('do not add a test framework unasked')
        expect(guide.bytes).toContain('Never report work as verified or passing')
        expect(guide.bytes).toContain('`./node_modules/@b0dea/cockpit/docs/work-and-browser.md`')
        // A tier table here would send agents to run a gate that does not exist.
        expect(guide.bytes).not.toMatch(/test-run|\| Tier \|/)
        expect(guide.costs.every(cost => cost.status === 'within_cap')).toBe(true)
        expect(stripDevelopmentMarkers(readFileSync(new URL('../../surfaces/references/testing-tiers.md', import.meta.url), 'utf8'))).toBe(guide.bytes)
    })
})
