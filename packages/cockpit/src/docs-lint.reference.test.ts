import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectProseReferences } from '../../../scripts/docs-lint.mjs'
import {
    checkRepositoryReferences,
    diagnosticInventory as maintainerDiagnosticInventory,
    diagnosticInventoryFromSources,
    exported,
    productionTypeScriptPaths,
    publishRepositoryReferences,
    typeScriptSource,
} from '../../../scripts/diagnostic-inventory.mjs'
import { ROOT, committedReferenceFixture, malformedGitBoundary } from '../test-support/docs-fixtures.js'

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

            expect([...inventory.commandDiagnostics.get('sync') ?? []]).toEqual(expect.arrayContaining([
                'SURFACE_STATE_CONFLICT',
                'TEAM_METADATA_UNAVAILABLE',
            ]))
            expect([...inventory.commandDiagnostics.get('check') ?? []]).toEqual(expect.arrayContaining([
                'COCKPIT_VERSION_MISMATCH',
                'COMPOSE_TOPOLOGY_UNAVAILABLE',
            ]))

            for (const [code, owners] of expectedOwners) {
                expect(inventory.items).toContain(`diagnostic:${code}`)
                expect([...inventory.owners.get(code) ?? []].sort()).toEqual([...owners].sort())
            }
        } finally {
            rmSync(root, { recursive: true, force: true, maxRetries: 5 })
        }
    }, 240_000)

    it('derives diagnostic unions from returned code parameters and ignores codes that are only mentioned', () => {
        const path = 'packages/cockpit/src/generated/vendor.ts'
        const inventory = diagnosticInventoryFromSources([path], new Map([[path, [
            "export type VendorCode = 'VENDOR_NOT_MEASURED' | 'VENDOR_NOT_AVAILABLE'",
            'function unmeasured(code: VendorCode) { return { state: "unavailable", code } }',
            'export function observeVendor(code: VendorCode) { return unmeasured(code) }',
            "const unrelated = 'SYNTHETIC_NOT_EMITTED' // SYNTHETIC_COMMENT_ONLY",
            'void unrelated',
            '',
        ].join('\n')]]))
        expect(inventory.items).toEqual(['diagnostic:VENDOR_NOT_AVAILABLE', 'diagnostic:VENDOR_NOT_MEASURED'])
        expect([...inventory.owners.get('VENDOR_NOT_MEASURED') ?? []]).toEqual([path])
    })

    it('derives typed parser findings collected before the public result is returned', () => {
        const path = 'packages/cockpit/src/work-orders/parser.ts'
        const inventory = diagnosticInventoryFromSources([path], new Map([[path, [
            "export const PARSER_FINDING_CODES = Object.freeze(['WO_SIZE_LIMIT', 'WO_FRONTMATTER_INVALID'] as const)",
            'export type ParserFindingCode = typeof PARSER_FINDING_CODES[number]',
            'interface ParserFinding { readonly code: ParserFindingCode; readonly target: string; readonly message: string }',
            'function immutable<T>(value: T): T | undefined { return snapshotJson(value) as T | undefined }',
            'export function parseWorkOrder(input: string) {',
            '  const findings: ParserFinding[] = []',
            '  const add = (code: ParserFindingCode, target: string, message: string) => {',
            '    findings.push(Object.freeze({ code, target, message }))',
            '  }',
            "  if (input.length > 8) add('WO_SIZE_LIMIT', 'work-order', 'too large')",
            "  if (!input.startsWith('---')) add('WO_FRONTMATTER_INVALID', 'frontmatter', 'invalid')",
            '  return immutable({ ok: findings.length === 0, findings: Object.freeze(findings) })!',
            '}',
            'function usageOutcome(code: string, message: string) { return { status: 2, diagnostics: [{ code, message }] } }',
            "export const rejected = () => usageOutcome('WORK_APPLICATION_REFUSED', 'work refused')",
            "export const operator = () => usageOutcome('WORK_OPERATOR_REQUIRED', 'operator required')",
            'function writeOutput(existing: boolean) {',
            "  const diagnostic = existing ? { code: 'OUTPUT_EXISTS', message: 'exists' } : { code: 'OUTPUT_WRITE_FAILED', message: 'write failed' }",
            '  return { diagnostics: [diagnostic] }',
            '}',
            'function renderJsonResponse(value: unknown) { return JSON.stringify(value) }',
            'function guard() {',
            '  let response: unknown',
            "  response = { diagnostics: [{ code: 'GUARD_INPUT_UNAVAILABLE' }] }",
            '  renderJsonResponse({ diagnostics: response.diagnostics })',
            '}',
            'function document() {',
            '  const diagnostics: unknown[] = []',
            "  diagnostics.unshift({ code: 'DOCUMENT_STDOUT_TARGET' })",
            '  return { diagnostics }',
            '}',
            'function warnings() {',
            '  const warnings: unknown[] = []',
            "  warnings.push(Object.freeze({ code: 'SURFACE_GENERATOR_TRUST_WARNING' }))",
            '  return Object.freeze(warnings)',
            '}',
            'function collectMcp() {',
            '  const diagnostics: unknown[] = []',
            "  diagnostics.push({ code: 'MCP_APPROVAL_UNKNOWN' })",
            '  const outcome = snapshotJson({ diagnostics })',
            '  return outcome',
            '}',
            "function unrelatedTransform() { const value = transform({ code: 'DECOY_TRANSFORM_ARGUMENT' }); return value }",
            "function unrelatedMutation() { const warnings: unknown[] = []; warnings.push({ code: 'DECOY_UNRETURNED_ARRAY' }); return [] }",
            "function unrelatedRender() { renderOther({ code: 'DECOY_RENDER_ARGUMENT' }) }",
            "function unrelated() { const add = (value: string) => value; return add('DECOY_GENERIC_ADD') }",
            "const unrelatedObject = Object.freeze({ code: 'DECOY_NOT_RETURNED' })",
            '',
        ].join('\n')]]))
        expect(inventory.items).toEqual([
            'DOCUMENT_STDOUT_TARGET', 'GUARD_INPUT_UNAVAILABLE', 'MCP_APPROVAL_UNKNOWN', 'OUTPUT_EXISTS', 'OUTPUT_WRITE_FAILED',
            'SURFACE_GENERATOR_TRUST_WARNING', 'WORK_APPLICATION_REFUSED', 'WORK_OPERATOR_REQUIRED', 'WO_FRONTMATTER_INVALID', 'WO_SIZE_LIMIT',
        ].map(code => `diagnostic:${code}`))
        for (const code of ['WO_SIZE_LIMIT', 'GUARD_INPUT_UNAVAILABLE']) expect([...inventory.owners.get(code) ?? []]).toEqual([path])
    })

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
            rmSync(root, { recursive: true, force: true, maxRetries: 5 })
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
            rmSync(root, { recursive: true, force: true, maxRetries: 5 })
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
            rmSync(root, { recursive: true, force: true, maxRetries: 5 })
        }
    }, 240_000)
})
