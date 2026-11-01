import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import {
    cpSync,
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
    classifyMarkdownPath,
    diagnosticInventory,
    deriveDocumentationInventory,
    lintMarkdown,
    repositoryMarkdownPaths,
    validateImpactLedger,
    validateAcceptanceEvidence,
    validateAcceptanceDocuments,
    validateEdgeCoverage,
    validateEdgeCoverageDocuments,
    validateNavigationEvidence,
    validateNavigationEvidenceFromManifest,
    validateOperatorReviewEvidence,
    validateReviewEvidence,
    validateReviewReports,
    validateRuntimeEvidence,
    writeReviewManifest,
    walkMarkdownProse,
    inspectProseReferences,
} from '../../../scripts/docs-lint.mjs'
import {
    checkRepositoryReferences,
    diagnosticInventory as maintainerDiagnosticInventory,
    exported,
    productionTypeScriptPaths,
    publishRepositoryReferences,
    typeScriptSource,
} from '../../../scripts/diagnostic-inventory.mjs'
import { ROOT, LINTER, committedReferenceFixture, malformedGitBoundary, writeEvidence, commentIdForTest, signNavigation, createEvidenceFixture, createCommittedEvidenceFixture, writeJson } from '../test-support/docs-fixtures.js'
import type { EvidenceRow, EvidenceDocument } from '../test-support/docs-fixtures.js'



describe('runtime evidence', () => {
    const execution = (sequence: number, exitStatus: number) => ({
        command: `synthetic-run-${sequence}`, durationMs: 20, exitStatus, sequence, timeoutMs: 100,
        transcriptSha256: createHash('sha256').update(String(sequence)).digest('hex'),
    })
    const record = (head: string) => ({
        schema_version: 1, source_head: head,
        package_sha256: 'a'.repeat(64), installed_module: '/synthetic/installed/runtime-probe.js',
        installed_module_sha256: 'b'.repeat(64), runtime_path: '/synthetic/docker', runtime_sha256: 'c'.repeat(64),
        runtime_version: '29.4.0', compose_version: '5.1.2',
        candidate: { outcome: 'passed', sha256: 'd'.repeat(64), checks: {
            localRuntime: true, imagePreexisting: true, profile: true, topology: true, applicationUp: true,
            mountHostToContainer: true, mountContainerToHost: true, ownership: true, health: true,
            recovery: true, logs: true, resetPreview: true, configuredHostPathTeardown: true, teardown: true,
        } },
        broken_control: { outcome: 'rejected', sha256: 'e'.repeat(64) },
        started_at: '2026-09-26T00:00:00.000Z', finished_at: '2026-09-26T00:00:01.000Z',
        expires_at: '2026-09-26T00:04:00.000Z', batch_id: 'f'.repeat(32), project_name: `cockpit-probe-${'f'.repeat(32)}`,
        operating_system: 'darwin', architecture: 'arm64',
        cleanup: { ownedSurvivors: [] as string[], resourcesEqual: true, claimsEqual: true, leasesEqual: true },
        disposition: 'supported',
    })

    it('rejects a generic self-asserted promotion unrelated to the runtime producer', () => {
        const fixture = createCommittedEvidenceFixture()
        try {
            writeJson(join(fixture.root, 'runtime.json'), {
                manifest: fixture.manifest,
                candidate: execution(1, 0),
                brokenControl: { ...execution(2, 3), detectorCode: '' },
                cleanupBefore: [], cleanupAfter: [],
                assertions: [{ id: 'arbitrary', status: 'passed' }],
                verdict: 'enforced', promoted: true,
            })
            expect(validateRuntimeEvidence({ root: fixture.root, path: 'runtime.json', expectedFixedPoint: fixture.base, candidate: fixture.head }).join('\n'))
                .toContain('DOCEV070_RUNTIME_EXECUTION_INVALID')
        } finally {
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })

    it.each([
        ['accepted control', 'DOCEV072_RUNTIME_CONTROL_ACCEPTED', (value: any) => { value.broken_control.outcome = 'accepted' }],
        ['cleanup drift', 'DOCEV073_RUNTIME_CLEANUP_MISMATCH', (value: any) => value.cleanup.ownedSurvivors.push('leftover')],
        ['claim drift', 'DOCEV073_RUNTIME_CLEANUP_MISMATCH', (value: any) => { value.cleanup.claimsEqual = false }],
        ['lease drift', 'DOCEV073_RUNTIME_CLEANUP_MISMATCH', (value: any) => { value.cleanup.leasesEqual = false }],
        ['partial cell promotion', 'DOCEV074_RUNTIME_PROMOTION_UNSUPPORTED', (value: any) => { delete value.candidate.checks.configuredHostPathTeardown }],
        ['failed cell promotion', 'DOCEV074_RUNTIME_PROMOTION_UNSUPPORTED', (value: any) => { value.candidate.checks.health = false }],
        ['arbitrary passed assertion', 'DOCEV074_RUNTIME_PROMOTION_UNSUPPORTED', (value: any) => { value.candidate.checks = { arbitrary: true } }],
        ['same candidate and control', 'DOCEV074_RUNTIME_PROMOTION_UNSUPPORTED', (value: any) => { value.broken_control.sha256 = value.candidate.sha256 }],
        ['wrong package digest', 'DOCEV070_RUNTIME_EXECUTION_INVALID', (value: any) => { value.package_sha256 = 'wrong' }],
        ['wrong runtime identity', 'DOCEV074_RUNTIME_PROMOTION_UNSUPPORTED', (value: any) => { value.runtime_sha256 = null }],
        ['mixed project basis', 'DOCEV074_RUNTIME_PROMOTION_UNSUPPORTED', (value: any) => { value.project_name = 'cockpit-probe-wrong' }],
        ['stale source head', 'DOCEV064_MANIFEST_MISMATCH', (value: any) => { value.source_head = '0'.repeat(40) }],
        ['reversed observation window', 'DOCEV070_RUNTIME_EXECUTION_INVALID', (value: any) => { value.finished_at = '2026-09-25T00:00:00.000Z' }],
        ['expired observation window', 'DOCEV071_RUNTIME_NOT_ADJACENT', (value: any) => { value.finished_at = '2026-09-26T00:04:01.000Z' }],
    ])('rejects %s', (_name, code, mutate) => {
        const fixture = createCommittedEvidenceFixture()
        try {
            const evidence = record(fixture.head)
            mutate(evidence)
            writeJson(join(fixture.root, 'runtime.json'), evidence)
            expect(validateRuntimeEvidence({ root: fixture.root, path: 'runtime.json', expectedFixedPoint: fixture.base, candidate: fixture.head }).join('\n')).toContain(code)
        } finally {
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })

    it('rejects nested runtime records not emitted by the producer', () => {
        const fixture = createCommittedEvidenceFixture()
        try {
            for (const key of ['candidate', 'broken_control', 'cleanup'] as const) {
                const evidence = record(fixture.head)
                writeJson(join(fixture.root, 'runtime.json'), { ...evidence, [key]: { ...evidence[key], invented: true } })
                expect(validateRuntimeEvidence({ root: fixture.root, path: 'runtime.json', expectedFixedPoint: fixture.base, candidate: fixture.head }).join('\n'), key)
                    .toContain('DOCEV070_RUNTIME_EXECUTION_INVALID')
            }
        } finally {
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })

    it('binds unavailable diagnostics to the committed candidate registry', () => {
        const fixture = createCommittedEvidenceFixture({ unavailable: 'SYNTHETIC_RUNTIME_UNAVAILABLE', timeout: 'SYNTHETIC_RUNTIME_TIMEOUT' })
        try {
            const evidence = {
                ...record(fixture.head), disposition: 'unavailable',
                unavailable_code: 'SYNTHETIC_RUNTIME_UNAVAILABLE', unavailable_reason: 'Synthetic runtime is unavailable.',
            }
            const options = { root: fixture.root, path: 'runtime.json', expectedFixedPoint: fixture.base, candidate: fixture.head }
            writeJson(join(fixture.root, 'runtime.json'), evidence)
            expect(validateRuntimeEvidence(options)).toEqual([])
            writeJson(join(fixture.root, 'runtime.json'), { ...evidence, unavailable_code: 'RUNTIME_UNAVAILABLE' })
            expect(validateRuntimeEvidence(options).join('\n')).toContain('DOCEV075_RUNTIME_UNAVAILABLE_INVALID')
            writeJson(join(fixture.root, 'runtime.json'), evidence)
            writeFileSync(join(fixture.root, 'packages/cockpit/src/environment/contract.ts'), 'export const ENVIRONMENT_CODES = {}\n')
            expect(validateRuntimeEvidence(options).join('\n')).toContain('DOCEV061_TRACKED_DIRTY')
        } finally {
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })

    it('accepts the complete producer record and a reasoned unavailable result without promotion', () => {
        const fixture = createCommittedEvidenceFixture({ unavailable: 'RUNTIME_UNAVAILABLE', timeout: 'RUNTIME_PROBE_TIMEOUT' })
        try {
            const evidence = record(fixture.head)
            writeJson(join(fixture.root, 'runtime.json'), evidence)
            const options = { root: fixture.root, path: 'runtime.json', expectedFixedPoint: fixture.base, candidate: fixture.head }
            expect(validateRuntimeEvidence(options)).toEqual([])
            const unavailable = {
                ...evidence, disposition: 'unavailable', unavailable_code: 'RUNTIME_UNAVAILABLE',
                unavailable_reason: 'The configured host-path teardown requires an operator.',
                candidate: { ...evidence.candidate, outcome: 'failed', checks: { ...evidence.candidate.checks, configuredHostPathTeardown: false } },
            }
            writeJson(join(fixture.root, 'runtime.json'), unavailable)
            expect(validateRuntimeEvidence(options)).toEqual([])
            writeJson(join(fixture.root, 'runtime.json'), { ...unavailable, unavailable_reason: '' })
            expect(validateRuntimeEvidence(options).join('\n')).toContain('DOCEV075_RUNTIME_UNAVAILABLE_INVALID')
        } finally {
            rmSync(fixture.root, { recursive: true, force: true })
        }
    })
})

describe('edge contract and coverage', () => {
    function fixture(): { contract: any; evidence: any; root: string } {
        const root = mkdtempSync(join(tmpdir(), 'edge-evidence-'))
        const edges = ['edge-a', 'edge-b', 'edge-c'].map((id, index) => ({
            id,
            classification: index < 2 ? 'classified' : 'unclassified',
            sources: [`src/${id}.ts`],
            tests: [`test/${id}.test.ts`],
            anchors: [`covers ${id}`],
        }))
        return {
            root,
            contract: { counts: { total: 3, classified: 2, unclassified: 1 }, inputIds: ['item-a', 'item-b'], edges },
            evidence: { edges: edges.map((row) => ({ ...row, status: 'covered' })) },
        }
    }

    it('accepts an exact dependency edge while keeping ordinary edges covered', () => {
        const value = fixture()
        try {
            value.contract.counts.dependencyEdges = 1
            value.contract.dependencyEdges = ['edge-c']
            value.evidence.dependencyEdges = ['edge-c']
            value.evidence.edges[2].status = 'dependency_needed'
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'evidence.json'), value.evidence)
            expect(validateEdgeCoverage({ root: value.root, contractPath: 'contract.json', inputPath: 'evidence.json' })).toEqual([])
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })

    it.each([
        ['input omission', (value: ReturnType<typeof fixture>) => { value.contract.dependencyEdges = [] }],
        ['contract omission', (value: ReturnType<typeof fixture>) => { value.evidence.dependencyEdges = [] }],
        ['set mismatch', (value: ReturnType<typeof fixture>) => {
            value.contract.counts.dependencyEdges = 1
            value.contract.dependencyEdges = ['edge-a']
            value.evidence.dependencyEdges = ['edge-b']
        }],
        ['unknown edge', (value: ReturnType<typeof fixture>) => {
            value.contract.counts.dependencyEdges = 1
            value.contract.dependencyEdges = ['edge-missing']
            value.evidence.dependencyEdges = ['edge-missing']
        }],
        ['missing explicit count', (value: ReturnType<typeof fixture>) => {
            value.contract.dependencyEdges = ['edge-c']
            value.evidence.dependencyEdges = ['edge-c']
        }],
    ])('rejects an invalid dependency edge set: %s', (_name, mutate) => {
        const value = fixture()
        try {
            mutate(value)
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'evidence.json'), value.evidence)
            expect(validateEdgeCoverage({ root: value.root, contractPath: 'contract.json', inputPath: 'evidence.json' }).join('\n'))
                .toContain('DOCEV084_EDGE_DEPENDENCY_SET_INVALID')
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })

    it.each([
        ['dependency marked covered', 2, 'covered'],
        ['ordinary edge marked dependency needed', 0, 'dependency_needed'],
    ])('rejects %s', (_name, index, status) => {
        const value = fixture()
        try {
            value.contract.counts.dependencyEdges = 1
            value.contract.dependencyEdges = ['edge-c']
            value.evidence.dependencyEdges = ['edge-c']
            value.evidence.edges[2].status = 'dependency_needed'
            value.evidence.edges[index].status = status
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'evidence.json'), value.evidence)
            expect(validateEdgeCoverage({ root: value.root, contractPath: 'contract.json', inputPath: 'evidence.json' }).join('\n'))
                .toContain('DOCEV082_EDGE_TUPLE_INVALID')
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })

    it.each([
        ['reordered row', 'DOCEV081_EDGE_SET_INVALID', (value: any) => value.evidence.edges.reverse()],
        ['count drift', 'DOCEV080_EDGE_CONTRACT_INVALID', (value: any) => { value.contract.counts.total = 4 }],
        ['tuple drift', 'DOCEV082_EDGE_TUPLE_INVALID', (value: any) => { value.evidence.edges[0].anchors = ['different'] }],
        ['unavailable row', 'DOCEV082_EDGE_TUPLE_INVALID', (value: any) => { value.evidence.edges[0].status = 'unavailable' }],
    ])('rejects a %s', (_name, code, mutate) => {
        const value = fixture()
        try {
            mutate(value)
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'evidence.json'), value.evidence)
            expect(validateEdgeCoverage({ root: value.root, contractPath: 'contract.json', inputPath: 'evidence.json' }).join('\n')).toContain(code)
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })

    it('binds coverage to the exact supplied source input', () => {
        const value = fixture()
        try {
            const source = `${JSON.stringify(value.contract.inputIds.map((id: string) => ({ id })), null, 2)}\n`
            value.evidence.inputSha256 = createHash('sha256').update(source).digest('hex')
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'coverage.json'), value.evidence)
            writeFileSync(join(value.root, 'source.json'), source)
            expect(validateEdgeCoverageDocuments({
                root: value.root,
                contractPath: 'contract.json',
                coveragePath: 'coverage.json',
                sourceInputPath: 'source.json',
            })).toEqual([])
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })
})

describe('acceptance evidence', () => {
    function fixture(): { contract: any; evidence: any; root: string } {
        const root = mkdtempSync(join(tmpdir(), 'acceptance-evidence-'))
        const contract = {
            counts: { ids: 4, exits: 2, prerequisites: 2, operatorCategories: 2, deferredIds: 1 },
            ids: ['item-a', 'item-b', 'item-c', 'item-d'],
            exits: ['exit-a', 'exit-b'],
            prerequisites: ['check-a', 'check-b'],
            operatorCategories: ['category-a', 'category-b'],
            deferredIds: ['item-d'],
            maxFeedbackLatencyMs: 1000,
        }
        const evidence = {
            ids: [...contract.ids],
            exits: [...contract.exits],
            prerequisites: [...contract.prerequisites],
            operatorCategories: [...contract.operatorCategories],
            deferredIds: [...contract.deferredIds],
            feedbackLatencyMs: 100,
            commands: [{ command: 'synthetic-check', durationMs: 100, timeoutMs: 1000, exitStatus: 0, transcriptSha256: createHash('sha256').update('check').digest('hex') }],
            operatorRows: [
                { category: 'category-a', status: 'complete', ids: [] },
                { category: 'category-b', status: 'human_needed', ids: ['item-d'] },
            ],
            verdict: 'human_needed',
            statuses: { 'item-a': 'passed', 'item-b': 'passed', 'item-c': 'passed', 'item-d': 'human_needed' },
        }
        return { root, contract, evidence }
    }

    function dependencyOnly(value: ReturnType<typeof fixture>): void {
        value.contract.counts.deferredIds = 0
        value.contract.counts.deferredDependencies = 1
        value.contract.deferredIds = []
        value.contract.deferredDependencies = ['item-c']
        value.evidence.deferredIds = []
        value.evidence.deferredDependencies = ['item-c']
        value.evidence.operatorRows[1] = { category: 'category-b', status: 'complete', ids: [] }
        value.evidence.statuses['item-c'] = 'dependency_needed'
        value.evidence.statuses['item-d'] = 'passed'
        value.evidence.verdict = 'dependency_needed'
    }

    it('accepts the legacy contract only when both dependency fields are absent', () => {
        const value = fixture()
        try {
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'evidence.json'), value.evidence)
            expect(validateAcceptanceEvidence({ root: value.root, contractPath: 'contract.json', inputPath: 'evidence.json' })).toEqual([])
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })

    it('accepts an exact dependency handoff without an open operator row', () => {
        const value = fixture()
        try {
            dependencyOnly(value)
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'evidence.json'), value.evidence)
            expect(validateAcceptanceEvidence({ root: value.root, contractPath: 'contract.json', inputPath: 'evidence.json' })).toEqual([])
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })

    it('keeps an open operator row ahead of an exact dependency handoff', () => {
        const value = fixture()
        try {
            value.contract.counts.deferredDependencies = 1
            value.contract.deferredDependencies = ['item-c']
            value.evidence.deferredDependencies = ['item-c']
            value.evidence.statuses['item-c'] = 'dependency_needed'
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'evidence.json'), value.evidence)
            expect(validateAcceptanceEvidence({ root: value.root, contractPath: 'contract.json', inputPath: 'evidence.json' })).toEqual([])
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })

    it.each([
        ['input omission', (value: ReturnType<typeof fixture>) => { value.contract.deferredDependencies = [] }],
        ['contract omission', (value: ReturnType<typeof fixture>) => { value.evidence.deferredDependencies = [] }],
        ['set mismatch', (value: ReturnType<typeof fixture>) => {
            value.contract.counts.deferredDependencies = 1
            value.contract.deferredDependencies = ['item-a']
            value.evidence.deferredDependencies = ['item-b']
        }],
        ['operator overlap', (value: ReturnType<typeof fixture>) => {
            value.contract.counts.deferredDependencies = 1
            value.contract.deferredDependencies = ['item-d']
            value.evidence.deferredDependencies = ['item-d']
        }],
        ['missing explicit count', (value: ReturnType<typeof fixture>) => {
            dependencyOnly(value)
            delete value.contract.counts.deferredDependencies
        }],
        ['count mismatch', (value: ReturnType<typeof fixture>) => {
            dependencyOnly(value)
            value.contract.counts.deferredDependencies = 2
        }],
        ['unsorted set', (value: ReturnType<typeof fixture>) => {
            value.contract.counts.deferredDependencies = 2
            value.contract.deferredDependencies = ['item-c', 'item-a']
            value.evidence.deferredDependencies = ['item-c', 'item-a']
        }],
        ['duplicate dependency', (value: ReturnType<typeof fixture>) => {
            value.contract.counts.deferredDependencies = 2
            value.contract.deferredDependencies = ['item-c', 'item-c']
            value.evidence.deferredDependencies = ['item-c', 'item-c']
        }],
        ['unknown dependency', (value: ReturnType<typeof fixture>) => {
            value.contract.counts.deferredDependencies = 1
            value.contract.deferredDependencies = ['item-extra']
            value.evidence.deferredDependencies = ['item-extra']
        }],
    ])('rejects an invalid dependency contract: %s', (_name, mutate) => {
        const value = fixture()
        try {
            mutate(value)
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'evidence.json'), value.evidence)
            expect(validateAcceptanceEvidence({ root: value.root, contractPath: 'contract.json', inputPath: 'evidence.json' }).join('\n'))
                .toContain('DOCEV098_DEPENDENCY_SET_INVALID')
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })

    it.each([
        ['passed dependency status', 'DOCEV096_ACCEPTANCE_STATUS_INVALID', (value: ReturnType<typeof fixture>) => {
            dependencyOnly(value)
            value.evidence.statuses['item-c'] = 'passed'
        }],
        ['operator dependency status', 'DOCEV096_ACCEPTANCE_STATUS_INVALID', (value: ReturnType<typeof fixture>) => {
            dependencyOnly(value)
            value.evidence.statuses['item-c'] = 'human_needed'
        }],
        ['passed dependency verdict', 'DOCEV094_ACCEPTANCE_VERDICT_INVALID', (value: ReturnType<typeof fixture>) => {
            dependencyOnly(value)
            value.evidence.verdict = 'passed'
        }],
    ])('rejects %s', (_name, code, mutate) => {
        const value = fixture()
        try {
            mutate(value)
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'evidence.json'), value.evidence)
            expect(validateAcceptanceEvidence({ root: value.root, contractPath: 'contract.json', inputPath: 'evidence.json' }).join('\n')).toContain(code)
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })

    it.each([
        ['missing id', 'DOCEV090_ACCEPTANCE_CONTRACT_MISMATCH', (value: any) => value.evidence.ids.pop()],
        ['unbounded command', 'DOCEV092_ACCEPTANCE_COMMAND_INVALID', (value: any) => { delete value.evidence.commands[0].timeoutMs }],
        ['passing open category', 'DOCEV094_ACCEPTANCE_VERDICT_INVALID', (value: any) => { value.evidence.verdict = 'passed' }],
        ['wrong deferred set', 'DOCEV095_DEFERRED_SET_INVALID', (value: any) => { value.evidence.operatorRows[1].ids = ['item-c'] }],
        ['contract count drift', 'DOCEV090_ACCEPTANCE_CONTRACT_MISMATCH', (value: any) => { value.contract.counts.ids = 5 }],
        ['status disagreement', 'DOCEV096_ACCEPTANCE_STATUS_INVALID', (value: any) => { value.evidence.statuses['item-d'] = 'passed' }],
        ['extra status', 'DOCEV096_ACCEPTANCE_STATUS_INVALID', (value: any) => { value.evidence.statuses['item-extra'] = 'passed' }],
    ])('rejects %s', (_name, code, mutate) => {
        const value = fixture()
        try {
            mutate(value)
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'evidence.json'), value.evidence)
            expect(validateAcceptanceEvidence({ root: value.root, contractPath: 'contract.json', inputPath: 'evidence.json' }).join('\n')).toContain(code)
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })

    it('binds a fenced acceptance record to every supplied document', () => {
        const value = fixture()
        try {
            const artifacts = {
                acceptanceChecklist: 'checklist.md',
                operatorReviewEvidence: 'operator.md',
                requirements: 'requirements.md',
                roadmap: 'roadmap.md',
                verification: 'verification.md',
            }
            for (const [role, path] of Object.entries(artifacts)) writeFileSync(join(value.root, path), `${role}\n`)
            ;(value.evidence as any).artifacts = Object.entries(artifacts).map(([role, path]) => ({
                role,
                path,
                sha256: createHash('sha256').update(`${role}\n`).digest('hex'),
            })).sort((left, right) => left.role.localeCompare(right.role))
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeFileSync(join(value.root, 'evidence.md'), `# Acceptance\n\n\`\`\`acceptance-evidence\n${JSON.stringify(value.evidence, null, 2)}\n\`\`\`\n`)
            expect(validateAcceptanceDocuments({
                root: value.root,
                contractPath: 'contract.json',
                inputPath: 'evidence.md',
                artifacts,
            })).toEqual([])
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })

    it('rejects a missing supplied document path as evidence', () => {
        const value = fixture()
        try {
            writeJson(join(value.root, 'contract.json'), value.contract)
            writeJson(join(value.root, 'evidence.json'), value.evidence)
            expect(validateAcceptanceDocuments({
                root: value.root,
                contractPath: 'contract.json',
                inputPath: 'evidence.json',
                artifacts: { acceptanceChecklist: undefined as unknown as string },
            }).join('\n')).toContain('DOCEV097_ACCEPTANCE_ARTIFACT_MISMATCH')
        } finally {
            rmSync(value.root, { recursive: true, force: true })
        }
    })
})

describe('maintained prose detectors', () => {
    async function detectors() {
        return await import('../../../scripts/docs-lint.mjs') as unknown as {
            inspectInternalLinks(input: { path: string; body: string; readTarget(path: string): string }): Array<{ code: string }>
            validateDocumentationIndexes(input: { readDocument(path: string): string; documents?: string[] }): Array<{ code: string }>
            buildExternalLinkReport(input: {
                documents: Array<{ path: string; body: string }>
                checkedAt: string
                check(url: string): Promise<{ status: 'ok' | 'broken' | 'unavailable'; httpStatus?: number }>
            }): Promise<{ checkedAt: string; summary: { checked: number; ok: number; broken: number; unavailable: number }; links: Array<{ url: string; sources: unknown[]; status: string }> }>
            requestExternalLink(url: string): Promise<{ status: string; httpStatus?: number }>
            inspectMaintainedProse(input: { documents: Array<{ path: string; body: string }>; currentVersion: string; staleMinorThreshold?: number; mechanismExists?(path: string): boolean; identifierExists?(identifier: string): boolean; today?: string }): {
                diagnostics: Array<{ code: string }>; reports: Array<{ code: string }>
            }
        }
    }

    it('rejects missing, retired, and stale-anchor internal links through the prose walker', async () => {
        const { inspectInternalLinks } = await detectors()
        const documents: Record<string, string> = {
            'docs/current.md': '# Current heading\n',
            'docs/current(with-parentheses).md': '# Parenthesized target\n',
            'docs/retired.md': '# Retired\n\n<!-- cockpit:retired -->\n',
        }
        const inspect = (body: string) => inspectInternalLinks({
            path: 'docs/source.md',
            body,
            readTarget: path => {
                if (!(path in documents)) throw new Error('missing fixture')
                return documents[path]
            },
        })
        expect(inspect('[missing](missing.md)')).toMatchObject([{ code: 'DOCEV026_LINK_MISSING' }])
        expect(inspect('[old](retired.md)')).toMatchObject([{ code: 'REFERENCE_RETIRED' }])
        expect(inspect('[stale](current.md#missing)')).toMatchObject([{ code: 'DOCEV027_LINK_ANCHOR_MISSING' }])
        expect(inspect('[current](current.md#current-heading)')).toEqual([])
        expect(inspect('[current][target]\n\n[target]: current.md#current-heading')).toEqual([])
        expect(inspect('[broken][missing]')).toMatchObject([{ code: 'DOC041_REFERENCE_UNRESOLVED' }])
        expect(inspect('![broken][missing]')).toMatchObject([{ code: 'DOC041_REFERENCE_UNRESOLVED' }])
        expect(inspect('[current](current(with-parentheses).md#parenthesized-target)')).toEqual([])
        expect(inspect('```md\n[control](missing.md)\n```')).toEqual([])
    })

    it('keeps consumer and contributor navigation in separate indexes', async () => {
        const { validateDocumentationIndexes } = await detectors()
        const documents: Record<string, string> = {
            'docs/README.md': '# Guides\n\n[guide](environment.md)\n',
            'docs/contributing/README.md': '# Contributors\n\n[policy](style.md)\n',
        }
        const validate = () => validateDocumentationIndexes({ readDocument: path => documents[path] })
        expect(validate()).toEqual([])
        documents['docs/README.md'] += '[internal policy](contributing/style.md)\n'
        expect(validate()).toMatchObject([{ code: 'DOC061_ESTATE_CROSS_LINK' }])
        documents['docs/README.md'] = '# Guides\n\n[guide](environment.md)\n'
        documents['docs/contributing/README.md'] += '[operator guide](../environment.md)\n'
        expect(validate()).toMatchObject([{ code: 'DOC061_ESTATE_CROSS_LINK' }])
        documents['docs/contributing/README.md'] = '# Contributors\n\n[policy](style.md)\n'
        documents['docs/guide.md'] = '# Guide\n\n[maintainer policy](contributing/style.md)\n'
        expect(validateDocumentationIndexes({ readDocument: path => documents[path], documents: Object.keys(documents) }))
            .toMatchObject([{ code: 'DOC061_ESTATE_CROSS_LINK' }])
    })

    it('reports broken external links without turning the report into a gate', async () => {
        const { buildExternalLinkReport, requestExternalLink } = await detectors()
        const checked: string[] = []
        const report = await buildExternalLinkReport({
            checkedAt: '2026-10-25T00:00:00.000Z',
            documents: [{ path: 'docs/README.md', body: [
                '# Links',
                '',
                '[healthy][health]',
                '[broken](https://example.invalid/broken)',
                '[balanced](HTTPS://example.invalid/a_(b))',
                '```md',
                '[inert control](https://example.invalid/inert)',
                '```',
                '',
                '[health]: https://example.invalid/healthy',
            ].join('\n') }],
            check: async url => {
                checked.push(url)
                return url.endsWith('/broken') ? { status: 'broken', httpStatus: 404 } : { status: 'ok', httpStatus: 200 }
            },
        })
        expect(checked.sort()).toEqual(['HTTPS://example.invalid/a_(b)', 'https://example.invalid/broken', 'https://example.invalid/healthy'])
        expect(report).toMatchObject({
            checkedAt: '2026-10-25T00:00:00.000Z',
            summary: { checked: 3, ok: 2, broken: 1, unavailable: 0 },
            links: [
                { url: 'HTTPS://example.invalid/a_(b)', status: 'ok', sources: [{ path: 'docs/README.md', line: 5 }] },
                { url: 'https://example.invalid/broken', status: 'broken', sources: [{ path: 'docs/README.md', line: 4 }] },
                { url: 'https://example.invalid/healthy', status: 'ok', sources: [{ path: 'docs/README.md', line: 3 }] },
            ],
        })
        const originalFetch = globalThis.fetch
        const methods: string[] = []
        globalThis.fetch = (async (_url: string | URL | Request, options?: RequestInit) => {
            methods.push(options?.method ?? '')
            return { status: options?.method === 'HEAD' ? 403 : 429 } as Response
        }) as typeof fetch
        try {
            await expect(requestExternalLink('https://example.invalid/rate-limited'))
                .resolves.toMatchObject({ status: 'unavailable', httpStatus: 429 })
            expect(methods).toEqual(['HEAD', 'GET'])
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    // docs-lint reads the version from packages/cockpit/package.json. A page verified at an earlier
    // release stays valid until it falls outside the stale window, so a release bump alone must not
    // turn this red.
    it('checks repository prose against the shipped workspace version', () => {
        const result = spawnSync(process.execPath, [join(ROOT, 'scripts/docs-lint.mjs')], {
            cwd: ROOT, encoding: 'utf8', timeout: 60_000,
        })
        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()
        expect(result.stderr).not.toContain('[DOC063_VERIFIED_VERSION_INVALID]')
        expect(result.stdout).not.toContain('[DOC069_VERIFIED_VERSION_MISSING]')
    }, 65_000)

    it('checks vocabulary, capture metadata, enforcement mechanisms, and reports stale verification', async () => {
        const { inspectMaintainedProse } = await detectors()
        const valid = inspectMaintainedProse({
            currentVersion: '2.4.0',
            today: '2026-10-25',
            mechanismExists: path => path === 'scripts/docs-lint.mjs',
            identifierExists: identifier => identifier === 'SYNTHETIC_DEFINED',
            documents: [
                { path: 'docs/concepts.md', body: '# Concepts\n\n<!-- cockpit:verified version=2.4.0 -->\n\n## Registry\n\nA registry declares resources.\n' },
                { path: 'docs/guide.md', body: [
                    '# Guide',
                    '<!-- cockpit:verified version=2.2.0 -->',
                    '',
                    'Use the [Registry][registry]; `SYNTHETIC_DEFINED` names a code the source defines.',
                    '```text',
                    'SYNTHETIC_FENCED is sample output, not a reference: `SYNTHETIC_FENCED`',
                    '```',
                    '<!-- cockpit:capture date=2026-10-25 version=2.4.0 --> ![terminal](terminal.png)',
                    '<!-- cockpit:ref path=scripts/docs-lint.mjs --> The linter enforces this rule.',
                    'Checked in CI.',
                    '',
                    '[registry]: concepts.md#registry',
                ].join('\n') },
                // A release fragment is copied verbatim into the generated changelog, so it carries
                // no verification marker; the changeset guide beside it still does.
                { path: '.changeset/initial-release.md', body: '---\n"@b0dea/cockpit": minor\n---\n\nInitial release.\n' },
                // A generated page is verified by regeneration, so a release bump must not make it
                // need a hand-maintained version.
                { path: 'docs/command-list.md', body: '# Command list\n\n<!-- Generated by `npm run references`; edit its sources, not this file. -->\n\nThe command table supplies this list.\n' },
            ],
        })
        expect(valid.diagnostics).toEqual([])
        expect(valid.reports).toMatchObject([{ code: 'DOC064_VERIFIED_VERSION_STALE' }])

        const broken = inspectMaintainedProse({
            currentVersion: '2.4.0',
            today: '2026-10-25',
            mechanismExists: () => true,
            identifierExists: identifier => identifier === 'SYNTHETIC_DEFINED',
            documents: [
                { path: 'docs/concepts.md', body: '# Concepts\n\n## Registry\n\n## Registry\n' },
                // A documented code that nothing outside documentation and tests defines tells the
                // reader to look for a diagnostic cockpit can never print.
                { path: 'docs/codes.md', body: '# Codes\n<!-- cockpit:verified version=2.4.0 -->\n\n`SYNTHETIC_UNDEFINED` means a retired budget was exceeded; `SYNTHETIC_DEFINED` is current.\n' },
                { path: '.changeset/README.md', body: '# Changesets\n\nHow to write a release fragment.\n' },
                { path: 'docs/guide.md', body: '# Guide\n<!-- cockpit:verified version=2.5.0 -->\n\n[Registry](concepts.md#registry) and Registry is a list.\n\n![screenshot: terminal](terminal.png)\n\n~~~console\noutput\n~~~\n\n<!-- cockpit:capture date=2026-02-30 version=2.4.0 --> Evidence.\n\n<!-- cockpit:ref path=../outside --> The check enforces it.\n' },
            ],
        })
        expect(broken.diagnostics.map(row => row.code)).toEqual(expect.arrayContaining([
            'DOC062_CONCEPT_DUPLICATE',
            'DOC065_CAPTURE_METADATA_MISSING',
            'DOC066_ENFORCEMENT_MECHANISM_MISSING',
            'DOC067_CONCEPT_UNLINKED',
            'DOC068_CONCEPT_REDEFINED',
            'DOC063_VERIFIED_VERSION_INVALID',
        ]))
        expect(broken.diagnostics.filter(row => row.code === 'DOC071_CODE_UNDEFINED')).toMatchObject([{ path: 'docs/codes.md', line: 4, message: 'SYNTHETIC_UNDEFINED' }])
        expect(broken.diagnostics.filter(row => row.code === 'DOC067_CONCEPT_UNLINKED')).toHaveLength(1)
        expect(broken.diagnostics.filter(row => row.code === 'DOC065_CAPTURE_METADATA_MISSING')).toHaveLength(3)
        expect(broken.reports).toMatchObject([
            { code: 'DOC069_VERIFIED_VERSION_MISSING', path: 'docs/concepts.md' },
            { code: 'DOC069_VERIFIED_VERSION_MISSING', path: '.changeset/README.md' },
        ])
    })

    it('runs external checking only on a scheduled or manual read-only workflow with pinned actions', () => {
        const workflow = readFileSync(join(ROOT, '.github/workflows/external-links.yml'), 'utf8')
        expect(workflow).toContain('schedule:')
        expect(workflow).toContain('workflow_dispatch:')
        expect(workflow).not.toContain('pull_request:')
        expect(workflow).toContain('permissions:\n  contents: read')
        expect(workflow).toContain('node scripts/docs-lint.mjs --external-report')
        // Any pinned release: Dependabot moves the SHA, and the loop below checks it is a full commit.
        expect(workflow).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} /)
        for (const reference of workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) {
            expect(reference[1]).toMatch(/^[0-9a-f]{40}$/)
        }
    })
})
