import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { prepareNavigationProbe, renderNavigationEvidence, runNavigationProbe } from '../../../scripts/navigation-probe.mjs'
import * as docsLint from '../../../scripts/docs-lint.mjs'

const { deriveDocumentationInventory, validateNavigationEvidence, writeReviewManifest } = docsLint
const { inspectInternalLinks } = docsLint as unknown as {
    inspectInternalLinks: (input: {
        path: string
        body: string
        readTarget: (path: string) => string
    }) => Array<{ code: string; line: number; message: string; path: string }>
}

const scratch: string[] = []
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const ROOT_NAVIGATION = [
    'docs/cli-reference.md',
    '.github/CODEOWNERS',
    'CONTRIBUTING.md#verification',
    'docs/harness-surfaces.md#ownership-and-extension',
] as const

afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { force: true, recursive: true })
})

describe('public root navigation', () => {
    const readDocument = (path: string) => readFileSync(join(ROOT, path), 'utf8')

    it('shows invocation help without a review manifest or a repository', () => {
        const root = mkdtempSync(join(tmpdir(), 'navigation-help-'))
        scratch.push(root)
        const result = spawnSync(process.execPath, [join(ROOT, 'scripts/navigation-probe.mjs'), '--help'], {
            cwd: root, encoding: 'utf8',
        })
        expect(result.status).toBe(0)
        expect(result.stderr).toBe('')
        for (const flag of ['--write-evidence', '--review-manifest', '--base', '--head']) {
            expect(result.stdout).toContain(flag)
        }
        expect(existsSync(join(root, '.git'))).toBe(false)
    })

    it('locates commands, owners, tests, and extension seams from the root entrypoint', () => {
        const body = readDocument('README.md')

        for (const target of ROOT_NAVIGATION) {
            expect(body).toContain(`](${target})`)
            expect(inspectInternalLinks({
                path: 'README.md', body: `[Navigation](${target})`, readTarget: readDocument,
            })).toEqual([])
        }
    })

    it('rejects a dead root navigation target', () => {
        expect(inspectInternalLinks({
            path: 'README.md',
            body: '# Root\n\n[Missing](docs/does-not-exist.md)\n',
            readTarget: readDocument,
        })).toEqual([expect.objectContaining({ code: 'DOCEV026_LINK_MISSING' })])
    })
})

function repository(extra: Record<string, string | Buffer> = {}, navigationScope: string[] = []) {
    const root = mkdtempSync(join(tmpdir(), 'navigation-probe-repository-'))
    scratch.push(root)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.email', 'probe@example.invalid')
    git('config', 'user.name', 'Navigation Probe')
    writeFileSync(join(root, 'README.md'), '# Purpose\nSynthetic product purpose.\n')
    writeFileSync(join(root, 'AGENTS.md'), '# Navigation\nRun `npm test -- navigation`.\n')
    writeFileSync(join(root, 'removed.txt'), 'removed at candidate\n')
    git('add', 'README.md', 'AGENTS.md', 'removed.txt')
    git('commit', '-qm', 'initial public contract')
    const base = git('rev-parse', 'HEAD')
    execFileSync('mkdir', ['-p', join(root, 'packages/cockpit/src')])
    writeFileSync(join(root, 'packages/cockpit/src/cli.ts'), 'export const ready = true\n')
    writeFileSync(join(root, 'packages/cockpit/src/cli.test.ts'), 'test("rejects invalid input", () => {})\n')
    const commandTable = navigationScope.length === 0 ? {} : {
        'packages/cockpit/src/command-table.ts': `export const commands = [\n${navigationScope.map((id) => {
            if (!id.startsWith('command:')) throw new Error(`unsupported synthetic navigation item: ${id}`)
            return `    {\n        name: '${id.slice('command:'.length)}',\n        options: {},\n    },`
        }).join('\n')}\n]\n`,
    }
    const candidateFiles = { ...extra, ...commandTable }
    for (const [path, body] of Object.entries(candidateFiles)) {
        execFileSync('mkdir', ['-p', join(root, path, '..')])
        writeFileSync(join(root, path), body)
    }
    git('add', 'packages/cockpit/src/cli.ts', 'packages/cockpit/src/cli.test.ts', ...Object.keys(candidateFiles))
    git('rm', '-q', 'removed.txt')
    git('commit', '-qm', 'add public implementation')
    const head = git('rev-parse', 'HEAD')
    const manifestPath = join(root, 'review-manifest.json')
    const errors = writeReviewManifest({ root, path: 'review-manifest.json', expectedFixedPoint: base, candidate: head })
    if (errors.length > 0) throw new Error(errors.join('\n'))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (JSON.stringify(manifest.navigationScope) !== JSON.stringify(navigationScope)) {
        throw new Error(`unexpected synthetic navigation scope: ${JSON.stringify(manifest.navigationScope)}`)
    }
    return { base, git, head, manifest, manifestPath, root }
}

function executable(root: string, name: string, source: string): string {
    const path = join(root, name)
    writeFileSync(path, `#!/usr/bin/env node\n${source}`)
    chmodSync(path, 0o755)
    return path
}

describe('navigation probe preparation', () => {
    it('accepts the exact manifest written by the documentation detector', async () => {
        const binary = Buffer.from([0xff, 0x00, 0xfe, 0x80])
        const fixture = repository({ M: 'status-shaped path\n', 'binary.bin': binary })
        const integrationManifest = join(fixture.root, 'integration-manifest.json')
        expect(writeReviewManifest({
            root: fixture.root,
            path: 'integration-manifest.json',
            expectedFixedPoint: fixture.base,
            candidate: fixture.head,
        })).toEqual([])
        const destination = mkdtempSync(join(tmpdir(), 'navigation-probe-writer-integration-'))
        scratch.push(destination)

        const prepared = await prepareNavigationProbe({
            repository: fixture.root,
            reviewManifest: integrationManifest,
            base: fixture.base,
            head: fixture.head,
            destination,
        })

        expect(prepared.manifest).toEqual(JSON.parse(readFileSync(integrationManifest, 'utf8')))
        expect(prepared.manifest.files).toContainEqual(expect.objectContaining({ path: 'M', state: 'present' }))
        expect(prepared.manifest.files).toContainEqual({
            path: 'binary.bin',
            state: 'present',
            sha256: createHash('sha256').update(binary).digest('hex'),
        })
        expect(prepared.manifest.files).toContainEqual({ path: 'removed.txt', state: 'deleted', sha256: null })
    })

    it('creates separate harness parents with adjacent candidate and broken-control trees from one commit', async () => {
        const fixture = repository()
        const destination = mkdtempSync(join(tmpdir(), 'navigation-probe-prepared-'))
        scratch.push(destination)
        const prepared = await prepareNavigationProbe({
            repository: fixture.root,
            reviewManifest: fixture.manifestPath,
            base: fixture.base,
            head: fixture.head,
            destination,
        })

        expect(prepared.commit).toBe(fixture.head)
        expect(prepared.harnesses.codex.parent).not.toBe(prepared.harnesses.claude.parent)
        for (const harness of Object.values(prepared.harnesses)) {
            expect(join(harness.parent, 'candidate')).toBe(harness.candidate)
            expect(join(harness.parent, 'broken-control')).toBe(harness.brokenControl)
            expect(readFileSync(join(harness.candidate, 'packages/cockpit/src/cli.ts'), 'utf8')).toContain('ready')
            expect(readFileSync(join(harness.brokenControl, '.navigation-control'), 'utf8')).toBe(prepared.controlMarker)
            expect(() => readFileSync(join(harness.candidate, '.git'), 'utf8')).toThrow()
            const confinement = readFileSync(harness.profiles.candidate, 'utf8')
            expect(confinement).toContain(`(deny file-read* (subpath "${prepared.sentinel}"))`)
            expect(confinement).toContain(`(deny file-read* (subpath "${realpathSync(fixture.root)}"))`)
            expect(confinement).toContain(`(deny file-read* (subpath "${harness === prepared.harnesses.codex ? prepared.harnesses.claude.parent : prepared.harnesses.codex.parent}"))`)
            expect(confinement).toContain('(allow process-exec (literal "/bin/cat"))')
            expect(confinement).toContain('(allow file-read* (literal "/"))')
            expect(confinement).not.toContain('(allow file-read* (subpath "/"))')
            expect(confinement).not.toContain('(allow file-read* (subpath "/Library"))')
            expect(confinement).not.toContain('(allow file-read* (subpath "/private/etc"))')
            expect(confinement).not.toContain('(allow mach-lookup)\n')
            const brokenConfinement = readFileSync(harness.brokenProfile, 'utf8')
            expect(brokenConfinement).toContain('(allow file-read* (literal "/"))')
            expect(brokenConfinement).not.toContain('(allow file-read* (subpath "/"))')
            expect(brokenConfinement).toContain(`(allow file-read* (subpath "${prepared.sentinel}"))`)
            expect(brokenConfinement).not.toContain(`(deny file-read* (subpath "${prepared.sentinel}"))`)
        }
    })

    it.each(['internal/private.txt', '.local-notes/' + 'state.md', '.claude/work' + 'trees/residue.txt'])(
        'rejects forbidden archive path %s',
        async (path) => {
            const fixture = repository({ [path]: 'must not enter probe tree\n' })
            const destination = mkdtempSync(join(tmpdir(), 'navigation-probe-forbidden-'))
            scratch.push(destination)
            await expect(prepareNavigationProbe({
                repository: fixture.root,
                reviewManifest: fixture.manifestPath,
                base: fixture.base,
                head: fixture.head,
                destination,
            })).rejects.toThrow(/forbidden public archive path/)
        },
    )

    it('rejects stale, unsorted, and content-mismatched review manifests', async () => {
        const fixture = repository()
        const destination = mkdtempSync(join(tmpdir(), 'navigation-probe-manifest-'))
        scratch.push(destination)
        fixture.manifest.files.reverse()
        writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest))
        await expect(prepareNavigationProbe({
            repository: fixture.root,
            reviewManifest: fixture.manifestPath,
            base: fixture.base,
            head: fixture.head,
            destination,
        })).rejects.toThrow(/sorted changed file inventory/)
    })

    it('requires a sorted unique navigation scope in the committed review manifest', async () => {
        const fixture = repository()
        const destination = mkdtempSync(join(tmpdir(), 'navigation-probe-scope-'))
        scratch.push(destination)
        fixture.manifest.navigationScope = ['extension:z', 'command:a', 'command:a']
        writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest))

        await expect(prepareNavigationProbe({
            repository: fixture.root,
            reviewManifest: fixture.manifestPath,
            base: fixture.base,
            head: fixture.head,
            destination,
        })).rejects.toThrow(/sorted unique navigation scope/)
    })

    it('requires an empty absolute destination owned by this invocation', async () => {
        const fixture = repository()
        await expect(prepareNavigationProbe({
            repository: fixture.root,
            reviewManifest: fixture.manifestPath,
            base: fixture.base,
            head: fixture.head,
            destination: 'relative-probe-root',
        })).rejects.toThrow(/destination must be absolute/)
        const destination = mkdtempSync(join(tmpdir(), 'navigation-probe-nonempty-'))
        scratch.push(destination)
        writeFileSync(join(destination, 'owned-by-someone-else'), 'keep\n')
        await expect(prepareNavigationProbe({
            repository: fixture.root,
            reviewManifest: fixture.manifestPath,
            base: fixture.base,
            head: fixture.head,
            destination,
        })).rejects.toThrow(/destination must be empty/)

        const target = mkdtempSync(join(tmpdir(), 'navigation-probe-symlink-target-'))
        const link = `${target}-link`
        scratch.push(target, link)
        symlinkSync(target, link)
        await expect(prepareNavigationProbe({
            repository: fixture.root,
            reviewManifest: fixture.manifestPath,
            base: fixture.base,
            head: fixture.head,
            destination: link,
        })).rejects.toThrow(/destination must be a real directory/)
    })

})

describe('bounded navigation execution', () => {
    function detectorErrors(
        fixture: ReturnType<typeof repository>,
        navigation: Awaited<ReturnType<typeof runNavigationProbe>>,
        publicKey: KeyObject,
    ): string[] {
        const evidencePath = join(fixture.root, 'navigation-evidence.md')
        const publicKeyPath = join(fixture.root, 'navigation-public.pem')
        writeFileSync(evidencePath, renderNavigationEvidence(fixture.base, navigation))
        writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
        const inventory = deriveDocumentationInventory({ root: fixture.root,
            expectedFixedPoint: fixture.base, candidate: fixture.head })
        if (inventory.errors.length > 0) throw new Error(inventory.errors.join('\n'))
        writeFileSync(join(fixture.root, 'impact-ledger.md'), '```docs-evidence\n' + JSON.stringify({
            fixedPoint: fixture.base, candidate: fixture.head,
            rows: inventory.items.map((id, index) => ({ id, disposition: 'updated',
                anchor: index % 2 === 0 ? 'AGENTS.md#navigation' : 'README.md#purpose' })),
        }) + '\n```\n')
        return validateNavigationEvidence({
            root: fixture.root,
            path: 'navigation-evidence.md',
            expectedFixedPoint: fixture.base,
            candidate: fixture.head,
            navigationPublicKeyPath: 'navigation-public.pem',
            impactLedgerPath: 'impact-ledger.md',
        })
    }

    function harnesses(root: string, scope: string[] = [], codexFault = '', profileCaptures?: string) {
        const bin = mkdtempSync(join(tmpdir(), 'navigation-probe-bin-'))
        scratch.push(bin)
        const sandbox = executable(bin, 'sandbox-exec', `
const { spawn } = require('node:child_process')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] !== '-f') process.exit(91)
if (args[2] === '/bin/cat' && args.at(-1).includes('confinement-sentinel') && path.basename(args[1]) !== 'broken-confinement.sb') process.exit(77)
const profileCaptures = ${JSON.stringify(profileCaptures)}
if (profileCaptures && ['codex', 'claude'].includes(path.basename(args[2]))) {
  require('node:fs').writeFileSync(path.join(profileCaptures, path.basename(args[2]) + '-' + path.basename(process.cwd()) + '.sb'), require('node:fs').readFileSync(args[1]))
}
const child = spawn(args[2], args.slice(3), { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.on('exit', (status) => process.exit(status ?? 92))
`)
        const scopeEvidence = scope.map((id, index) => index === 0
            ? { id, ownerPath: 'AGENTS.md', contractPath: 'AGENTS.md', testPath: 'packages/cockpit/src/cli.test.ts', verificationPath: 'AGENTS.md', verificationCommand: 'npm test -- navigation', anchor: 'npm test -- navigation' }
            : { id, ownerPath: 'packages/cockpit/src/cli.ts', contractPath: 'AGENTS.md', testPath: 'packages/cockpit/src/cli.test.ts', verificationPath: 'AGENTS.md', verificationCommand: 'npm test -- navigation', anchor: 'export const ready = true' })
        const shared = `
const fs = require('node:fs')
const path = require('node:path')
const markerPath = path.join(process.cwd(), '.navigation-control')
const control = fs.existsSync(markerPath)
const payload = control
  ? { controlMarker: fs.readFileSync(markerPath, 'utf8') }
  : { located: [
      { kind: 'purpose', path: 'README.md' },
      { kind: 'contract', path: 'AGENTS.md' },
      { kind: 'implementation', path: 'packages/cockpit/src/cli.ts' },
      { kind: 'test', path: 'packages/cockpit/src/cli.test.ts' },
      { kind: 'command', path: 'AGENTS.md' },
    ], exactCommand: 'npm test -- navigation', openedPaths: ${JSON.stringify(['AGENTS.md', 'README.md', 'packages/cockpit/src/cli.test.ts', 'packages/cockpit/src/cli.ts', ...(scope.length > 0 ? ['packages/cockpit/src/command-table.ts'] : [])].sort())}, scopeEvidence: ${JSON.stringify(scopeEvidence)} }
`
        const codex = executable(bin, 'codex', `${shared}
const args = process.argv.slice(2)
const output = args[args.indexOf('-o') + 1]
const prompt = args.at(-1)
const fault = ${JSON.stringify(codexFault)}
const expected = ['exec','--ephemeral','--ignore-user-config','--ignore-rules','-s','read-only','-C',args[7],'--json','-o',output,prompt]
if (JSON.stringify(args) !== JSON.stringify(expected) || fs.realpathSync(args[7]) !== fs.realpathSync(process.cwd())) process.exit(88)
const emitted = control && fault === 'wrong-marker' ? { controlMarker: 'wrong' } : payload
fs.writeFileSync(output, (!control && fault === 'candidate-json') || (control && fault === 'control-json') ? '{' : JSON.stringify(emitted))
if (!control && fault === 'native-json') process.stdout.write('not-json\\n')
else for (const openedPath of payload.openedPaths || ['.navigation-control']) process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'cat -- ' + openedPath, exit_code: 0, aggregated_output: 'bounded output' } }) + '\\n')
process.exit(control && fault === 'control-nonzero' ? 9 : 0)
`)
        const claude = executable(bin, 'claude', `${shared}
const args = process.argv.slice(2)
const config = args[args.indexOf('--mcp-config') + 1]
const prompt = args.at(-1)
const expected = ['-p','--restricted','--setting-sources','project','--permission-mode','plan','--permission-prompts','none','--allowedTools','Read,Glob,Grep','--strict-mcp-config','--mcp-config',config,'--no-session-persistence','--output-format','stream-json','--verbose',prompt]
if (JSON.stringify(args) !== JSON.stringify(expected)) process.exit(88)
const openedPaths = payload.openedPaths || ['.navigation-control']
for (const [index, openedPath] of openedPaths.entries()) {
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-' + index, name: 'Read', input: { file_path: openedPath } }] } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-' + index, content: 'bounded output', is_error: false }] } }) + '\\n')
}
process.stdout.write(JSON.stringify({ type: 'result', result: JSON.stringify(payload) }) + '\\n')
process.exit(0)
`)
        return { sandbox, codex, claude }
    }

    async function preparedFixture(navigationScope: string[] = []) {
        const fixture = repository({}, navigationScope)
        const destination = mkdtempSync(join(tmpdir(), 'navigation-probe-run-'))
        scratch.push(destination)
        return {
            fixture,
            prepared: await prepareNavigationProbe({
                repository: fixture.root,
                reviewManifest: fixture.manifestPath,
                base: fixture.base,
                head: fixture.head,
                destination,
            }),
        }
    }

    it('enforces paired native confinement or makes signed navigation unavailable', async () => {
        const { prepared } = await preparedFixture()
        const harness = prepared.harnesses.codex
        const allowed = join(harness.writable, 'runtime-marker')
        const denied = join(prepared.sentinel, 'credential-store')
        writeFileSync(allowed, 'runtime marker\n')
        const read = (profile: string, path: string) => spawnSync(
            '/usr/bin/sandbox-exec', ['-f', profile, '/bin/cat', '--', path],
            { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 5_000 },
        )
        const allowedRead = read(harness.profiles.candidate, allowed)
        if (allowedRead.status === 0) {
            expect(allowedRead.stdout).toBe('runtime marker\n')
            expect(read(harness.profiles.candidate, denied).status).not.toBe(0)
            const brokenRead = read(harness.brokenProfile, denied)
            expect(brokenRead.status).toBe(0)
            expect(brokenRead.stdout).toBe('synthetic host marker\n')
        }

        const binaries = harnesses(prepared.root)
        binaries.sandbox = executable(dirname(binaries.sandbox), 'sandbox-runtime-unavailable', 'process.exit(77)')
        const { privateKey } = generateKeyPairSync('ed25519')
        const evidence = await runNavigationProbe({ prepared, binaries, privateKey, prompt: 'same prompt', scope: [] })
        expect(evidence).toEqual([
            { harness: 'codex', scope: [], status: 'unavailable', reason: 'confinement runtime launch is unavailable' },
            { harness: 'claude', scope: [], status: 'unavailable', reason: 'confinement runtime launch is unavailable' },
        ])
        expect(evidence.every((row) => !('signature' in row))).toBe(true)
    })

    it('uses exact fresh read-only argv, one prompt, bounded environments, and signed secret-free receipts', async () => {
        const scope = ['command:check', 'command:environment']
        const { fixture, prepared } = await preparedFixture(scope)
        const profileCaptures = mkdtempSync(join(tmpdir(), 'navigation-profile-captures-'))
        scratch.push(profileCaptures)
        const binaries = harnesses(prepared.root, scope, '', profileCaptures)
        const { privateKey, publicKey } = generateKeyPairSync('ed25519')
        const evidence = await runNavigationProbe({
            prepared,
            binaries,
            prompt: 'Locate the public navigation contract.',
            scope,
            privateKey,
            now: () => new Date('2026-09-26T10:00:00.000Z'),
        })

        expect(evidence.map(({ harness }) => harness)).toEqual(['codex', 'claude'])
        for (const row of evidence) {
            if (!('receipt' in row)) throw new Error(`${row.harness} unexpectedly unavailable: ${row.reason}`)
            expect(row.receipt.candidateCommit).toBe(fixture.head)
            expect(row.receipt.candidate.exitStatus).toBe(0)
            expect(row.receipt.brokenControl.exitStatus).not.toBe(0)
            expect(row.receipt.brokenControl.detectorCode).toBe('NAVIGATION_CONTROL_DETECTED')
            expect(row.receipt.brokenControl.harnessExitStatus).toBe(0)
            expect(row.receipt.brokenControl.harnessCommand).toContain(row.harness)
            expect(row.receipt.brokenControl.command).toContain('node')
            expect(row.receipt.candidate.transcriptSha256).toMatch(/^[a-f0-9]{64}$/)
            expect(row.receipt.scopeSha256).toMatch(/^[a-f0-9]{64}$/)
            expect(row.receipt.bounds).toEqual({ maxSeconds: 120, maxOutputBytes: 4 * 1024 * 1024 })
            expect(row.receipt.openedPaths).toEqual(['AGENTS.md', 'README.md', 'packages/cockpit/src/cli.test.ts', 'packages/cockpit/src/cli.ts', 'packages/cockpit/src/command-table.ts'])
            expect(row.receipt.cleanup.before).toBe(row.receipt.cleanup.after)
            expect(row.receipt.differential).toContain('broken control')
            expect(verify(null, Buffer.from(JSON.stringify({ harness: row.harness, scope: row.scope, receipt: row.receipt })), publicKey, Buffer.from(row.signature, 'base64'))).toBe(true)
            expect(JSON.stringify(row)).not.toContain('OPENAI_API_KEY')
        }
        expect(detectorErrors(fixture, evidence, publicKey)).toEqual([])
        expect('receipt' in evidence[0]! ? evidence[0].receipt.candidate.command : '').toContain('codex exec --ephemeral --ignore-user-config --ignore-rules -s read-only -C ')
        expect('receipt' in evidence[1]! ? evidence[1].receipt.candidate.command : '').toContain('claude -p --restricted --setting-sources project --permission-mode plan --permission-prompts none --allowedTools Read,Glob,Grep --strict-mcp-config')
        for (const harness of Object.values(prepared.harnesses)) {
            expect(() => readFileSync(join(harness.writable, 'candidate', 'last-message.json'), 'utf8')).toThrow()
            expect(() => readFileSync(join(harness.writable, 'broken-control', 'last-message.json'), 'utf8')).toThrow()
        }
        const icuDataPaths = process.platform === 'darwin'
            ? readdirSync('/usr/share/icu').filter((name) => /^icudt\d+l\.dat$/.test(name)).map((name) => realpathSync(join('/usr/share/icu', name)))
            : []
        if (process.platform === 'darwin') expect(icuDataPaths).toHaveLength(1)
        for (const kind of ['candidate', 'broken-control']) {
            const claudeProfile = readFileSync(join(profileCaptures, `claude-${kind}.sb`), 'utf8')
            for (const icuDataPath of icuDataPaths) {
                expect(claudeProfile).toContain(`(allow file-read* (literal "${icuDataPath}"))`)
            }
            for (const forbidden of prepared.harnesses.claude.forbiddenRoots) {
                expect(claudeProfile).toContain(`(deny file-read* (subpath "${forbidden}"))`)
            }
            expect(readFileSync(join(profileCaptures, `codex-${kind}.sb`), 'utf8')).not.toContain('/usr/share/icu')
        }
    })

    it('rejects a caller scope that differs from the manifest-bound navigation scope', async () => {
        const { prepared } = await preparedFixture(['command:check'])
        const binaries = harnesses(prepared.root)
        const { privateKey } = generateKeyPairSync('ed25519')

        await expect(runNavigationProbe({
            prepared,
            binaries,
            privateKey,
            prompt: 'same prompt',
            scope: [],
        })).rejects.toThrow(/scope must equal the review manifest navigation scope/)
    })

    it('rejects navigation paths and commands that are not present in the frozen candidate tree', async () => {
        const first = await preparedFixture()
        rmSync(join(first.prepared.harnesses.codex.candidate, 'packages/cockpit/src/cli.ts'))
        const { privateKey: firstKey } = generateKeyPairSync('ed25519')
        const firstEvidence = await runNavigationProbe({
            prepared: first.prepared,
            binaries: harnesses(first.prepared.root),
            privateKey: firstKey,
            prompt: 'same prompt',
            scope: [],
        })
        expect(firstEvidence[0]).toMatchObject({ harness: 'codex', status: 'unavailable' })
        expect(firstEvidence[1]).toHaveProperty('receipt')

        const second = await preparedFixture()
        writeFileSync(join(second.prepared.harnesses.codex.candidate, 'AGENTS.md'), 'No verification command here.\n')
        const { privateKey: secondKey } = generateKeyPairSync('ed25519')
        const secondEvidence = await runNavigationProbe({
            prepared: second.prepared,
            binaries: harnesses(second.prepared.root),
            privateKey: secondKey,
            prompt: 'same prompt',
            scope: [],
        })
        expect(secondEvidence[0]).toMatchObject({ harness: 'codex', status: 'unavailable' })
        expect(secondEvidence[1]).toHaveProperty('receipt')
    })

    it.each(['candidate-json', 'native-json', 'control-json', 'wrong-marker', 'control-nonzero'])(
        'keeps peer evidence when Codex emits unavailable %s evidence',
        async (fault) => {
            const { prepared } = await preparedFixture()
            const { privateKey } = generateKeyPairSync('ed25519')
            const evidence = await runNavigationProbe({
                prepared,
                binaries: harnesses(prepared.root, [], fault),
                privateKey,
                prompt: 'same prompt',
                scope: [],
            })

            expect(evidence[0]).toMatchObject({ harness: 'codex', status: 'unavailable' })
            expect(evidence[0]).not.toHaveProperty('signature')
            expect(evidence[1]).toHaveProperty('receipt')
            expect(() => readFileSync(join(prepared.harnesses.codex.writable, 'candidate', 'last-message.json'))).toThrow()
            expect(() => readFileSync(join(prepared.harnesses.codex.writable, 'broken-control', 'last-message.json'))).toThrow()
        },
    )

    it.each([
        [{ timeoutMs: 120_001 }, /timeout cannot exceed 120000ms/],
        [{ maxOutputBytes: 4 * 1024 * 1024 + 1 }, /output limit cannot exceed 4194304 bytes/],
        [{ environment: { SECRET_TOKEN: 'not-allowed' } }, /environment name is not allow-listed/],
    ])('rejects a bound or environment escape %#', async (override, message) => {
        const { prepared } = await preparedFixture()
        const binaries = harnesses(prepared.root)
        const { privateKey } = generateKeyPairSync('ed25519')
        await expect(runNavigationProbe({
            prepared, binaries, privateKey, prompt: 'same prompt', scope: [], ...override,
        })).rejects.toThrow(message)
    })

    it('marks authentication failure unavailable rather than parity', async () => {
        const { prepared } = await preparedFixture()
        const binaries = harnesses(prepared.root)
        binaries.codex = executable(dirname(binaries.codex), 'codex-auth', `process.stderr.write('authentication required'); process.exit(1)`)
        const { privateKey } = generateKeyPairSync('ed25519')
        const evidence = await runNavigationProbe({ prepared, binaries, privateKey, prompt: 'same prompt', scope: [] })
        expect(evidence.find(({ harness }) => harness === 'codex')).toMatchObject({
            status: 'unavailable', reason: 'authentication unavailable within the bounded environment',
        })
    })

    it('keeps a missing harness executable unavailable without erasing its peer result', async () => {
        const scope = ['command:check', 'command:environment']
        const { fixture, prepared } = await preparedFixture(scope)
        const binaries = harnesses(prepared.root, scope)
        binaries.codex = join(prepared.root, 'missing-codex')
        const { privateKey, publicKey } = generateKeyPairSync('ed25519')
        const evidence = await runNavigationProbe({ prepared, binaries, privateKey, prompt: 'same prompt', scope })

        expect(evidence[0]).toMatchObject({ harness: 'codex', status: 'unavailable' })
        expect(evidence[1]).toHaveProperty('receipt')
        expect(detectorErrors(fixture, evidence, publicKey)).toEqual([])
    })

    it('keeps asynchronous spawn failure unavailable without erasing peer evidence', async () => {
        const { prepared } = await preparedFixture()
        const binaries = harnesses(prepared.root)
        const sandbox = join(dirname(binaries.sandbox), 'sandbox-permission-race')
        writeFileSync(sandbox, `#!/bin/sh
set -eu
[ "$1" = "-f" ] || exit 91
profile=$2
shift 2
last=
for argument do last=$argument; done
case "$last" in
  *confinement-sentinel*) case "$profile" in */broken-confinement.sb) ;; *) exit 77 ;; esac ;;
esac
case "$1" in */codex) chmod 600 "$0" ;; esac
exec "$@"
`)
        chmodSync(sandbox, 0o755)
        binaries.sandbox = sandbox
        const { privateKey } = generateKeyPairSync('ed25519')

        const evidence = await runNavigationProbe({ prepared, binaries, privateKey, prompt: 'same prompt', scope: [] })

        expect(evidence).toHaveLength(2)
        expect(evidence.map(({ harness }) => harness)).toEqual(['codex', 'claude'])
        expect(evidence[0]).toMatchObject({
            harness: 'codex', status: 'unavailable', reason: 'broken-control execution evidence is unavailable',
        })
        expect(evidence[0]).not.toHaveProperty('signature')
    })

    it('terminates the whole process group at the timeout bound', async () => {
        const { prepared } = await preparedFixture()
        const binaries = harnesses(prepared.root)
        const parentPath = join(prepared.root, 'timeout-parent')
        const descendantPath = join(prepared.root, 'timeout-descendant')
        const sandbox = join(dirname(binaries.sandbox), 'sandbox-timeout')
        writeFileSync(sandbox, `#!/bin/sh
set -eu
[ "$1" = "-f" ] || exit 91
profile=$2
shift 2
last=
for argument do last=$argument; done
case "$last" in
  *confinement-sentinel*) case "$profile" in */broken-confinement.sb) ;; *) exit 77 ;; esac ;;
esac
exec "$@"
`)
        chmodSync(sandbox, 0o755)
        binaries.sandbox = sandbox
        const codex = join(dirname(binaries.codex), 'codex-timeout')
        writeFileSync(codex, `#!/bin/sh
set -eu
trap '' TERM
echo "$$" > ${JSON.stringify(parentPath)}
/bin/sh -c 'trap "" TERM
echo "$$" > ${JSON.stringify(descendantPath)}
kill -STOP "$$"
' &
while [ ! -s ${JSON.stringify(descendantPath)} ]; do :; done
kill -STOP "$$"
`)
        chmodSync(codex, 0o755)
        binaries.codex = codex
        const { privateKey } = generateKeyPairSync('ed25519')
        const pids: number[] = []
        const realSetTimeout = globalThis.setTimeout
        // Startup depends on host load; freeze the deadline until both real processes exist.
        // Keep cleanup's 25ms waits on the real clock so the OS can reap the process group.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const deadlineTimer = globalThis.setTimeout
        const clock = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, milliseconds, ...args) =>
            milliseconds === 400 ? deadlineTimer(callback, milliseconds, ...args) : realSetTimeout(callback, milliseconds, ...args))
        let pending: ReturnType<typeof runNavigationProbe> | undefined
        try {
            pending = runNavigationProbe({
                prepared, binaries, privateKey, prompt: 'same prompt', scope: [], timeoutMs: 400,
            })
            const readyBy = Date.now() + 5_000
            while (![parentPath, descendantPath].every((path) => existsSync(path) && readFileSync(path, 'utf8').trim() !== '')) {
                if (Date.now() >= readyBy) throw new Error('timeout fixture parent and descendant did not initialize within 5000ms')
                await new Promise<void>((resolve) => realSetTimeout(resolve, 10))
            }
            for (const path of [parentPath, descendantPath]) pids.push(Number(readFileSync(path, 'utf8')))
            await vi.advanceTimersByTimeAsync(400)
            const evidence = await pending
            expect(evidence[0]).toMatchObject({ harness: 'codex', status: 'unavailable' })
            expect(pids).toHaveLength(2)
            for (const pid of pids) {
                expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
                expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
            }
        } finally {
            try {
                await vi.advanceTimersByTimeAsync(400)
                await pending
            } finally {
                clock.mockRestore()
                vi.useRealTimers()
                for (const pid of pids) {
                    try { process.kill(pid, 'SIGKILL') } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
                    }
                }
            }
        }
    })

    it('terminates an invocation before output can exceed its byte bound', async () => {
        const { prepared } = await preparedFixture()
        const binaries = harnesses(prepared.root)
        binaries.codex = executable(dirname(binaries.codex), 'codex-output', `process.stdout.write('x'.repeat(512)); setInterval(() => {}, 1000)`)
        const { privateKey } = generateKeyPairSync('ed25519')
        const evidence = await runNavigationProbe({
            prepared, binaries, privateKey, prompt: 'same prompt', scope: [], maxOutputBytes: 64,
        })
        expect(evidence[0]).toMatchObject({ harness: 'codex', status: 'unavailable' })
        expect(evidence[1]).toMatchObject({ harness: 'claude', status: 'unavailable' })
    })
})
