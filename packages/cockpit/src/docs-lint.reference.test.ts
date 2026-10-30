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



describe('maintainer reference boundary', () => {
    it('keeps one diagnostic scanner below docs-lint and shares its AST helpers', () => {
        const docsLint = readFileSync(new URL('../../../scripts/docs-lint.mjs', import.meta.url), 'utf8')
        const maintainer = readFileSync(new URL('../../../scripts/diagnostic-inventory.mjs', import.meta.url), 'utf8')

        expect(docsLint).toContain("from './diagnostic-inventory.mjs'")
        expect(docsLint).not.toMatch(/function (?:environmentDiagnosticRegistry|uppercaseDiagnostic)\b/)
        expect(maintainer).not.toContain("from './docs-lint.mjs'")
        expect(maintainer.match(/export function diagnosticInventory\b/g)).toHaveLength(1)
        const preparation = maintainer.slice(
            maintainer.indexOf('async function prepareRender'),
            maintainer.indexOf('function region'),
        )
        expect(preparation.match(/diagnosticInventoryFromSources\(/g)).toHaveLength(1)
        expect(preparation).toContain('diagnostics: inventory')
        expect(docsLint.slice(docsLint.indexOf('async function run()'))).not.toContain('diagnosticInventory(')
        expect(maintainerDiagnosticInventory).toBe(diagnosticInventory)
        expect(productionTypeScriptPaths(ROOT, 'HEAD')).toContain('packages/cockpit/src/environment/contract.ts')
        expect(typeScriptSource('synthetic.ts', 'export const value = 1').statements).toHaveLength(1)
        expect(exported(typeScriptSource('synthetic.ts', 'export const value = 1').statements[0]!)).toBe(true)
    })

    it('derives conditional and fallback diagnostic codes from production owners', () => {
        const root = committedReferenceFixture()
        try {
            const inventory = maintainerDiagnosticInventory(root, 'HEAD')
            const expectedOwners = new Map<string, readonly string[]>([
                ['DOCUMENT_DEFAULT', ['packages/cockpit/src/document/command.ts']],
                ['DOCUMENT_INFERRED', ['packages/cockpit/src/document/command.ts']],
                ['ADOPTION_STATE_INVALID', ['packages/cockpit/src/registry-resolve/command.ts']],
                ['ADOPTION_RECORD_INVALID', ['packages/cockpit/src/registry-resolve/command.ts']],
                ['ADOPTION_ENCODING_INVALID', ['packages/cockpit/src/registry-resolve/command.ts']],
                ['ADOPTION_NOT_FOUND', ['packages/cockpit/src/registry-resolve/command.ts']],
                ['ADOPTION_UNREADABLE', ['packages/cockpit/src/registry-resolve/command.ts']],
                ['REGISTRY_ENCODING_INVALID', [
                    'packages/cockpit/src/document/command.ts',
                    'packages/cockpit/src/registry-resolve/command.ts',
                ]],
                ['REGISTRY_NOT_FOUND', [
                    'packages/cockpit/src/document/command.ts',
                    'packages/cockpit/src/registry-resolve/command.ts',
                ]],
                ['REGISTRY_UNREADABLE', [
                    'packages/cockpit/src/document/command.ts',
                    'packages/cockpit/src/registry-resolve/command.ts',
                ]],
                ['REGISTRY_ROW_SKIPPED', [
                    'packages/cockpit/src/document/command.ts',
                    'packages/cockpit/src/registry-resolve/command.ts',
                ]],
                ['SURFACE_OVERRIDE_INSPECTION_REFUSED', ['packages/cockpit/src/environment/health-composition.ts']],
                ['REGISTRY_GENERATED_BASELINE_MISSING', ['packages/cockpit/src/registry-derivation.ts']],
                ['REGISTRY_ARTIFACT_UNSAFE', ['packages/cockpit/src/registry-resolve/command.ts']],
                ['COCKPIT_VERSION_MISMATCH', [
                    'packages/cockpit/src/environment/contract.ts',
                    'packages/cockpit/src/team-metadata.ts',
                ]],
            ])

            expect([...inventory.commandOwners.get('sync') ?? []]).toEqual(expect.arrayContaining([
                'packages/cockpit/src/generated-environment/command.ts',
                'packages/cockpit/src/environment/generated-application.ts',
            ]))
            expect([...inventory.commandOwners.get('check') ?? []]).toEqual(expect.arrayContaining([
                'packages/cockpit/src/team-metadata.ts',
                'packages/cockpit/src/environment/generated-application.ts',
            ]))

            for (const [code, owners] of expectedOwners) {
                expect(inventory.items).toContain(`diagnostic:${code}`)
                expect([...inventory.owners.get(code) ?? []].sort()).toEqual([...owners].sort())
            }
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    }, 240_000)

    it('derives the complete public command inventory from compact rows and bounded option spreads', () => {
        const root = committedReferenceFixture()
        try {
            const fixedPoint = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: root, encoding: 'utf8' }).trim()
            const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
            const inventory = deriveDocumentationInventory({ root, expectedFixedPoint: fixedPoint, candidate })
            const expectedCommands = [
                'baseline-record', 'browser-accessibility', 'browser-debugger', 'browser-drive', 'browser-screenshot',
                'check', 'doctor', 'document', 'down', 'init', 'logs', 'preflight', 'registry-resolve', 'reset', 'runtime', 'selftest',
                'session', 'setup', 'sibling', 'sleep', 'sync', 'test-run', 'up', 'upgrade', 'work-accept', 'work-execute', 'work-grade',
                'work-intake', 'work-metrics', 'work-programme-mint', 'work-record', 'work-recover', 'work-renew', 'work-resume',
                'work-reverse', 'work-review', 'work-status', 'work-sweep',
            ].map(name => `command:${name}`).sort()

            expect(inventory.errors).toEqual([])
            expect(inventory.navigationItems.filter(item => item.startsWith('command:'))).toEqual(expectedCommands)
            expect(inventory.items).toEqual(expect.arrayContaining([
                'flag:work-intake:--config',
                'flag:work-intake:--json',
                'flag:work-intake:--work-order',
                'flag:work-review:--work-order',
                'flag:browser-drive:--role',
                'flag:test-run:--gate',
                'flag:test-run:--mode',
                'flag:test-run:--select',
            ]))

            const tablePath = join(root, 'packages/cockpit/src/command-table.ts')
            const original = readFileSync(tablePath, 'utf8')
            writeFileSync(tablePath, `${original}\nconst plantedSpec = { name: 'planted-spec', options: { spec: { type: 'string' } } }\nvoid plantedSpec\n`)
            execFileSync('git', ['add', 'packages/cockpit/src/command-table.ts'], { cwd: root })
            execFileSync('git', ['commit', '-m', 'plant unrelated command-shaped object'], { cwd: root, stdio: 'ignore' })
            const planted = deriveDocumentationInventory({ root, expectedFixedPoint: fixedPoint, candidate: 'HEAD' })
            expect(planted.errors).toEqual([])
            expect(planted.items).not.toContain('command:planted-spec')
            expect(planted.items).not.toContain('flag:planted-spec:--spec')

            writeFileSync(tablePath, original.replace('...workOrderOption', '...unknownOptions'))
            execFileSync('git', ['add', 'packages/cockpit/src/command-table.ts'], { cwd: root })
            execFileSync('git', ['commit', '-m', 'plant unresolved option spread'], { cwd: root, stdio: 'ignore' })
            expect(deriveDocumentationInventory({ root, expectedFixedPoint: fixedPoint, candidate: 'HEAD' }).errors.join('\n'))
                .toContain('DOCEV015_INVENTORY_FAILED')

            writeFileSync(tablePath, original.replace('...workOrderOption', '...makeOptions()'))
            execFileSync('git', ['add', 'packages/cockpit/src/command-table.ts'], { cwd: root })
            execFileSync('git', ['commit', '-m', 'plant dynamic option spread'], { cwd: root, stdio: 'ignore' })
            expect(deriveDocumentationInventory({ root, expectedFixedPoint: fixedPoint, candidate: 'HEAD' }).errors.join('\n'))
                .toContain('DOCEV015_INVENTORY_FAILED')
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    }, 240_000)

    it('binds work and test policy references to their source owners rather than diagnostic codes', () => {
        const documentation = readFileSync(join(ROOT, 'docs/work-and-browser.md'), 'utf8')
        const markers = [
            '<!-- cockpit:ref path=packages/cockpit/src/work-orders/contract.ts -->',
            '<!-- cockpit:ref path=packages/cockpit/src/testing/verdict.ts -->',
        ]
        for (const marker of markers) expect(documentation).toContain(marker)
        const authority = { commands: new Set<string>(), diagnostics: new Set<string>(), identifiers: new Set<string>(),
            flags: new Set<string>(), schemaFields: new Set<string>(), consumerPaths: new Set<string>() }
        const resolvePath = (path: string) => existsSync(join(ROOT, path)) ? 'present' : 'missing'

        expect(inspectProseReferences({ path: 'docs/work-and-browser.md', body: markers.join('\n'), authority, resolvePath })).toEqual([])
        for (const symbol of ['parseWorkOrder', 'classifyRun']) {
            expect(inspectProseReferences({
                path: 'docs/work-and-browser.md',
                body: `<!-- cockpit:ref code=${symbol} -->`,
                authority,
                resolvePath,
            })).toMatchObject([{ code: 'DOCEV050_NAMED_REFERENCE_MISSING' }])
        }
    })

    it('exposes closed canonical operations and rejects caller inventory or publication authority', async () => {
        expect(checkRepositoryReferences.length).toBe(1)
        expect(publishRepositoryReferences.length).toBe(1)
        const maintainer = readFileSync(new URL('../../../scripts/diagnostic-inventory.mjs', import.meta.url), 'utf8')
        const publish = maintainer.slice(maintainer.indexOf('export async function publishRepositoryReferences'))
        expect(publish).toContain('owners.references.writeReferences(')
        expect(publish).not.toContain('publishPreparedReferences')
        const forged = await (publishRepositoryReferences as (...arguments_: unknown[]) => Promise<{
            diagnostics: readonly { code: string }[]
        }>)(ROOT, { dryRun: true, diagnostics: maintainerDiagnosticInventory(ROOT, 'HEAD') })
        expect(forged.diagnostics).toMatchObject([{ code: 'REFERENCE_INPUT_INVALID' }])
        const extra = await (checkRepositoryReferences as (...arguments_: unknown[]) => Promise<{
            diagnostics: readonly { code: string }[]
        }>)(ROOT, 'HEAD', maintainerDiagnosticInventory(ROOT, 'HEAD'))
        expect(extra.diagnostics).toMatchObject([{ code: 'REFERENCE_INPUT_INVALID' }])
    })

    it('fails closed without creating repository state when owner inputs are unavailable', async () => {
        const root = mkdtempSync(join(tmpdir(), 'reference-check-read-only-'))
        try {
            const before = readdirSync(root)
            const result = await checkRepositoryReferences(root)

            expect(result.kind).toBe('refusal')
            expect(result.diagnostics).toEqual([
                expect.objectContaining({ code: expect.stringMatching(/^REFERENCE_[A-Z0-9_]+$/) }),
            ])
            expect(readdirSync(root)).toEqual(before)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('authenticates one committed closure and keeps the canonical check read-only under causal controls', async () => {
        const root = committedReferenceFixture()
        try {
            const before = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root })
            const result = await checkRepositoryReferences(`${root}/`)

            expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete', ok: false })
            expect(result.diagnostics).toMatchObject([
                { code: 'REFERENCE_COPY_MISSING', target: 'docs/cli-reference.md' },
                { code: 'REFERENCE_COPY_MISSING', target: 'docs/configuration-reference.md' },
                { code: 'REFERENCE_COPY_MISSING', target: 'docs/command-list.md' },
                { code: 'REFERENCE_COPY_MISSING', target: 'docs/capability-matrix.md' },
                { code: 'REFERENCE_COPY_MISSING', target: 'skills/adopt-cockpit/SKILL.md' },
                { code: 'REFERENCE_COPY_STALE', target: 'docs/troubleshooting.md' },
            ])
            const preview = await publishRepositoryReferences(`${root}/`, { dryRun: true })
            expect(preview, JSON.stringify(preview)).toMatchObject({ kind: 'complete', ok: true, committed: [] })
            expect(execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root })).toEqual(before)
            expect(existsSync(join(root, '.cockpit'))).toBe(false)

            const packagePath = join(root, 'package.json')
            const packageBytes = readFileSync(packagePath)
            writeFileSync(packagePath, Buffer.concat([packageBytes, Buffer.from('\n')]))
            const dirty = await checkRepositoryReferences(root)
            expect(dirty).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'REFERENCE_SOURCE_DIRTY' }] })
            writeFileSync(packagePath, packageBytes)

            const sameSize = Buffer.from(packageBytes)
            sameSize[0] = sameSize[0] === 0x7b ? 0x5b : 0x7b
            writeFileSync(packagePath, sameSize)
            const changedBytes = await checkRepositoryReferences(root)
            expect(changedBytes).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'REFERENCE_SOURCE_DIRTY' }] })
            writeFileSync(packagePath, packageBytes)

            chmodSync(packagePath, 0o755)
            const changedMode = await checkRepositoryReferences(root)
            expect(changedMode).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'REFERENCE_SOURCE_DIRTY' }] })
            chmodSync(packagePath, 0o644)

            const heldPackage = `${packagePath}.held`
            renameSync(packagePath, heldPackage)
            symlinkSync(heldPackage, packagePath)
            const linked = await checkRepositoryReferences(root)
            expect(linked).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'REFERENCE_SOURCE_DIRTY' }] })
            rmSync(packagePath)
            renameSync(heldPackage, packagePath)

            const mixed = await checkRepositoryReferences(root, 'HEAD~1')
            expect(mixed).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'REFERENCE_CANDIDATE_MISMATCH' }] })

            const builtPath = join(root, 'packages/cockpit/dist/guards/evaluator.js')
            const builtBytes = readFileSync(builtPath)
            writeFileSync(builtPath, Buffer.concat([builtBytes, Buffer.from('\n')]))
            const unauthenticated = await checkRepositoryReferences(root)
            expect(unauthenticated).toMatchObject({
                kind: 'refusal',
                diagnostics: [{ code: 'REFERENCE_BUILD_UNAUTHENTICATED' }],
            })
            writeFileSync(builtPath, builtBytes)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    }, 240_000)

    it('rejects malformed NUL framing at committed-tree capture and revalidation', async () => {
        const root = committedReferenceFixture()
        const boundary = malformedGitBoundary(root)
        const priorPath = process.env.PATH
        process.env.PATH = boundary.path
        try {
            boundary.set('valid', 0)
            const valid = await checkRepositoryReferences(root)
            expect(valid, JSON.stringify(valid)).toMatchObject({ kind: 'complete', ok: false })
            expect(boundary.state().sourceBlobs).toBe(0)

            for (const mutation of ['leading', 'doubled', 'trailing', 'missing'] as const) {
                boundary.set(mutation, 1)
                const malformedCapture = await checkRepositoryReferences(root)
                expect(malformedCapture, `${mutation} capture: ${JSON.stringify(malformedCapture)}`).toMatchObject({
                    kind: 'refusal',
                    diagnostics: [{ code: 'REFERENCE_SOURCE_INVALID' }],
                })
            }

            for (const mutation of ['leading', 'doubled', 'trailing', 'missing'] as const) {
                boundary.set(mutation, 2)
                const malformedRevalidation = await checkRepositoryReferences(root)
                expect(malformedRevalidation, `${mutation} revalidation: ${JSON.stringify(malformedRevalidation)}`).toMatchObject({
                    kind: 'refusal',
                    diagnostics: [{ code: 'REFERENCE_SOURCE_CHANGED' }],
                })
            }
        } finally {
            if (priorPath === undefined) delete process.env.PATH
            else process.env.PATH = priorPath
            rmSync(root, { recursive: true, force: true })
        }
    }, 240_000)
})
