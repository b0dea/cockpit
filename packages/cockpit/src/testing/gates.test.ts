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
import { installedPackageMetadata } from '../package-metadata.js'
import { createGateRegistry, runGate, renderTierGuide, TESTING_GUIDE_REGISTRY, GATE_SELECTOR_OPTION, type GateSelector, type ProductGateInvocation } from './gates.js'
import type { ProjectionPlannerInput } from '../surfaces/projection.js'

const registry = () => createGateRegistry({
    stages: [
        { id: 'unit', command: ['product-tool', 'unit'], requiresStack: false },
        { id: 'browser', command: ['product-tool', 'drive'], requiresStack: true },
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
    it('passes one typed select value to product tooling without interpreting its text as shell', async () => {
        expect(GATE_SELECTOR_OPTION).toBe('--select')
        for (const kind of ['spec', 'file', 'test', 'route'] as const) {
            const select: GateSelector = { kind, value: 'name with spaces; $(false)' }
            const calls: ProductGateInvocation[] = []
            const result = await runGate(registry(), { gate: 'focused', select }, {
                ...dependencies(), runProductTool: async invocation => {
                    calls.push(invocation)
                    return { kind: 'executed', exitCode: 0, signal: null, outputBytes: 1, assertion: 'passed' }
                },
            })
            expect(calls).toEqual([{ gate: 'focused', stage: 'unit', command: ['product-tool', 'unit'], select }])
            expect(result.verdict).toBe('PARTIAL')
        }
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

    it('derives all three tiers from the registry within the unchanged total guide cap', () => {
        const guide = renderTierGuide(TESTING_GUIDE_REGISTRY, guideInput())
        expect(guide.kind).toBe('complete')
        if (guide.kind !== 'complete') throw new Error('guide refused')
        expect(guide.bytes).toContain(`<!-- cockpit:verified version=${installedPackageMetadata.version} -->`)
        expect(guide.bytes).toContain('| None |')
        expect(guide.bytes).toContain('Targeted')
        expect(guide.bytes).toContain('Full')
        expect(guide.bytes).not.toContain('focused')
        expect(guide.bytes).toContain('--select')
        expect(guide.bytes).toContain('Extend an existing behavior test')
        expect(guide.bytes).toContain('Each test must fail when that behavior regresses')
        expect(guide.bytes).toContain('If the declared tier is Full, run the complete gate once')
        expect(guide.bytes).toContain('Do not duplicate proof')
        expect(guide.costs).toHaveLength(3)
        expect(guide.costs.every(cost => cost.status === 'within_cap' && cost.value === guide.lines + 1)).toBe(true)
        const existing = guideInput()
        const rerender = renderTierGuide(TESTING_GUIDE_REGISTRY, { ...existing, guideCapLines: guide.lines + 1,
            standingSources: [...existing.standingSources, ...(['claudecode', 'codexcli', 'opencode'] as const).map(target => ({
                target, path: 'packages/cockpit/surfaces/references/testing-tiers.md', content: 'Old guide\n'.repeat(200), scope: 'always' as const,
            }))] })
        expect(rerender).toMatchObject({ kind: 'complete', bytes: guide.bytes, costs: guide.costs.map(cost => ({ ...cost, cap: guide.lines + 1 })) })
        expect(renderTierGuide(TESTING_GUIDE_REGISTRY, { ...guideInput(), guideCapLines: guide.lines }).kind).toBe('refusal')
        expect(renderTierGuide(TESTING_GUIDE_REGISTRY, { ...guideInput(), loadCharacterizations: {} }).kind).toBe('refusal')
        expect(renderTierGuide(registry(), guideInput())).toMatchObject({ kind: 'complete', bytes: expect.stringContaining('focused') })
        expect(() => renderTierGuide({ ...TESTING_GUIDE_REGISTRY }, guideInput())).toThrow('issued')
        expect(readFileSync(new URL('../../surfaces/references/testing-tiers.md', import.meta.url), 'utf8')).toBe(guide.bytes)
    })
})
