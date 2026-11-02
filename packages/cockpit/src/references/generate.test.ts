import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { diagnosticInventory } from '../../../../scripts/docs-lint.mjs'
import { diagnosticInventoryFromSources, type DiagnosticRemedy } from '../../../../scripts/diagnostic-inventory.mjs'
import { runCli } from '../cli.js'
import { commands } from '../command-table.js'
import { executeProbe } from '../environment-exec/execute.js'
import { resolveGitExecutable } from '../environment/executable.js'
import type { GeneratedSurfaceSelftestProjection } from '../environment/generated-application.js'
import { captureReferenceBootstrap, encodeReferenceManifest, nodeAuthority } from '../generated-environment/transaction.js'
import { configurationDefaults } from '../schema.js'
import { renderCockpitSchema } from '../schema-json.js'
import { inspectSkillSet, type AdmittedSkillCollection } from '../surfaces/skill-contract.js'
import { classifySurfaceOwnership } from '../surfaces/ownership.js'
import { prepareCommittedCapabilityProjection, renderReferences, writeReferences, validateTroubleshootingIndex, type CommittedCapabilityProjection, type RenderedReferences } from './generate.js'

// Every render in this file runs as a release-bumped package: the committed references are
// regenerated at one version and must stay byte-identical after the next bump.
const BUMPED_VERSION = vi.hoisted(() => '99.0.0')
vi.mock('../package-metadata.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../package-metadata.js')>()
    return { ...original, installedPackageMetadata: Object.freeze({ ...original.installedPackageMetadata, version: BUMPED_VERSION }) }
})

const roots: string[] = []
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const begin = '<!-- cockpit:diagnostic-index:begin -->'
const end = '<!-- cockpit:diagnostic-index:end -->'
const prose = `# Troubleshooting\r\n\r\nKeep this human paragraph.\r\n${begin}\nold index\n${end}\r\n\r\nKeep the suffix.\r\n`
const wholePaths = ['docs/cli-reference.md', 'docs/configuration-reference.md', 'docs/command-list.md', 'docs/capability-matrix.md', 'skills/adopt-cockpit/SKILL.md']
let skills: AdmittedSkillCollection
let capabilities: GeneratedSurfaceSelftestProjection
let committed: CommittedCapabilityProjection
let adoptSkill: { template: string; procedure: string }

async function shippedAssets() {
    const surfaceRoot = 'packages/cockpit/surfaces'
    const terminalBytes = await readFile(`${surfaceRoot}/skills/procedures/onboarding.md`, 'utf8')
    const collectionBytes = await readFile(`${surfaceRoot}/skills/collection.json`, 'utf8')
    const sourceAsset = async (path: string, installedPath: string) => {
        const bytes = await readFile(path, 'utf8')
        return { path, installedPath, bytes, sha256: digest(bytes) }
    }
    return {
        guardTemplate: await readFile(`${surfaceRoot}/guards/bash-guard.sh`, 'utf8'),
        adapters: await Promise.all(['claude', 'codex', 'opencode'].map(async name => JSON.parse(await readFile(`${surfaceRoot}/guards/${name}.adapter.json`, 'utf8')))),
        skillSources: (await Promise.all(['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'].map(async name => [
            { path: `skills/${name}/SKILL.md`, bytes: await readFile(`${surfaceRoot}/skills/${name}.skill.md`, 'utf8') },
            { path: `skills/${name}/procedures/onboarding.md`, bytes: terminalBytes },
        ]))).flat(),
        collection: { path: 'skills/collection.json', bytes: collectionBytes, sha256: digest(collectionBytes) },
        terminal: { path: 'skills/procedures/onboarding.md', bytes: terminalBytes, sha256: digest(terminalBytes) },
        sourceAssets: await Promise.all([
            sourceAsset(`${surfaceRoot}/skills/collection.json`, 'skills/collection.json'),
            sourceAsset(`${surfaceRoot}/skills/procedures/onboarding.md`, 'skills/procedures/onboarding.md'),
            ...['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'].flatMap(name => [
                sourceAsset(`${surfaceRoot}/skills/${name}.skill.md`, `skills/${name}/SKILL.md`),
                sourceAsset(`${surfaceRoot}/skills/procedures/onboarding.md`, `skills/${name}/procedures/onboarding.md`),
            ]),
        ]),
    }
}

beforeAll(async () => {
    const surfaceRoot = 'packages/cockpit/surfaces/skills'
    const terminalBytes = await readFile(`${surfaceRoot}/procedures/onboarding.md`, 'utf8')
    adoptSkill = { template: await readFile('packages/cockpit/src/references/adopt-cockpit.skill.md', 'utf8'), procedure: terminalBytes }
    const collectionBytes = await readFile(`${surfaceRoot}/collection.json`, 'utf8')
    const sources = (await Promise.all(['cockpit-setup', 'cockpit-explain', 'cockpit-fix', 'cockpit-work'].map(async name => [
        { path: `skills/${name}/SKILL.md`, bytes: await readFile(`${surfaceRoot}/${name}.skill.md`, 'utf8') },
        { path: `skills/${name}/procedures/onboarding.md`, bytes: terminalBytes },
    ]))).flat()
    const result = await inspectSkillSet({ sources,
        collection: { path: 'skills/collection.json', bytes: collectionBytes, sha256: digest(collectionBytes) },
        terminal: { path: 'skills/procedures/onboarding.md', bytes: terminalBytes, sha256: digest(terminalBytes) } })
    if (result.kind !== 'complete') throw new Error(`skill authority failed: ${JSON.stringify(result)}`)
    skills = result.collection
    const payload = { schema: 'cockpit-generated-surface-selftest/v1' as const, configuredHarnesses: ['claudecode', 'codexcli', 'opencode'],
        declarations: [], custom: [], entries: result.files.filter(file => ['claudecode', 'codexcli', 'opencode'].includes(file.target)).map(file => ({ kind: 'file' as const, path: file.path, bytes: file.bytes, sha256: file.sha256,
            harnesses: [file.target] as readonly [typeof file.target], scope: 'always' as const, capability: 'instructed' as const, ownership: 'whole-file' as const,
            writer: 'cockpit' as const, schemaVersion: 1 as const })) }
    const ownership = classifySurfaceOwnership({ configuredHarnesses: payload.configuredHarnesses,
        entries: [...payload.entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) })
    if (ownership.kind !== 'complete') throw new Error(`capability ownership failed: ${ownership.diagnostic.message}`)
    const admitted = { schema: payload.schema, configuredHarnesses: payload.configuredHarnesses,
        declarations: payload.declarations, entries: ownership.entries, custom: payload.custom }
    capabilities = { ...admitted, manifestSha256: digest(JSON.stringify(admitted)) }
    const prepared = await prepareCommittedCapabilityProjection(await shippedAssets())
    if (prepared.kind !== 'complete') throw new Error(JSON.stringify(prepared))
    committed = prepared.projection
})

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function input(troubleshooting = prose) {
    return { skills, troubleshooting, diagnostics: { items: ['diagnostic:SYNTHETIC_FAILURE'],
        owners: new Map([['SYNTHETIC_FAILURE', new Set(['packages/cockpit/src/document/command.ts'])]]),
        remedies: new Map([['SYNTHETIC_FAILURE', { kind: 'fixed' as const, fix: 'repair the synthetic input' }]]),
        commandDiagnostics: new Map([['document', new Set(['SYNTHETIC_FAILURE'])]]) },
        capabilities, guideCosts: [], adoptSkill }
}

async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-references-')))
    roots.push(root)
    const authority = { root, cockpitId: 'synthetic-references', configPath: join(root, 'package.json') }
    const sourceSha256 = digest('synthetic source')
    await mkdir(join(root, 'docs'))
    await mkdir(join(root, '.cockpit'))
    await mkdir(join(root, 'skills/adopt-cockpit'), { recursive: true })
    await writeFile(join(root, 'docs/troubleshooting.md'), prose)
    await Promise.all(wholePaths.map(path => writeFile(join(root, path), 'prior')))
    const blobs = new Map([...wholePaths.map(path => [path, 'prior'] as const), ['docs/troubleshooting.md', prose]])
    const objects = [...blobs].map(([path, bytes]) => ({ path, bytes,
        oid: createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex') }))
    const script = `#!${process.execPath}\nconst args=process.argv.slice(2);const objects=${JSON.stringify(objects)};` +
        `if(args[0]==='rev-parse')process.stdout.write(args[1]==='--show-object-format'?'sha1\\n':'${'a'.repeat(40)}\\n');` +
        `else if(args[0]==='ls-tree')process.stdout.write(objects.map(row=>'100644 blob '+row.oid+'\\t'+row.path+'\\0').join(''));` +
        `else if(args[0]==='cat-file'){const row=objects.find(row=>row.oid===args[2]);if(!row)process.exitCode=1;else process.stdout.write(row.bytes);}` +
        `else process.exitCode=1;\n`
    await writeFile(join(root, 'git'), script)
    await chmod(join(root, 'git'), 0o755)
    const git = await resolveGitExecutable({ PATH: root })
    if (git.state !== 'available') throw new Error(`synthetic Git unavailable: ${git.reason}`)
    const captured = await captureReferenceBootstrap(root, git.value, { execute: executeProbe })
    if (captured.kind !== 'complete') throw new Error(JSON.stringify(captured))
    const prior = encodeReferenceManifest({ sourceSha256, generation: digest('prior'),
        files: wholePaths.map(path => ({ path, sha256: digest('prior') })), troubleshootingSha256: digest('old index\n') })
    await writeFile(join(root, '.cockpit/generated-reference-ownership.json'), prior.bytes)
    const node = await nodeAuthority()
    if (!node) throw new Error('Node authority unavailable')
    const status = await lstat(root)
    const publicationFor = async (rendered: RenderedReferences) => {
        const ledger = await readFile(join(root, '.cockpit/generated-reference-ownership.json'), 'utf8')
        const ledgerStatus = await lstat(join(root, '.cockpit/generated-reference-ownership.json'))
        const owned = [...rendered.files.map(({ path, sha256 }) => ({ path, sha256 })), { path: rendered.troubleshooting.path, sha256: rendered.troubleshooting.sha256 }]
        const generation = digest(JSON.stringify(owned))
        const next = encodeReferenceManifest({ sourceSha256, generation,
            files: rendered.files, troubleshootingSha256: digest(rendered.troubleshooting.bytes) })
        return { authority, sourceSha256, generation, node, referenceBootstrap: captured.bootstrap,
            rootIdentity: { dev: status.dev, ino: status.ino }, nextLedgerBytes: next.bytes,
            ledgerExpected: { kind: 'file' as const, sha256: digest(ledger), identity: { dev: ledgerStatus.dev, ino: ledgerStatus.ino } } }
    }
    return { root, prior, publicationFor }
}

describe('reference generation', () => {
    it('renders captured repository sources for committed collection, displacement and entrypoints', () => {
        const rendered = renderReferences({ committed, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill })
        expect(rendered.kind).toBe('complete')
        if (rendered.kind !== 'complete') return
        const configuration = rendered.files[1]!.bytes
        expect(configuration).toContain('The limits come from `packages/cockpit/surfaces/skills/collection.json`')
        expect(configuration).toContain('The procedure `packages/cockpit/surfaces/skills/procedures/onboarding.md` is read on demand and has no size limit')
        for (const entry of skills.entrypoints) {
            const name = entry.path.split('/')[1]
            expect(configuration).toContain(`| \`packages/cockpit/surfaces/skills/${name}.skill.md\` | lines | ${entry.cap} | \`packages/cockpit/surfaces/skills/procedures/onboarding.md\` |`)
        }
        expect(configuration.match(/`packages\/cockpit\/surfaces\/skills\/procedures\/onboarding\.md`/g)).toHaveLength(1 + Object.keys(skills.caps).length + skills.entrypoints.length)
        expect(configuration).not.toMatch(/`skills\/(?:collection\.json|procedures\/onboarding\.md|(?:bootstrap|explain|fix)\/SKILL\.md)`/)
    })

    it('emits generated reference files with exactly one terminal newline', () => {
        const rendered = renderReferences({ committed, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill })
        expect(rendered.kind).toBe('complete')
        if (rendered.kind !== 'complete') return
        for (const file of rendered.files) expect(file.bytes, file.path).toMatch(/[^\n]\n$/)
    })
    it('opens each generated reference with its audience and purpose', () => {
        const rendered = renderReferences({ committed, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill })
        expect(rendered.kind).toBe('complete')
        if (rendered.kind !== 'complete') return
        const files = new Map(rendered.files.map(file => [file.path, file.bytes]))
        expect(files.get('docs/cli-reference.md')).toContain('for users looking up an exact command, flag, exit code or diagnostic')
        expect(files.get('docs/configuration-reference.md')).toContain('for users authoring or reviewing `cockpit.toml`')
        expect(files.get('docs/command-list.md')).toContain('for users choosing the command that owns their next operation')
        expect(files.get('docs/capability-matrix.md')).toContain('for users checking what cockpit actually enforces in each agent tool')
    })
    it('preserves the exact CRLF marker boundary when replacing its bounded index', () => {
        const source = prose.replace(`${begin}\n`, `${begin}\r\n`)
        const rendered = renderReferences(input(source))
        expect(rendered.kind).toBe('complete')
        if (rendered.kind === 'complete') expect(rendered.troubleshooting.document).toContain(`${begin}\r\nEach diagnostic message`)
    })
    it('refuses source paths without matching captured bytes and snapshots admitted source bindings', async () => {
        const assets = await shippedAssets()
        const first = assets.sourceAssets[0]!
        for (const changed of [
            { ...first, path: 'foreign/collection.json' },
            { ...first, installedPath: 'skills/foreign.json' },
            { ...first, bytes: first.bytes + '\n' },
            { ...first, bytes: first.bytes + '\n', sha256: digest(first.bytes + '\n') },
            { ...first, sha256: '0'.repeat(64) },
        ]) {
            expect((await prepareCommittedCapabilityProjection({ ...assets, sourceAssets: [changed, ...assets.sourceAssets.slice(1)] })).kind).toBe('refusal')
        }
        expect((await prepareCommittedCapabilityProjection({ ...assets, sourceAssets: assets.sourceAssets.slice(1) })).kind).toBe('refusal')
        const prepared = await prepareCommittedCapabilityProjection(assets)
        expect(prepared.kind).toBe('complete')
        if (prepared.kind !== 'complete') return
        const before = renderReferences({ committed: prepared.projection, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill })
        assets.sourceAssets[0]!.path = 'foreign/collection.json'
        assets.sourceAssets[0]!.bytes = 'foreign bytes'
        expect(renderReferences({ committed: prepared.projection, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill })).toEqual(before)
    })
    it('derives committed capability strength from shipped bytes and refuses a changed guard contract', async () => {
        const assetInput = await shippedAssets()
        const prepared = await prepareCommittedCapabilityProjection(assetInput)
        expect(prepared.kind, JSON.stringify(prepared)).toBe('complete')
        if (prepared.kind !== 'complete') return
        const rendered = renderReferences({ committed: prepared.projection, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill })
        expect(rendered.kind, JSON.stringify(rendered)).toBe('complete')
        if (rendered.kind !== 'complete') return
        const matrix = rendered.files.find(file => file.path === 'docs/capability-matrix.md')!.bytes
        const section = (page: string, heading: string) => page.slice(page.indexOf(`## ${heading}\n`)).split(/\n(?=## )/)[0]!
        // One row per harness, one column per capability. Cursor and Grok Build get generated rules and
        // skills but no guard hook: the grid must not call emitted files unavailable, nor the absent
        // guard anything else. Guard firing is enforced only where a dated run of the real tool showed
        // a refusal, and Codex's holds only once a person trusts the hook.
        expect(matrix).toContain('| Tool | Guard firing | Instruction loading | Skills |\n| --- | --- | --- | --- |\n'
            + '| Claude Code (`claudecode`) | enforced | instructed | instructed |\n'
            + '| Codex (`codexcli`) | enforced (needs a person) | instructed | instructed |\n'
            + '| OpenCode (`opencode`) | enforced | instructed | instructed |\n'
            + '| Cursor (`cursor`) | unavailable | generated | generated |\n'
            + '| Grok Build (`grokcli`) | unavailable | generated | generated |\n')
        // Every measured cell names its date and tool version beside what the run showed.
        const measurements = section(matrix, 'Measurements')
        expect(measurements).toMatch(/^- Claude Code, guard firing \(2026-11-01, version 2\.1\.316\): [^\n]+\.$/m)
        expect(measurements).toMatch(/^- Codex, guard firing \(2026-11-01, version 0\.165\.0\): only after a person trusts the hook: [^\n]+\.$/m)
        expect(measurements).toMatch(/^- OpenCode, guard firing \(2026-11-01, version 1\.19\.4\): [^\n]+\.$/m)
        for (const tool of ['Claude Code', 'Codex', 'OpenCode']) {
            expect(measurements).toMatch(new RegExp(`^- ${tool}, instruction loading \\(\\d{4}-\\d{2}-\\d{2}, version \\d[^)]*\\): [^\\n]+\\.$`, 'm'))
        }
        expect(measurements).not.toMatch(/Cursor|Grok Build|skills/)
        // A date reads as a run of the tool, so cells nobody ran carry none. The skills share one
        // verdict per harness and read as one line per verdict, not one per skill.
        const unmeasured = section(matrix, 'Without a measurement')
        expect(unmeasured).not.toMatch(/\d{4}-\d{2}-\d{2}/)
        expect(unmeasured).toContain('- Guard firing in Cursor and Grok Build: no guard adapter is checked in, so cockpit generates no guard hook.\n')
        expect(unmeasured).toContain('- Skills in Claude Code (`.claude/skills`), Codex (`.agents/skills`) and OpenCode (`.opencode/skills`): ')
        expect(unmeasured).toContain('- Skills in Cursor (`.cursor/skills`) and Grok Build (`.grok/skills`): ')
        expect(matrix).not.toMatch(/cockpit-setup\/SKILL\.md|pending_evidence|human_needed|not_applicable|inspectSkillSet|operator parity|unmeasured/)
        expect(renderReferences({ committed: { ...prepared.projection }, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill }).kind).toBe('refusal')
        expect((await prepareCommittedCapabilityProjection({ ...assetInput, guardTemplate: '#!/bin/sh\nexit 0\n' })).kind).toBe('refusal')
        expect((await prepareCommittedCapabilityProjection({ ...assetInput, skillSources: assetInput.skillSources.slice(2) })).kind).toBe('refusal')
        const editedSkill = assetInput.skillSources[2]!.bytes.replace(/\n$/, '\nA reworded closing line.\n')
        const editedPath = assetInput.skillSources[2]!.path
        const edited = await prepareCommittedCapabilityProjection({ ...assetInput,
            skillSources: assetInput.skillSources.map(source => source.path === editedPath ? { ...source, bytes: editedSkill } : source),
            sourceAssets: assetInput.sourceAssets.map(source => source.installedPath === editedPath ? { ...source, bytes: editedSkill, sha256: digest(editedSkill) } : source) })
        expect(edited.kind, JSON.stringify(edited)).toBe('complete')
        if (edited.kind !== 'complete') return
        const editedMatrix = renderReferences({ committed: edited.projection, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill })
        // The manifest is invisible to readers but still moves with any shipped skill byte.
        const manifestLine = (page: string) => /^<!-- Source manifest: [0-9a-f]{64} -->$/m.exec(page)?.[0]
        expect(manifestLine(matrix)).toBeDefined()
        expect(editedMatrix.kind === 'complete' && manifestLine(editedMatrix.files[3]!.bytes)).not.toBe(manifestLine(matrix))
        const unavailable = await prepareCommittedCapabilityProjection({ ...assetInput, adapters: assetInput.adapters.map(row => row.target === 'codexcli'
            ? { format: row.format, target: row.target, mechanism: 'unavailable', measuredOn: row.measuredOn, measuredVersion: null,
                provenance: 'synthetic unavailable adapter', reason: 'native entry unavailable' } : row) })
        expect(unavailable.kind, JSON.stringify(unavailable)).toBe('complete')
        if (unavailable.kind !== 'complete') return
        const changed = renderReferences({ committed: unavailable.projection, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill })
        expect(changed.kind).toBe('complete')
        if (changed.kind === 'complete') {
            expect(changed.files[3]!.bytes).toContain('| Codex (`codexcli`) | unavailable | instructed | instructed |')
            expect(changed.files[3]!.bytes).toContain('- Guard firing in Codex: synthetic unavailable adapter.\n')
            expect(changed.files[3]!.bytes).not.toMatch(/^- Codex, guard firing/m)
        }
    })

    it('derives exactly the whole-file references and one bounded region from real owners', () => {
        const first = renderReferences(input())
        expect(first).toEqual(renderReferences(input()))
        expect(first.kind, JSON.stringify(first)).toBe('complete')
        if (first.kind !== 'complete') return
        expect(first.files.map(file => file.path)).toEqual(wholePaths)
        for (const file of first.files) {
            expect(file.bytes).not.toContain('cockpit:verified')
            expect(file.bytes).not.toContain(BUMPED_VERSION)
        }
        const cli = first.files[0]!.bytes
        for (const command of commands) {
            expect(cli).toContain(`cockpit ${command.name}`)
            for (const flag of Object.keys(command.options)) expect(cli).toContain(`--${flag}`)
        }
        const commandSection = (name: string, next?: string) => cli.slice(cli.indexOf(`## cockpit ${name}`),
            next === undefined ? cli.length : cli.indexOf(`## cockpit ${next}`))
        expect(cli).not.toContain('## cockpit compare')
        expect(cli).not.toContain('| `validate` | `none` | `--fixture` | `--fixture`, `--json` |')
        expect(cli).not.toContain('| `run` | `resolved` | `--fixture`, `--config` | `--fixture`, `--config`, `--json` |')
        expect(cli).not.toContain('| `status` | `none` | `--fixture`, `--ledger` | `--fixture`, `--ledger`, `--json` |')
        expect(commandSection('sync', 'check')).toContain('| `--adopt` | string | unset |')
        expect(commandSection('up', 'sleep')).toContain('Start or resume the declared environment.')
        expect(commandSection('test-run')).toContain('| `--gate` | string | unset |')
        expect(first.files[1]!.bytes).toContain(renderCockpitSchema().trim())
        expect(first.files[1]!.bytes).toContain(String(configurationDefaults().cockpit.guide_cap))
        expect(first.files[1]!.bytes).toContain(skills.source.sha256)
        expect(first.files[1]!.bytes).toContain('is read on demand and has no size limit')
        expect(first.files[3]!.bytes).toContain('unavailable')
        expect(first.troubleshooting.document.slice(0, prose.indexOf(begin))).toBe(prose.slice(0, prose.indexOf(begin)))
        expect(first.troubleshooting.document.slice(first.troubleshooting.document.indexOf(end) + end.length)).toBe(prose.slice(prose.indexOf(end) + end.length))
        expect(validateTroubleshootingIndex(input().diagnostics, first.troubleshooting.bytes)).toEqual([])
        // The command list holds commands only: an unexplained block of placeholders gave its reader nothing to act on.
        expect(first.files[2]!.path).toBe('docs/command-list.md')
        expect(first.files[2]!.bytes.split('\n').filter(line => line !== '' && !/^(?:#|<!--|This generated index)/.test(line)))
            .toEqual(commands.map(command => expect.stringMatching(new RegExp(`^- \`cockpit ${command.name}\``))))
    })

    it('copies shipped procedure sections into the adopt-cockpit skill and refuses a template every harness would not load', () => {
        const rendered = renderReferences(input())
        expect(rendered.kind, JSON.stringify(rendered)).toBe('complete')
        if (rendered.kind !== 'complete') return
        const skill = rendered.files.find(file => file.path === 'skills/adopt-cockpit/SKILL.md')!.bytes
        expect(skill).toMatch(/^---\nname: adopt-cockpit\ndescription: "[^"\n]+"\n---\n/)
        for (const name of ['Bootstrap', 'Create a local setup', 'Secret handling']) {
            const start = adoptSkill.procedure.indexOf(`## ${name}\n`)
            const next = adoptSkill.procedure.indexOf('\n## ', start + 1)
            expect(skill).toContain(`#${adoptSkill.procedure.slice(start, next === -1 ? undefined : next).trimEnd()}`)
        }
        expect(skill).not.toContain('cockpit:procedure-section')

        const changedProcedure = adoptSkill.procedure.replace('## Create a local setup\n\n', '## Create a local setup\n\nA changed shipped step.\n\n')
        const followed = renderReferences({ ...input(), adoptSkill: { ...adoptSkill, procedure: changedProcedure } })
        expect(followed.kind === 'complete' && followed.files.find(file => file.path === 'skills/adopt-cockpit/SKILL.md')!.bytes).toContain('A changed shipped step.')

        const harnessKey = adoptSkill.template.replace('name: adopt-cockpit\n', 'name: adopt-cockpit\nallowed-tools: [Bash]\n')
        expect(renderReferences({ ...input(), adoptSkill: { ...adoptSkill, template: harnessKey } })).toMatchObject({ kind: 'refusal' })
        const missingSection = adoptSkill.template.replace('procedure-section Secret handling', 'procedure-section Absent section')
        expect(renderReferences({ ...input(), adoptSkill: { ...adoptSkill, template: missingSection } })).toMatchObject({ kind: 'refusal' })
        expect(renderReferences({ committed, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill: { ...adoptSkill, procedure: changedProcedure } }))
            .toMatchObject({ kind: 'refusal' })
    })

    it('joins the document command options, exits, diagnostics, configuration contract and remedy from owners', () => {
        const rendered = renderReferences(input())
        expect(rendered.kind).toBe('complete')
        if (rendered.kind !== 'complete') return
        const cli = rendered.files.find(file => file.path === 'docs/cli-reference.md')!.bytes
        expect(cli).toContain('## cockpit document')
        expect(cli).toContain('| `--registry` | string | unset |')
        expect(cli).toContain('| 0 | success |')
        expect(cli).toContain('| 2 | failure |')
        expect(cli).toContain('| 130 | cancelled |')
        expect(cli).toContain('| `SYNTHETIC_FAILURE` | repair the synthetic input |')
        expect(rendered.troubleshooting.bytes).toContain('| `SYNTHETIC_FAILURE` | repair the synthetic input |')
        expect(rendered.troubleshooting.bytes).toContain('[Respond to diagnostic codes](environment.md#respond-to-diagnostic-codes)')
        for (const page of [cli, rendered.troubleshooting.bytes]) expect(page).not.toContain('packages/cockpit/src/')
        const documentSection = cli.slice(cli.indexOf('## cockpit document'), cli.indexOf('## cockpit registry-resolve'))
        expect(documentSection).toContain('Does not read `cockpit.toml`.')
        expect(cli.slice(cli.indexOf('## cockpit sync'), cli.indexOf('## cockpit check'))).toContain('Reads `cockpit.toml` from `--config`.')
        expect(cli.slice(cli.indexOf('## cockpit upgrade'), cli.indexOf('\n## cockpit up\n')))
            .toContain('Status: experimental. This interface may change before a stable release.')
    })

    it('points each command diagnostic at its fixed remedy or troubleshooting section, and lists the rest without a guidance column', () => {
        const documentOwner = 'packages/cockpit/src/document/command.ts'
        const syncOwner = 'packages/cockpit/src/generated-environment/command.ts'
        const owned = (path: string) => new Set([path])
        const none: DiagnosticRemedy = { kind: 'none' }
        const emitted = (handler: string) => new Set(['SHARED_FAILURE',
            ...handler === 'document' ? ['BARE_FAILURE', 'FIXED_FAILURE', 'GUIDED_FAILURE'] : handler === 'sync' ? ['OTHER_FAILURE'] : []])
        const diagnostics = { items: ['diagnostic:BARE_FAILURE', 'diagnostic:FIXED_FAILURE', 'diagnostic:GUIDED_FAILURE', 'diagnostic:OTHER_FAILURE', 'diagnostic:SHARED_FAILURE'],
            owners: new Map([['BARE_FAILURE', owned(documentOwner)], ['FIXED_FAILURE', owned(documentOwner)], ['GUIDED_FAILURE', owned(documentOwner)], ['OTHER_FAILURE', owned(syncOwner)], ['SHARED_FAILURE', owned(syncOwner)]]),
            remedies: new Map<string, DiagnosticRemedy>([['BARE_FAILURE', none], ['FIXED_FAILURE', { kind: 'fixed', fix: 'repair the input' }], ['GUIDED_FAILURE', none], ['OTHER_FAILURE', none], ['SHARED_FAILURE', none]]),
            commandDiagnostics: new Map(commands.map(command => [command.handler, emitted(command.handler)])) }
        const troubleshooting = `# Troubleshooting\n\n\`OTHER_FAILURE\` is named before any section.\n\n## Guided recovery, step one\n\n\`GUIDED_FAILURE\` means the guide applies.\n\n${begin}\nold index\n${end}\n`
        const rendered = renderReferences({ ...input(troubleshooting), diagnostics })
        expect(rendered.kind, JSON.stringify(rendered)).toBe('complete')
        if (rendered.kind !== 'complete') return
        const cli = rendered.files.find(file => file.path === 'docs/cli-reference.md')!.bytes
        expect(cli).not.toContain('see the message')
        const documentSection = cli.slice(cli.indexOf('## cockpit document'), cli.indexOf('## cockpit registry-resolve'))
        expect(documentSection).toContain('| Diagnostic | What to do |\n| --- | --- |\n'
            + '| `FIXED_FAILURE` | repair the input |\n'
            + '| `GUIDED_FAILURE` | [Troubleshooting](troubleshooting.md#guided-recovery-step-one) |\n'
            + '\n| Other diagnostics |\n| --- |\n| `BARE_FAILURE` |\n')
        const syncSection = cli.slice(cli.indexOf('## cockpit sync'), cli.indexOf('## cockpit check'))
        expect(syncSection).toContain('| Diagnostic |\n| --- |\n| `OTHER_FAILURE` |\n')
        expect(syncSection).not.toContain('What to do')
        // A code every command emits is listed once, before the commands, and not under each one.
        expect(cli.slice(0, cli.indexOf('\n## cockpit '))).toContain('| Diagnostic |\n| --- |\n| `SHARED_FAILURE` |\n')
        expect(cli.match(/`SHARED_FAILURE`/g)).toHaveLength(1)
        // The troubleshooting index is the full lookup table and keeps one row per code.
        expect(rendered.troubleshooting.bytes).toContain('| `GUIDED_FAILURE` | see the message |')
    })

    it('repeats a fix in the troubleshooting index only when every place that raises the code states it', () => {
        const contract = 'packages/cockpit/src/environment/contract.ts'
        const owner = 'packages/cockpit/src/synthetic/owner.ts'
        const sources = new Map([
            [contract, "export const ENVIRONMENT_CODES = Object.freeze({\n    REGISTERED_FAILURE: 'REGISTERED_FAILURE',\n} as const)\nexport const EXECUTION_FAILURE_CODES = Object.freeze([] as const)\n"],
            [owner, [
                "import { ENVIRONMENT_CODES } from '../environment/contract.js'",
                "function refusal(code: string, message: string, fix?: string) { return { code, message, ...(fix ? { fix } : {}) } }",
                // Named through the registry, as environment codes must be, beside a literal fix.
                "export function registered() { return { code: ENVIRONMENT_CODES.REGISTERED_FAILURE, message: 'm', fix: 'repair the registered input' } }",
                "export function agreedFirst() { return { code: 'AGREED_FAILURE', message: 'm', fix: 'repair the shared input' } }",
                "export function agreedSecond() { return refusal('AGREED_FAILURE', 'm', 'repair the shared input') }",
                "export function differingFirst() { return { code: 'DIFFERING_FAILURE', message: 'm', fix: 'repair the first input' } }",
                "export function differingSecond() { return refusal('DIFFERING_FAILURE', 'm', 'repair the second input') }",
                // One place states a fix and another computes its own: neither is the code's fix.
                "export function partialFirst() { return { code: 'PARTIAL_FAILURE', message: 'm', fix: 'repair the partial input' } }",
                "export function partialSecond(detail: string) { return { code: 'PARTIAL_FAILURE', message: 'm', fix: `repair ${detail}` } }",
            ].join('\n')],
        ])
        const inventory = diagnosticInventoryFromSources([...sources.keys()], sources)
        const rendered = renderReferences({ ...input(), diagnostics: inventory })
        expect(rendered.kind, JSON.stringify(rendered)).toBe('complete')
        if (rendered.kind !== 'complete') return
        const index = rendered.troubleshooting.bytes
        expect(index).toContain('| `REGISTERED_FAILURE` | repair the registered input |\n')
        expect(index).toContain('| `AGREED_FAILURE` | repair the shared input |\n')
        expect(index).toContain('| `DIFFERING_FAILURE` | depends on what failed; see the message |\n')
        expect(index).toContain('| `PARTIAL_FAILURE` | depends on what failed; see the message |\n')
        expect(index).not.toMatch(/repair the (?:first|second|partial) input/)
    })

    it('lists under each command every code its CLI failure paths emit, and none its dispatch cannot reach', async () => {
        const inventory = diagnosticInventory(process.cwd(), 'HEAD')
        expect([...inventory.commandDiagnostics.keys()]).toEqual(commands.map(command => command.handler))
        const rendered = renderReferences({ ...input(), diagnostics: inventory })
        expect(rendered.kind, JSON.stringify(rendered)).toBe('complete')
        if (rendered.kind !== 'complete') return
        const cli = rendered.files.find(file => file.path === 'docs/cli-reference.md')!.bytes
        const everyCommand = cli.slice(0, cli.indexOf('\n## cockpit '))
        const section = (name: string) => {
            const start = cli.indexOf(`\n## cockpit ${name}\n`)
            const next = cli.indexOf('\n## cockpit ', start + 1)
            return cli.slice(start, next === -1 ? undefined : next)
        }
        expect(section('sync')).toContain('`SURFACE_STATE_CONFLICT`')
        expect(section('sync')).toContain('`TEAM_METADATA_UNAVAILABLE`')
        expect(section('sync')).not.toContain('`COCKPIT_VERSION_MISMATCH`')
        expect(section('check')).toContain('`COCKPIT_VERSION_MISMATCH`')
        // Only check inspects the Compose topology; sync shares its module but not that function.
        expect(section('check')).toContain('`COMPOSE_TOPOLOGY_UNAVAILABLE`')
        expect(section('sync')).not.toContain('`COMPOSE_TOPOLOGY_UNAVAILABLE`')
        expect(section('up')).toContain('`LIFECYCLE_EVIDENCE_INVALID`')
        // The guard and the interactive reset and work-order operators are other commands' paths
        // through the same dispatch code.
        // Asserted on the inventory: a code wrongly attributed to every command would leave each
        // section and move to the shared list, so a section check alone could not go red.
        const up = inventory.commandDiagnostics.get('up')!
        for (const other of ['GUARD_REFUSED', 'RESET_CONFIRMATION_MISMATCH', 'WORK_OPERATOR_REQUIRED']) expect(up.has(other), other).toBe(false)
        expect(section('document')).toContain('`OUTPUT_EXISTS`')
        expect(section('sync')).not.toContain('`OUTPUT_EXISTS`')
        for (const unreachable of ['CLI_COMMAND_REQUIRED', 'CLI_UNKNOWN_COMMAND', 'GUARD_INPUT_UNAVAILABLE']) expect(cli).not.toContain(`\`${unreachable}\``)
        const sibling = inventory.commandDiagnostics.get('sibling')!
        for (const other of ['CLAIM_CO_TENANT', 'DATA_MODE_UNAVAILABLE', 'TEMPLATE_NOT_FOUND']) expect(sibling.has(other), other).toBe(false)

        // Every code a command actually emits on its CLI-level failure paths must be in its table.
        // No executable is on PATH and the config never exists or never parses, so no run reaches a
        // runtime, a network or the caller's state.
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-cli-diagnostics-')))
        roots.push(root)
        const missing = join(root, 'missing.toml')
        const invalid = join(root, 'invalid.toml')
        const existing = join(root, 'existing.md')
        await writeFile(invalid, 'not = [toml')
        await writeFile(existing, 'prior')
        const env = { PATH: '', HOME: root, XDG_STATE_HOME: join(root, 'state'), NO_UPDATE_NOTIFIER: '1' }
        const createReleaseMetadataTransport = () => { throw new Error('the reference test never reaches a release registry') }
        const commandRuns: Readonly<Record<string, readonly (readonly string[])[]>> = {
            document: [['--registry', missing, '--output', existing]],
            'registry-resolve': [['--registry', missing], ['--registry', missing, '--siblings-root', root], ['--output', existing]],
            init: [[root, '--target', 'claudecode']],
            'baseline-record': [['--config', missing, '--interactive']],
            sibling: [['add', 'synthetic', '--config', missing]],
            runtime: [['measure', '--config', missing, '--image', 'synthetic']],
            logs: [['--config', missing, '--service', 'synthetic']],
            session: [['--config', missing, '--', 'true']],
        }
        const unlisted: string[] = []
        for (const command of commands) {
            const json = 'json' in command.options
            const runs = [[], ['--unknown-option'], ['--config', missing], ['--config', invalid], ['--config', missing, '--config', invalid],
                ...'work-order' in command.options ? [['--config', missing, '--work-order', 'synthetic', '--interactive']] : [],
                ...commandRuns[command.name] ?? []]
            for (const run of runs) {
                let stdout = ''
                let stderr = ''
                const io = { stdout: { write: (text: string) => { stdout += text; return true } }, stderr: { write: (text: string) => { stderr += text; return true } } }
                await runCli([command.name, ...json ? ['--json'] : [], ...run], io, {}, { env, createReleaseMetadataTransport })
                // session has no JSON mode, so its diagnostics are read from the human rendering.
                const emitted = json ? (JSON.parse(stdout) as { diagnostics: { code: string }[] }).diagnostics.map(row => row.code)
                    : [...stderr.matchAll(/^[A-Z]+ ([A-Z][A-Z0-9_]+)\b/gm)].map(match => match[1]!)
                expect(emitted.length, `${command.name} ${run.join(' ')}`).toBeGreaterThan(0)
                for (const code of emitted) {
                    if (!section(command.name).includes(`\`${code}\``) && !everyCommand.includes(`\`${code}\``)) unlisted.push(`${command.name}: ${code}`)
                }
            }
        }
        expect([...new Set(unlisted)]).toEqual([])
    }, 120_000)

    it.each(['', `${begin}\n${begin}\n${end}`, `${end}\n${begin}`, `${begin}\n${end}\n${end}`, `${begin} inline\n${end}`])('refuses ambiguous or malformed region markers: %s', body => {
        expect(renderReferences(input(body)).kind).toBe('refusal')
    })

    it('rejects fabricated cap authority and missing, duplicate or orphan troubleshooting rows', () => {
        expect(renderReferences({ ...input(), skills: { ...skills } }).kind).toBe('refusal')
        const row = '| `SYNTHETIC_FAILURE` | repair the synthetic input |\n'
        expect(validateTroubleshootingIndex(input().diagnostics, '')).toEqual(expect.arrayContaining([expect.stringContaining('SYNTHETIC_FAILURE')]))
        expect(validateTroubleshootingIndex(input().diagnostics, row + row).length).toBeGreaterThan(0)
        expect(validateTroubleshootingIndex(input().diagnostics, row + '| `ORPHAN_FAILURE` | none |\n').length).toBeGreaterThan(0)
        expect(validateTroubleshootingIndex(input().diagnostics, row + '| unknown-code | none |\n').length).toBeGreaterThan(0)
        expect(validateTroubleshootingIndex(input().diagnostics, row.replace('repair the synthetic input', 'stale remedy')).length).toBeGreaterThan(0)
        const missingRemedies = { ...input().diagnostics, remedies: new Map() } as Parameters<typeof validateTroubleshootingIndex>[0]
        expect(validateTroubleshootingIndex(missingRemedies, row).length).toBeGreaterThan(0)
        const inventory = diagnosticInventory(process.cwd(), 'HEAD')
        expect(inventory.items.length).toBeGreaterThan(10)
        expect(inventory.remedies.size).toBe(inventory.items.length)
        const rendered = renderReferences({ ...input(), diagnostics: inventory })
        expect(rendered.kind, JSON.stringify(rendered)).toBe('complete')
        if (rendered.kind === 'complete') {
            expect(validateTroubleshootingIndex(inventory, rendered.troubleshooting.bytes)).toEqual([])
            // A person looks this warning up to learn how to trust the hook, so the row carries the remedy.
            expect(rendered.troubleshooting.bytes).toMatch(/^\| `CODEX_HOOK_UNTRUSTED` \| .*codex -C <cockpit root>.*Trust all and continue.* \|$/m)
            const cli = rendered.files.find(file => file.path === 'docs/cli-reference.md')!.bytes
            const documentSection = cli.slice(cli.indexOf('## cockpit document'), cli.indexOf('## cockpit registry-resolve'))
            expect(documentSection).toContain('`DOCUMENT_GAP`')
            expect(cli).not.toContain('packages/cockpit/src/')
            expect(documentSection).toContain('| `OUTPUT_EXISTS` | choose a new path; replacement requires a future explicit option |')
            // A gap's fix is chosen per gap, so neither the page nor the index presents one as the code's fix.
            expect(documentSection).not.toContain('supply this value before treating the draft as valid')
            expect(rendered.troubleshooting.bytes).toContain('| `DOCUMENT_GAP` | depends on what failed; see the message |')
        }
    })

    it('publishes through the admitted transaction and performs no replacement on an identical render', async () => {
        const { root, publicationFor } = await fixture()
        const rendered = renderReferences({ committed, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill })
        if (rendered.kind !== 'complete') throw new Error('render failed')
        const result = await writeReferences({ root, publication: await publicationFor(rendered), rendered }, { revalidate: async () => true })
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'complete' })
        if (result.kind !== 'complete') return
        expect(result.committed.map(file => file.path).sort()).toEqual([...wholePaths, 'docs/troubleshooting.md', '.cockpit/generated-reference-ownership.json'].sort())
        for (const file of result.committed) expect(digest(await readFile(join(root, file.path), 'utf8'))).toBe(file.sha256)
        const before = await lstat(join(root, wholePaths[0]!))
        const again = renderReferences({ committed, diagnostics: input().diagnostics, troubleshooting: rendered.troubleshooting.document, adoptSkill })
        if (again.kind !== 'complete') throw new Error('second render failed')
        expect(await writeReferences({ root, publication: await publicationFor(again), rendered: again }, { revalidate: async () => true })).toMatchObject({ kind: 'complete', committed: [] })
        expect((await lstat(join(root, wholePaths[0]!))).ino).toBe(before.ino)
    })

    it('keeps dry runs read-only and refuses a foreign prose change after render', async () => {
        const { root, publicationFor, prior } = await fixture()
        const rendered = renderReferences({ committed, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill })
        if (rendered.kind !== 'complete') throw new Error('render failed')
        const publication = await publicationFor(rendered)
        const consumerLedger = 'synthetic consumer estate\n'
        await writeFile(join(root, '.cockpit/generated-environment-ownership.json'), consumerLedger)
        expect(await writeReferences({ root, publication, rendered }, { dryRun: true, revalidate: async () => true })).toMatchObject({ kind: 'complete', committed: [] })
        expect(await readFile(join(root, 'docs/troubleshooting.md'), 'utf8')).toBe(prose)
        for (const path of wholePaths) expect(await readFile(join(root, path), 'utf8')).toBe('prior')
        expect(await readFile(join(root, '.cockpit/generated-reference-ownership.json'), 'utf8')).toBe(prior.bytes)
        const changedProse = prose.replace('Keep this human paragraph.', 'A foreign edit after render.')
        await writeFile(join(root, 'docs/troubleshooting.md'), changedProse)
        expect((await writeReferences({ root, publication, rendered }, { revalidate: async () => true })).kind).toBe('refusal')
        expect(await readFile(join(root, 'docs/troubleshooting.md'), 'utf8')).toBe(changedProse)
        expect(await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8')).toBe(consumerLedger)
        const again = renderReferences({ committed, diagnostics: input().diagnostics, troubleshooting: changedProse, adoptSkill })
        if (again.kind !== 'complete') throw new Error('render failed')
        expect((await writeReferences({ root, publication: await publicationFor(again), rendered: again }, { revalidate: async () => true })).kind).toBe('complete')
        expect(await readFile(join(root, 'docs/troubleshooting.md'), 'utf8')).toBe(again.troubleshooting.document)
        expect(again.troubleshooting.document).toContain('A foreign edit after render.')
        expect(await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8')).toBe(consumerLedger)
    })

    it('refuses forged destinations and preserves all bytes after transaction failure', async () => {
        const { root, publicationFor, prior } = await fixture()
        const rendered = renderReferences({ committed, diagnostics: input().diagnostics, troubleshooting: prose, adoptSkill })
        if (rendered.kind !== 'complete') throw new Error('render failed')
        const publication = await publicationFor(rendered)
        const consumerRender = renderReferences(input())
        if (consumerRender.kind !== 'complete') throw new Error('consumer render failed')
        expect((await writeReferences({ root, publication, rendered: consumerRender }, { revalidate: async () => true })).kind).toBe('refusal')
        expect((await writeReferences({ root, publication, rendered: { ...rendered, files: [{ path: '../escape.md', bytes: 'escape', sha256: digest('escape') }] } }, { revalidate: async () => true })).kind).toBe('refusal')
        let fault = false
        const result = await writeReferences({ root, publication, rendered }, { revalidate: async () => true, execute: async step => {
            const outcome = await executeProbe(step)
            if (!fault && step.labels.action === 'publish-batch') { fault = true; throw new Error('synthetic publication failure') }
            return outcome
        } })
        expect(fault).toBe(true)
        expect(result.kind).toBe('refusal')
        expect(await readFile(join(root, 'docs/troubleshooting.md'), 'utf8')).toBe(prose)
        expect(await readFile(join(root, '.cockpit/generated-reference-ownership.json'), 'utf8')).toBe(prior.bytes)
        for (const path of wholePaths) expect(await readFile(join(root, path), 'utf8')).toBe('prior')
    })
})
