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
import { afterAll, describe, expect, it } from 'vitest'
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

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export const LINTER = fileURLToPath(new URL('../../../scripts/docs-lint.mjs', import.meta.url))

export function committedReferenceFixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'reference-closure-')))
    for (const path of [
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'packages/cockpit/package.json',
        'packages/cockpit/tsconfig.build.json',
        'packages/cockpit/cockpit.schema.json',
        'packages/cockpit/libexec',
        'packages/cockpit/src',
        'packages/cockpit/surfaces',
        'packages/cockpit/dist',
        'scripts/diagnostic-inventory.mjs',
        'scripts/diagnostic-inventory.d.mts',
        'scripts/docs-lint.mjs',
        'scripts/docs-lint.d.mts',
    ]) {
        const destination = join(root, path)
        mkdirSync(join(destination, '..'), { recursive: true })
        cpSync(join(ROOT, path), destination, { recursive: true })
    }
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/troubleshooting.md'), [
        '# Troubleshooting',
        '',
        'Foreign maintainer prose.',
        '',
        '<!-- cockpit:diagnostic-index:begin -->',
        'stale diagnostic index',
        '<!-- cockpit:diagnostic-index:end -->',
        '',
    ].join('\n'))
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['add', 'package.json', 'package-lock.json', 'tsconfig.json', 'packages/cockpit/package.json',
        'packages/cockpit/tsconfig.build.json', 'packages/cockpit/cockpit.schema.json',
        'packages/cockpit/libexec', 'packages/cockpit/src',
        'packages/cockpit/surfaces', 'scripts', 'docs/troubleshooting.md'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' })
    writeFileSync(join(root, 'fixture-head.txt'), 'current head\n')
    execFileSync('git', ['add', 'fixture-head.txt'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'advance'], { cwd: root, stdio: 'ignore' })
    return root
}

export function malformedGitBoundary(root: string) {
    const bin = join(root, 'fixture-bin')
    const statePath = join(root, 'fixture-git-state.json')
    const realGit = realpathSync(execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim())
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), [
        `#!${process.execPath}`,
        "import { readFileSync, writeFileSync } from 'node:fs'",
        "import { spawnSync } from 'node:child_process'",
        `const statePath = ${JSON.stringify(statePath)}`,
        `const realGit = ${JSON.stringify(realGit)}`,
        "const arguments_ = process.argv.slice(2)",
        "const state = JSON.parse(readFileSync(statePath, 'utf8'))",
        "if (arguments_[0] === 'cat-file' && arguments_[1] === 'blob') state.sourceBlobs += 1",
        "if (arguments_[0] === 'show' && arguments_[1]?.includes(':packages/cockpit/src/')) state.sourceShows += 1",
        "const result = spawnSync(realGit, arguments_, { cwd: process.cwd(), encoding: null, input: readFileSync(0), maxBuffer: 64 * 1024 * 1024 })",
        "let stdout = result.stdout ?? Buffer.alloc(0)",
        "if (arguments_[0] === 'ls-tree') {",
        "  state.seen += 1",
        "  if (state.seen === state.corruptAt) {",
        "    if (state.mutation === 'leading') stdout = Buffer.concat([Buffer.from([0]), stdout])",
        "    if (state.mutation === 'doubled') {",
        "      const boundary = stdout.indexOf(0)",
        "      stdout = Buffer.concat([stdout.subarray(0, boundary + 1), Buffer.from([0]), stdout.subarray(boundary + 1)])",
        "    }",
        "    if (state.mutation === 'trailing') stdout = Buffer.concat([stdout, Buffer.from([0])])",
        "    if (state.mutation === 'missing') stdout = stdout.subarray(0, stdout.length - 1)",
        "  }",
        "}",
        "writeFileSync(statePath, JSON.stringify(state))",
        "writeFileSync(1, stdout)",
        "writeFileSync(2, result.stderr ?? Buffer.alloc(0))",
        "process.exit(result.status ?? 1)",
        '',
    ].join('\n'), { mode: 0o755 })
    return {
        path: bin,
        set(mutation: 'valid' | 'leading' | 'doubled' | 'trailing' | 'missing', corruptAt: number) {
            writeFileSync(statePath, JSON.stringify({ mutation, corruptAt, seen: 0, sourceBlobs: 0, sourceShows: 0 }))
        },
        state(): { seen: number; sourceBlobs: number; sourceShows: number } {
            return JSON.parse(readFileSync(statePath, 'utf8')) as { seen: number; sourceBlobs: number; sourceShows: number }
        },
    }
}

export interface EvidenceRow {
    anchor?: string
    disposition: 'updated' | 'not_applicable' | 'deferred'
    id: string
    reason?: string
    requirement?: string
}

export interface EvidenceDocument {
    candidate: string
    fixedPoint: string
    navigation: Array<{
        harness: string
        receipt: {
            bounds: { maxOutputBytes: number; maxSeconds: number }
            brokenControl: { command: string; detectorCode?: string; exitStatus?: number; transcriptSha256?: string }
            candidate: { command: string; exitStatus?: number; transcriptSha256?: string }
            candidateCommit: string
            cleanup: { after: string; before: string }
            differential: string
            issuedAt: string
            openedPaths: string[]
            scopeSha256: string
        }
        signature: string
        scope: string[]
    }>
    operatorReview: {
        action?: string
        completionEvidence?: string
        date?: string
        rows?: Array<{ disposition: string; evidence: string; id: string }>
        scope?: string[]
        status: string
    }
    rows: EvidenceRow[]
}

export function writeEvidence(path: string, evidence: EvidenceDocument): void {
    writeFileSync(path, `# Evidence\n\nSynthetic evidence fixture.\n\n\`\`\`docs-evidence\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`)
}

export function commentIdForTest(path: string, change: 'added' | 'removed', line: number, body: string): string {
    return `comment:${path}:${change}:${line}:${createHash('sha256').update(body).digest('hex').slice(0, 16)}`
}

export function signNavigation(evidence: EvidenceDocument, privateKey: KeyObject): void {
    for (const row of evidence.navigation) {
        const payload = Buffer.from(JSON.stringify({ harness: row.harness, scope: row.scope, receipt: row.receipt }))
        row.signature = sign(null, payload, privateKey).toString('base64')
    }
}

const DEFAULT_README_ADDITION = 'Run `cockpit up` with `--config`; see [environment details](docs/environment.md#environment).'
const DEFAULT_COMMENT = '// Explain why the synthetic seam remains explicit.'

type EvidenceFixture = {
    candidate: string
    evidence: EvidenceDocument
    evidencePath: string
    fixedPoint: string
    privateKey: KeyObject
    publicKeyPath: string
    root: string
}

let defaultEvidenceFixture: EvidenceFixture | undefined

afterAll(() => {
    if (defaultEvidenceFixture) rmSync(defaultEvidenceFixture.root, { recursive: true, force: true })
    defaultEvidenceFixture = undefined
})

export function createEvidenceFixture(
    readmeAddition = DEFAULT_README_ADDITION,
    comment = DEFAULT_COMMENT,
    declarations: Readonly<Record<string, string>> = {},
): EvidenceFixture {
    if (
        readmeAddition === DEFAULT_README_ADDITION
        && comment === DEFAULT_COMMENT
        && Object.keys(declarations).length === 0
    ) {
        defaultEvidenceFixture ??= buildEvidenceFixture(readmeAddition, comment, declarations)
        const root = mkdtempSync(join(tmpdir(), 'docs-evidence-'))
        cpSync(defaultEvidenceFixture.root, root, { recursive: true })
        const evidence = structuredClone(defaultEvidenceFixture.evidence)
        const { privateKey, publicKey } = generateKeyPairSync('ed25519')
        signNavigation(evidence, privateKey)
        const evidencePath = join(root, 'evidence.md')
        const publicKeyPath = join(root, 'navigation-public-key.pem')
        writeEvidence(evidencePath, evidence)
        writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
        return {
            candidate: defaultEvidenceFixture.candidate,
            evidence,
            evidencePath,
            fixedPoint: defaultEvidenceFixture.fixedPoint,
            privateKey,
            publicKeyPath,
            root,
        }
    }
    return buildEvidenceFixture(readmeAddition, comment, declarations)
}

function buildEvidenceFixture(
    readmeAddition: string,
    comment: string,
    declarations: Readonly<Record<string, string>>,
): EvidenceFixture {
    const root = mkdtempSync(join(tmpdir(), 'docs-evidence-'))
    const write = (path: string, body: string): void => {
        mkdirSync(join(root, path, '..'), { recursive: true })
        writeFileSync(join(root, path), body)
    }
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'synthetic@example.invalid'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Synthetic Fixture'], { cwd: root })
    write('README.md', '# Cockpit\n\nSynthetic repository guide.\n')
    write('docs/environment.md', '# Environment\n\nSynthetic environment reference.\n')
    write('docs/retired.md', '# Retired\n\nSynthetic retired reference.\n')
    write('packages/cockpit/src/command-table.ts', [
        'export const commands = [',
        '    {',
        "        name: 'up',",
        "        handler: 'up',",
        '        options: {',
        "            config: { type: 'string' },",
        "            json: { type: 'boolean' },",
        '        },',
        '    },',
        '    {',
        "        name: 'retired',",
        "        handler: 'retired',",
        '        options: {',
        "            legacy: { type: 'boolean' },",
        '        },',
        '    },',
        '] as const',
        '',
    ].join('\n'))
    write('packages/cockpit/src/cli.ts', [
        "const commandName = '--help'",
        "const env = { DOCKER_CONTEXT: 'synthetic' }",
        "if (commandName === '--help') void env.DOCKER_CONTEXT",
        '',
    ].join('\n'))
    write('packages/cockpit/cockpit.schema.json', JSON.stringify({
        type: 'object',
        properties: {
            cockpit: { type: 'object', properties: { name: { type: 'string' } } },
            retired: { type: 'boolean' },
        },
    }))
    write('packages/cockpit/src/environment/contract.ts', [
        'export const ENVIRONMENT_CODES = Object.freeze({',
        "    SYNTHETIC_FAILURE: 'SYNTHETIC_FAILURE',",
        "    RETIRED_FAILURE: 'RETIRED_FAILURE',",
        '})',
        'export const EXECUTION_FAILURE_CODES = Object.freeze([])',
        '',
    ].join('\n'))
    write('packages/cockpit/src/environment/synthetic.ts', [
        'export const mechanism = {',
        "    id: 'synthetic',",
        "    module: 'packages/cockpit/src/environment/synthetic.ts',",
        "    exports: ['runSynthetic', 'retiredSynthetic'],",
        '} as const',
        "export type RetiredDiagnosticCode = 'RETIRED_LOCAL_FAILURE'",
        'function retiredRefusal(code: RetiredDiagnosticCode) { return { code } }',
        "export function runSynthetic() { return retiredRefusal('RETIRED_LOCAL_FAILURE') }",
        'export const legacy = 1 // Removed inline explanation.',
        '',
    ].join('\n'))
    write('packages/cockpit/src/environment/retired.ts', '// Deleted source explanation.\nexport const retired = true\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'synthetic base'], { cwd: root, stdio: 'ignore' })
    const fixedPoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    write('README.md', `# Cockpit\n\nSynthetic repository guide.\n\n${readmeAddition}\n`)
    write('packages/cockpit/src/command-table.ts', [
        'export const commands = [',
        '    {',
        "        name: 'up',",
        "        handler: 'up',",
        '        options: {',
        "            config: { type: 'string' },",
        "            json: { type: 'boolean' },",
        '        },',
        '    },',
        '] as const',
        '',
    ].join('\n'))
    write('packages/cockpit/cockpit.schema.json', JSON.stringify({
        type: 'object',
        properties: { cockpit: { type: 'object', properties: { name: { type: 'string' } } } },
    }))
    write('packages/cockpit/src/environment/contract.ts', [
        'export const ENVIRONMENT_CODES = Object.freeze({',
        "    SYNTHETIC_FAILURE: 'SYNTHETIC_FAILURE',",
        '})',
        'export const EXECUTION_FAILURE_CODES = Object.freeze([])',
        '',
    ].join('\n'))
    write('packages/cockpit/src/environment/synthetic.ts', [
        'export const mechanism = {',
        "    id: 'synthetic',",
        "    module: 'packages/cockpit/src/environment/synthetic.ts',",
        "    exports: ['runSynthetic'],",
        '} as const',
        "export type SyntheticDiagnosticCode = 'SYNTHETIC_LOCAL_FAILURE'",
        'function refusal(code: SyntheticDiagnosticCode) { return { code } }',
        `export function runSynthetic() { return refusal('SYNTHETIC_LOCAL_FAILURE') } ${comment}`,
        "const unrelated = 'SYNTHETIC_NOT_EMITTED' // SYNTHETIC_COMMENT_ONLY",
        'void unrelated',
        '',
    ].join('\n'))
    write('packages/cockpit/src/environment/synthetic.test.ts', 'export const syntheticTest = true\n')
    write('packages/cockpit/src/generated/synthetic-command.ts', [
        'export const mechanism = {',
        "    id: 'synthetic-command',",
        "    module: 'packages/cockpit/src/generated/synthetic-command.ts',",
        "    exports: ['runSyntheticCommand'],",
        '} as const',
        "export type SyntheticCompatibility = 'compatible' | 'incompatible'",
        'export function runSyntheticCommand() {}',
        '',
    ].join('\n'))
    write('packages/cockpit/src/command-table.test.ts', 'export const commandTableTest = true\n')
    write('packages/cockpit/src/cli.test.ts', 'export const cliTest = true\n')
    execFileSync('git', ['rm', 'docs/retired.md', 'packages/cockpit/src/environment/retired.ts'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['add',
        'README.md',
        'packages/cockpit/cockpit.schema.json',
        'packages/cockpit/src/command-table.ts',
        'packages/cockpit/src/environment/contract.ts',
        'packages/cockpit/src/environment/synthetic.ts',
        'packages/cockpit/src/environment/synthetic.test.ts',
        'packages/cockpit/src/generated/synthetic-command.ts',
        'packages/cockpit/src/command-table.test.ts',
        'packages/cockpit/src/cli.test.ts',
    ], { cwd: root })
    for (const [path, body] of Object.entries(declarations)) write(path, body)
    if (Object.keys(declarations).length > 0) execFileSync('git', ['add', ...Object.keys(declarations)], { cwd: root })
    execFileSync('git', ['commit', '-m', 'synthetic candidate'], { cwd: root, stdio: 'ignore' })
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const stateDirectory = '.local-notes'
    mkdirSync(join(root, stateDirectory), { recursive: true })
    writeFileSync(join(root, stateDirectory, 'REQUIREMENTS.md'), '- [ ] **REQ-S1.1**: Synthetic deferred requirement.\n')
    const inventory = deriveDocumentationInventory({ root, expectedFixedPoint: fixedPoint, candidate })
    expect(inventory.errors).toEqual([])
    expect(inventory.items).toEqual(expect.arrayContaining([
        'command:up',
        'command:retired',
        'flag:retired:--legacy',
        'flag:up:--config',
        'flag:up:--json',
        'schema:cockpit',
        'schema:cockpit.name',
        'schema:retired',
        'diagnostic:SYNTHETIC_FAILURE',
        'diagnostic:RETIRED_FAILURE',
        'diagnostic:RETIRED_LOCAL_FAILURE',
        'diagnostic:SYNTHETIC_LOCAL_FAILURE',
        'extension:packages/cockpit/src/environment/synthetic.ts#runSynthetic',
        'extension:packages/cockpit/src/environment/synthetic.ts#legacy',
        'extension:packages/cockpit/src/generated/synthetic-command.ts#runSyntheticCommand',
        'document:README.md',
        'document:docs/retired.md',
        commentIdForTest('packages/cockpit/src/environment/synthetic.ts', 'added', 8, comment),
        commentIdForTest('packages/cockpit/src/environment/synthetic.ts', 'removed', 9, '// Removed inline explanation.'),
        commentIdForTest('packages/cockpit/src/environment/retired.ts', 'removed', 1, '// Deleted source explanation.'),
    ]))
    const rows: EvidenceRow[] = inventory.items.map((id) => ({
        id,
        disposition: 'updated',
        anchor: id === 'document:README.md' ? 'README.md#cockpit' : 'docs/environment.md#environment',
    }))
    const navigation = ['codex', 'claude'].map((harness) => ({
        harness,
        scope: inventory.navigationItems,
        receipt: {
            bounds: { maxOutputBytes: 65536, maxSeconds: 30 },
            candidateCommit: candidate,
            cleanup: {
                before: createHash('sha256').update(`${harness}:cleanup`).digest('hex'),
                after: createHash('sha256').update(`${harness}:cleanup`).digest('hex'),
            },
            differential: 'The broken control was detected while the candidate completed.',
            issuedAt: '2026-09-26T00:00:00.000Z',
            openedPaths: [...new Set([...inventory.navigationPaths, 'docs/environment.md'])].sort(),
            scopeSha256: createHash('sha256').update(`${inventory.navigationItems.join('\n')}\n`).digest('hex'),
            candidate: {
                command: `${harness} candidate`,
                exitStatus: 0,
                transcriptSha256: createHash('sha256').update(`${harness}:candidate`).digest('hex'),
            },
            brokenControl: {
                command: `${harness} broken`,
                exitStatus: 1,
                detectorCode: 'SYNTHETIC_CONTROL_DETECTED',
                transcriptSha256: createHash('sha256').update(`${harness}:broken`).digest('hex'),
            },
        },
        signature: '',
    }))
    const evidence: EvidenceDocument = {
        candidate,
        fixedPoint,
        rows,
        navigation,
        operatorReview: {
            status: 'human_needed',
            date: '2026-09-26',
            scope: inventory.reviewItems,
            action: 'Review every changed public document and comment.',
            completionEvidence: 'Record a dated disposition for every listed item.',
        },
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    signNavigation(evidence, privateKey)
    const publicKeyPath = join(root, 'navigation-public-key.pem')
    writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
    const evidencePath = join(root, 'evidence.md')
    writeEvidence(evidencePath, evidence)
    return { candidate, evidence, evidencePath, fixedPoint, privateKey, publicKeyPath, root }
}

export function createCommittedEvidenceFixture(runtimeCodes?: { unavailable: string; timeout: string }): {
    base: string
    head: string
    manifest: Record<string, unknown>
    root: string
} {
    const root = mkdtempSync(join(tmpdir(), 'committed-evidence-'))
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'synthetic@example.invalid'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Synthetic Fixture'], { cwd: root })
    writeFileSync(join(root, 'subject.txt'), 'base\n')
    if (runtimeCodes) {
        const contract = 'packages/cockpit/src/environment/contract.ts'
        mkdirSync(join(root, 'packages/cockpit/src/environment'), { recursive: true })
        writeFileSync(join(root, contract), [
            'export const ENVIRONMENT_CODES = Object.freeze({',
            `    RUNTIME_UNAVAILABLE: '${runtimeCodes.unavailable}',`,
            `    RUNTIME_PROBE_TIMEOUT: '${runtimeCodes.timeout}',`,
            '})',
            'export const EXECUTION_FAILURE_CODES = Object.freeze([])',
            '',
        ].join('\n'))
        execFileSync('git', ['add', contract], { cwd: root })
    }
    execFileSync('git', ['add', 'subject.txt'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    writeFileSync(join(root, 'subject.txt'), 'candidate\n')
    writeFileSync(join(root, 'added.txt'), 'added\n')
    execFileSync('git', ['add', 'subject.txt', 'added.txt'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'candidate'], { cwd: root, stdio: 'ignore' })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    expect(writeReviewManifest({ root, path: 'manifest.json', expectedFixedPoint: base, candidate: head })).toEqual([])
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>
    return { base, head, manifest, root }
}

export function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
